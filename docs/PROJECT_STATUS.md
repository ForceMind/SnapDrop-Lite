# Zeydrop 当前工程状态

记录：2026-11-07 UTC。0.3.0-dev.1未发布开发候选；开发分支feat/direct-first-workspace-20261019，[Draft PR #2](https://github.com/ForceMind/SnapDrop-Lite/pull/2)。

## 当前结论

[CI57全套通过](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42357894421)，运行代码172adc8ae2bfc9dd577f56fb92c103a4ad64e78b，revision10c5794070ac6a1b：285/285 Node、完整audit、构建/PWA、临时HTTPS/WSS、三引擎清单/Worker、Chromium1GiB/Firefox100MiB、原生OPFS/跨刷新、严格六组合、离线PWA仿真与UI检查通过。[完整证据及限制](TEST_REPORT_20261107_FINAL.md)。

可交付独立测试主机部署验证的开发候选，不是正式RC/稳定版。main未合并、生产和用户电脑未操作；仓库最后由用户手动更名，不假定拥有zeydrop.com。

## 已落地且形成云端证据

| 范围 | 行为与边界 |
|---|---|
| 配对/直连 | 128bit双人邀请、锁定身份/TTL、精确Origin/信令白名单；selected非relay、DTLS人工核码和接收同意；无文件中继 |
| 文件 | 分块/背压/写入ACK、完整SHA、0B/多文件/暂停/取消/手动失败重试；完成含sink结束及双方哈希，不按100%进度判断 |
| 恢复 | 同页120秒、用户主动选择OPFS断点和发送清单；新路径/身份确认、完整重选/前缀校验、无自动历史文件绑定 |
| 数据保护 | Issue #6修复并通过：原checkpoint错误保留、旧write完整记账后park、过期交接和迟到finish按精确state清理、原生Worker失败释放active；物理I/O仍有下述限制 |
| 资源/Worker | 清单全量SHA专用Worker；前缀256KiB/共享4未结束I/O，恢复RPC32项；实时/前缀SHA计算仍主线程 |
| UI/PWA | 深浅主题可读暂存面板/placeholder/焦点，真实列表组件和键盘测试；当前版本SW/缓存/Worker离线仿真通过，非真机生命周期证明 |
| 性能 | owning-browser RSS/PSS/CPU覆盖报告、实际慢读者128KiB阈值与永久不读者真实30秒回收；不是整机指标或生产容量 |
| 交付 | 23项公共输入快照、版本缓存/隐藏路径、干净源码manifest/有限秘密扫描、可重复归档、独立246文件解压/重装285测试/无Git重建 |

小时本机信令已实际通过：3600秒、64连接/32房、15360条全部收齐、472次原身份恢复；真实121.902秒后自动清零。原b19f工具/新00f guard短测边界及RSS观察增长见SERVER_SOAK，不宣称无泄漏、生产容量或公网成功率。

用户文件正文不经HTTP/WSS，服务器仍有网页/信令/心跳/STUN相关少量流量。已提交断点的故障保留不等于备份保证；主动取消当前文件、手动删除及确证完整性失配保持对应策略。native close或restore/park挂起时不能保证物理锁立即释放。

## 精确已验源码候选

[CI57 artifact](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42357894421/artifacts/13568541404)，246文件，保留7天；tar SHA-256为766331d11154ab649cd4796003f4caf9a27b77026c2e7e4fd868959ba2bf0f52。完整ZIP校验、manifest临时合并来源及独立复验见最终报告和evidence/candidate-extraction-ci57.json。

后续文档候选以自身manifest/Actions artifact为准；PR保留最新下载/校验，不能将上面的归档哈希用于不同文件包。main仍是旧版，部署不要仅依赖main或移动分支名。

## 未完成与验收阻断

| 项目 | 真实状态 |
|---|---|
| WAN/NAT/IPv6/双栈/严格防火墙/切网 | 正式RC阻断；需两个真实设备与链路、selected非relay、独立SHA和服务端流量证据，Issue #4 |
| Edge/移动/macOS与iOS Safari/真实picker/磁盘/驱逐/后台/PWA升级/无障碍 | 正式RC阻断；Linux WebKit不是Safari硬件，Issue #5；WK哈希基准只有8MiB回退 |
| 独立主机TLS/证书续期/WSS/systemd/升级迁移/重启回滚 | 正式RC阻断；需用户自行授权测试主机，当前只是隔离夹具 |
| 12小时/多日、真实生产并发SLA、弱移动设备资源 | 未验证；小时本机信令和短1000连接不替代 |
| 实时/恢复前缀SHA专用Worker | 未实现；当前有界主线程，清单Worker不能冒充全迁移 |
| 显式授权LAN发现 | 未实现，非Web MVP硬前提；邀请/二维码可用，不以相同公网IP冒充可信邻居 |

下一步按REAL_DEVICE_TESTING采集真实网络/设备/主机证据；软件增强依据实际性能继续推进。发布门槛不因CI成功自动打勾，不转Ready/合并main。历史报告、失败JSON和Git提交均保留。
