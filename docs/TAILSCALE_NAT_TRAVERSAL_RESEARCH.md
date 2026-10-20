# Zeydrop：借鉴 Tailscale 的公网直连与 NAT 穿透研究

> 状态：设计与后续研发建议，**不是功能已实现、测试通过或发布声明**。  
> 日期：2026-10-20  
> 项目：Zeydrop（闪投）；GitHub 远端目前仍为 ForceMind/SnapDrop-Lite，正式改名留待仓库所有者手动完成。  
> 现有实现：Draft [PR #2](https://github.com/ForceMind/SnapDrop-Lite/pull/2)，2026-10-19 审阅时 head 为 `e10f3fbdb7ce665e3aae206707b35ba6b23ab61e`。进展以当前 PR head 和 [PROJECT_STATUS](PROJECT_STATUS.md) 为准。

## 1. 结论与不变量

Tailscale 对本项目最重要的启发是：**连接协调与文件数据通路分离、先探测并争取直连、根据实际选中路径诊断、失败可解释且状态可靠**。不是将整个 Tailscale 客户端、WireGuard 或 DERP 直接移植到浏览器。

Zeydrop 的不可退让边界：

1. 自有服务器仅提供 HTTPS 静态内容、WSS 配对/信令，不传输、不缓存、不存储文件正文，也不提供 WebSocket 文件转发、TURN 或 DERP 文件中继。
2. Web 端继续用浏览器 WebRTC ICE + RTCDataChannel；**无需安装 Tailscale、VPN、额外客户端或登录 Tailscale**。浏览器没有任意原生 UDP socket/端口映射权限。
3. 只能在真实选中的、可核验的**非 relay 路径**上传文件；选中 TURN relay、不知道选中路径、协商超时，必须阻断并明确失败，绝不暗中走服务器。
4. 保留 DTLS 会话身份码的带外人工核对、接收方明确同意、安全邀请与防滥用；连上信令服务器不等于已经连接对端。
5. 不承诺“100% 打洞成功”或“服务器总带宽为零”：页面、信令和 STUN 探测仍消耗少量流量；严格网络会失败。
6. 禁止以直接复制第三方私有控制面代码、暗中启动系统代理、自动修改路由器或 NAT 预测“玄学打洞”替代 WebRTC 标准 ICE。

### Tailscale 与 Zeydrop 的关键区别

| 维度 | Tailscale | Zeydrop 决定 |
| --- | --- | --- |
| 运行环境 | 原生代理/设备网络栈，可操作 UDP socket | 浏览器沙盒，使用内建 WebRTC/ICE |
| 身份与准入 | Tailnet 身份和设备 ACL | 临时高熵邀请、双向身份码、显式接收同意 |
| 文件/业务数据 | WireGuard 隧道，必要时 DERP/Peer Relay 转发 | **只通过直接建立的 RTCDataChannel** |
| NAT 探测 | 原生 UDP、端点协商、路径动态升级 | ICE host/srflx/prflx、IPv4/IPv6、实际 selected pair |
| 失败回退 | 可自动转中继 | 无文件中继；提示原因、指导换网络或稍后重试 |
| 部署依赖 | 独立控制面与原生客户端 | 沿用现有 Node/WSS/浏览器栈 |

Tailscale 的中继可改善连通性，但与 Zeydrop 现有 Direct-only 产品承诺冲突。**不列入当前路线图**。将来也不能未经单独产品决策悄悄添加。

## 2. 对现有 PR #2 的增量，而不是重复开发

已在 PR #2 开发候选中存在（仍非发布版）：随机邀请/会话锁定、WSS 白名单、DTLS 指纹安全码、接收同意、selected candidate-pair 检查、无 TURN/relay、ICE 有界重启、脱敏诊断、分块背压/流式写入及哈希校验。不要从原版 main 重新实现这些能力，也不要将 CI 同机测试误称公网穿透已验收。

新增研究集中在以下**未闭环事实**：

- 两个真实设备跨家庭宽带、蜂窝网络及跨运营商 NAT 环境的连接率、失败分类、协商耗时和选中路径尚无证据。
- 真实 IPv4/IPv6 双栈与 IPv6-only/NAT64、Wi-Fi↔4G/5G 切换、浏览器后台冻结、网络断续未完成目标平台实测。
- 断线后**跨连接**续传与持久化恢复尚未完成；现有暂停只在当前连接内有效。
- 显式同意的 LAN 发现、Safari/iOS 真机文件/磁盘权限与实际部署演练未完成。
- 不知道候选、看见 srflx 或信令成功，都不等价于已建立公网直连；所有结论须根据真实选中的 candidate pair 和文件校验记录。

参照现有 [ARCHITECTURE](ARCHITECTURE.md)、[STUN_CONFIGURATION](STUN_CONFIGURATION.md)、[REAL_DEVICE_TESTING](REAL_DEVICE_TESTING.md)、[TEST_MATRIX](TEST_MATRIX.md)，禁止并行另造第二套配对协议或第二个文件传输栈。

## 3. 实施包（依优先级独立 PR）

### Z-NAT-01｜公网实机基线与路径可观测（P0，先做）

- 基于现有本机脱敏诊断建立**由用户主动导出**的跨网络实测记录模板：系统/浏览器版本、网络组合、STUN 可达性、ICE gathering/checking 变化、最终 pair 的双方类型与协议、IPv4/IPv6、RTT、连接耗时、断开原因、收发文件 SHA-256 和服务器出站计量口径。
- 不上传 IP、原始 SDP/ICE、令牌、文件名、完整错误对象或 DTLS 身份码；浏览器隐藏统计字段时写“未知”，不填推测值。
- 比较两组：同 Wi-Fi 基线 / 不同公网，至少家庭宽带↔家庭宽带、家庭↔蜂窝、双蜂窝、严格办公 Wi-Fi 及可取得的 IPv6。
- 把每条结果分类为 `direct-confirmed`、`pair-unavailable`、`signaling-failed`、`stun-unreachable`、`user-declined`、`transfer-failed`；诊断分类不能替代 ICE 最终状态。
- **验收**：留存真实设备、真实异网、候选与最终选中路径的去敏证据；连接失败也归档，不能用同机/同 LAN 的浏览器 E2E 代替。

### Z-NAT-02｜连接策略与失败解释（P1）

- 复查 IPv6/IPv4 候选并行、早到 ICE/SDP 队列、断网恢复、单一 offerer、有界 ICE restart 和超时；优先修复 PR #2 实测发现的具体失败，不凭空增加“神奇穿透”算法。
- 对用户区分“配对成功但不能直连”“STUN 不可达”“网络阻止 UDP”“对方离线”“接收拒绝”“直连中断”；不能把 Hard NAT 精准归因为唯一原因，除非有充分证据。
- 借鉴 Tailscale 路径切换的**理念**，而不是引入 DERP：网络切换时重新 ICE 探测，新的有效非 relay 路径经验证后才恢复传输；未知或 relay 路径立即 fail closed。
- **验收**：切 Wi-Fi/蜂窝、断网 30 秒、页面后台/恢复、ICE 失败等场景状态收敛；无无限重试、假成功或无授权重连。

### Z-NAT-03｜文件恢复与资源上限（P1/P2）

- 在原有 `transferId` / ACK / SHA-256 协议基础上单独设计跨连接恢复：接收端持久化已确认偏移、文件标识和增量哈希可安全校验的状态；发送方重新选择原文件后核对身份、长度、已确认数据和会话，再恢复。
- 恢复不得绕过重新确认身份码或接收权限；原始授权过期与恢复令牌失效时重配对；无法安全恢复时明确从头发送。
- Android / iOS Safari 等不具备等价持久化接口的平台先呈现能力门槛，不承诺通用断点续传。
- 继续保持发送 `bufferedAmount` 背压、接收持久化 ACK 与上限，失败后不能以“已完成”显示。
- **验收**：至少 100 MiB 与 1 GiB 在支持平台上模拟断线并真正恢复，比对完整 SHA-256、资源峰值和服务器非文件数据量；Safari 单独标记资格。

### Z-NAT-04｜原生增强的可行性预研（P3，非 Web MVP）

- 只有在未来明确开发 Android/Windows/macOS/iOS 原生版本时，才评估受权限限制的 UDP 端口映射、PCP/NAT-PMP/UPnP、NAT64/IPv6 网络探测及更丰富的路径诊断。
- 不自动开启 UPnP、修改用户路由器、申请 VPN/TUN 权限或改变设备系统路由；每项均需用户明确授权、威胁建模与独立评审。
- 目标仍是两端直接加密传输，不以新增中继掩盖网络限制。

## 4. 必须通过的回归与指标

| 断言 | 通过标准 |
| --- | --- |
| 路径真实性 | 仅在实际 selected non-relay pair 上开始用户文件发送；relay/未知 pair 不发送 |
| 文件零中继 | 无 TURN、DERP、WS 文件代理、上传和服务器文件存储；WS 拒绝二进制/非白名单信令 |
| 可靠性 | 失去直连、ICE 重启失败、网络切换均有确定的错误/可重试状态 |
| 身份与准入 | 高熵邀请、配对锁定、人工安全码比较、接收确认不倒退 |
| 完整性 | 0 B/100 MiB/1 GiB 等按平台能力执行并核对双方 SHA-256 |
| 带宽审计 | 隔离传输阶段，记录 WSS/HTTP/STUN 与文件大小关联；不能宣称服务器所有流量为 0 |
| 隐私 | 用户主动导出最小诊断，日志/报告无 IP、SDP、令牌、文件信息 |
| 真实性 | CI 同机/假 STUN/浏览器自动化，与公网异网/真机/生产环境分别标注 |

建议用实测建立三个基线指标：`direct_success_rate`（按网络组别、样本量披露）、`time_to_direct_p50/p95`（仅成功样本）与 `failure_reason_distribution`。未有真实样本时不填写目标百分比，也不把 Tailscale 的成功率套用到本项目。

## 5. 执行顺序与工程纪律

1. 当前 PR #2 保持 Draft，不变更其历史测试结论；本文件只是独立研究建议，不在本 PR 修改运行时代码。
2. 首先完成 Z-NAT-01 实机测试，分类瓶颈；只有真实证据要求时才改 ICE 策略，避免没有数据的优化。
3. 下一步实现 Z-NAT-02 与 Z-NAT-03，每一项独立提交、测试与 PR；原生 Z-NAT-04 仅在确定客户端路线后启动。
4. 同步更新 PROJECT_STATUS、TEST_MATRIX、真实设备报告和风险；所有 PR 要给出 exact-head 与所跑测试，发布、部署及仓库正式更名独立处理。
5. 不创建定时任务，不擅自启用代理或修改生产网络。

## 6. 参考资料

- [Tailscale Connection Types](https://tailscale.com/docs/reference/connection-types)：直连、DERP 和 Peer Relay 三种路径，不能把中继当作直连。
- [Tailscale How NAT traversal works](https://tailscale.com/blog/how-nat-traversal-works)：端点探测、UDP hole punching 与网络限制。
- [Tailscale Device connectivity](https://tailscale.com/docs/reference/device-connectivity)：连通性依赖网络条件，中继可解决但与本项目目标冲突。
- [WebRTC ICE RFC 8445](https://www.rfc-editor.org/rfc/rfc8445)：浏览器 WebRTC 的标准路径协商基础。
