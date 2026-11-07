# Zeydrop 云端验收与开发候选 · 2026-11-07

当前运行代码：172adc8ae2bfc9dd577f56fb92c103a4ad64e78b；revision 10c5794070ac6a1b；版本0.3.0-dev.1。 [CI57完整通过](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42357894421)。这是可在独立测试主机验证的未发布开发候选，不是正式RC/稳定版。PR #2保持Draft，main和生产未改，仓库更名由用户最后手动完成。

## 当前功能及验证

| 范围 | 实际结果 |
|---|---|
| Node/供应链/构建 | 285/285、根与server完整audit零已知漏洞、确定性build/PWA、23项公开输入、实际临时Nginx HTTPS/WSS通过 |
| 文件/授权 | Chromium1GiB、Firefox100MiB、0B/多文件/失败重试、完整SHA-256、接收同意和非relay路径门槛通过 |
| 跨浏览器 | 三引擎清单、严格六组合双向文件/独立下载SHA通过；同一Linux CI主机、STUN关闭 |
| 恢复/数据保留 | 原生OPFS/跨刷新、逻辑前缀取消、旧wire/epoch/同ID隔离；Issue #6的读取/存储失败、迟到finish和旧write记账有先红后绿回归 |
| 本机计算 | 清单保存/重选使用256KiB专用SHA Worker，取消/故障/有界fallback三引擎通过；实时传输及恢复前缀仍主线程 |
| PWA | 清HTTP cache后整页离线仿真、当前版本真实SW/CacheStorage/两个原生Worker、独立SHA/OPFS通过；没有修改产品缓存策略 |
| UI | 实际暂存记录、启用删除按钮、placeholder、房间状态和键盘焦点两主题检查通过；不是完整无障碍认证 |
| 服务端 | 实际慢读者背压及永久不读者约30秒关闭通过，独立健康房间保持可用；精确源哈希和范围见SERVER_PERFORMANCE |

Firefox大文件E2E使用替代picker选择和真实OPFS writer，不是Firefox真实保存对话框能力证明。Linux WebKit不是Safari/iOS硬件；其哈希基准未完成100MiB OPFS，只实测8MiB Blob回退。

## 修复后的数据策略

读取/哈希引擎、quota/permission、park提交失败不再证明旧partial无效；已提交断点保留，下一次仍须原件/新配对/核码及接收授权。完整可信SHA不匹配、主动取消当前文件和手动删除保持各自处理。未提交尾部可能被截断。

过期交接/活动连接失败均等待已开始的旧write及adopt barrier，正确结算原state的offset/SHA后再park；不能按ID取消新文件。finish仅使用本地真实匹配的finalSHA；transient迟到本机结果不自动报远端成功。RPC最多32项未完成，前缀每片≤256KiB、共享4项底层I/O。

逻辑取消不等于终止磁盘I/O；restore/park挂起或native close抛错仍可能延迟物理锁释放，不能保证底层立即解锁。具体故障复现及独立复验见ENGINEERING_AUDIT_20261107；真实磁盘耗尽/驱逐尚未验收。

## CI57性能观察

| 哈希基准 | 实际大小/来源 | Worker/main ms | 最大16ms interval间隔 Worker/main ms |
|---|---|---:|---:|
| Chromium | 100MiB原生OPFS File | 1740.3 / 1724.7 | 16.1 / 17.8 |
| Firefox | 100MiB原生OPFS File | 2312 / 2265 | 17 / 21 |
| Linux WebKit | 8MiB Blob回退 | 243 / 464 | 21 / 50 |

一次共享Runner上的耗时不是速度承诺，Worker不保证更快，也不代表移动响应性。原始ci57-file-hash三份JSON保留能力/实际大小和独立SHA。

Chromium1GiB的两个独立persistent browser profile各82点；每份报告均5个CDP报告进程，82个RSS/PSS完整采样、81个CPU可比完整区间，issues为空：

| owning-browser报告 | RSS相加观察峰bytes | PSS相加观察峰bytes | 观察区间累计CPU秒 |
|---|---:|---:|---:|
| sender | 673710080 | 302493696 | 121.38 |
| receiver | 660803584 | 298561536 | 123.66 |

RSS会重复计算共享页，PSS按共享比例分摊；CPU是同PID/starttime区间差额累计的最后值，不能用last-first。瞬时峰值可能被1秒采样漏过，进程新生/退出/复用/权限失败会留下缺口；同一browser的多个页面报告不能当独立设备相加，亦非整机测量。0B单点无CPU可比区间，Firefox/WebKit的CDP指标明确unsupported。数据、逐字段coverage和limitations完整保留。

永久不读者CI57真实关闭30000.425ms、连接/WS数4→3、两次等待中健康交换及终止后交换通过；最后session清理明确注入时钟。默认TCP缓存吸收该有限批次，未触发阈值的分支仍保留；成功背压使用仅测试socket的缓冲约束，非全局内核调整。

## 小时信令

本会话真实执行后退出0：3600003ms活动、3722082ms总墙钟、65个快照；15360条预期信令全部收齐、46008个真实pong、59轮/472次原身份恢复。活动快照均64连接/64session/32房/64WS clients；正常关闭后真实再等121902ms，原定时sweep将四计数全部归零，未推进时钟或手动sweep。

原始evidence/server-soak-1h-20261107.json SHA-256为9b0161eb699e7f6af2d33cc07490b02e386c54d52b3c9f00386546a75a42882d。使用4d617b1中b19fd3b4…工具、server b3aa2d2f…源码，不冒充后续00f末尾异常检查工具跑过一小时；新工具另有6秒活动及真实124021ms回收。监测边界详见SERVER_SOAK。

活动RSS首42,217,472/末56,672,256B、观察峰57,692,160B，服务进程OS高水位58,458,112B；存在观察增长，不能称无泄漏或硬内存界限。端点CPU差约1.754秒/3600秒（约0.05%单核），只限低频本机合成信令，非网页/TLS/文件吞吐/生产容量。信令p95桶上界5ms、实际最大7.254ms，不是WebRTC RTT或互联网延迟。

## 源码候选与独立复验

[CI57源码包](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42357894421/artifacts/13568541404)已独立解压，246项权限/大小/SHA校验，重装两份锁文件，285项测试，无.git重建及重复构建，最后再验全部文件一致。manifest记录CI临时合并8b30899ec1c781bf0ccceb8a0c7517df2679da55，源分支172adc8。

- tar.gz SHA-256：766331d11154ab649cd4796003f4caf9a27b77026c2e7e4fd868959ba2bf0f52
- 外层ZIP SHA-256：0288069426b82f9166e36098956db9677ab045b1724c21e7837cfe83ebf69dec
- CI57 evidence ZIP SHA-256：8a1bab9aaeadbd2233667cd76238d4147c103a6fad519e47317949b94480e7eb

原始24份JSON和独立解压证明保存在evidence/ci57-*及candidate-extraction-ci57.json。随后文档头的包会有不同归档哈希；须核对自身manifest/CI，不能沿用上述哈希。运行时输入仍须逐字节与该已验代码一致。哈希不是签名；有限秘密扫描不是所有秘密不存在的证明。Actions artifact默认7天，Git中的源码/证据持续保留。

## 历史失败保留与正式门槛

CI55的唯一失败为PWA组合就绪predicate；CI56明确只有navigator.onLine仍true，实际无缓存HTTP请求已阻断且模块/Controller/缓存正常。CI57分别配置请求阻断和CDP renderer网络提示，全部原断言保留并实际通过，没有重定义navigator或降低Worker/路径/授权校验。CI56被新提交的运行替代；原失败JSON及CI49/50/51等历史均保留。

真实跨运营商/NAT/IPv6/切网、移动/Edge/macOS和iOS Safari、真实picker/磁盘/驱逐/后台/PWA升级/无障碍、独立授权主机TLS/systemd/安装升级回滚仍未完成，见Issue #4/#5、REAL_DEVICE_TESTING和RELEASE_GATES。小时信令不是WAN成功率、文件吞吐、12小时或多日稳定性、生产容量SLA。实时/前缀SHA Worker迁移与显式授权LAN发现仍是后续工程项；服务器文件代理、TURN、DERP均未引入。
