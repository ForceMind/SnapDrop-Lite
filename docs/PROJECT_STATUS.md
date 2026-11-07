# Zeydrop 当前工程状态

更新时间：2026-11-06。版本0.3.0-dev.1，分支 `feat/direct-first-workspace-20261019` / Draft PR #2。最新已验证运行代码 `848d16c1bd1e419ab30c543f8afa0eb0c0c2ff1e`，build revision `dd492385685e4a1f`。

## 本轮持续研发（2026-11-06，新功能验收未通过）

在a59204e/CI48全绿的基础上继续修改开发分支：

- 失败任务独立重发及保留后续队列，fresh ID/接收同意/保存屏障；8项新协议回归通过。
- 自愿跨刷新多文件发送清单，完整哈希重选/新配对/手动发送/成功逐项删除；14项存储回归通过，新增真实浏览器验收待CI。
- 修复hello会话容量竞态及满表阻断合法恢复，3项实际WS边界回归通过。
- 服务端独立进程压力/RSS/CPU/回收工具已运行：64/256/1000连接短基线精确收齐、恢复时钟推进后状态归零，详见SERVER_PERFORMANCE；不代表长期soak或公网。
- 新UI异步代次、撤回同意与Firefox表单恢复补12项实际class回归。本地合计183/183、依赖审计零已知生产漏洞、构建/脚本检查通过；浏览器CI待验收。

[CI49](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42346993080)在新增发送清单E2E首个保存检查前出现TypeError，两端实际直连已建立，未确认根因；原始去敏证据ci49-send-queue-failure.json保留。177项、压力、HTTPS、恢复、Firefox100MiB、WebKit UI和六组合通过，Chromium1GiB因前序失败跳过。

4deda00补安全源码行号和三引擎清单测试；86c6ae4将main的既有历史文档同步入开发分支并保留历史说明，解决add/add冲突，main本身未改。[CI50](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42347854091)正在重验。13e8a01候选188文件独立解压/重装/177测试/无.git重建及CI归档逐字节一致，见candidate-extraction-13e8a01-20261107.json；它不是浏览器验收通过声明。

上述运行时代码不能沿用CI48的绿灯，完成本轮构建、压力及浏览器矩阵后才交付新验收候选。main/生产均未改，PR2保持Draft。

## 当前结论

- [CI #47完整通过](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42216448334)：**139/139 Node**、依赖审计、可重复构建、Nginx/临时HTTPS-WSS、Chromium1GiB/Firefox100MiB、恢复、WebKit UI及六组合双向文件/独立SHA-256。
- Linux WebKit云端阻断已解除：默认原生环境失败，补齐并预检Avahi/NSS后，同默认浏览器策略的原生和严格产品六组合通过。未关闭产品mDNS、改写候选或放宽selected非relay/安全码/接收授权门槛。真实Safari仍在Issue #5，真实网络/主机在Issue #4。
- 已交付**可供用户隔离部署测试的开发候选**；未达到正式RC/稳定发布门槛。main、生产、用户电脑未改；原地仓库更名最后由用户手动完成，不假定拥有zeydrop.com。

## 实现和本轮修复

| 范围 | 实际行为 | 验证边界 |
|---|---|---|
| 配对/直连 | 128-bit邀请、未配对15分钟/锁定会话最长12小时、短时恢复令牌、标准ICE/STUN、selected已知非relay、双方核对DTLS码 | 同机真实WS/WebRTC；无真实NAT成功率 |
| 文件 | 16KiB分块、256KiB写入ACK、背压、完整SHA-256、多文件/暂停/取消/拒绝、64MiB有界回退 | Chrome1GiB/Firefox100MiB/0B/特殊文件名/独立磁盘哈希；真实picker待测 |
| 恢复 | 同页120秒；接收方自愿OPFS跨刷新，双方新配对/重选原文件/前缀及完整哈希 | 原生OPFS/Worker/并发与刷新通过；硬件存储驱逐/配额/后台待测 |
| UI/PWA | 工作台、邀请/二维码、明暗/手机布局、授权、传输/失败、本机暂存、收起高级诊断 | WebKit新版键盘/复制/布局smoke通过；触控/屏幕阅读器/实际PWA升级待测 |
| 发布 | 干净追踪源码+核验dist、有限秘密扫描/逐文件清单、部署/回滚锁/权限/Node路径/真实WS hello | 云端包/故障夹具/TLS-WSS通过，实际systemd/TLS主机仍未演练 |

本轮修复发送和ICE代次、旧异步错误、空MIME、存储配额失败、OPFS锁内重读及Worker事务；准备中的本地前缀不提前暴露为可续传状态，旧peer失败按精确state所有权传播，双向ID冲突拒绝于sink分配前，避免writer/64MiB预算泄漏。新增可见/启用控件焦点循环、复制失败保留文本、近期有界速度/ETA与准确暂存清理说明。

最后复查修复直接构建会把未追踪client/.env和笔记发布至dist的隔离复现问题：**明确20项公共输入快照**，额外文件不发布且不影响revision，文件/父目录符号链接或特殊文件拒绝于替换旧构建前；vendor使用已验证快照。Nginx拒绝隐藏路径并保留.well-known，真实HTTPS fixture已通过。未观察到真实用户秘密泄漏。规则见ARCHITECTURE、SECURITY_AUDIT_20261106和AGENTS。

## 可验证候选与证据

[代码848d16c的候选附件](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42216448334/artifacts/13500684979)，保留至2026-11-13；tar.gz SHA-256：

```text
71ee5a318084206013aac2865653eb2a4c21adf998c3565427ad2ffece0d82e2
```

本地独立解压167文件逐项哈希/权限通过，实际重装依赖、139项测试、无.git重建通过；Node24本地与Node22 CI归档逐字节一致。manifest记录CI临时合并树5a097e7，源分支为848d16c，文件树相同。包在浏览器前生成，须结合该run全套结果；有限扫描不证明所有秘密不存在，SHA-256不是签名。

完整报告 TEST_REPORT_20261106；原始脱敏JSON与汇总 evidence/ci47-*.json；独立包核验 candidate-extraction-848d16c-20261106.json。部署/回滚说明DEPLOYMENT；外部矩阵RELEASE_GATES、TEST_MATRIX、REAL_DEVICE_TESTING。

## 必须继续的外部验收

- 两条真实运营商/蜂窝/跨宽带、IPv6/NAT64/CGNAT/严格NAT、切网/后台冻结；无法选中非relay路径时应明确失败，不切换服务器文件代理。
- Windows Edge、macOS/iOS Safari、Android、真实文件picker/磁盘/配额/驱逐/触控/屏幕阅读器/PWA。
- 用户独立测试主机：可信域名证书/续期、systemd、迁移、重启、失败恢复及回滚。云端没有这些设备/链路/主机，未操作用户生产环境。
- 跨刷新发送清单本轮实现、等待新CI与真机验收；显式同意LAN自动发现仍未实现。同页队列已支持；OPFS24小时后过期/最多20项，清理仅站点运行时尽力执行，不保证恢复或后台删除。

启动head0c7bf14/77项；906a15c→105；cfdda0c→134/CI45、9ad3ddc→CI46全绿；848d16c→139/CI47全绿。CI44曾因APT慢源耗尽18分钟而取消，未运行浏览器；过程证据与修复保留。早期累计状态保存在history/PROJECT_STATUS_before_20261106_audit.md及Git历史。以后运行时代码改动须重新验证，不沿用本次绿灯；保持Draft，不自动合并main或部署生产。

### CI50新增定位与修复（待下轮验证）

Chromium/WebKit的发送清单全流程已通过，Firefox首次保存/完整哈希通过，但刷新时浏览器恢复了已勾选同意框，原断言保持并失败于测试line180；不代表File已自动绑定或发送。已对同意框禁用表单恢复，并在初始化/pagehide/BFCache返回时清空许可及文件控件，新增2项实际UI回归。CI50的Chromium1GiB/Firefox100MiB通过；六组合另有Chromium↔WebKit底层已直连但应用hello未就绪的失败，其余5组通过。该失败不能归因于未知selected路径，需修复应用握手。原始三引擎结果见ci50-send-queue-browser-*.json；CI49 TypeError未再复现，但原失败保留，不倒推为通过。

新增测试专用CDP资源采样：有限频率/样本/白名单字段，JS heap、backingStorage（含外部字符串）与renderer duration单独记录，非RSS/全CPU或内存硬上限；Firefox/WebKit不支持时明确unsupported。新增4项计量边界测试，握手修复前本地总计183项。真实CDP数据须后续CI，不伪造当前本地浏览器采样。

### 待下一轮CI的连接修复

已用旧HEAD实际复现单向首条hello丢失后提前verify，加入每通道随机nonce/实际处理后ACK/最多10次重发及协议就绪门槛，保持路径/身份/接收授权；十项生命周期+一项阶段分类回归。旧wire、epoch、nonce、计时器均隔离，legacy v2兼容；文字也共享就绪门槛。

CI51 Firefox清单9项流程均完成，但预期quota/corrupt操作触发两条全局error，最终严格错误断言仍失败。锁回调改为结果包装、锁外重抛原异常，新增两项先红后绿回归。上述修改合并后本地196项，等待新head完整浏览器CI，不标已发布。
