# Zeydrop 当前工程状态

记录：2026-11-07 UTC。0.3.0-dev.1未发布开发候选；开发分支feat/direct-first-workspace-20261019，[Draft PR #2](https://github.com/ForceMind/SnapDrop-Lite/pull/2)。

## 当前结论

[CI60全套通过](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42368690277)，运行代码3e7fd6c1b03133d1e93484a8535d5e9ad804ddbe，revision25c4bc95c5f8c577：339/339 Node、两侧依赖audit、重复构建、临时HTTPS/WSS、三引擎Worker/清单、Chromium1GiB/Firefox100MiB、OPFS/跨刷新/故障恢复、严格六组合双向SHA、离线PWA与UI均通过。已读真实最终日志及下载JSON；[本轮完整报告](TEST_REPORT_20261107_STREAM_HASH.md)。

可交付独立测试主机部署验证的开发候选，不是正式RC/稳定版。main未合并，生产、用户电脑与账户未操作；仓库更名最后由用户手动完成，不假定拥有zeydrop.com。

## 已实现且形成云端证据

| 范围 | 行为与边界 |
|---|---|
| 配对/直连 | 128bit双人邀请、锁定身份/TTL、精确Origin/信令白名单；selected非relay、DTLS人工核码和接收同意；无文件中继 |
| 文件 | 分块/背压/写入ACK、完整SHA、0B/多文件/暂停/取消/手动失败重试；完成含sink结束及双方哈希，不按100%进度判断 |
| 恢复 | 同页120秒、主动选择OPFS断点与发送清单；新路径/核码、完整重选/前缀校验，不自动绑定历史文件 |
| 状态式哈希 | 实时/恢复前缀本机Worker，4句柄/每句柄4操作、256KiB上限/30秒操作截止、调用方buffer不detach；失败不静默回退；三引擎原生验证 |
| 数据保护 | 写入后哈希故障仅释放已提交offset/SHA，不发布未验证尾部；真实OPFS故障用例重载前取得文件锁，另一活动记录继续，新授权恢复最终SHA一致 |
| 生命周期 | 自然会话结束保留自愿暂存、不保留身份；取消清理失败明确提示；面板代次/各自取消和URL总数20，已点击下载保留60秒宽限 |
| UI/PWA | 深浅主题/键盘/暂存组件；三个同revision Worker从真实缓存离线启动；不是物理断网/硬件PWA升级证明 |
| 资源 | 有界分块/队列，前缀共享4未结束I/O、恢复RPC32项；owning-browser资源观察、实际慢读者回收，不是整机或生产SLA |
| 交付 | 25项公开输入快照、版本缓存/隐藏路径、manifest/有限秘密扫描；304文件候选独立解压重装339项、无Git重建、29项dist逐字节一致 |

原生故障用例：1MiB已提交、额外16KiB写入后真实SHA Worker崩溃；metadata原样保留、无erase/错误ACK/完成；同一存储Worker重载前释放锁。新页面/邀请/核码/手动选择后只发送3MiB尾部，下载4MiB独立SHA一致。此为可控本机Worker故障，不是实际磁盘故障、WAN或Safari证据。

小时本机信令曾实际通过：3600秒、64连接/32房、15360条收齐、472次原身份恢复；真实121.902秒后自动清零。原b19f工具/新guard短测边界及RSS观察增长见SERVER_SOAK；服务器源码未变，不冒称本轮重跑一小时或无泄漏。

正文不经HTTP/WSS，网页/信令/心跳/STUN仍有少量流量。已提交断点保护不是备份保证；明确取消/删除、确证完整性失配按对应策略。native close或存储RPC挂起不能保证物理锁立即释放。

## 精确已验源码候选

[CI60 artifact](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42368690277/artifacts/13572489502)，304文件（275源码/29构建），保留7天。ZIP SHA-256为c7a9bf6cef294a8c67ef6dfdcad7aebd9e5465b30a27724999e3b16871ad7cfc；tar SHA-256为6b8bc10ab68ceb2e42f42b5984c0bc793f13daf1a81b876e67e04cf93e108164。见evidence/cleanup-ci60-candidate.json和cleanup-runtime-extraction.json；实际tar与独立安装/339项测试/无Git重建的归档逐字节一致。manifest的5953bab临时合并来源已核对，不等于main被合并。

后续纯文档候选以自己的manifest/SHA为准，PR保留最新下载/校验；不能把上面哈希用于另一包。main仍是旧版，部署不要仅依赖main或移动分支名。CI57/59历史证据及失败记录保留于各报告。

## 尚未完成的正式验收

| 项目 | 真实状态 |
|---|---|
| WAN/NAT/IPv6/双栈/CGNAT/严格防火墙/切网 | 正式RC阻断；需真实设备/链路、两端selected非relay、独立SHA和服务端流量，Issue #4 |
| Edge/移动/macOS及iOS Safari/真实picker/磁盘/驱逐/后台/PWA升级/无障碍 | 正式RC阻断；Linux WebKit不是Safari硬件，Issue #5；WK全文件基准只有8MiB回退 |
| 独立主机TLS/证书续期/WSS/systemd/迁移/重启/升级回滚 | 正式RC阻断；用户自行在授权测试主机执行，目前只有隔离夹具 |
| 12小时/多日、生产容量SLA、弱移动设备资源 | 未验证；小时本机信令、同机文件与短1000连接不替代 |
| 显式授权LAN自动发现/未来原生增强 | 未实现的可选范围，非Web MVP硬前提；邀请/二维码可用，不以相同公网IP冒充可信邻居 |

云端已完成本轮可复现缺陷修复与必要自动化；下一步按REAL_DEVICE_TESTING采集真实网络/设备/主机证据。公开门槛不因CI成功自动打勾，不转Ready或合并main；不承诺会话结束后继续运行。
