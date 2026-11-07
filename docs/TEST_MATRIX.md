# 测试矩阵与证据范围

## 本轮更改待验

实时发送/接收及恢复前缀现已接入状态式SHA Worker，已完成本机文件复验使用全文件Worker；新增自然会话到期和写入后哈希失败保留旧checkpoint的路径。本轮必须执行对应提交的完整CI和候选复验，不能沿用以下基线绿灯。本地检查时点324/324 Node、重复构建/语法、双方依赖audit通过；浏览器启动受socket EPERM限制，仍待GitHub Runner的实际执行。

| 新增范围 | 方法/门槛 | 当前状态 |
|---|---|---|
| 状态式SHA Worker | 独立Node摘要、快照继续/最终释放、调用方buffer不detach、4句柄/4操作/256KiB上限、故障/超时/取消及旧消息隔离 | 实现与自动化用例已加入，待完整CI |
| 异步传输集成 | 写入后update失败、snapshot/final期间取消与断线、旧wire/新owner、无错误ACK/完成、精确已提交offset/SHA保留 | 新回归及原生文件矩阵待本轮验证 |
| 发送前缀本机故障 | 读取/Worker失败只取消当前发送文件，同时接收文件与通道继续；保留独立内容校验 | 新2项回归本地通过，待完整CI |
| 永久会话退出 | 真实server过期消息次序驱动network+transfer，不保留身份，普通sink/主动取消策略不变 | 新回归待完整CI |
| 当前PWA Worker缓存 | 三个Worker均为批准源码、本地打包、精确revision及原生离线启动 | 新stream Worker须随本轮复验 |
| 已完成暂存下载 | 全文件Worker结果大小/格式/完整SHA均核对后才建URL，失败可管理重试 | 新UI回归待完整CI |

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
