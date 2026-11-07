# 测试矩阵与证据范围

## 追加删除反馈回归

显式删除失败与界面代次分离：隐藏/重开后的失败仍固定提示本机数据可能保留，不操作新行、不恢复旧hash/URL；过期成功保持静默。新增3项，当前本地342/342、revision50be36dcf5f9d638及重复构建通过。需对应新提交CI；下述CI60不验证此追加补丁。

## 当前完整云端基线

3e7fd6c / revision25c4bc95c5f8c577的[CI60](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42368690277)全套通过，339/339 Node、0失败/跳过；已读实际最终日志、下载JSON并独立复验候选。原始证据evidence/ci60-*，报告TEST_REPORT_20261107_STREAM_HASH。main/生产未改，真实外部门槛继续开放。

| 本轮范围 | 实际方法及结果 |
|---|---|
| 状态式SHA Worker | 三引擎原生快照继续/最终释放、独立SHA、调用方buffer不detach、4句柄/4操作/256KiB、故障/超时/隔离取消通过 |
| 异步传输 | 旧wire/接管owner、写入后update失败、snapshot/final取消、无错误ACK/完成、双向故障隔离及4句柄并行前缀恢复通过 |
| 原生OPFS故障恢复 | 真实SHA Worker在1MiB检查点后额外16KiB落盘时崩溃；原metadata保留、重载前取得锁、另一活动记录完成、新授权后3MiB尾部/4MiB完整SHA通过 |
| 文件/浏览器 | Chromium1GiB、Firefox100MiB、0B/多文件/原生保存、8MiB同页恢复；全部live句柄为Worker、结束0租约；严格六组合双向SHA通过，STUN关闭/同机 |
| 生命周期 | 自然会话过期、8项取消清理异常、10项暂存UI/代次/各自取消/20URL上限及60秒宽限通过；注入错误不是实际磁盘故障 |
| PWA/UI/部署 | 三个精确revision Worker实际离线缓存启动、深浅/键盘/对比度、临时HTTPS/WSS/Nginx、audit/构建通过 |
| 候选 | 304文件安全解压/manifest/权限/大小/SHA，独立重装339测试/无Git重建，29构建字节一致；实际CI归档相同 |

真实WAN/NAT/IPv6/移动/Safari/存储驱逐/PWA升级和独立主机部署仍未验证，不从上述结果推断公网成功率、硬件表现或生产SLA。

## 既有完整云端基线

172adc8 / revision10c5794070ac6a1b的 [CI57](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42357894421)全套通过，285/285 Node。完整原始证据见evidence/ci57-*与TEST_REPORT_20261107_FINAL。下面的通过均限定对应环境，不转化为真实公网/硬件成功率。

| 场景 | 实际方法 | 结果/限制 |
|---|---|---|
| 协议、安全、恢复、存储、部署及构建边界 | Node VM/真实WS/本机脚本隔离夹具，共285项 | 通过；故障注入不是实际磁盘故障 |
| Origin/类型/二进制/帧/消息与字节预算 | 真实回环WS、生产信令代码 | 通过，无文件代理 |
| 已选非relay路径、人工核码、接收同意 | 真实浏览器/WebRTC/RTCDataChannel | 文件发送前均须满足；未知/relay不放行 |
| Chromium↔Chromium | 双向约1MiB、下载独立SHA | 通过 |
| Firefox↔Firefox | 同上 | 通过 |
| Chromium↔Firefox | 同上 | 通过 |
| Chromium↔Linux WebKit | 同上 | 通过，非Safari硬件 |
| Firefox↔Linux WebKit | 同上 | 通过，非Safari硬件 |
| Linux WebKit↔Linux WebKit | 同上 | 通过，非Safari硬件 |
| 0B/100MiB/1GiB、中文及多文件、拒绝/暂停/取消/手动重试 | Chromium实际数据通道/原生OPFS writer；1GiB用两个persistent profile | 通过；picker由测试替代选择 |
| Firefox100MiB及同页恢复 | 原生OPFS writer+替代picker、独立SHA | 通过，不证明真实保存对话框支持 |
| OPFS写入/检查点/跨刷新/锁/删除与恢复 | 真实Chromium Worker/OPFS及WebRTC流 | 通过；设备驱逐/磁盘耗尽仍待真机 |
| 发送清单 | 三引擎真实UI/刷新/重选完整SHA/重新配对/手动发送 | 通过；不自动恢复File句柄或授权 |
| 文件哈希Worker | 三引擎原生Worker、故障/取消/显式无Worker fallback | 通过；基准Chrome/Firefox100MiB OPFS，WK只有8MiB回退 |
| 暂存错误保留/旧write记账/迟到finish/expired handoff | 先红后绿源码/存储故障、独立5B复验和真实OPFS happy path | 通过；Issue #6关闭该云端复现范围 |
| RPC32上限/序号耗尽、前缀256KiB/共享4挂读 | 源码实际队列/未resolve I/O夹具 | 通过，不声称终止底层磁盘I/O |
| 离线PWA | 真SW/cache/Worker；清HTTP缓存、Playwright请求阻断+CDP renderer离线仿真 | 通过；实际无缓存HTTP拒绝及原navigator断言保留，非OS断网/升级生命周期 |
| 深浅UI、暂存记录/启用删除、placeholder/键盘焦点 | 真实Chromium用户入口/原生记录/computed style/组件截图 | 通过，非完整WCAG/真机验收 |
| 布局/PWA/HTTPS/WSS/静态隐藏路径 | 三引擎UI与真实临时Nginx TLS夹具 | 通过，不是用户主机部署 |
| 浏览器资源 | Chromium owning-browser CDP+/proc，1GiB每端82点/5进程/81 CPU区间 | 通过当前字段；保留unsupported/partial、RSS/PSS和重叠限制 |
| 慢读者/永久不读者 | 真实WS、仅测试socket小缓冲，生产128KiB阈值/真实约30秒超时 | 通过；默认TCP未达阈值仍保留，最终session清理注入时钟 |
| 小时信令 | 64连接/32房、真实3600秒、15360条全收、472恢复、真实121.902秒自动回收 | 通过旧b19f正常流；新guard只有短活动/真实grace，不混同工具版本 |

浏览器同一CI主机，STUN关闭；mDNS默认保留，先保存原生默认控制，再验证Linux Avahi/NSS环境。Linux系统依赖不是产品文件中继。picker/真实网络/Safari/OS存储行为不能由这些通过项替代。

## 必须由真实设备/网络验收（均待测）

| 网络 | Chrome | Edge | Firefox | Safari | Android Chrome | iOS Safari |
|---|---|---|---|---|---|---|
| 同一Wi-Fi | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 |
| 两家庭宽带 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 |
| 宽带↔4G/5G | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 |
| 不同移动运营商 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 |
| IPv6/双栈/NAT64 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 |
| 严格NAT/CGNAT/UDP阻断，允许预期失败 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 |
| 切网/后台冻结/恢复/PWA更新 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 |

每组合记录版本、设备/拓扑、成功和失败样本、实际selected非relay、人工授权、内容独立SHA、服务器是否承载正文。小文件/图片/视频/多文件、0B/100MiB/1GiB按能力测试；不足时验证明确拒绝。另验真实picker、磁盘/权限、存储驱逐/配额、慢设备、独立TLS/systemd升级回滚。见REAL_DEVICE_TESTING，Issues #4/#5保持open。

## 历史失败与可追溯性

CI49未充分定位的首条E2E异常、CI50/51 Firefox许可/hello/锁回调问题及原始证据保留；后续修复不改安全门槛。CI55唯一PWA timeout，CI56逐字段证明只差navigator提示，后被新提交替代；CI57配置正确的浏览器请求/renderer仿真后原断言全通过。原始失败JSON留在evidence/ci55-*、ci56-*。

此前CI52/54、短压力和WebKit mDNS研究结果按各自commit阅读；当前不以历史待验文字代替新结论。main/生产未改，真实门槛不自动打勾。
