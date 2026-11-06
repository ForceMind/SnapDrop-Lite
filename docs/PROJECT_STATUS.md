# Zeydrop 工程接管状态

更新时间：2026-10-24。版本 `0.3.0-dev.1`，开发分支 `feat/direct-first-workspace-20261019`，PR #2 保持 Draft。下面区分本轮实际验证、历史 CI 和尚未完成的发布验收；不是稳定发行声明。

## 2026-11-06：临时 HTTPS/WSS 反向代理实际集成测试（待当前 CI）

新增 `tests/https-proxy.cjs`：在 GitHub Ubuntu 测试主机临时生成自签名 TLS 证书，实际启动基于生产 `deployment/nginx.conf` 模板的 Nginx 和独立信令服务，确认 HTTPS 首页与安全头、HTTP 重定向、拒绝文件上传、WebSocket Origin 白名单和双端 WSS 配对。所有端口仅在测试机 127.0.0.1 监听；测试结束杀掉临时进程并删除证书，不触及正式服务器。此测试**只验证代理/信令链路，不能证明真实公网 NAT 穿透或生产证书续期**。提交后以当前 CI 为准。

## 2026-11-05：离线双端公网测试证据校验工具（候选，待 CI）

新增 `scripts/field-verify.cjs` 及 `tests/field-verify.test.cjs`。本地读取两个 Zeydrop 脱敏诊断 JSON，检查版本一致性、**最后一次**连接记录确实为 selected 非 relay 且用户已确认安全码（旧的历史成功不能掩盖后续断线），可选择流式读取双方的文件并使用 SHA-256 比对。输出报告白名单仅包含协议、候选类型、地址族、RTT、长度和一致性等必要字段，不导出本地系统路径、文件名、IP、文件哈希或原始诊断。工具不会联网或上传任何内容；文件不一致显式标记 `integrity-mismatch`，不能误判为只缺少证据。

此工具**不能证明**测试场景描述属实、独立公网 NAT 穿透或服务器不存在文件代理，只是帮助用户在将来部署并取得双端真实数据后进行本地一致性核验。新提交 CI 必须通过后才是已验证开发能力。仍未执行不同运营商的真实网络实测。

## 2026-11-05：信令会话创建频率及空邀请回收（待新 CI）

旧服务端把 `create-room` 的 5 秒创建间隔记录在瞬时 WebSocket peer 上；使用相同恢复令牌快速重连可重置额度。本次把时间戳绑定到服务端签发的 session，在同一合法身份重连后继续限制；不引入用户账户、IP 持久化或第三方服务。未配对邀请在最后一名成员主动离开时立即清理，防止占满全局最多 1000 个房间。已完成配对的房间仍保留此前固定期限、成员锁定和短时恢复规则。

新增 `tests/signaling.test.cjs` 的两项真实 WS 集成测试：重连后仍不可立即创建第二邀请、5 秒后可以创建；创建者离开后旧邀请不存在且无法通过 join 重建。此阶段只有开发分支，必须以新 CI 为准；未进行跨运营商 NAT 或生产环境验收。保持 Direct-only、PR Draft、main 不变。

## 2026-11-05：Chromium ↔ Firefox 异构浏览器互传（CI #31 通过）

新增 `tests/interoperability.cjs`，在同一 CI 主机启动 Chromium、Firefox 两个不同浏览器引擎，用真实 WebRTC DataChannel 和 STUN 关闭的 host 路径，完成双向文件传输。每个方向必须核对相同 DTLS 安全码、在接收同意前不得有文件正文、真实下载后用 Node SHA-256 独立校验、检查 WebSocket 仅含信令（不得有文件名、正文或哈希）。与“两个 Chromium”或“两个 Firefox”的已通过测试不同，本项验证浏览器引擎互操作性。

**CI #31 已通过**：代码提交 `16d6f21b203b323070fc8e35ce2b6e62350fd6b0`，run `41992078868`。Chromium → Firefox 和 Firefox → Chromium 均传输 1,048,785 B，分别独立核验 SHA-256，信令 WS 无文件名、正文或哈希；60/60 Node、Chromium 1 GiB、Firefox 100 MiB、WebKit UI、真实 OPFS 和 4 MiB 跨刷新流程全部通过。原始验收范围见 [`docs/evidence/ci31-browser-interoperability.json`](evidence/ci31-browser-interoperability.json)。本测试仍然不能证明不同设备/运营商之间的 NAT 穿透、真实 Safari/iOS 或生产部署，不合并 `main`、不部署、不加文件中继。

## 2026-11-05：DataChannel 旧消息隔离（CI #28 全部通过）

针对 ICE restart 和异步写盘的竞态，RTCPeer 在每次接收 WebRTC DataChannel 帧时将消息绑定到具体通道，拒绝已关闭、失败、断开的旧通道回调；TransferPeer 接收消息链在异步队列真正出队时再次判断通道仍有效，防止旧通道的 ACK/cancel/hello/text 影响已重新绑定的新传输。仍保留接收队列上限并在丢弃时释放计数，不变更传输协议、配对、身份核验、文件直连或存储行为。

新增 `tests/late-channel.test.cjs`，覆盖重绑定旧事件、同通道 ICE 路径代次变化、异步队列后到消息隔离、当前通道正常处理和接收队列归零。**CI #28 在 `202de19e4f6563d6a1aefc0a9c4c069dfe30e190` 全部通过**：60/60 Node 单测，Chromium 1 GiB、Firefox 100 MiB、WebKit UI，以及 Chromium 真实 OPFS 存储与 4 MiB 跨刷新文件恢复。证据见 `docs/evidence/ci28-late-channel.json`。它仍只是同主机测试，**不能代表真实跨网络 NAT 和移动后台冻结验证**。Draft PR 不合并 main、不部署，仓库由用户最后手动更名。

## 2026-11-04：OPFS 损坏数据、双标签锁与异常类型加固（CI #25 已通过）
- 断点清单不再静默忽略已损坏的 JSON，用户可以查看并删除；完整文件的完成哈希和前缀状态更严格核对。
- 对失去索引的 `.part` 使用 24 小时年龄门槛，清理过期孤立数据时避开正在使用或近期修改的文件；不在所有标签关闭时承诺后台清理。取消清单 20 条硬截断，避免超限数据永远不可见；新增断点创建仍严格限制 20 条。
- 多标签页同时打开一个 OPFS 断点时保留原始独占锁，并显示清楚的冲突错误，不允许第二页面悄然覆盖。
- Worker 到窗口的消息保留 QuotaExceededError / NotAllowedError 类型，便于存储空间不足、权限失败的准确提示。
- 新 Chromium 真实 OPFS 测试已通过：第二标签页尝试占用同一断点被拒绝、释放后恢复成功；21 条损坏元数据可以全部列出并手动删除，创建新断点受 20 条上限约束；Worker 配额/权限错误类型正确透传。**CI #25（`4c1dc884349b6b9c4558dd2ffc66a075f6858153`，run `41978538734`）全部成功**，含 57/57 Node、构建审计/Nginx、Chromium 1GiB、Firefox 100MiB、WebKit UI smoke 和真实跨刷新 4MiB→1MiB 已存/3MiB 补传流程。以上仍在同一 CI 主机，STUN 关闭，不是公网 NAT/移动真机验收。详见 [证据](evidence/ci25-opfs-hardening.json)。继续保持 PR #2 Draft、不部署、不合并 main、不改变 Direct-only 原则。

## 2026-10-24：跨刷新本机断点恢复候选（等待新 CI）

新增 `client/scripts/recovery-worker.js` 与桥接 `client/scripts/recovery.js`：只有接收方主动选择“在本机保存断点”时，才写入当前浏览器 Origin Private File System (OPFS)。专用 Worker 的同步访问句柄分块写入/flush，每达到约 1 MiB 或传输结束持久化一次；先落盘再更新元信息，页面异常中断后以已提交 offset 截断未提交尾部。记录最长 24 小时，最多保留 20 项，可从页面主动查看与删除。未启用选项时沿用原生保存器/64 MiB 内存回退，不改变默认文件通路。

收到新文件邀请后，接收方必须再次明确勾选匹配的本机断点；仅同文件名、大小和 MIME 类型可尝试，重新验证本地前缀 SHA-256，再通过新 DataChannel 的 `resume-at → resume-confirm` 与发送端重新选择的本地 File 逐字节比对前缀。成功后只传剩余部分，完成后仍需全文件 SHA-256。完全不通过信令服务器传文件名、哈希或正文，也不使用 TURN/DERP。中断的本机副本仍可能因浏览器配额/数据清理丢失；跨设备、Safari/iOS、真实公网 NAT、双标签锁、持久化 UI 端到端实测仍待验证。跨刷新需要新邀请，并不恢复已丢失的服务器身份。

新增独立双浏览器上下文 WebRTC 跨刷新测试 `tests/persistent-flow-browser.cjs`，在真实 1 MiB 持久化检查点中断后让接收方刷新、新邀请重新核对安全码、重新选择原文件并验证文件 SHA-256；CI 是否通过以当前 PR 记录为准。

新增 Playwright Chromium **真实 OPFS Worker** 测试 `tests/recovery-browser.cjs`：创建/写入/刷新/回滚未提交尾部/再次写入/完整性校验/清理。新提交需要以实际 CI 状态判断成败；不得沿用 CI #16/#18 的旧绿灯。PR #2 保持 Draft，不合并、正式部署或强推。

## 2026-10-24：Firefox DataChannel error/close 竞态修复（待新提交 CI 验证）

CI #16 已通过 Chromium/Firefox 续传，归档文档提交的 CI #17 则在 Firefox 8 MiB 恢复时出现一次 180 秒超时；接收端报告“续传协商超时”，发送端报告“文件通道发生错误”。这是实际测试失败，不应将 CI #17 标记为通过。原因定位为旧 RTCDataChannel 的 `error` 在 Firefox 可先于 `close` 到达，而该事件此前直接调用终止性 `_fail`，提前删除同页续传断点。现已把 transient `error/close` 统一为有界重连入口；协议违规仍调用不可恢复的 `_protocolError`。新增同次 error+close 去重、接收端等待截止及协议致命性回归测试。本段变更仍以之后新 PR head 的 CI 为准，真实公网和 Safari 实机继续未测。

## 2026-10-24：同页短时 P2P 文件续传首版

在 `6e88e5312b29e3645d6d20a356ac2f70ad8c68fa` 已合并入开发分支的代码中，增加 `resume-offer → resume-at → resume-confirm` DataChannel 协商：原设备在同一页面内短时重连，双方重新核对安全码、重新核验 selected 非 relay 路径后，以已写入偏移和 SHA-256 前缀进行确认，发送端只传余下字节。原 File 和接收 sink 仅保留在本页内存中、最长 120 秒；刷新/关闭浏览器、身份变化、跨会话及服务端重启后不支持恢复。多文件队列的待发文件暂不保留。不会经 WSS/服务器转发文件名、哈希、偏移或文件内容。

这一阶段增加 `tests/resume.test.cjs` 的真实代码级状态机测试：写入过程中断线、原 peer 对象替换、成功恢复并全文件校验、篡改前缀拒绝、伪造续传请求不能绕过接收授权；修复旧 ACK 等待 Promise 结束时误取消恢复对象的竞态。CI #15（提交 `6e88e53`）通过 47 项 Node 测试、构建/依赖/Nginx 检查及原有 Chromium、Firefox、WebKit 矩阵。**CI #16（开发提交 `51685d9`）已完整通过**：47 项 Node 单测、构建/审计/Nginx/Chromium/Firefox/WebKit。新增 Chromium 与 Firefox 双浏览器上下文实际 DataChannel + OPFS：写入 131,072 B 时中断 WSS，同一会话重新配对并核对安全码后续传 8,388,608 B；Chromium 发送 8,486,912 B、Firefox 8,437,760 B，最终 SHA-256 均正确。这是同机 STUN 关闭条件，不代表公网 NAT 成功。证据见 `docs/evidence/ci16-resume.json` 和 GitHub Actions run 40090569875。

仍需真实双网络/移动设备与 Safari 测试、跨页面重新打开后的持久化恢复、真正用户文件 picker 授权、服务端重启及生产部署。当前 PR 保持 Draft，不合并稳定版、不部署。

## 2026-10-23：断线恢复与路径授权加固

基于 `e10f3fbdb7ce665e3aae206707b35ba6b23ab61e` 修改 `client/scripts/network.js`，新增 `tests/recovery.test.cjs`。没有改动服务端文件通路、引入中继或部署站点。

本轮修复：

- ICE 失败、重新检查或断开时，发起端和接收端都立即撤销旧路径及人工确认状态并中止当前文件；DTLS 失败不能被仍然 connected 的 ICE 状态掩盖。
- `getStats()` 结果绑定连接、路径代次和请求序号；迟到结果不能覆盖断线、失败、关闭、新协商或更新的路径检查。无法读取/核验路径时撤销授权，使用固定截止时间，不无限停在 connecting。
- 新 SDP 协商期间不复用旧 selected pair；重新协商后的接收端恢复采样，但必须重新核对安全码。迟到的指纹摘要或已关闭连接的 offer 不得回写当前状态/发出信令。
- 每次自动 ICE restart 从发起到新路径核验成功或 20 秒截止前只占一个尝试，重复浏览器状态事件不能瞬间耗尽预算；仍最多两次。接收端等待对端恢复有固定 30 秒上限，重复事件不延长。

实际执行（云端开发容器，Node `v22.16.0`）：

```bash
node --check client/scripts/network.js
node --check tests/recovery.test.cjs
node --test tests/path.test.cjs tests/discovery.test.cjs tests/recovery.test.cjs
```

20 项新增恢复测试在原始代码上 **5 通过 / 15 失败**；修改后连同原有路径/发现测试 **25/25 通过**，整组重复 **10 轮全部通过**。执行的是实际 network.js 方法，RTCPeerConnection、计时器及文件取消调用使用 fixture；这不是浏览器实传或真实断网实验。输入文件 blob SHA、测试名称和范围见 [本轮证据](evidence/recovery-20261023.json)。原有 path/discovery 测试内容与基线 blob SHA 一致。

本轮容器无法解析 GitHub 域名，不能通过 git clone/npm 联网补齐完整依赖；源码经已连接 GitHub 读取并校验 blob SHA。尚未在此容器执行完整 npm test、构建、Chromium/Firefox/WebKit E2E。**当前提交完整 CI 以 PR checks 为准，不能复用旧提交的绿灯。**

这里描述的是 **10 月 23 日时点** 的状态；10 月 24 日已增加同页短时续传首版，但不支持刷新/关闭页面后恢复，详见本文开头。

## 历史已验证基线（不等于本轮代码全部通过）

实现提交 `7e83ba4e6306d18c4a5b557e4c548c68368b7f9b` 的 [CI #10](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/39274470166) 与文档 head `e10f3fb` 的 [CI #11](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/39275517805) 记录了：24 项 Node 测试；锁文件安装、生产依赖审计、shell、两次构建一致/资源引用、实际 Nginx 模板解析；Chromium 1 GiB、Firefox 100 MiB 实际 DataChannel/OPFS/SHA-256；WebKit 手机 UI smoke。详细方法、失败历史及原始证据仍见 TEST_REPORT_20261019、TEST_MATRIX 与 `evidence/ci10-*.json`。

Chromium 1 GiB 历史用时 99.919 秒（含独立磁盘读取/哈希），接收待处理消息峰值 262,228 B（不是浏览器总内存）。历史传输阶段 WS 45 条/675 B，未发现文件名、正文、文件哈希或二进制帧；不含配对、静态页面或后续重连。不能把这些指标当成本轮重新测得的数据。

## 已有核心能力

私有双人邀请、服务器签发身份/恢复令牌、固定会话期限与锁定成员；DTLS 指纹安全码与接收方同意；实际 selected 非 relay 路径核验；16 KiB 分块、256 KiB 写入 ACK 窗口、背压/有界队列、增量 SHA-256；多文件排队与当前连接暂停/取消；原生文件 sink 或全局 64 MiB Blob 回退池；响应式工作台、明暗模式、二维码、PWA 和白名单本机诊断导出；HTTPS/WSS/systemd/Nginx/迁移及回滚候选脚本。

服务器只分发静态页面、配对和受限 SDP/ICE 信令，没有 TURN、服务器上传/存储或 WebSocket 文件代理。诊断不含 IP、身份/邀请/恢复令牌、安全码或文件信息，不自动上传。“无服务器文件正文中转”不等于“服务器总流量为零”。

## 尚未完成的发布验收

| 阶段 | 仍待完成 |
|---|---|
| M0 | 仓库最终更名由用户手动完成；更深的最初导入历史溯源 |
| M1 | 真实跨公网 STUN/NAT、跨运营商连接证据；显式同意的 LAN 发现 |
| M2 | 真实 IPv6/双栈/严格 NAT、Wi-Fi/蜂窝切换、后台冻结；本轮恢复改动的浏览器与实机回归 |
| M3 | 同页短时续传 + Chromium/Firefox 真实 DataChannel/OPFS 回归 CI #16 通过；仍待跨公网实机、页面重载持久化恢复、真实 picker/磁盘/移动端权限与大文件能力 |
| M4 | 屏幕阅读器、平台安装/升级、触屏实机 |
| M5 | CI #16 全部自动化已通过；TEST_MATRIX 真实设备/跨网络发布门槛仍未完成 |
| M6 | 正式主机及已确认域名/TLS；安装、证书续期、重启、迁移和回滚演练 |

CI 同机且关闭 STUN 不证明公网 NAT 成功率。历史 OPFS 是原生 writer，但 picker 选择由测试替代；WebKit UI 不等于 iOS Safari 文件实传。Firefox 历史未跑 1 GiB。页面刷新会新建身份，不能把从零重发宣传成续传；无流式能力接收中/待保存 Blob 合计最多 64 MiB。邀请未配对 15 分钟，配对后最长 12 小时，离线席位保留 2 分钟，恢复不延长固定会话期限。

## 下一步与工作边界

CI #16 已核验新增同机浏览器续传 E2E；下一步按 REAL_DEVICE_TESTING / TEST_MATRIX 采集真实跨网络 selected pair 或无 pair 的成功/失败证据。持久化续传仍需独立设计文件句柄重获授权、接收端可靠落盘 checkpoint/原子恢复、接收同意与失效清理；不得跳过接收授权、凭旧身份替换对端或改走服务器文件中继。LAN 发现必须显式同意。

当前环境没有第二个真实网络设备、Safari/iOS 硬件、用户生产主机或已确认域名/证书。本轮没有正式部署、Release 或稳定版合并，也没有操作用户电脑、购买域名或创建定时任务。

仓库 ID `1255852392`，仍为 `ForceMind/SnapDrop-Lite`，不创建替代仓库、不强推、不改名；用户最后自行原地更名。main 运行代码仍为原版，实现都在 Draft PR #2。`zeydrop.com` 未确认购买。接手先读 AGENTS、README、本文件、ARCHITECTURE 和实际 PR head；不要把 M0–M6 全部标记完成，不承诺会话结束后后台工作。
