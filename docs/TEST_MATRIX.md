# 测试矩阵与证据范围

## 当前完整验收（CI52）

[a1dfef9 / revision 6a2caec304bbd413 全套通过](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42349478384)：196项、三引擎发送清单且errors为空、1GiB/100MiB、六组合双向独立哈希、恢复/OPFS、UI与HTTPS/WSS。实际范围/原始JSON见 [TEST_REPORT_20261107](TEST_REPORT_20261107.md)。所有实机/公网/生产/长时验证仍开放；下面较早的数量和“待下轮”均为历史过程。

## 2026-11-06 本轮基线与新增回归

启动时本地77项；第一批提交 `906a15c` 为105项；第二批整合后134项、静态发布边界加固后139项全部通过。新增覆盖发送/ICE代次隔离、OPFS锁内一致性和Worker队列、配额失败、空MIME、候选包/回滚事务、速率采样、脱敏mDNS预检及CI源配置边界。第二批新增断点准备6项、恢复所有权4项、双向ID冲突3项、部署3项、APT6项，均为可复现隔离测试。后文旧CI编号均是历史证据；新增真实浏览器场景以对应head Actions为准。

CI #44（42208443915）通过105项、构建/审计及TLS/WSS，但APT下载114MB/181包仅到第39项即耗尽18分钟预算并取消，浏览器全部未运行。见 evidence/ci44-infrastructure-timeout.json。CI源码候选包改在浏览器安装前上传，明确不包含浏览器通过结论；安装有独立10分钟上限，整套30分钟。CI45已保留浏览器默认原生控制，再配置Linux Avahi/NSS并预检，对比六组合严格文件矩阵与原生探针。CI45全部通过：预检后严格六组合双向文件/独立SHA-256、Chrome1GiB/Firefox100MiB、存储恢复和UI。mDNS预检和原生探针本身不是文件传输成功证据。

UI新增可见/禁用控件焦点循环、剪贴板缺失时手动复制、消息编辑键盘循环；浏览器新增中文特殊文件名/空MIME恢复。以上新浏览器断言在CI45通过，详见 TEST_REPORT_20261106 与 ci45-*.json。

## 历史完整验收（CI47）

代码848d16c、revision dd492385685e4a1f：139项、20项公共输入快照边界、真实HTTPS隐藏路径404/.well-known200、六组合双向文件、Chrome1GiB/Firefox100MiB、OPFS/刷新/队列与新UI全部通过。代码cfdda0c/CI45、9ad/CI46是此前已通过基线，后文具体旧编号保留作历史证据。最新原始JSON见evidence/ci47-*，完整范围见TEST_REPORT_20261106。

## 自动化

| 场景 | 方法 | 状态 / 范围 |
|---|---|---|
| 两人邀请、隔离及第三人拒绝 | 实际 WS 集成 | 通过 |
| 过期、短时重连、恢复令牌失效 | 实际 WS + 可控时钟 | 通过 |
| Origin / 路径 / 限速、拒绝文件及二进制 | 实际 WS 集成 | 通过 |
| 双端诊断与文件离线证据校验 | Node 流式 SHA-256 + 白名单诊断工具 | 本地真实CLI子进程/白名单测试通过；代码cfdda0c的CI45已通过Node回归。校验最后连接、版本一致性、拒绝 relay/过期连接、文件不一致与字段脱敏；不等于实网测试 |
| selected pair、拒绝 relay / TURN | stats fixture 单测 | 通过，不等于实网路径 |
| DataChannel 旧通道回调与异步排队消息隔离 | Node VM 真实 transfer/network 源码 | CI #28 通过，3 项新增测试：异步队列、通道替换/关闭、路径代次变化和队列计数归零 |
| 接收前零字节、0 / 3 / 2 MiB 文件 | 协议双端模拟 + sink | 通过 |
| SHA-256 损坏、超限、内存上限、未核对身份 | 协议模拟 | 通过 |
| 已接受文件的同页短时恢复、写入中的偏移、前缀篡改拒绝、伪造恢复请求 | 新增状态机与模拟原生 writer 测试 | CI #15 通过，不等于公网/实机 |
| 同页短时重连保留未发送文件队列 | transfer.js 状态机 Node 测试 | 历史CI已验证同页队列范围；本轮改动已在CI45通过Node回归。覆盖队列原地恢复、重新授权、旧通道禁发、超时释放及 Blob 保存屏障 |
| 真正 WSS 中断 / 新 peer / 原生 OPFS 8 MiB 恢复 / 独立 SHA-256 | Chromium + Firefox 双上下文 E2E | CI #16 均通过；同机 STUN 关闭，不代表公网 NAT 实测 |
| 构建两次一致、资源引用、PWA 图标 | 实际构建 | 通过 |
| Chromium 页面 / 邀请 / SDP / selected UDP 路径 | 双 profile 浏览器 | CI #10 完整通过 |
| Chromium ↔ Firefox 双引擎双向真实 DataChannel / 独立 SHA-256 / WS 零正文 | 两个不同 Playwright browser engine | CI #31 通过：每个方向 1,048,785 B、人工核对安全码并明确接受；同机 STUN 关闭，不是公网 NAT 验证 |
| Chromium 实际 DataChannel、100 MiB / 1 GiB 原生写入 | 双 profile E2E | CI #10 全部通过（原生 OPFS） |
| Firefox 完整 E2E | CI #10 实际执行 | 通过：含 100 MiB / SHA-256 / WS 无正文 / 配额失败后继续传输 / 会话恢复 |
| WebKit 手机 UI | CI #10 smoke | 通过；不等于 iOS Safari 实测 |
| Chromium ↔ WebKit 双向真实 DataChannel 文件/下载/哈希 | Playwright Linux WebKit + Chromium，同机关闭 STUN | CI45在Avahi/NSS验证环境已通过六组合（每方向约1MiB/独立SHA-256）；以下是历史失败：CI #40/#41 **未通过**：两端 ICE gathering 完毕、2/2 host candidates 服务端转发，但 ICE 仍为 new，无选中 pair；Issue #5保留真实Safari验收，旧Linux阻断在CI45解除。不能代替Safari/iOS真机 |

E2E 通过时会记录实际 selected pair、独立下载 / 磁盘 SHA-256、服务器 WS 字节计数与正文 sentinel 检查。原生文件流使用浏览器 OPFS writer；测试只代替 picker 选择，不证明真实用户 picker 授权体验。CI 网络同主机不能替代公网 NAT 场景。

2026-10-19历史快照：24项Node与当时Chromium/Firefox文件、WebKit仅UI的自动化范围在7e83ba4的CI #10通过。新增锁定成员/会话期限单测及“已配对邀请提前到期后继续真实文件传输”场景；这不代表真实持续运行 12 小时。早到信令实际捕获 Chromium 2 / Firefox 3 条；三个浏览器实际诊断下载通过。方法和固定提交见 TEST_REPORT_20261019。实机方法见 [REAL_DEVICE_TESTING](REAL_DEVICE_TESTING.md)。

## 实机发布门槛（均未验证）

| 网络 | Chrome | Edge | Firefox | Safari | Android Chrome | iOS Safari |
|---|---|---|---|---|---|---|
| 同一 Wi-Fi | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 |
| 不同家庭宽带 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 |
| 宽带 ↔ 4G/5G | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 |
| 不同运营商移动网络 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 |
| IPv6 / 双栈 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 |
| 严格 NAT / 防火墙（允许预期失败） | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 |
| Wi-Fi / 蜂窝切换、后台冻结与恢复 | 待测 | 待测 | 待测 | 待测 | 待测 | 待测 |

每个可连接组合测试：文本、图片、视频、多个文件、100 MB 和 1 GiB（能力不足时验证拒绝）。记录双方版本、设备、网络、候选统计、selected pair、协议 / 地址族、时间、哈希、断线 / 拒绝 / 取消 / 暂停结果、服务端是否接收到文件正文。默认不记录完整公网地址及文件正文。

## 本轮新增验收（2026-11-06，浏览器CI待运行）

- tests/retry-queue.test.cjs：8项，失败不自动重offer/fresh ID/授权/expiry/断线/held清空/Blob屏障，已本地通过。
- tests/send-queue-store.test.cjs：14项，完整内容重选/上限/TTL/损坏/CAS/配额/取消/有界读取，本地通过。
- tests/server-capacity.test.cjs：3项实际WS，在hello原子分配容量及满表恢复；填充离线session夹具避免单测开千个socket，非压力结论。
- tests/browser.cjs：新增真实重试、fresh接收同意、队列保留和保存屏障；tests/send-queue-browser.cjs新增跨刷新发送清单，待对应head的CI，不沿用旧通过状态。

- tests/send-queue-ui.test.cjs：10项，直接执行真实UI class与实际store，验证撤回同意、跨标签、旧异步load/remove/clear/send隔离及最终哈希才删除；本地合计177项通过。
- scripts/server-load.cjs：64/256/1000连接实际短profile精确收齐及资源回收，server RSS/CPU独立于负载发生器，原始报告见SERVER_PERFORMANCE。不是长期soak、真实WAN或文件速度证据。

CI50实际新增清单：Chromium/WebKit全流程和390px截图通过；Firefox原复选框刷新断言失败，已修复但等待新CI。CI50 Chromium1GiB恢复执行并通过。测试专用browser-resources只采Chromium目标CDP有界JS heap/backingStorage/renderer duration，遇不支持字段缺省，非RSS/全CPU。实际数据待新CI，4项采样边界+2项表单恢复回归使本地Node合计183项。

握手修复新增10项实际network+transfer源码回归（旧代码可复现单向丢hello后提前verify），以及1项连接阶段分类；nonce ACK先到、旧通道/epoch、已open绑定、十次截止、legacy兼容和重复消息无echo均覆盖。锁回调2项回归先红后绿，证明原Quota/Corrupt对象对调用方保留而不逃出锁callback。合计196项本地测试，真实浏览器结果待新head。
