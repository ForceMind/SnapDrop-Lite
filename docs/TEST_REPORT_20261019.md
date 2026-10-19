# 自动化测试报告 · 2026-10-19

测试代码提交：`b7d0b2fc989e0aebb3b7c65af09a81754d3cb61f`。CI：[run 39269775295](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/39269775295)，2026-10-19 北京时间 22:35 完成，整体 success。

| 检查 | 结果 | 范围 |
|---|---|---|
| Node 测试 | 17/17 通过 | 实际 WS、授权/隔离/过期/恢复、路径 fixture、分块完整性、背压窗口、取消、暂停、存储失败、终止状态 |
| 安装/审计/构建 | 通过 | 固定锁文件、生产依赖审计 0 已知漏洞、两次构建一致、资源引用、shell |
| Nginx | 通过 | 真实模板解析，临时证书，高位 loopback 端口；没有启动生产服务 |
| Chromium | 通过 | 两个独立持久化 profile，host↔host UDP；0、100 MiB、1 GiB 原生 OPFS 写入与独立全文件 SHA-256；拒绝、失败后再传、WS 恢复 |
| Firefox | 通过 | 两个临时 context，100 MiB 原生 OPFS 写入与独立 SHA-256，拒绝、失败后再传、WS 恢复 |
| WebKit | 通过 | 390×844 UI、信令、二维码/邀请/离开、接收弹窗；无 Safari/iOS 文件能力结论 |

1 GiB 测试用稀疏零文件，SHA-256 `49bc20df15e412a64472421e13fe86ff1c5165e18b2afccf160d4dc19fe68a14`。耗时 92.842 秒包含测试额外磁盘读取与校验，不是 WAN 速度基准。小文件另以指定正文比较下载结果，协议单测覆盖随机内容和人为损坏。

Chromium 接收待处理队列峰值 262,228 B，约 256 KiB；这不包含浏览器、操作系统或文件系统缓存。捕获传输阶段 WS 42 条消息共 630 B，未包含文件名/hash/正文或二进制帧；统计不包含页面资源、初始 ICE 配对或后续重连，不代表总流量为零。

原始数据在 `evidence/ci5-*.json`，标注对应 commit 与 run ID。所有实际传输均在同一 CI 主机，测试关闭 STUN，验证 DataChannel 协议与非中继路径；不能证明跨网络 NAT 打洞成功率。

流式测试将 picker 选择替换为原生 OPFS handle，真实浏览器执行实际写入。真实用户文件 picker、OS 文件保存体验、设备硬件、蜂窝网络、Safari/iOS/Android/Edge、IPv6 与严格 NAT 仍未执行。跨连接断点续传尚未实现。当前版本保持开发候选，PR 保留 Draft，未发布或部署。
