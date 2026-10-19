# STUN 配置与核验边界

2026-10-19 检查默认地址的官方来源：

| 默认 URI | 官方来源 | 本项目用途 |
|---|---|---|
| `stun:stun.cloudflare.com:3478` | [Cloudflare connection patterns](https://developers.cloudflare.com/realtime/sfu/get-started/connection-patterns/) 列出的公共 STUN 地址 | UDP 地址发现 |
| `stun:stun.l.google.com:19302` | [WebRTC peer connections 入门](https://webrtc.org/getting-started/peer-connections) 的示例配置 | UDP 地址发现 |

这仅验证配置有官方来源，**没有证明任一运营商网络中可达、NAT 可穿透或第三方提供可用性保证**。GitHub 文件 E2E 关闭 STUN，以免将同机 host 路径误称为公网打洞。第三方 STUN 会看到探测来源 IP，不提供文件传输或存储。

编辑 `client/config.js` 的 `ZEYDROP_CONFIG` 后重新构建。最多配置四个 server 条目，仅允许 `stun:` URI；TURN / TURNS、用户名和密码不会被加入 RTCPeerConnection，且 relay 候选和选中路径会被拒绝。不要把 Cloudflare 文档里的 SFU、TURN 或 WebSocket media adapter 接入本项目。

将 `config.js` 与对应构建一同部署并保存配置备份；配置使用 no-cache 且不进入 PWA shell 预缓存。关闭 `enableStun` 只是不收集 STUN 候选，不保证所有同一 Wi-Fi 都可直连，也不支持跨网络穿透保证。

实机核验：按 REAL_DEVICE_TESTING 使用两个不同网络设备，查看候选计数和实际 selected pair，导出脱敏诊断。出现 srflx 仅说明发现了映射地址；最终 selected pair 的类型和状态才是本次路径的证据。探测失败不能自动启用 TURN。不要固定第三方服务的解析 IP；随官方服务变化维护域名配置。
