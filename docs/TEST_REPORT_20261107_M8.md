# M8 资源、哈希与取消验收（进行中）

记录：2026-11-07 00:33 PST。最新完整云端结果为 [CI54](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42355134135)，源分支 `4d617b13e9c0553a358c8deb111a8c8dbb80448e`，revision `cac0d96fd4285f5d`。后续恢复取消/PWA改动仅有本地242项与构建通过，尚待自身CI。1小时实测仍运行，不预填通过。

## CI54 已通过的范围

223/223 Node、根/服务端完整依赖审计、确定性构建/PWA、实际临时Nginx HTTPS/WSS、三引擎发送清单、Chromium1GiB/Firefox100MiB、恢复/OPFS、WebKit UI、严格六组合双向独立SHA-256与默认mDNS诊断均通过。所有浏览器在同一Linux CI主机、STUN关闭，不是Safari硬件或公网NAT证据。

真实原生哈希Worker覆盖0B/abc/256KiB+113B独立SHA、取消后新Worker成功、Worker崩溃明确失败且不回退、无Worker时256KiB主线程回退；严格pageerrors为空，HTTP无上传及信令无测试文件信息。专用Worker目前只接入自愿发送清单的保存/重选，不替换实时传输或恢复前缀增量状态。

| CI54 引擎 | 实际基准来源/大小 | Worker耗时ms | main耗时ms | Worker/main最大16ms interval间隔ms |
|---|---|---:|---:|---:|
| Chromium | 原生OPFS File / 100MiB | 1731.5 | 1725.6 | 16.2 / 17.6 |
| Firefox | 原生OPFS File / 100MiB | 2302 | 2271 | 17 / 22 |
| Linux WebKit | OPFS操作不可用，8MiB Blob回退 | 147 | 111 | 20 / 19 |

耗时/interval只是一次共享桌面Runner的观测。Worker不保证更快；WebKit未完成100MiB OPFS基准，不能改写成三引擎100MiB通过。CPU/RSS来自下面独立采样，不从interval推导。

## CI54 owning-browser 资源观测

Chromium1GiB在两个独立persistent browser profile上各采83点，两个报告均5个CDP报告进程，83/83 RSS与PSS完整采样、82个CPU可比完整区间、issues为空。每个profile包含该browser报告的renderer/GPU/browser/utility等进程；不是只测页面，也不是整台机器或两台真实设备。

| 1GiB报告 | RSS相加的观察峰bytes | PSS相加的观察峰bytes | 观察区间累计CPU秒 |
|---|---:|---:|---:|
| sender browser | 675487744 | 304373760 | 121.25 |
| receiver browser | 664334336 | 300216320 | 123.5 |

RSS相加会重复计算共享页，PSS按共享比例分摊；两者不能混为同一指标。CPU取同PID/starttime相邻计数差额的累计最后值，不用summary.last-first。新生/退出/权限失败/进程复用会留下缺口，缺测不补0；其它场景同一browser的两页报告会重叠，不可相加。峰值只是1秒采样观察，不是内存硬上限或没有更高瞬间峰值的证明。0B只有单点，CPU没有可比区间；Firefox/WebKit不支持CDP，明确unsupported。完整字段/coverage/limitations保存在 `evidence/ci54-browser-chromium.json`。

## 独立源码候选核验

[CI54 artifact](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42355134135/artifacts/13567665454)中226个文件已独立解压、逐项核验权限/大小/SHA，重装锁定依赖、223项测试、无.git重建和重复构建通过，再核对全部文件哈希未变。manifest记CI临时合并 `8b7e9bc530e577084285cc9fc920a68e1cec4f58`，源分支4d617b1。

- 内部tar SHA-256：`bbbb0a0c5e7fad65a4cf97863ff61864226bed4d5b701aef5682916e33115cdc`
- artifact ZIP SHA-256：`c676fee6f35b6420733a824386eb4565e86e41e4f94a8251674fe5f26375bfea`
- evidence ZIP SHA-256：`acca05645dc93f99363f47391889dc196d9defa44628b7abbe463f73b4846ac7`

哈希不是签名，有限秘密扫描不是全无秘密的证明；该候选仅为开发隔离测试，后续源码必须重新构建/验收。

## 后续已落地、待自身CI

发送方恢复前缀读取不再阻塞入站控制；本地/远端取消、超时、断线、旧wire/epoch、乱序控制、短读与4挂读上限都有先红后绿回归。恢复Worker继承已加载脚本revision，新增真实离线整页/两种原生Worker的PWA测试入口。永久不读者实际约30秒终止的独立试验，以及soak末尾异常检查修复/真实124秒grace短复验，精确源哈希与限制见SERVER_PERFORMANCE/SERVER_SOAK。

接收端OPFS准备的底层读取与共享Worker RPC取消仍分别验收；逻辑取消不等于可立即终止磁盘I/O。小时实测完成前保持running，且初版工具b19f的结果不冒充后续00f修复版的一小时结果。

## 正式候选阻断

真实WAN/NAT/IPv6/切网、移动设备和Safari/Edge、真实文件picker/磁盘不足/存储驱逐/后台/PWA/无障碍、独立授权主机TLS/systemd/升级回滚仍未完成，见Issue #4/#5和RELEASE_GATES。无relay、服务器文件代理或生产变更；main未合并、PR仍Draft、更名由用户手动完成。


## CI55实际失败

CI55的242项Node、1GiB/100MiB、原生OPFS/跨刷新、三引擎Worker和清单、六组合及永久不读者均通过；整套失败，唯一失败为离线PWA重载后的组合就绪predicate超时。此前已验证两Worker精确revision已缓存，errors为空；不能确定哪个字段未就绪。原始evidence/ci55-pwa-workers-chromium.json保留，新增逐字段和无缓存HTTP断网探针，原断言不删除。

Issue #6后续断点保留、RPC界限、深色面板/文本/焦点改动需自身CI。夹具故障和物理I/O限制见ENGINEERING_AUDIT_20261107；小时实测仍未结束。
