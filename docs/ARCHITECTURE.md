# Zeydrop 协议与安全边界

## 网络通路

- HTTPS：只分发静态资源；Nginx 拒绝上传方法，1 KiB request body 上限。
- WSS `/server/webrtc`：`hello`、`create-room`、`join-room`、`leave-room`、`signal`、`ping/pong`。只转发经过白名单验证的 SDP / ICE；不转发文本、文件元信息、哈希或分块。
- WebRTC：可靠、有序 `zeydrop-v2` DataChannel，承载所有用户文件 / 文本。无 TURN 配置，过滤 relay 候选；选中 relay 路径立即停止。
- STUN：可配置、最多四个 STUN server 条目；只接受 `stun:` 地址。默认 Cloudflare / Google 的可用性没有在此环境中验证。不能将它们写成保证可用或自有服务。

## 邀请和会话

客户端安全随机生成 16 字节邀请 ID；只有 `create-room` 可创建，`join-room` 不会使过期或不存在的邀请复活。固定绝对有效期 15 分钟，最多两名会话成员。房间过期停止配对和活动连接。

设备 ID / 32 字节恢复令牌由服务器 `node:crypto` 生成；不接受客户端自报 ID 或 cookie 身份。恢复令牌只在 WS 第一条 hello 消息内发送，保存在当前页内存中，不进 URL / 日志 / localStorage。服务端重启会丢失内存房间及令牌；此时需重新邀请。

对端断线立即撤销前端 peer，释放传输资源；服务器保留离线会话的席位 2 分钟，以支持相同页面短时重连。此机制不等于文件断点续传。重新协商后需再次确认安全码。

## 身份与直连证据

先完成 ICE / DTLS 协商，提取双方 SDP 中 SHA-256 certificate fingerprints，规范为大写、排序连接，再 SHA-256，显示前 48-bit（12 个十六进制位）供人工比较。两端分别允许后方可发送。它降低未比较身份时误传的风险，不是账户体系，也不替代安全的带外比较。

路径先读 `transport.selectedCandidatePairId`，兼容报告显式 selected pair 的实现。只使用已选中 pair；不能用单独 nominated 推断。读取双方 candidateType、协议、地址族和 currentRoundTripTime。不向服务器上传候选路径统计，IP 信息只参与必要 ICE 信令。浏览器隐藏地址或候选字段时标记待核验，禁止虚构直连成功。

失败 / disconnected 后有界 ICE restart（单 offerer，最多两次）；没有无限重试或文件代理。双方 tab ID 使用服务器签发的随机身份进行 offerer 排序。

## 文件协议 v2

1. 通道 hello `{version:2}`；旧协议拒绝。
2. `offer {id,name,size,mime}` → 接收方人工同意、打开 sink → `accept {id}`。
3. 发 ≤16 KiB 二进制分块，每 ≤256 KiB 发送 `checkpoint {id,offset}`。
4. 接收端串行完成写入后 `ack {id,offset}`；发送端只在精确偏移确认后继续。
5. 双方独立增量计算 SHA-256；`finish {id,sha256}` 只能在声明长度完全一致时核验。
6. 接收端 hash 匹配、sink.close 成功后 `complete {id,sha256}`，发送方也必须核对值。零字节文件同样执行哈希和完成协议。

`pause/resume/cancel` 绑定 transfer ID。当前连接内暂停保留 offset；断线取消，明确重新选择重发。重发由用户重新选择文件触发，不会把失败当完成。

发送 DC buffer 上限 1 MiB，接收异步处理队列上限 1 MiB，持久化确认窗口 256 KiB；同时最多一个发送、一个接收。回退内存池对接收中和已完成待保存 Blob 合计限 64 MiB，关闭保存弹窗释放。

## 防护与尚存限制

- 精确 WS Origin，生产环境未配置 ALLOWED_ORIGINS 则拒绝启动。
- 64 KiB frame / message，240 条 / 分钟、512 KiB / 分钟，每连接计数包含心跳；128 KiB WS 输出缓存阈值；1000 个全局房间 / 会话 / 连接上限。
- 无压缩、拒绝二进制 WS，信令目标必须是同一未过期房间的实际成员；嵌套对象字段白名单。
- 文件名去除路径分隔符与控制字符；DOM 使用 textContent；不自动打开收到的 HTML / URL / 图片。
- Nginx TLS、CSP、no-referrer、访问日志省略 query；服务账号无特权、文件系统只读。
- 服务器不能识别所有恶意信令中的隐蔽数据编码。协议不提供文件转发接口，受限 SDP/ICE 仍是小流量协商通道；不承诺抵抗无限 botnet / 所有 DoS。
- 目前需人工处理邀请误分享、浏览器存储配额、接收磁盘满、后台冻结、设备权限拒绝；未取得跨运营商 NAT 矩阵证据。
