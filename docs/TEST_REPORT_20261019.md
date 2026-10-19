# 自动化测试报告 · 2026-10-19

测试代码提交：`a520ed9c501799aeb56857ec62879ccb1395cc51`。CI：[run 39271609507](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/39271609507)，2026-10-19 北京时间 22:48 完成，整体 success。

| 检查 | 结果 | 范围 |
|---|---|---|
| Node 测试 | 19/19 通过 | 实际 WS、授权/隔离/过期/恢复、路径 fixture、分块完整性、背压窗口、取消、暂停、存储失败、终止状态 |
| 安装/审计/构建 | 通过 | 固定锁文件、生产依赖审计 0 已知漏洞、两次构建一致、资源引用、shell |
| Nginx | 通过 | 真实模板解析，临时证书，高位 loopback 端口；没有启动生产服务 |
| Chromium | 通过 | 两个独立持久化 profile，host / prflx selected UDP；0、100 MiB、1 GiB 原生 OPFS 写入与独立全文件 SHA-256；拒绝、失败后再传、WS 恢复 |
| Firefox | 通过 | 两个临时 context，100 MiB 原生 OPFS 写入与独立 SHA-256，拒绝、失败后再传、WS 恢复 |
| WebKit | 通过 | 390×844 UI、信令、二维码/邀请/离开、接收弹窗；无 Safari/iOS 文件能力结论 |

1 GiB 测试用稀疏零文件，SHA-256 `49bc20df15e412a64472421e13fe86ff1c5165e18b2afccf160d4dc19fe68a14`。耗时 126.617 秒包含测试额外磁盘读取与校验，不是 WAN 速度基准。小文件另以指定正文比较下载结果，协议单测覆盖随机内容和人为损坏。

Chromium 接收待处理队列峰值 245,844 B，约 256 KiB；这不包含浏览器、操作系统或文件系统缓存。捕获传输阶段 WS 56 条消息共 840 B，未包含文件名/hash/正文或二进制帧；统计不包含页面资源、初始 ICE 配对或后续重连，不代表总流量为零。

原始数据在 `evidence/ci7-*.json`，标注对应 commit 与 run ID。所有实际传输均在同一 CI 主机，测试关闭 STUN，验证 DataChannel 协议与非中继路径；不能证明跨网络 NAT 打洞成功率。

流式测试将 picker 选择替换为原生 OPFS handle，真实浏览器执行实际写入。真实用户文件 picker、OS 文件保存体验、设备硬件、蜂窝网络、Safari/iOS/Android/Edge、IPv6 与严格 NAT 仍未执行。跨连接断点续传尚未实现。当前版本保持开发候选，PR 保留 Draft，未发布或部署。

协商顺序回归：主动延迟 answerer 的设备发现 250 ms，Chromium 捕获 2 条、Firefox 捕获 3 条先到的 SDP/ICE；缓冲至授权设备出现后建立直连。此证据对应 a520ed9，不包含后续诊断导出 UI 改动。

诊断导出提交 90962c1 的 [CI #8](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/39272819405) 于北京时间 22:55 全部通过：21 项 Node 测试及原完整浏览器矩阵，另验证 Chromium/Firefox/WebKit 实际 JSON 下载；回归确认报告不含设备 ID、安全码、邀请/恢复令牌、文件名或正文。evidence/ci8-*.json 保留原始结果。后续握手路径/发布指纹修复本地 22 项通过，仍需最新提交的完整 CI。

握手/服务端发布指纹提交 7c12857 的 [CI #9](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/39273386666) 全部通过：22 项 Node 测试与完整浏览器矩阵。原始 JSON 为 evidence/ci9-*.json。此结果不包括后续会话期限分离；后者本地 24 项通过，新增实际文件传输前让邀请到期的浏览器用例，需另查最新 head CI。
