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

## 浏览器资源口径补充（CI52实测）

`tests/browser-resources.cjs`仅用于自动化：每个0/100MiB/1GiB文件，从自动选文件/接收确认之前到最终verified complete之间，对两个Chromium页面以默认1秒采样，最多360点。Runtime.getHeapUsage输出JS heap used/total、embedder heap和backing storage；后者含ArrayBuffer backing及外部字符串。Performance只保存TaskDuration、ScriptDuration、LayoutDuration、RecalcStyleDuration累计秒数及差额，计数reset或只有单点时delta为空。

这些数值不是浏览器总RSS、Worker/GPU/所有进程内存、全进程CPU或硬内存上限，峰值只代表采样观察到的峰值。停止采样后再执行独立磁盘rehash；采样仍包含测试UI/IPC开销。Firefox/WebKit明确unsupported且不补零。命令超时/会话断开只记录固定错误码，绝不覆盖文件完整性或非relay路径断言；finally会停止并释放CDP会话。真实采样结果必须看对应head的CI，不以mock回归称真实性能成功。

CI52真实采样已归档evidence/ci52-browser-chromium.json：1GiB两端各79点、issues为空，观察峰与TaskDuration口径见TEST_REPORT_20261107。不是浏览器总RSS/所有进程CPU或硬内存上限。
