# Zeydrop · 闪投

**Direct by design.**

无需账号的浏览器设备直连文件传输。服务器分发页面、创建短期邀请并交换 WebRTC SDP / ICE 信令。文件正文只通过设备间的 RTCDataChannel 发送；不提供 TURN、WebSocket 文件中转、上传接口或云存储。

当前为 **0.3.0-dev.1 开发版**，不是稳定发行版。CI #16 已通过 47 项 Node 测试、Chromium 1 GiB / Firefox 100 MiB 实际 DataChannel 与独立磁盘 SHA-256、两种浏览器的 8 MiB 同页断线续传回归，以及 WebKit UI 检查；这些均为同一 CI 主机测试，详见 [测试报告](docs/TEST_REPORT_20261019.md)。仓库正式更名留待最后由用户手动完成，不阻塞研发；当前远程仍为 `ForceMind/SnapDrop-Lite`；分支、PR 和原始历史全部保留。`zeydrop.com` 未确认购买，不作为已拥有的部署域名。

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
- 增量 SHA-256，完整长度和哈希均匹配后才报告完成。
- 支持多文件发送队列、当前连接内暂停 / 继续和取消。**同一页面中短时断线可尝试续传已同意接收的文件**：原设备在 120 秒内重新配对，双方重新核对安全码，先校验接收端实际已写入偏移与 SHA-256 前缀，成功后只发剩余字节；不一致则取消。
- **不支持刷新网页、关闭浏览器或服务器会话丢失后的持久化续传**。接收写入句柄和发送 File 对象仅保存在当前页内存中；续传失败或超时需重新选择文件。仅保留当前已接受的文件，尚不保留断线时的多文件队列。
- 支持 `showSaveFilePicker` 的浏览器直接写入接收方选择的文件；必须由接收按钮触发授权。兼容性和用户操作仍需实机验证。
- 无流式文件保存能力时，接收中与待保存文件合计最多 **64 MiB**；超限在传输前拒绝。Safari / iOS 不宣称支持 1 GiB 文件。
- 拒绝、超时或校验失败不交付完成文件；接收方取消时尽力 abort 未完成写入。中断恢复不保留未经验证的进度。

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

## 工程导航

- [当前状态与下一步](docs/PROJECT_STATUS.md)
- [历史公网 P2P 方案](docs/PUBLIC_P2P_DEVELOPMENT_PLAN.md)（原方案保留，执行状态以当前状态为准）
- [UI 设计](docs/UI_DESIGN_V1.md)
- [协议、安全和架构](docs/ARCHITECTURE.md)
- [测试矩阵](docs/TEST_MATRIX.md) / [实机方法](docs/REAL_DEVICE_TESTING.md)
- [STUN 配置与官方来源](docs/STUN_CONFIGURATION.md)
- [许可证来源](docs/LICENSE_PROVENANCE.md)

## 许可证

本项目基于 Snapdrop 保留代码演进，组合应用使用 [GPL-3.0](LICENSE)。来源、修改与依赖声明见 [NOTICE](NOTICE)。原仓库的 Apache 文本被保留作历史来源记录；旧 README 的 ISC 声明已修正。
