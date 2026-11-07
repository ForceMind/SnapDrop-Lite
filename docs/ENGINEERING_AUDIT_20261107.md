# 2026-11-07 断点保留与资源边界审计

继续现有 PR #2。完整已通过基线为4d617b1/CI54；237daa8/CI55的242项Node、存储/文件/六组合等通过，但新增离线PWA就绪等待超时，整套仍失败。原JSON保留，不删除断言或沿用旧CI为新代码背书。

## Issue #6：已提交本机断点的清理

[跟踪任务](https://github.com/ForceMind/SnapDrop-Lite/issues/6)。以下缺陷在隔离源码/存储夹具中先复现失败；不表示已发现真实用户丢失数据、真实磁盘耗尽或公网攻击：

1. 恢复准备的读取/哈希引擎错误会进入abort，删除旧partial，即使没有证明内容损坏；逻辑取消也会等待快照读取。
2. Worker park的flush或元数据打开/写入/提交失败，不会释放自己的访问句柄；上层held过期/keepDurable失败又转abort删除旧检查点。
3. durable write/checkpoint/finish存储失败也默认删除旧partial；finish已消费SHA状态，不能再clone取得摘要。
4. finish期间断网后，旧取消和迟到result.release可能删除已在本机验证保存的结果。
5. 过期held迟到交接应与普通hold过期采用一致保留策略。清理须等待已经授权的旧write，并正确计入原state的hash/offset，防止发布不一致检查点。

## 修复约束

- 用户仍需明确选择原断点并重新授权。准备sink由局部任务持有；每片≤256KiB，与发送侧共用最多4个未结束前缀I/O。逻辑取消结算等待，迟到结果不改变新文件；完整校验通过才原子交接sink。
- 原checkpoint只park一次。读取/计算/park失败不是内容损坏证明；完整读取且有效32B SHA确实不匹配时保留原腐坏处理。普通sink失败和用户主动取消策略另外保持。
- 存储错误按原state对象和resumeOwner路由，不用可重放ID取消新文件。失败不发ACK/complete；仅本地最终SHA与对端真实匹配后保留finalSHA供清理使用。
- transient finishing不作为live held恢复。仅原state明确保留且结果确为locallyStored时，迟到结果才不release；不伪造发送成功或自动绑定历史文件。Blob和主动取消对照仍释放。
- Worker park成功或失败都尝试关闭自身访问句柄、释放active，不erase，也不覆盖最先发生的quota/permission错误。模拟故障清除后，实际resume须按旧offset/SHA截断未提交尾部。

## 物理I/O与RPC边界

Blob读取没有通用Abort API；逻辑取消不等于终止底层I/O。四个名额只有实际完成才释放。restore/park RPC挂起或native close抛错时，不能保证物理锁立即释放；不得强制终止共享Worker来伪造成功。

桥接另限32项未完成RPC，序号须为安全整数且不复用。拒绝发生在创建Worker/登记任务/发送前；已投递任务仍保留到真实reply/error，发送失败和Worker错误释放相应槽。没有会遗弃迟到文件操作的通用超时/abort。

## UI与后续验证

深色暂存面板原因surface未定义而白底近白字；主题变量、弱文字、placeholder和focus对比度已修，依据和边界见UI_ACCESSIBILITY_20261107。实际列表、启用按钮和两主题另有真实浏览器检查，不能只看首页截图。

本轮仍需自身完整Node、原生OPFS/跨刷新、文件/浏览器矩阵、构建和独立候选核验。真实存储失败/驱逐、移动Safari、WAN与独立主机门槛继续开放。服务器源码和Direct-only通路未改，用户文件不进入HTTP/WSS/分析服务。


## 追加复审：active durable取消的检查点一致性

独立5字节夹具证实，旧实现和本轮初版都存在：已有3B前缀，2B write尚未完成时直接abortAll(keepDurable)，清除incoming使旧write的hash/offset记账跳过，park会将offset5与hash(prefix3)配对。adopt到新peer时，仅等新消息链还会提前park，必须同时等待旧_resumeReady。

最终窄修在取消精确state前设置记账标记，barrier覆盖当前消息链、旧adopt ready及既有cleanup ready；只有已开始写入成功才更新原state，等待完成后park，再仅释放自己的标记。3项先红后绿，独立复验两条路径均无提前park、stateOffset=sinkSize=5、SHA一致且只清理一次，新同ID文件不受影响。原生OPFS与完整矩阵仍待新head CI。

## PWA实际诊断与测试配置

CI56实际证据：页面complete/controller activated、模块和Recovery均就绪；no-store /build.json真实请求立即TypeError且非timeout，Recovery Worker命中精确版本缓存，但navigator.onLine保持true。原失败是把网络请求模拟等同renderer状态的测试假设，未证明缓存失败。CI55/56原JSON均保留。

依据安装的CDP协议，测试另用Network.overrideNetworkState设置renderer离线提示，同时保留Playwright请求阻断、原navigator全部断言、实际HTTP断网探针、真实缓存/Worker/SHA与pageerrors。未修改navigator属性或产品源码，也不冒充物理断网。此配置须在新CI实际复验。
