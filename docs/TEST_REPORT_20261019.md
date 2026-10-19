# 自动化测试报告 · 2026-10-19

实现提交：`7e83ba4e6306d18c4a5b557e4c548c68368b7f9b`。CI：[run 39274470166](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/39274470166)，北京时间 23:06 完成，整体 success。此报告绑定固定提交；后续 head 仍需对应 CI。

| 检查 | 结果 | 范围 |
|---|---|---|
| Node | 24/24 | 实际 WS 授权/隔离/过期/锁定/恢复、原始 TCP 畸形握手、ICE fixture、早到信令、脱敏诊断、分块/损坏/暂停/取消/存储失败 |
| 安装/审计/构建 | 通过 | 锁文件、生产依赖审计 0 已知漏洞、两次构建一致、资源引用、shell |
| Nginx | 通过 | 临时证书、高位 loopback 端口实际模板解析；非生产服务验收 |
| Chromium | 通过 | 两个独立持久化 profile，selected UDP；0 / 100 MiB / 1 GiB 原生 OPFS 与独立磁盘 SHA-256；拒绝/配额失败后再传/WS 恢复 |
| Firefox | 通过 | 两个临时 context，100 MiB 原生 OPFS 与独立 SHA-256，同类完整 E2E；没有 1 GiB 结论 |
| WebKit | 通过 | 390×844 UI、信令/二维码/邀请/离开/接收弹窗/诊断下载；没有 Safari/iOS 文件能力结论 |

已配对邀请期限由测试提前设置至当前时间前，再执行实际文件矩阵；没有真实等待 15 分钟或 12 小时。会话锁定、原成员恢复不延长期限、最长会话到期及房间清理另由可控时钟/实际 WS 验证。此场景证明邀请到期不再切断已锁定会话，不能视为 12 小时稳定性测试。

协商顺序：延迟 answerer discovery 250 ms，Chromium 实际捕获 2 条、Firefox 3 条先到 SDP/ICE，最终直连。诊断导出实际下载并检查身份/安全码/邀请/恢复令牌/文件 sentinel 不在报告中；单测另覆盖 IP、SDP、任意错误原文和字段注入，验证 120 条历史和 30 个匿名映射上限。

1 GiB 为稀疏零文件，SHA-256 `49bc20df15e412a64472421e13fe86ff1c5165e18b2afccf160d4dc19fe68a14`；耗时 99.919 秒包含测试额外磁盘读取/校验，不是 WAN 速度。另有已知正文下载比较、随机内容及人为损坏协议测试。

Chromium 接收待处理队列峰值 262,228 B，不是进程总内存。传输阶段 WS 45 条 / 675 B，检查无二进制帧、文件名、正文 sentinel 和各已传文件 SHA-256；不含页面/初始配对/后续重连，不代表服务器总流量为零。

原始数据：`evidence/ci10-*.json`，均标明 commit/run/method。历史失败和 ci4–ci9 证据保留。本地 Node 日志、服务器构建指纹改变/还原实验、隔离旧握手复现也在 evidence。

边界：同一 CI 主机、STUN 关闭，不能证明公网 NAT 成功率；OPFS writer 原生但 picker 选择由测试提供。真实保存授权、OS/磁盘、Edge/Safari/iOS/Android、IPv6/严格 NAT 和生产部署/回滚均未执行。跨连接断点续传和显式 LAN 发现尚未实现。PR 保留 Draft，未正式发布或部署。
