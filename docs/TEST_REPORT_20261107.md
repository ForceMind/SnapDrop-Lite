# Zeydrop 工程验收报告 · 2026-11-07 UTC

**结论：开发候选可供独立部署测试，正式RC门槛尚未满足。** [CI52全绿](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42349478384)；源码a1dfef939cb2af1ab64fc987a84a9a18b996f685、revision 6a2caec304bbd413、0.3.0-dev.1，Draft PR #2，main/生产未改。

## 实际通过

- 196项Node；根目录（含构建/测试依赖）及server完整npm audit为0已知漏洞；shell、确定性构建、公共输入/缓存/图标、实际临时Nginx TLS/WSS/隐藏路径保护通过。
- Chromium↔Chromium、Firefox↔Firefox、Chromium↔Firefox、Chromium↔WebKit、Firefox↔WebKit、WebKit↔WebKit均passed/fileTransferExecuted。每组两个方向约1MiB，实际selected非relay、相同安全码和双方人工动作/逐文件接收同意、独立下载SHA-256。
- Chromium1GiB、Firefox100MiB、0B、中文特殊文件名、独立磁盘哈希、暂停/取消/拒绝/配额后继续、短时WSS恢复、接收方OPFS跨刷新、早到信令与UI/PWA检查通过。
- 三引擎的自愿发送清单全流程通过且errors=[]：刷新不绑定、不自动发；反序重选完整内容匹配、同元数据异内容拒绝、新配对/核码、最终complete才逐项删除、Blob保存屏障、配额提示、损坏清单显式删除。每引擎81976字节，两文件均独立SHA-256。
- 新nonce握手的单向丢帧、ACK先到、已open绑定、旧wire/epoch/nonce、十次截止、legacy兼容、重复消息不echo和协议失败分类有回归。相同丢首条hello夹具在旧HEAD可复现提前verify；本次代码阻止半就绪发送。

## 指标及口径

Chromium1GiB样本整体测试93683ms（含更广步骤）；独立SHA-256 `49bc20df15e412a64472421e13fe86ff1c5165e18b2afccf160d4dc19fe68a14`。信令观察45条/1507B，未见测试正文；接收应用队列采样峰值156/180305B，**不是RSS**。Firefox100MiB8379ms，信令8条/1296B，未见测试正文。不能把同机耗时解释为公网速度。

本次1GiB两端各79次CDP采样，status=sampled、issues={}、未达样本上限。发送JS heap used观察峰4,385,648B/backingStorage30,351,486B；接收16,230,108B/96,634,960B。接收backing首点即峰，含前序活动。TaskDuration差额发送41.518284s、接收30.421802s。**这些是目标页面/isolate及renderer累计时间，不是浏览器总RSS、纯ArrayBuffer、全进程CPU百分比或硬内存上限。** 采样窗在最终verified complete停止，后续独立磁盘rehash不在其中，仍含UI/IPC开销。Firefox/WebKit的CDP明确unsupported，不补零。

服务端另有独立进程64/256/1000连接短基线，1000连接/500房间/2000条合成信令精确收齐、约76MiB服务RSS观察峰；关闭后推进注入时钟核对资源归零。详见SERVER_PERFORMANCE与原始server-load-baseline-20261107.json。不是生产容量、文件性能、真实等待两分钟、慢读者极限或小时级soak验收。

## 候选独立复验

[源码附件](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42349478384/artifacts/13564752556)：外层ZIP SHA-256 `2743d0d33ee83606ffd5f5dcd036c0454b88a4101d4a781d7b096169cf733272`；内部tar SHA-256 `972e76dbb6b389ed4abd47489d02ba80a14bb4d5c4c448f1d50db08e07ccf851`。

203文件逐项哈希/权限通过；实际解压、无.git、重装两套锁文件依赖、196测试、重建及全部文件哈希再次一致。Node24.22.1本地与Node22 CI的tar逐字节一致。manifest外部commit为CI临时合并045db8f，branch source是a1dfef9，文件树一致。校验不是签名；源码附件在浏览器前上传，必须结合本次最终success，不能只凭存在附件视作验收。

## 缺陷过程和证据

CI49保留首个TypeError失败，未倒推为通过；CI50保留Firefox表单恢复勾选与C↔W应用hello未就绪（当时底层已direct），分类错误也已修正。CI51的9项Firefox清单流程完成，但Quota/Corrupt锁callback造成两条全局error，最终errors[]断言失败；改为锁内结果、锁外原错误传回后，CI52三引擎errors全部为空。未删除失败断言，未关闭mDNS或放宽selected/身份/接收权限以求通过。

本轮主要改动：client/index.html、ui.js、transfer.js、network.js、send-queue-store.js、styles.css、server/index.js、公共资产清单、CI及对应协议/存储/UI/容量/负载/资源与浏览器测试。代码提交13e8a01→4deda00→86c6ae4（仅同步main到开发分支）→eb80ad4→a1dfef9；完整历史均保留。

## 未验收

同一CI主机、STUN关闭、自动化picker夹具和Linux WebKit不能证明跨运营商/NAT成功率、真实Safari/移动设备/磁盘驱逐/后台/触控/屏幕阅读器/PWA、正式TLS/systemd安装与回滚。Issue #4/#5和RELEASE_GATES保持开放。小时级soak、慢读者极限、全进程资源、哈希Worker、显式LAN发现仍有后续工作，不能称云端全部完工。仓库更名最后由用户手动执行；不使用尚未确认拥有的zeydrop.com，不操作用户生产环境。

原始去敏结果与汇总：evidence/ci52-*.json、candidate-extraction-a1dfef9-20261107.json；完整[Actions证据附件](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42349478384/artifacts/13565171310)保留至2026-11-14。真实设备步骤见REAL_DEVICE_TESTING。
