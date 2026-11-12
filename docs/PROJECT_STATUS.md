# Zeydrop 当前工程状态

## 2026-11-12 极简传输界面

用户确认线稿后，在原开发分支重排传文件流程：默认只显示连接入口与加入邀请，首次配对才显示二维码/复制链接，已核对的直连会话直接显示设备和文件选择；接收授权、传输进度和续传入口留在同一工作区，文字、二维码、本机管理和诊断集中在「更多」。传输引擎、信令服务和安全协议未修改。新界面的浏览器证据以对应提交 CI 为准；真实公网、手机和独立主机验收仍开放。

## 2026-11-09 Codex交接与本Work停止

用户要求停止新增开发并交接。已核对c877127的CI76全套成功：442/442、0失败/跳过，完整原生套件及42份JSON；504文件候选ZIP/tar/成员与临时merge tree核验通过。本次仅文档/证据，交接提交CI单独看PR；不把CI76认证扩展到未来提交。[接手说明](CODEX_HANDOFF.md)、[CI76核验摘要](evidence/ci76-handoff-summary.json)。当前产品仍为未发布开发候选，Issue4/5真实网络/硬件/独立主机/长时门槛保持开放。未合并main、未部署生产、更名留给用户；本Work结束后不继续研发或创建定时任务。

## 当前验收入口 · 2026-11-09

[统一验收状态](ACCEPTANCE_STATUS.md)对照M1–M10列出已有实现、CI75精确应用基线与未通过的外部门槛。应用98291db / revision266604dbfe70dbfa已完成442/442及完整三引擎/六组合/1GiB/100MiB/恢复/HTTPS/PWA。Issue #10的独立原生下载对照及已知门槛已记录，调查已关闭。真实WAN、设备/存储、独立主机和长时容量仍未验收；PR2保持Draft。以下章节是历史证据，数量与“本轮/当前/待验证”均应按所对应提交阅读，不能取代最新验收入口。

## 2026-11-08 UTC：接收下载资源与连续保存

首轮CI73仅新增Chromium无间隔批量下载用例失败，已读日志并建Issue #10；不能以有节奏检查通过代替根因确认。加入全新进程的独立原生anchor对照和逐文件诊断，精确最终结果见PR。其余CI73完整套件通过；本轮仍非正式发布。

修复暂存文件下载地址/监听器随保存次数累积，以及共用保存链接在默认动作前切队列的竞态。只在保存时创建暂存URL，接收入口最多20项/60秒宽限，页面退出统一释放；不删除原件。新增7项生产控制器回归，本地442/442、build266604dbfe70dbfa/check-build、两侧生产audit0通过。三引擎原生下载脚本已加入CI，精确提交结果见PR；本地浏览器启动失败未计通过。[报告](TEST_REPORT_20261108_RECEIVE_DOWNLOAD.md)。所有外部发布门槛保留。

记录：2026-11-08 UTC。0.3.0-dev.1未发布开发候选；开发分支feat/direct-first-workspace-20261019，[Draft PR #2](https://github.com/ForceMind/SnapDrop-Lite/pull/2)。

## 2026-11-07 太平洋时间：手机QR与文字窗口继续加固

本轮以实际远程b468885/CI71为基线；已恢复原始截图并提供独立PNG。手机QR三按钮采用紧凑单行布局，44px触控目标不变，明文说明移到预览之前。Canvas能力缺失/清理/绘图/导出失败均安全退役旧画布和下载链接，不再使工具无法关闭；同页缓存返回保留原收文及队列，但QR原文/图片立即清空，不自动发送、恢复身份或接受文件。

新增8项生产控制器回归，本地435/435（0失败/跳过）及构建7cdefdd3de674966/check-build、两侧audit0通过。新增三引擎×五尺寸×深浅的真实几何/命中/独立PNG解码脚本，以及实际已核码连接期间的Canvas null/throw受控故障测试；精确提交的原生结果和原图以PR对应CI记录为准。BFCache证明仅为生产控制器受控事件，不冒称实际导航缓存资格。服务器、ICE及文件协议未改，所有真实网络/手机/Safari/主机门槛仍开放。详见[本轮报告](TEST_REPORT_20261107_UI_RECOVERY.md)。

## 2026-11-08 UTC：文字、二维码及真实UI复核（CI70全套通过）

运行代码033d88beffc1c6b390f378dbb22fc86234b3ea90 / revisionb46de331c87a6628，[CI70](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42440165523)已完整成功，job128607487259最终日志与35份原始JSON已读并归档。427/427 Node（0失败/跳过）、两侧audit0、三引擎真实文字/本机QR/独立ZBar像素解码、21张真实深浅/手机宽度/配对截图、1GiB/100MiB、严格六组合/恢复/HTTPS/PWA全套通过。

新工具无需配对，原文最多800 UTF-8字节，支持PNG，不上传/不自动存储、不截断、不替换坏Unicode；编辑撤旧码、关闭清空。核码后文字仍走DataChannel，最多4096 UTF-16单位，失败保留草稿；非text控制维持8192。手机按钮换行、单活动模态/20条收文队列和复制异步隔离有回归。三引擎各126976B文件完整SHA一致；HTTP请求体0、无WS二进制/正文，WSS仅3640/5140/3683B控制流量。同机/STUN关闭证据不等于真实WAN或服务器总流量0。

459文件运行候选（430源码/29dist）独立重装427项及无Git重建通过，实际CI tar逐字节一致；报告/原始证据在[文本与直传复核](TEST_REPORT_20261107_TEXT_QR.md)与evidence/ci70-*。本轮后续仅更新文档/归档与截图捕获：QR弹窗改用当前viewport，配对图等真实提示自然消失，不修改应用代码或安全断言；最终CI/包哈希见PR的精确提交。全部产品/设计验收仍未完成，下方真实网络、移动Safari、独立主机及长时门槛保留。

## 前阶段生命周期及部署重试（CI68全套通过）

当时本地410/410（0失败/跳过）、构建c75833843f0b324f/check-build/shell/diff与同一锁文件的两侧audit0通过。新部署校验器仅复用完整精确非当前release，保留inode/内容/模式/所有权，不改写或删除既有目录；已current保持previous和配置，残缺/不安全目录继续拒绝。[CI68](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42409023529)全套通过410项/0失败跳过，最终日志和32份JSON已读并归档。419文件候选独立重装410项/无Git重建/29dist复验通过，实际CI tar字节相同；[报告](TEST_REPORT_20261107_LIFECYCLE.md)，[Issue #9](https://github.com/ForceMind/SnapDrop-Lite/issues/9)跟踪这一精确范围；完整目录只读复用通过，残缺目录仍需人工检查。

前阶段c4c7d6e/revisioncc281863f488aa68的[CI67](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42407825773)全套通过400项、原生PWA failed-install/等待/关闭所有旧客户端后升级回滚、原生暂存删除、三引擎Worker/清单、六组合、1GiB/100MiB、HTTPS/WSS/PWA/UI。32份原始JSON已归档，381文件候选独立重装400项/无Git重建并与实际CI tar字节一致。ICE旧回调、暂存三类删除竞态及首次部署current自环修复由这一精确版本认证，本轮后续3cd/CI68亦已独立验收新部署helper。旧Worker不使用新锁，升级须结束传输并关闭全部旧标签。本地socket EPERM未算原生成功。Issue #8已关闭代码/云端复现范围；真实网络/设备/主机门槛仍开放。

## 前轮进程恢复与初始化加固（CI65 全套通过）

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
| 交付 | 25项公开输入快照、版本缓存/隐藏路径、manifest/有限秘密扫描；419文件候选独立解压重装410项、无Git重建、29项dist逐字节一致 |

原生故障用例：1MiB已提交、额外16KiB写入后真实SHA Worker崩溃；metadata原样保留、无erase/错误ACK/完成；同一存储Worker重载前释放锁。新页面/邀请/核码/手动选择后只发送3MiB尾部，下载4MiB独立SHA一致。此为可控本机Worker故障，不是实际磁盘故障、WAN或Safari证据。

小时本机信令曾实际通过：3600秒、64连接/32房、15360条收齐、472次原身份恢复；真实121.902秒后自动清零。原b19f工具/新guard短测边界及RSS观察增长见SERVER_SOAK；服务器源码未变，不冒称本轮重跑一小时或无泄漏。

正文不经HTTP/WSS，网页/信令/心跳/STUN仍有少量流量。已提交断点保护不是备份保证；明确取消/删除、确证完整性失配按对应策略。native close或存储RPC挂起不能保证物理锁立即释放。

## 精确已验源码候选

[CI68 artifact](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42409023529/artifacts/13588981140)，419普通文件（390源码/29构建），保留7天。ZIP989407字节，SHA-256为6fe25037daf92d2ae440c2967686d7d1dd0f1b172c6baf50850d39b63cba658a；tar971150字节，SHA-256为870b2032c95f69c89ec2e29ecfbe269f4f11b5a650aac3c385b8e6d4a0b21768。见evidence/prepared-release-ci68-candidate.json及prepared-release-runtime-extraction.json；全部成员/模式/大小/SHA/安全归档边界及实际临时合并父提交/树均核对，tar与独立重装410项/无Git重建的归档字节相同。

manifest的019362a16d7895ff9237bcd805e25759e0de4853为3cdbeae进入未改main2b4f75c的临时PR合并，不是main被合并。后续纯文档候选使用自己的manifest/SHA，PR记录最终下载与校验；不能用这里哈希核验另一包。main仍是旧版，部署请核对精确候选，不只依赖main或移动分支名。历史失败与原始控制保留在对应报告。

## 尚未完成的正式验收

| 项目 | 真实状态 |
|---|---|
| WAN/NAT/IPv6/双栈/CGNAT/严格防火墙/切网 | 正式RC阻断；需真实设备/链路、两端selected非relay、独立SHA和服务端流量，Issue #4 |
| Edge/移动/macOS及iOS Safari/真实picker/磁盘/驱逐/后台/PWA升级/无障碍 | 正式RC阻断；Linux WebKit不是Safari硬件，Issue #5；WK全文件基准只有8MiB回退 |
| 独立主机TLS/证书续期/WSS/systemd/迁移/重启/升级回滚 | 正式RC阻断；用户自行在授权测试主机执行，目前只有隔离夹具 |
| 12小时/多日、生产容量SLA、弱移动设备资源 | 未验证；小时本机信令、同机文件与短1000连接不替代 |
| 显式授权LAN自动发现/未来原生增强 | 未实现的可选范围，非Web MVP硬前提；邀请/二维码可用，不以相同公网IP冒充可信邻居 |

云端已完成本轮可复现缺陷修复与必要自动化；下一步按REAL_DEVICE_TESTING采集真实网络/设备/主机证据。公开门槛不因CI成功自动打勾，不转Ready或合并main；不承诺会话结束后继续运行。
