# Zeydrop 当前工程状态

记录：2026-11-07 UTC。0.3.0-dev.1未发布开发候选；开发分支feat/direct-first-workspace-20261019，[Draft PR #2](https://github.com/ForceMind/SnapDrop-Lite/pull/2)。

## 本轮进程恢复与初始化加固（CI65 全套通过）

运行代码 `26aed4136ee849a84689c1915e59feb891f00ca7`，文档头 `e8ac72c4e670cc5d5b57e2d860db30c7a952589e`，revision `06d9143aa3bbb8fe`；[本轮报告](TEST_REPORT_20261107_PROCESS_RECOVERY.md)。已修复两处同 ID OPFS 初始化覆盖/迟到删除竞态、BFCache 后清理不恢复，以及本机现场核验读取变动文件仍可能报告一致和 CLI 错误泄漏路径的问题。

[CI65](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42388784628)全套通过，job128451749732；已读最终日志（369/369、0失败/跳过）及下载JSON。两侧audit0、重复构建、临时HTTPS/WSS/Nginx、三引擎Worker/清单、Chromium1GiB/Firefox100MiB、严格六组合双向SHA、OPFS/跨刷新/故障恢复及离线PWA/UI通过。原始证据evidence/ci65-*。独立源包341文件重装369项与无Git重建通过，实际CI tar逐字节一致。

新增两项原生验收：双页面/双Worker争用同ID时，partial/complete/corrupt三态的16KiB正文和元数据不变、无erase，未重载即重新取锁；实际SIGKILL测试专属Chromium隔离进程组，旧存活成员归零，1MiB检查点和metadata保留，新进程/页面/身份不自动绑定。新邀请/核码/重选/手动断点同意后仅传3MiB尾部，4MiB下载完整SHA一致。这不是断电、磁盘故障、Safari或公网证明。本地socket EPERM未算成功，原生结果来自实际Runner。

## 前一轮已验基线

[CI62全套通过](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42370267657)，运行代码88ebde0cfee36e7a06071a85661996b620d87c30，revision50be36dcf5f9d638：342/342 Node、两侧依赖audit、重复构建、临时HTTPS/WSS、三引擎Worker/清单、Chromium1GiB/Firefox100MiB、OPFS/跨刷新/故障恢复、严格六组合双向SHA、离线PWA与UI均通过。已读真实最终日志及下载JSON；[本轮完整报告](TEST_REPORT_20261107_STREAM_HASH.md)。

可交付独立测试主机部署验证的开发候选，不是正式RC/稳定版。main未合并，生产、用户电脑与账户未操作；仓库更名最后由用户手动完成，不假定拥有zeydrop.com。

## 已实现且形成云端证据

| 范围 | 行为与边界 |
|---|---|
| 配对/直连 | 128bit双人邀请、锁定身份/TTL、精确Origin/信令白名单；selected非relay、DTLS人工核码和接收同意；无文件中继 |
| 文件 | 分块/背压/写入ACK、完整SHA、0B/多文件/暂停/取消/手动失败重试；完成含sink结束及双方哈希，不按100%进度判断 |
| 恢复 | 同页120秒、主动选择OPFS断点与发送清单；新路径/核码、完整重选/前缀校验，不自动绑定历史文件 |
| 状态式哈希 | 实时/恢复前缀本机Worker，4句柄/每句柄4操作、256KiB上限/30秒操作截止、调用方buffer不detach；失败不静默回退；三引擎原生验证 |
| 数据保护 | 写入后哈希故障仅释放已提交offset/SHA，不发布未验证尾部；真实OPFS故障用例重载前取得文件锁，另一活动记录继续，新授权恢复最终SHA一致 |
| 生命周期 | 自然会话结束保留自愿暂存、不保留身份；取消清理失败明确提示，显式删除失败不受面板隐藏/重开影响；面板代次/各自取消和URL总数20，已点击下载保留60秒宽限 |
| UI/PWA | 深浅主题/键盘/暂存组件；三个同revision Worker从真实缓存离线启动；不是物理断网/硬件PWA升级证明 |
| 资源 | 有界分块/队列，前缀共享4未结束I/O、恢复RPC32项；owning-browser资源观察、实际慢读者回收，不是整机或生产SLA |
| 交付 | 25项公开输入快照、版本缓存/隐藏路径、manifest/有限秘密扫描；341文件候选独立解压重装369项、无Git重建、29项dist逐字节一致 |

原生故障用例：1MiB已提交、额外16KiB写入后真实SHA Worker崩溃；metadata原样保留、无erase/错误ACK/完成；同一存储Worker重载前释放锁。新页面/邀请/核码/手动选择后只发送3MiB尾部，下载4MiB独立SHA一致。此为可控本机Worker故障，不是实际磁盘故障、WAN或Safari证据。

小时本机信令曾实际通过：3600秒、64连接/32房、15360条收齐、472次原身份恢复；真实121.902秒后自动清零。原b19f工具/新guard短测边界及RSS观察增长见SERVER_SOAK；服务器源码未变，不冒称本轮重跑一小时或无泄漏。

正文不经HTTP/WSS，网页/信令/心跳/STUN仍有少量流量。已提交断点保护不是备份保证；明确取消/删除、确证完整性失配按对应策略。native close或存储RPC挂起不能保证物理锁立即释放。

## 精确已验源码候选

[CI65 artifact](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42388784628/artifacts/13580781957)，341普通文件（312源码/29构建），保留7天。ZIP851747字节，SHA-256为45fb7682dfdceaf2ace7757b6ffb512e9e98e7742f7706ecfc10701a59b515af；tar834496字节，SHA-256为a76db517fff94ca2c8160c1887fb2f7c835e80d2f288bc4c6d5847d89f4428f6。见evidence/process-recovery-ci65-candidate.json和process-recovery-runtime-extraction.json；全部成员、模式/大小/SHA、安全归档边界及实际临时合并父提交/树均核对，tar与独立重装369项/无Git重建的归档字节完全一致。

manifest的932803071af62139e172939e232b1d2a29abee3f为e8ac72c进入原main2b4f75c的临时PR合并，不是main被合并。后续纯文档候选使用自己的manifest/SHA，PR记录最终链接/校验；不能用这里哈希核验另一包。main仍是旧版，部署请核对精确候选，不只依赖main或移动分支名。旧失败/通过记录与原始控制保留在各历史报告。

## 尚未完成的正式验收

| 项目 | 真实状态 |
|---|---|
| WAN/NAT/IPv6/双栈/CGNAT/严格防火墙/切网 | 正式RC阻断；需真实设备/链路、两端selected非relay、独立SHA和服务端流量，Issue #4 |
| Edge/移动/macOS及iOS Safari/真实picker/磁盘/驱逐/后台/PWA升级/无障碍 | 正式RC阻断；Linux WebKit不是Safari硬件，Issue #5；WK全文件基准只有8MiB回退 |
| 独立主机TLS/证书续期/WSS/systemd/迁移/重启/升级回滚 | 正式RC阻断；用户自行在授权测试主机执行，目前只有隔离夹具 |
| 12小时/多日、生产容量SLA、弱移动设备资源 | 未验证；小时本机信令、同机文件与短1000连接不替代 |
| 显式授权LAN自动发现/未来原生增强 | 未实现的可选范围，非Web MVP硬前提；邀请/二维码可用，不以相同公网IP冒充可信邻居 |

云端已完成本轮可复现缺陷修复与必要自动化；下一步按REAL_DEVICE_TESTING采集真实网络/设备/主机证据。公开门槛不因CI成功自动打勾，不转Ready或合并main；不承诺会话结束后继续运行。
