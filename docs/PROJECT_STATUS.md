# Zeydrop 工程接管状态

更新时间：2026-10-24。版本 `0.3.0-dev.1`，开发分支 `feat/direct-first-workspace-20261019`，PR #2 保持 Draft。下面区分本轮实际验证、历史 CI 和尚未完成的发布验收；不是稳定发行声明。

## 2026-10-24：跨刷新本机断点恢复候选（等待新 CI）

新增 `client/scripts/recovery-worker.js` 与桥接 `client/scripts/recovery.js`：只有接收方主动选择“在本机保存断点”时，才写入当前浏览器 Origin Private File System (OPFS)。专用 Worker 的同步访问句柄分块写入/flush，每达到约 1 MiB 或传输结束持久化一次；先落盘再更新元信息，页面异常中断后以已提交 offset 截断未提交尾部。记录最长 24 小时，最多保留 20 项，可从页面主动查看与删除。未启用选项时沿用原生保存器/64 MiB 内存回退，不改变默认文件通路。

收到新文件邀请后，接收方必须再次明确勾选匹配的本机断点；仅同文件名、大小和 MIME 类型可尝试，重新验证本地前缀 SHA-256，再通过新 DataChannel 的 `resume-at → resume-confirm` 与发送端重新选择的本地 File 逐字节比对前缀。成功后只传剩余部分，完成后仍需全文件 SHA-256。完全不通过信令服务器传文件名、哈希或正文，也不使用 TURN/DERP。中断的本机副本仍可能因浏览器配额/数据清理丢失；跨设备、Safari/iOS、真实公网 NAT、双标签锁、持久化 UI 端到端实测仍待验证。跨刷新需要新邀请，并不恢复已丢失的服务器身份。

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
