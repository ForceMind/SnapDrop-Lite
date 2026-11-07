> 本文保留短基线历史；当前CI57与小时正常信令证据见末尾及TEST_REPORT_20261107_FINAL。旧“未测/待CI”仅适用于对应历史工具/时点。

# 服务端本机压力与资源短基线

本工具仅在当前隔离测试主机上启动一个新的回环信令服务。**不连接外部或已有服务器，不测试 WebRTC/ICE/DataChannel，不发送用户文件，不代表公网 P2P、NAT 成功率或真实生产容量。**

## 可重复运行

```bash
node scripts/server-load.cjs --help
node scripts/server-load.cjs --connections 64 --signals 20 --duration-ms 1000 --cycles 2 --out test-results/server-load.json
```

需要先按项目文档安装根目录和 server 的锁文件依赖。CLI 参数：

| 参数 | 默认 | 有界范围 / 含义 |
|---|---|---|
| --connections | 32 | 2–1000 的偶数；每两条连接创建一个锁定房间 |
| --signals | 10 | 每端每周期 1–100 条合成 SDP 控制消息 |
| --duration-ms | 1000 | 0–10000；每周期均匀发送的目标窗口 |
| --cycles | 1 | 1–3 个连接/配对/信令/关闭/清理周期 |
| --skip-bound-probes | 不启用 | 仅测普通信令，不执行独立非法/限额探测 |
| --out | 不写文件 | 主动指定 JSON 输出位置；实际路径不会进入报告 |

每次运行都 fork 独立 Node 服务进程，以 96 MiB V8 old-space 上限启动，与现有 systemd 模板一致；**没有施加 systemd MemoryMax 或 OS/cgroup 限制**。父进程是负载发生器，报告 RSS/heap/CPU 来自子服务进程，避免把发生器计入服务端资源。工具有最多约 45 秒硬截止，不接受远程 URL 参数。短基线不能替代持续数小时/数天的 soak；本轮没有完成长期稳定性验收，也不声称达到某个生产并发 SLA。

## 计量口径

- connectHelloLatencyMs：发生器从建立 WS 到收到服务端 hello 的耗时，包含本机客户端、内核和服务端开销。
- signalRelayLatencyMs：合成 SDP 从一个发生器客户端经信令子进程到另一个客户端的耗时；**不是 WebRTC RTT、文件速度或互联网延迟**。
- serverCpu：每周期从开始到普通信令完成的进程 CPU 差额；百分比以一个 CPU 核的墙钟时间计算，含轻量指标采集/IPC 开销，不含父进程 CPU。
- rssBytes、heapUsedBytes、externalBytes 是采样时值；processPeakRssBytes 是 OS 提供的该服务进程历史高水位。maxSocketBufferedBytesAtSample 仅是采样时各 socket 当前缓冲的最大值，不是全运行期间瞬间峰值；不能将它当作完整背压峰值证据。
- 正常关闭后，连接立即归零；session/房间可能按设计在两分钟恢复窗口中保留。工具随后**推进注入时钟**执行真实 sweep，核对 connections/sessions/rooms/WS clients 全部归零；没有真实等待两分钟，也没有据此证明 GC/RSS 回到启动水平。
- 独立探测检查二进制 WS 拒绝（1008）、超过 64 KiB 的帧（1009）、消息频率（1008）和 512 KiB/分钟字节预算（1008）。这些使用有限合成控制数据，不上传文件。慢读者输出背压未被本工具单独隔离验证，报告明确标记未测。
- JSON 只包含固定标签、计数、耗时和资源数字，不包含设备/房间 ID、邀请/恢复令牌、SDP、候选/IP、文件名或输出系统路径；工具不上传报告。

## 本轮实际结果

原始白名单 JSON：`evidence/server-load-baseline-20261107.json`。报告保存了所测 server/tool 源码 SHA-256；当时工作树有尚未提交的改动，base commit 仅供追踪，不能将本地结果冒充后续 head 的 CI。

在共享云端 Linux 测试环境连续运行三个标准 profile，另运行一个 256 连接 profile 和一个 1000 连接、每端仅 2 条消息的上限短 profile；每周期的信令窗口均为 1000 ms。表内 CPU/p95 范围是两个周期的观测值，RSS 高水位含本次协议限额探测：

| 运行 | 连接数 | 每端消息/周期 | 周期 | 服务进程峰值 RSS MiB | CPU/单核 | 控制消息 p95 ms | grace 后状态 |
|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 64 | 20 | 2 | 52.40 | 6.71–10.90% | 2.240–3.898 | 全部归零 |
| 2 | 64 | 20 | 2 | 52.74 | 7.67–11.80% | 2.699–5.924 | 全部归零 |
| 3 | 64 | 20 | 2 | 51.61 | 7.04–10.26% | 1.989–4.654 | 全部归零 |
| 4 | 256 | 40 | 2 | 69.27 | 33.83–34.37% | 5.283–6.025 | 全部归零 |
| 5 | 1000 | 2 | 1 | 79.14 | 29.70% | 14.862 | 全部归零 |

1000 连接 profile 实际建立 1000 个 session 和 500 个双人房间，精确转发 2000 条合成控制消息；它只持续一个短窗口，不代表 1000 个高流量活跃用户或长时容量验收。以上负载刻意低于每连接 240 条/分钟预算；所有合成信令均精确收齐，非法/限额探测按预期关闭，所有周期的容器状态在推进恢复时钟后归零。RSS 未断言归零：V8/分配器保留内存、GC 时机与共享主机竞争都会影响短观察。不可将该表推广为 1C/512MB、1000 用户、真实 Nginx/TLS 或公网吞吐承诺。

## 本轮发现与回归

容量预检原来只发生在 WS 升级时：预置 999 个合法离线 session 状态、先升级两个真实 WS 再同时 hello，旧服务会分配到 1001 个 session。现将新 session 容量校验放在 hello 实际分配之前，保持独立 1000 连接上限；满 session 表时原身份可以在有界 transport 内恢复，新身份仍被拒绝。`tests/server-capacity.test.cjs` 用预置状态避免每次单测创建 1000 个连接，另有真实双 socket hello、合法恢复和 transport 上限回归。该修复不改变配对身份、安全码、接收同意或 Direct-only 文件通路。

`tests/server-load.test.cjs` 运行实际 fork 服务与 CLI，验证信令计数、资源清理、四类限额、参数上限、远程地址拒绝和隐私字段边界。后续 CI 应对精确提交重新执行短 profile；真实设备/NAT、长期 soak、慢读者极端背压和生产部署仍分别验收。

## 浏览器资源口径补充（历史 CI52 页面级实测）

`tests/browser-resources.cjs`仅用于自动化：每个0/100MiB/1GiB文件，从自动选文件/接收确认之前到最终verified complete之间，对两个Chromium页面以默认1秒采样，最多360点。Runtime.getHeapUsage输出JS heap used/total、embedder heap和backing storage；后者含ArrayBuffer backing及外部字符串。Performance只保存TaskDuration、ScriptDuration、LayoutDuration、RecalcStyleDuration累计秒数及差额，计数reset或只有单点时delta为空。

这些数值不是浏览器总RSS、Worker/GPU/所有进程内存、全进程CPU或硬内存上限，峰值只代表采样观察到的峰值。停止采样后再执行独立磁盘rehash；采样仍包含测试UI/IPC开销。Firefox/WebKit明确unsupported且不补零。命令超时/会话断开只记录固定错误码，绝不覆盖文件完整性或非relay路径断言；finally会停止并释放CDP会话。真实采样结果必须看对应head的CI，不以mock回归称真实性能成功。

CI52真实采样已归档evidence/ci52-browser-chromium.json：1GiB两端各79点、issues为空，观察峰与TaskDuration口径见TEST_REPORT_20261107。不是浏览器总RSS/所有进程CPU或硬内存上限。

## 2026-11-07 独立慢读者背压夹具（本地已测，新 CI 待验）

```bash
node tests/slow-reader.cjs --mode auto --out test-results/slow-reader.json
```

该夹具另起一个 96 MiB V8 old-space 的回环信令子进程，最多四个客户端 / 两个合法配对房、两次试验和 45 秒硬截止。真实调用当前服务端 `send()`；只在调用前后观察实际 `bufferedAmount` 和状态，不伪造缓冲值或替换关闭策略。每次发八条合法合成 SDP，发送端合计输入 473162 B / 10 条，低于每连接分钟 512 KiB / 240 条预算；不发送用户文件。独立正常房在慢端暂停及恢复后都实际交换控制消息，发送端须保持连接。

本地当前工具报告 `test-results/slow-reader-current.json`：总墙钟 2732 ms，`auto` 最终 passed。具体分支必须一并保留：

| 分支 | 实际观测 | 判定 |
|---|---|---|
| 默认 socket，仅 `ws.pause()` | 八次真实转发尝试，观察到的 Node 缓冲最大 0 B；未启动阈值关闭 | `threshold-not-reached`，未证明默认 socket 背压保护 |
| 约束测试 socket | 仅修改本次两个测试 socket 的 SO_RCVBUF / SO_SNDBUF；请求 4096 B、Linux 实际均为 8192 B | 实际达到生产阈值并通过 |

约束分支观察到最大缓冲 177454 B，生产 `send()` 关闭前为 177429 B，**确实超过 131072 B 阈值**，随后实际收到 1008 和预期关闭原因；发送端及独立正常房保持可用。没有修改全局内核参数。`auto` 通过只说明至少一个明确标注的分支达到了阈值并验证关闭，不能把默认分支的未达阈值改写为通过。无 Python / 无 socket 句柄或两分支均未达阈值时分别报告 `unsupported` / `inconclusive`，CLI 退出 2，不能静默当作通过。

为读取排队的关闭帧，夹具会恢复接收。资源归零来自受控关闭后**显式推进保留时钟**，不证明永久不读者的关闭握手超时回收、真实两分钟 grace、GC/RSS 回落或公网慢客户端行为。两次试验共用一个隔离服务进程，第二次的 RSS 历史高水位可能包含第一次；CPU 字段只是累计微秒，不能用工具总墙钟推导每个试验的 CPU 百分比。当前本地观测尚未替代新提交的 CI 结果。

## 2026-11-07 schema 2 浏览器进程资源口径（新 CI 待验）

更新后的 `tests/browser-resources.cjs` 保留上述页面 heap / renderer duration，另外尝试从**该页面所属 browser 的 CDP**读取 `SystemInfo.getProcessInfo`，仅检查其报告的最多 128 个 PID。Linux 同 UID 的 `/proc/stat` 在内存读取前后核对 starttime，再读 `smaps_rollup`；读取并发最多八个，有独立超时。不枚举系统其它进程，不导出 PID、comm、命令行、路径、任意进程类型或原始协议错误。

| 字段 | 含义与限制 |
|---|---|
| `rssSumBytes` | 观察到的 browser 进程 RSS 之和；共享驻留页会被重复计算，不是独占物理内存 |
| `pssSumBytes` | 对共享页分摊后的进程 PSS 之和；仍不是整机内存，也不覆盖未被 CDP 列出的进程 |
| `cpuObservedCumulativeSeconds` | 同 PID / starttime、连续可比较 CDP CPU 累计秒数的差额之和，含进程内各线程；初次只有基线时缺省，不补零 |
| `cpuIntervalComplete` / coverage | 新建、退出、读不到、PID 复用或计数重置都会留下缺口；两次采样间出现又退出的短进程不可见 |

顶层页面采样状态和 `processes.status` 是两个范围。进程字段可为 `supported` 且 `partial`，某个可用 RSS 值不等于全部 PID / CPU 区间覆盖。必须逐字段查看 `availableFields`、`rssComplete` / `pssComplete`、CPU comparable / complete interval 数以及 `issues`；字段缺失、超时或不支持保持缺省，不能解释为零资源或零故障。浏览器上下文缺少 owning-browser CDP、非 Linux / 不共享 PID namespace、Firefox / WebKit 时，进程观测明确 unsupported / unavailable。

普通双上下文可能共用同一个 browser，sender / receiver 的进程报告会重叠，不能相加当作两台设备的总量；独立 persistent browser 也仍处在同一测试主机。页面 `TaskDuration` 不是全进程 CPU 百分比，进程 CPU 差额也不是整机 CPU、功耗或性能承诺。观测包含其它同 browser 页面及测试 / 采样开销；采样峰值不是硬内存上限或完整瞬时峰值。PID 在 CDP 列表与 proc 读取间退出/重用仍是采样边界，不能用进程列表声称所有短命进程都已计量。

schema 2 边界回归使用受控 CDP / proc 夹具检验 PID 更替、截断、权限和超时；实际 Node proc 读取只验证解析器。**当前 schema 2 进程资源的真实 Chromium / 1 GiB 数据仍待新 CI**，不能沿用 CI52 页面级数据证明新字段已实测，也不能用文件 E2E 通过代替指标可用性判定。指标失败不会覆盖文件完整性或非 relay 路径断言。

## 真实墙钟长测（仍在运行）

新增 [SERVER_SOAK](SERVER_SOAK.md) 使用原生时钟、真实心跳和同身份周期重连，分钟采样后关闭连接，实际等待 120 秒 grace 及自动 sweep。2026-11-07T08:12:05.172Z 启动的 64 连接 / 32 房 / 3600 秒 profile 本段记录时仍在运行，**尚未通过一小时验收**；必须读取最终状态和真实回收结果。它与上面的推进时钟短基线、约束 socket 慢读者、浏览器资源观测分别计量，不互相替代。

冻结版 soak 工具末次活动窗口对客户端异常标记的检查仍有边界，见 SERVER_SOAK：正常预期信令计数/资源结果不能扩展为所有末尾异常都已捕获。后续修复应保留正在运行工具的源码哈希和真实证据对应关系。


## 永久不读取客户端的独立真实超时（2026-11-07）

新增显式参数，普通Node单测仍只跑快速边界：

```bash
node tests/slow-reader.cjs --permanent --out test-results/slow-reader.json
```

除了恢复读取核验1008的原场景，`--permanent`另建四个新连接，并在受约束测试socket触发生产背压后始终保持接收端pause。未修改ws默认关闭超时、未推进时钟、未恢复该端读取；隔离服务真实约30秒从CLOSING到CLOSED、连接和WS clients由4降至3。等待期间和终止后独立房间仍双向正常。此场景没有读取关闭帧，不能声称客户端收到1008；默认TCP大缓冲未达阈值的结果仍保留。

精确上述命令在本地通过，报告 `test-results/slow-reader-permanent-final.json`：总32877ms，服务端关闭等待30000.706ms，父端观察等待30049ms。最后session/房间清理仍通过明确注入时钟完成，与1小时soak的真实grace分开。固定45秒硬截止，Python只调整测试socket缓冲；不是互联网慢客户端分布、文件吞吐或生产容量承诺。

报告新 `source.serverSha256` / `source.toolSha256` 分别为 `b3aa2d2f4a3f6a547f3e6bb7661f010bcbf326702461c425657fddadd850e52f` / `900ddac825867eafdffeb6b0a99e91274ab70bf0643928061dfbc7947da8aa21`。启动前读取固定文件、结束后再次核对一致；哈希是版本关联信息，不是独立签名或远程证明。后续CI须验证本轮源码，不沿用旧版三秒用例的结果。


## CI57最终云端与当前口径

172adc8/285项完整CI57已通过。原始ci57-browser-chromium.json：1GiB每端82样本，5个owning-browser进程，82个RSS/PSS完整样本/81个CPU完整可比区间，issues为空。两个独立persistent profile的RSS观察峰673710080/660803584B，PSS峰302493696/298561536B，累计观察CPU121.38/123.66秒。所有逐字段coverage与limitations保留；RSS重复共享页、PSS比例分摊、CPU样本缺口、页面报告重叠和非硬内存上限限制仍适用。

ci57-slow-reader.json保留默认TCP未达阈值、约束socket触发177429B并恢复读取确认1008、另一个永久不读者真实30000.425ms后4→3及健康房间通过。永久等待时未推进时钟；最终session清理仍明确注入时钟，与SERVER_SOAK的真实grace分开。工具900ddac8…、server b3aa2d2f…精确源哈希在报告内；没有改生产超时或全局内核设置。

本机64连接一小时正常信令及真实121.902秒回收已完成，原始65快照/旧b19f工具监测边界和RSS增长见SERVER_SOAK。该结果不提升为生产容量、全流量/多日稳定或公网文件吞吐承诺。
