# 测试矩阵与证据范围

## 自动化

| 场景 | 方法 | 状态 / 范围 |
|---|---|---|
| 两人邀请、隔离及第三人拒绝 | 实际 WS 集成 | 通过 |
| 过期、短时重连、恢复令牌失效 | 实际 WS + 可控时钟 | 通过 |
| Origin / 路径 / 限速、拒绝文件及二进制 | 实际 WS 集成 | 通过 |
| selected pair、拒绝 relay / TURN | stats fixture 单测 | 通过，不等于实网路径 |
| 接收前零字节、0 / 3 / 2 MiB 文件 | 协议双端模拟 + sink | 通过 |
| SHA-256 损坏、超限、内存上限、未核对身份 | 协议模拟 | 通过 |
| 已接受文件的同页短时恢复、写入中的偏移、前缀篡改拒绝、伪造恢复请求 | 新增状态机与模拟原生 writer 测试 | CI #15 通过，不等于公网/实机 |
| 真正 WSS 中断 / 新 peer / 原生 OPFS 8 MiB 恢复 / 独立 SHA-256 | Chromium + Firefox 双上下文 E2E | CI #16 均通过；同机 STUN 关闭，不代表公网 NAT 实测 |
| 构建两次一致、资源引用、PWA 图标 | 实际构建 | 通过 |
| Chromium 页面 / 邀请 / SDP / selected UDP 路径 | 双 profile 浏览器 | CI #10 完整通过 |
| Chromium 实际 DataChannel、100 MiB / 1 GiB 原生写入 | 双 profile E2E | CI #10 全部通过（原生 OPFS） |
| Firefox 完整 E2E | CI #10 实际执行 | 通过：含 100 MiB / SHA-256 / WS 无正文 / 配额失败后继续传输 / 会话恢复 |
| WebKit 手机 UI | CI #10 smoke | 通过；不等于 iOS Safari 实测 |

E2E 通过时会记录实际 selected pair、独立下载 / 磁盘 SHA-256、服务器 WS 字节计数与正文 sentinel 检查。原生文件流使用浏览器 OPFS writer；测试只代替 picker 选择，不证明真实用户 picker 授权体验。CI 网络同主机不能替代公网 NAT 场景。

24 项 Node 与 Chromium/Firefox/WebKit 最新完整自动化矩阵在 7e83ba4 的 CI #10 全部通过。新增锁定成员/会话期限单测及“已配对邀请提前到期后继续真实文件传输”场景；这不代表真实持续运行 12 小时。早到信令实际捕获 Chromium 2 / Firefox 3 条；三个浏览器实际诊断下载通过。方法和固定提交见 TEST_REPORT_20261019。实机方法见 [REAL_DEVICE_TESTING](REAL_DEVICE_TESTING.md)。

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
