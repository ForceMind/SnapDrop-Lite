# 测试矩阵与证据范围

## 自动化

| 场景 | 方法 | 本地状态 |
|---|---|---|
| 两人邀请、隔离及第三人拒绝 | 实际 WS 集成 | 通过 |
| 过期、短时重连、恢复令牌失效 | 实际 WS + 可控时钟 | 通过 |
| Origin / 路径 / 限速、拒绝文件及二进制 | 实际 WS 集成 | 通过 |
| selected pair、拒绝 relay / TURN | stats fixture 单测 | 通过，不等于实网路径 |
| 接收前零字节、0 / 3 / 2 MiB 文件 | 协议双端模拟 + sink | 通过 |
| SHA-256 损坏、超限、内存上限、未核对身份 | 协议模拟 | 通过 |
| 构建两次一致、资源引用、PWA 图标 | 实际构建 | 通过 |
| Chromium 页面 / 邀请 / SDP / selected UDP 路径 | 双 profile 浏览器 | CI #7 完整通过 |
| Chromium 实际 DataChannel、100 MiB / 1 GiB 原生写入 | 双 profile E2E | CI #7 全部通过（原生 OPFS） |
| Firefox 完整 E2E | CI #7 实际执行 | 通过：含 100 MiB / SHA-256 / WS 无正文 / 配额失败后继续传输 / 会话恢复 |
| WebKit 手机 UI | CI #7 smoke | 通过；不等于 iOS Safari 实测 |

E2E 通过时会记录实际 selected pair、独立下载 / 磁盘 SHA-256、服务器 WS 字节计数与正文 sentinel 检查。原生文件流使用浏览器 OPFS writer；测试只代替 picker 选择，不证明真实用户 picker 授权体验。CI 网络同主机不能替代公网 NAT 场景。

协商顺序回归在 CI #7 中实际捕获 Chromium 2 / Firefox 3 条早到信令，设备发现延迟 250 ms 后仍成功直连。导出诊断的 Chromium/Firefox/WebKit 实际下载回归在 90962c1 的 CI #8 全部通过；本地脱敏与有界记录单测通过。实机记录方法见 [REAL_DEVICE_TESTING](REAL_DEVICE_TESTING.md)。

## 实机发布门槛（均未验证）

| 网络 | Chrome | Edge | Firefox | Safari | Android Chrome | iOS Safari |
|---|---|---|---|---|---|---|
| 同一 Wi-Fi | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 |
| 不同家庭宽带 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 |
| 宽带 ↔ 4G/5G | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 |
| 不同运营商移动网络 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 |
| IPv6 / 双栈 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 |
| 严格 NAT / 防火墙（允许预期失败） | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 |
| Wi-Fi / 蜂窝切换、后台冻结与恢复 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 |

每个可连接组合测试：文本、图片、视频、多个文件、100 MB 和 1 GiB（能力不足时验证拒绝）。记录双方版本、设备、网络、候选统计、selected pair、协议 / 地址族、时间、哈希、断线 / 拒绝 / 取消 / 暂停结果、服务端是否接收到文件正文。默认不记录完整公网地址及文件正文。
