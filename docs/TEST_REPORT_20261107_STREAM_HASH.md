# Zeydrop 状态式哈希与数据保留验收

记录：2026-11-07 UTC。未发布开发候选，非正式RC。当前运行代码88ebde0cfee36e7a06071a85661996b620d87c30，revision50be36dcf5f9d638，开发分支feat/direct-first-workspace-20261019，Draft PR #2。main、生产和用户电脑未操作，仓库更名留给用户。

## 最新完整验收与候选（CI62）

[CI62](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42370267657)全套通过，job128396754485；已读最终日志：342通过/0失败/0跳过。两侧audit、重复构建/Nginx/临时HTTPS/WSS、三引擎状态式/全文件/清单Worker、Chromium1GiB/Firefox100MiB、原生OPFS/跨刷新/Worker故障恢复、六组合双向SHA、离线PWA及UI均通过，原始JSON为evidence/ci62-*。原始证据ZIP2001391字节，SHA-256为a839f9fa6f5803c6ca785e58fd0412b568ce8674baf526e3a76eb60f115ced8e。

最终追加P2：用户在删除请求结束前隐藏/重开面板，erase迟到失败曾被代次检查吞掉。最小修复先发固定失败提示，再限制旧界面刷新；隐藏失败/重开失败/迟到成功3项使暂存UI达到13项、全套342项。失败不暴露file ID/原生细节，成功旧操作不改新行或恢复旧hash/URL。

原生OPFS故障结果重现：1MiB已提交、额外16KiB已写入后单次真实SHA Worker异常；原metadata逐字节不变、未erase/未错误ACK/未完成；同一存储Worker在重载前立即重新取得锁，另一4KiB活动记录继续完成。新页面/邀请/核码/重选原件/明确断点选择后只传3145728字节，4194304字节下载的独立SHA为da3feddbbe6ad43f9a22c98dc6c035515efd66c69fd40a1bc5d69c2704e7c47f。两端live哈希全部Worker、mainCalls=0、active=0；19条3827字节信令没有正文/文件信息，HTTP上传及外部请求均0。这是受控Worker故障，不是实际磁盘故障证明。

本次Chromium1GiB时段148427ms，Firefox100MiB13395ms；与CI60不同，不能当作受控前后性能对比或公网/弱设备SLA。三个原生Worker均从50be36dcf5f9d638的真实缓存离线启动，仍仅浏览器网络仿真。

[精确CI62源码候选](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42370267657/artifacts/13573442924)保留7天：ZIP785207字节，SHA-256为84322b5c6b4fcdef88be7c7bda6df7cb8ef4fce4c0876eab5f9c64d2491575ac；tar768528字节，SHA-256为ed0c7be03eacf98b39baa6011b0858e162b460c0a7a5eff4e0efb163e0b3cbec。319个普通文件（290源码/29构建）完整安全成员、模式/大小/SHA及Git来源均核对。实际tar与独立重装两侧依赖、342项、无Git重建及29项dist逐字节复验的归档完全相同；manifest仅CI临时合并来源81ff7001996d487b2b691ef100f920982e5ded2d不同，已核对88ebde0合入原main2b4f75c，main分支未移动。见evidence/delete-feedback-runtime-extraction.json、delete-feedback-ci62-candidate.json和ci62-workflow.json。

后续纯文档包使用自己的manifest/SHA；PR记录最终下载、精确头和工作流，不把本节旧包校验值套用于另一包。真实WAN/设备/Safari/存储故障/PWA升级及独立主机部署门槛继续开放。以下保留本轮基线与定位历史。

## 核心基线完整验收（CI60，历史）

[CI60](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42368690277)全套通过，job128392106510；最终真实日志为339通过/0失败/0跳过。两侧audit、重复构建、Nginx/临时HTTPS/WSS、三引擎原生Worker/清单、Chromium1GiB/Firefox100MiB、OPFS/跨刷新、严格六组合双向独立SHA、离线PWA和UI检查全部通过。已下载并核对实际原始JSON，存入evidence/ci60-*；工作流摘要见ci60-workflow.json。证据ZIP1958753字节，SHA-256为a2e94f58db1227ae985703abb2d89f8a2771b044d3791ef841f40aa4b2ec7282。

原生故障组合的实测结果：

| 核验 | 结果 |
|---|---|
| 写入后真实SHA Worker异常 | 原检查点1048576字节，物理文件1064960字节，单次故障及单次releaseCommitted |
| 数据保留 | 原metadata逐字节不变，未erase、没有超过1MiB的ACK、没有完成事件 |
| 物理锁 | 不导航、不重载、不终止存储Worker，立即恢复同一记录成功，截断尾部/1MiB快照独立SHA一致 |
| 独立记录 | 共享存储Worker中的另一4KiB活动记录继续写入并完成，内容SHA正确 |
| 新授权恢复 | 新页面/邀请/两端核码、发送方重选原文件、接收方手动选断点后，恰好只发3145728字节尾部；下载4194304字节独立SHA一致 |
| 资源/隐私 | 两端全部live哈希为Worker、mainCalls=0、结束active=0；HTTP上传/外部请求均0，19条3826字节信令无文件信息/正文 |

上述4MiB最终独立SHA为da3feddbbe6ad43f9a22c98dc6c035515efd66c69fd40a1bc5d69c2704e7c47f，原始故障JSON为evidence/ci60-stream-hash-recovery-chromium.json。此为合成测试文件及受控Worker运行时故障，不是真实磁盘故障或设备性能证明。

Chromium1GiB本次时段87391ms、Firefox100MiB7384ms，均含独立内容验证流程；没有受控前后对比，不据此宣传提速。两端所有live句柄使用Worker且结束0租约，完整六组合均实际双向传文件并独立SHA。当前PWA的三个Worker都从25c4bc95c5f8c577缓存实际离线启动；仍仅浏览器网络仿真。

## CI60核心运行候选（历史）

[CI60 artifact13572489502](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42368690277/artifacts/13572489502)，保留7天。ZIP751705字节，SHA-256为c7a9bf6cef294a8c67ef6dfdcad7aebd9e5465b30a27724999e3b16871ad7cfc；tar735941字节，SHA-256为6b8bc10ab68ceb2e42f42b5984c0bc793f13daf1a81b876e67e04cf93e108164。

304个普通文件（275源码/29构建）的完整成员、权限、大小、SHA、安全归档边界均核对。实际tar与独立重装两侧依赖、339项测试、无Git重建及29项dist逐字节复验的本地归档完全相同。manifest只因CI临时合并来源5953bab23783f6d191529813e6a6b60f231d7c12不同，已独立核对合入3e7fd6c和原main2b4f75c，main未移动。见evidence/cleanup-runtime-extraction.json和cleanup-ci60-candidate.json。

后续纯文档包必须使用自己的manifest/归档SHA；PR记录最终下载/校验，不能把本节校验值用于另一包。以下保留Worker基线与失败定位历史，以便重现本轮决策。

## 本轮实现

- 实时发送/接收、同页与显式本机恢复的前缀SHA使用本机状态式Worker；已完成暂存的下载复验使用全文件Worker。原始发送缓冲保持可用，无哈希状态序列化或网络计算服务。
- 状态式桥接最多4个句柄，每句柄4个待完成操作、分块至多256KiB，单操作含初始化默认30秒截止；快照可继续，最终摘要释放；取消/崩溃/错误/超时释放精确Worker。只有没有Worker能力时采用有界主线程回退，组件缺失或Worker失败不静默重算。
- 新增releaseCommitted/parkCommitted：写入已成功但哈希失败时关闭精确句柄，保留此前已提交offset/SHA和元数据，不将旧摘要配给新磁盘偏移、不擦除或截断；下次重新明确授权恢复时按原检查点截断。native close失败仍拒绝，不能保证物理锁已释放。
- 修复自然会话到期先peers=[]造成暂存被删除：永久退出保留自愿本机断点，但结束旧身份/配对/held授权。明确文件取消、手动删除和确证完整性失败保持对应策略。
- 修复本机发送前缀读/哈希失败误走全连接协议错误：仅取消该发送文件，反方向已授权接收仍可继续。恶意/无效远端恢复控制仍按协议拒绝。
- 公共构建输入从23增至25，两个哈希Worker和恢复Worker均本地打包/按revision缓存；无服务器文件接口、TURN、DERP或WS正文回退。

实现与验证涉及stream-hash.js/Worker、transfer、recovery/Worker、network、ui、index、构建公共清单、CI及测试。README中英文、架构、状态、矩阵、发布门槛、设备与部署说明同步更新。

## Worker基线本地验证（e2a2088）

324/324 Node测试、0失败/跳过。相对285项基线新增39项：状态式桥接/实际Worker源14、异步传输12、安全释放6、会话到期4、完成暂存UI3。异步测试加载实际TransferPeer与不暴露clone/digest的实际桥接，仅延迟原生Worker边界并使用独立Node SHA回答；它们不是浏览器或真实磁盘故障证据。

覆盖写入后哈希失败、snapshot/final期间取消、旧wire与接管owner、迟到旧回调及相同ID新文件、无错误ACK/complete、独立双向故障隔离、并行恢复4句柄上限与结束释放。真实server过期方法驱动network+transfer，覆盖先peers=[]后room-expired的顺序。修复前自然过期4项中2失败；本机前缀故障审查复现删除反方向断点，修复后不删除且接收继续。

npm run build和node scripts/check-build.mjs通过；shell脚本语法/diff检查通过；根目录和server的npm audit均0已报告漏洞。见evidence/stream-hash-local-20261107.json。构建、依赖扫描和有限安全回归不是所有安全风险不存在的证明。

本地Playwright默认浏览器缺失，实际尝试系统Chromium又在process_singleton的socket()遭EPERM。没有把该启动失败算通过，原生浏览器验证交由新提交的GitHub Runner。

## 状态式Worker基线CI59及候选（历史）

[CI59](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42367663439)全套通过，job128389041205；已读取最终真实日志（324通过/0失败/0跳过）及实际下载的证据JSON。三引擎原生状态式/全文件Worker、恢复/跨刷新OPFS、三引擎清单、严格六组合双向文件SHA、Chromium1GiB/Firefox100MiB、临时HTTPS/WSS、离线PWA和UI均通过。原始证据存入evidence/ci59-*，实际证据ZIP SHA为1e58c5df6ba9560c30f57960d6148801c6dced39e4708dbd00715cfaafb22589。

Chromium与Firefox两端liveHashWorkers均记录全部句柄为worker、mainCalls=0、结束active=0；8MiB断线恢复从实际写入前缀继续，并重新核码。Chromium1GiB含独立内容校验的时段109145ms，Firefox100MiB为10251ms；这不是公网速度承诺或与旧版本的受控性能比较。对应信令1627/1312字节且无正文/文件名/摘要；不外推真实拓扑。三引擎Worker故障/超时不回退及输入缓冲保留均通过。

CI59只认证e2a2088；其后的清理和原生OPFS故障组合另由3e7fd6c/CI60全套验证，见顶部，不沿用旧绿灯。

[CI59实际候选](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42367663439/artifacts/13571604402)已独立复验：ZIP701472字节，SHA-256为909f1f51cb59f8a7ed30080df2e981a96bf089b9f15bb6215d28e68f82031f08；内部tar687433字节，SHA-256为dcc30529c67fc0c6e6915a2e7fb65987bd9f31c383f094188b5f5b0c732dbb5b。288个普通文件（259源码/29构建），完整成员、权限、大小、摘要、归档边界均核对。

实际tar与已独立依赖重装、324项测试、无.git构建及29项dist逐字节重建复验的本地归档完全一致。外部manifest唯一差异为GitHub临时合并来源6178a14a18737fab7314a1fa0c9bcdaaaf4f642e，已核对合入e2a2088与原main2b4f75c，未将main分支移动。见evidence/stream-hash-runtime-extraction.json和evidence/stream-hash-ci59-candidate.json。后续文档提交的包须使用自己的manifest/SHA，不沿用这里的归档校验值。

## 发布边界

真实WAN/NAT/IPv6/双栈/CGNAT/UDP限制、网络切换、Windows Edge/Android/iOS与macOS Safari、真实picker/磁盘不足/存储驱逐/后台冻结/PWA升级、独立主机TLS证书续期/systemd/升级回滚仍未验收，见Issues #4/#5和REAL_DEVICE_TESTING。Linux同机默认STUN关闭的成功不能推广为跨运营商成功率。Worker不保证低端移动设备提速或整机内存SLA。

服务器源文件本轮未改，仍是b3aa2d2f4a3f6a547f3e6bb7661f010bcbf326702461c425657fddadd850e52f；既有真实一小时本机信令及其工具/资源观察限制见SERVER_SOAK。此次不冒称重新完成一小时、12小时/多日或生产容量验证。文件正文不经服务器不等于服务器总流量为零。

保持Draft，不合并main，不发布正式Release；所有外部正式RC门槛继续开放。

## 后续清理与原生故障组合验收（CI60）

进一步修复两项实际问题：取消时sink.abort的同步异常/异步拒绝被统一消费，并提示本机删除或保存位置清理失败，不泄露原始错误，也不影响新state；不再将停止传输等同于本地已删除。新增8项隔离回归，负向控制恢复旧调用会在普通/durable两例检出真实未处理NotAllowedError。

本机暂存面板按render代次和各自AbortController管理：迟到list/completed/hash不发布旧链接；普通隐藏/刷新释放未点击URL，已点击链接保留最长60秒下载启动宽限；删除/pagehide清理全部，撤销timer只绑定旧URL。总URL上限20，满额提前拒绝读取和哈希、也在异步完成后再检查，不逐出正在启动的下载；释放后可以重试。UI用例由3增至10。

新增原生Chromium OPFS组合测试stream-hash-recovery-browser.cjs：真实建连/核码/接收同意后，只给第一个真实接收哈希Worker注入运行时异常；验证写入后旧1MiB元数据保留、物理锁在重载前可重新取得、独立活动记录不受影响，以及新页面/邀请/核码/明确断点选择后的独立完整SHA。本地浏览器未能启动；对应原生用例已经在CI60实际执行通过，详细数值与原始JSON见顶部。

后续本地339/339 Node、构建25c4bc95c5f8c577、重复构建/本地引用与脚本语法/diff检查通过。本地原生浏览器组合用例因socket EPERM无法运行；现由3e7fd6c/CI60独立完整通过并完成新候选复验，CI59只认证此前e2a2088。

## 追加显式删除失败反馈（CI62已验）

最终只读复核复现P2：删除请求未完成时隐藏/重开管理面板，随后erase拒绝；旧代码noticeCount=0，记录仍存在，新行虽未被修改但用户没有失败反馈。追加最小修复将固定通知放在generation/hidden检查之前，界面刷新仍只属于当前代次；不暴露文件ID/任意原生错误。新增隐藏失败、重开失败和迟到成功控制3项，相关UI13项/整体342项本地通过，构建50be36dcf5f9d638可重复。此前CI60/61不认证该追加改动；现由88ebde0/CI62独立完整通过，并完成319文件/342项/无Git候选复验，见顶部。
