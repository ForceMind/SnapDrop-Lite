# Zeydrop · 闪投

**Direct by design.**

[English](README.en.md)

无需账号的浏览器设备直连文件传输。服务器分发页面、创建短期邀请并交换 WebRTC SDP / ICE 信令。文件正文只通过设备间的 RTCDataChannel 发送；不提供 TURN、WebSocket 文件中转、上传接口或云存储。

当前为 **0.3.0-dev.1 未发布开发候选**，位于[Draft PR #2](https://github.com/ForceMind/SnapDrop-Lite/pull/2)。运行代码3cdbeae / revisionc75833843f0b324f完成[CI68全套通过](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42409023529)：**410/410项Node**、两侧audit、三引擎原生Worker/清单、Chromium1GiB/Firefox100MiB、严格六组合双向SHA、OPFS/恢复、临时HTTPS/WSS、PWA离线/升级回滚及UI检查。[本轮报告](docs/TEST_REPORT_20261107_LIFECYCLE.md)与[精确源码候选/校验](docs/PROJECT_STATUS.md)。

本轮修复旧ICE异步回调干扰新协商、过期/重叠删除与活动提交之间的断点丢失、首次部署current自环；完整匹配的遗留发布目录可经只读核验后重试，已是当前版本或残缺/不安全目录则保留并拒绝。升级须结束传输并关闭全部旧标签，旧Worker不自动获得新锁。419文件候选已独立重装410项、无Git重建，29项构建字节一致。

真实Service Worker安装失败会保留旧版，新版等待所有旧客户端退出后才激活；A→B→A的三个阶段均核验缓存字节、三个Worker离线启动和本机检查点保留，历史文件没有自动绑定。整Chromium进程强杀及重新手动授权后的完整SHA也通过。它们是同机受控浏览器证据，不保证真实断电、磁盘故障、移动/已安装PWA或正式RC。实时/恢复前缀SHA仍在有界本机Worker完成，错误不静默回退。

此前Linux WebKit阻断已通过原生前后对照定位到系统mDNS环境：补齐并预检Avahi/NSS后保持默认浏览器策略与全部安全门槛，六组合通过；该准备仅用于临时CI。真实Safari仍见[Issue #5](https://github.com/ForceMind/SnapDrop-Lite/issues/5)，真实网络/主机见[Issue #4](https://github.com/ForceMind/SnapDrop-Lite/issues/4)。同机、STUN关闭的CI不证明真实NAT成功率、移动/Safari硬件或正式部署。main/生产未改，仓库最后更名由用户手动完成，zeydrop.com未确认购买。

## 使用流程

创建邀请 → 另一台设备打开链接 / 扫描二维码 → 等待实际直连路径核验 → 双方核对相同的安全码并各自允许传输 → 选择文件 → 接收方同意 → 传输、校验、保存。

- 邀请包含 128-bit 随机凭证，未配对有效期 15 分钟，最多两台设备；配对后立即锁定成员，不允许替换设备，并使用独立的固定最长 12 小时会话期限，重连不延长。链接只应交给信任的人。凭证放在 URL fragment 中，避免进入常规 HTTP 请求及访问日志。
- 服务端生成设备 ID 和 256-bit 恢复令牌；短时 WebSocket 重连保留配对身份，离线房间席位保留 2 分钟。刷新标签页会生成新会话；已锁定配对不能替换身份，需要重新创建邀请。
- 安全码与双方 DTLS SHA-256 指纹绑定，需通过可信渠道人工比较。设备名称仅供显示，不是身份认证。
- `getStats()` 选中 candidate pair 为已知非 relay 路径后才能发送。仅信令在线、候选收集或 nominated 状态不算直连成功。
- 工作台可导出本机连接诊断 JSON：仅包含最多 120 条状态/候选类型/RTT 记录及构建版本，不含 IP、设备 ID、安全码、邀请、令牌或文件信息；不会自动上传。
- STUN 只是地址发现，不能保证突破严格 NAT / CGNAT / 防火墙。失败时明确提示，不切换到服务器文件代理。
- 同一 Wi-Fi 也可通过邀请连接。目前暂停未鉴权的子网自动发现；显式同意的局域网发现仍在待办中。

## 文件能力与限制

- 16 KiB 分块，256 KiB 接收写入确认窗口；DataChannel 背压和接收消息队列均有上限。
- 增量 SHA-256，完整长度和哈希均匹配后才报告完成。实时传输与恢复前缀在本机专用Worker中计算；每页最多4个状态，每状态最多4个待完成操作、分块复制不超过256KiB，单操作默认30秒超时。仅没有Worker能力时分块回退主线程，Worker故障明确停止，不静默重算。
- 支持多文件发送队列、当前连接内暂停 / 继续和取消。单个文件失败或拒绝会暂停并保留后续队列，可选择重新发送或继续后续文件；重发使用新的文件请求并重新征求接收同意，同页失败引用最多30项/15分钟，断线释放。**同一页面中短时断线可尝试续传已同意接收的文件**：原设备在 120 秒内重新配对，双方重新核对安全码，先校验接收端实际已写入偏移与 SHA-256 前缀，成功后只发剩余字节；不一致则取消。
- **跨刷新本机断点恢复是实验功能，仅接收端主动勾选后使用**：原始文件分块在当前浏览器 OPFS 保存，每约 1 MiB 提交持久化检查点；刷新/重新开页后需建立新邀请、重新核对安全码，发送端重新选择原文件并对比已存前缀 SHA-256，不匹配必须取消。默认保存模式不会产生持久化断点；浏览器清站点数据、磁盘配额不足、崩溃或存储驱逐仍可能导致丢失，绝不保证恢复成功。服务器重启后需要新配对，不恢复旧信令身份。待发文件队列可在同页短时重连（最多 120 秒）后恢复；新增自愿保存的**跨刷新发送清单**仅保留本机元数据和完整哈希，刷新后须重选全部原件、重新配对及核对安全码，并手动发送；未接受的文件仍须接收方重新明确同意。详见 [本地恢复说明](docs/RECOVERY_STORAGE.md)。
- 支持 `showSaveFilePicker` 的浏览器直接写入接收方选择的文件；必须由接收按钮触发授权。兼容性和用户操作仍需实机验证。
- 无流式文件保存能力时，接收中与待保存文件合计最多 **64 MiB**；超限在传输前拒绝。Safari / iOS 不宣称支持 1 GiB 文件。
- 拒绝、超时或校验失败不交付完成文件；接收方主动取消时尽力 abort 未完成写入。会话结束不沿用旧身份，但保留已启用的本机检查点供重新授权恢复。若文件块已写入而哈希失败，仅释放句柄并保留上一个已提交offset/SHA，不发布未验证尾部；下次显式恢复时截断尾部。已完成的本机文件也需重新通过大小及SHA校验才提供保存；面板校验可取消，未点击下载链接在列表切换时释放；已点击的链接保留有界下载启动时间，删除或离开页面时释放。取消后的底层删除失败会明确提示检查本机暂存，不虚报已删除。

“服务器文件正文流量为零”不等于“服务器总流量为零”：页面资源、WebSocket 心跳 / 信令和 STUN 探测都会产生少量流量；第三方 STUN 可看到探测来源地址。

## 本地开发

需要 Node.js 22+：

```bash
npm ci --ignore-scripts
npm --prefix server ci --ignore-scripts
npm test
npm run build
npm run dev
```

打开 `http://localhost:8080`。其他设备 / 公网环境必须使用 HTTPS / WSS。浏览器只运行本地打包代码，无运行时 CDN、二维码上传服务或分析埋点。

```bash
node scripts/check-build.mjs
npx playwright install --with-deps chromium firefox webkit
LARGE_FILE_TEST=1 npm run test:browser
BROWSER_TYPE=firefox npm run test:browser
BROWSER_TYPE=webkit npm run test:smoke
node tests/interoperability.cjs
node tests/recovery-browser.cjs
node tests/recovery-start-race-browser.cjs
node tests/recovery-retirement-browser.cjs
node tests/pwa-upgrade-browser.cjs
node tests/browser-crash-recovery.cjs
node tests/persistent-flow-browser.cjs
node tests/stream-hash-browser.cjs
BROWSER_TYPE=firefox node tests/stream-hash-browser.cjs
BROWSER_TYPE=webkit node tests/stream-hash-browser.cjs
node tests/stream-hash-recovery-browser.cjs
BROWSER_PAIRS=chromium-chromium,firefox-firefox,chromium-firefox,chromium-webkit,firefox-webkit,webkit-webkit node tests/webkit-transfer.cjs
node tests/webrtc-primitives.cjs
```

`dist/` 由确定性构建生成，不再提交旧构建。固定路径的 Service Worker 预缓存完整同版本 shell；新版本等待旧标签关闭后激活，避免传输中强制刷新。配置、信令和邀请 URL 不进入动态缓存。

## 部署与安全

正式部署使用自有域名和已有 TLS 证书，见 [部署与回滚](docs/DEPLOYMENT.md)。信令仅监听回环地址；Origin 使用精确白名单；二进制和非信令转发被拒绝；限制消息大小、速率、连接和房间总数。

```bash
sudo DOMAIN=transfer.example.com \
  TLS_CERT=/etc/letsencrypt/live/transfer.example.com/fullchain.pem \
  TLS_KEY=/etc/letsencrypt/live/transfer.example.com/privkey.pem \
  bash deploy.sh
```

示例域名不是已配置站点。部署脚本不会购买域名、申请证书、改变防火墙或自动停止旧 Snapdrop 服务。现有安装迁移需先按部署文档准备并验证。

服务端短压力基线可运行 `npm run test:load -- --connections 64 --signals 20 --duration-ms 1000 --cycles 2 --out test-results/server-load.json`。指标仅为隔离回环信令服务的RSS/CPU/控制消息/清理，不是文件速度或公网容量；见[性能口径与原始结果](docs/SERVER_PERFORMANCE.md)。

## 开发候选包

干净已提交源码安装依赖和构建后运行 `node scripts/package-candidate.mjs`；输出归档、SHA-256和逐文件manifest。CI在浏览器安装前上传 `zeydrop-unreleased-source-candidate`，即使后续浏览器环境不可用也可下载用于隔离测试；它仅证明源码/构建检查，必须另查整套CI结果，不是稳定版、签名或浏览器验收。打包拒绝脏源码、敏感路径、符号链接和不一致dist，并执行有限秘密模式扫描；不能保证识别全部秘密。请按 [部署与回滚](docs/DEPLOYMENT.md) 在独立测试主机使用。

## 工程导航

- [当前状态与下一步](docs/PROJECT_STATUS.md)
- [历史公网 P2P 方案](docs/PUBLIC_P2P_DEVELOPMENT_PLAN.md)（原方案保留，执行状态以当前状态为准）
- [UI 设计](docs/UI_DESIGN_V1.md)
- [协议、安全和架构](docs/ARCHITECTURE.md)
- [测试矩阵](docs/TEST_MATRIX.md) / [实机方法与离线证据工具](docs/REAL_DEVICE_TESTING.md)
- [实验性本机断点存储与隐私](docs/RECOVERY_STORAGE.md)
- [正式发布门槛与外部验收](docs/RELEASE_GATES.md)
- [STUN 配置与官方来源](docs/STUN_CONFIGURATION.md)
- [许可证来源](docs/LICENSE_PROVENANCE.md)

## 许可证

本项目基于 Snapdrop 保留代码演进，组合应用使用 [GPL-3.0](LICENSE)。来源、修改与依赖声明见 [NOTICE](NOTICE)。原仓库的 Apache 文本被保留作历史来源记录；旧 README 的 ISC 声明已修正。
