# Zeydrop 工程接管状态

更新时间：2026-10-23。版本 `0.3.0-dev.1`，开发分支 `feat/direct-first-workspace-20261019`，PR #2 保持 Draft。下面区分本轮实际验证、历史 CI 和尚未完成的发布验收；不是稳定发行声明。

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

这次完成的是恢复状态机与安全边界修复，**不是跨连接文件断点续传**。当前断线仍取消文件，重连后重新确认安全码、选择文件并从零发送。

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
| M3 | 跨连接断点续传、持久化恢复、真实 picker/磁盘/移动端权限与大文件能力 |
| M4 | 屏幕阅读器、平台安装/升级、触屏实机 |
| M5 | TEST_MATRIX 的真实设备/跨网络全部发布门槛；本轮完整 CI |
| M6 | 正式主机及已确认域名/TLS；安装、证书续期、重启、迁移和回滚演练 |

CI 同机且关闭 STUN 不证明公网 NAT 成功率。历史 OPFS 是原生 writer，但 picker 选择由测试替代；WebKit UI 不等于 iOS Safari 文件实传。Firefox 历史未跑 1 GiB。页面刷新会新建身份，不能把从零重发宣传成续传；无流式能力接收中/待保存 Blob 合计最多 64 MiB。邀请未配对 15 分钟，配对后最长 12 小时，离线席位保留 2 分钟，恢复不延长固定会话期限。

## 下一步与工作边界

先核验本轮 PR head 的完整自动化，再按 REAL_DEVICE_TESTING / TEST_MATRIX 采集真实两端、selected pair 或无 pair 的成功/失败证据。后续开发跨连接续传时，应单独设计绑定原对端身份的恢复凭证、接收端持久化 checkpoint、源文件校验、过期清理和用户恢复同意；不能跳过接收授权或改走服务器文件中继。LAN 发现必须显式同意。

当前环境没有第二个真实网络设备、Safari/iOS 硬件、用户生产主机或已确认域名/证书。本轮没有正式部署、Release 或稳定版合并，也没有操作用户电脑、购买域名或创建定时任务。

仓库 ID `1255852392`，仍为 `ForceMind/SnapDrop-Lite`，不创建替代仓库、不强推、不改名；用户最后自行原地更名。main 运行代码仍为原版，实现都在 Draft PR #2。`zeydrop.com` 未确认购买。接手先读 AGENTS、README、本文件、ARCHITECTURE 和实际 PR head；不要把 M0–M6 全部标记完成，不承诺会话结束后后台工作。
