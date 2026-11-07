# Zeydrop 当前工程状态

记录：2026-11-07 UTC。版本 **0.3.0-dev.1 未发布开发候选**，开发分支 `feat/direct-first-workspace-20261019` / [Draft PR #2](https://github.com/ForceMind/SnapDrop-Lite/pull/2)。

## 本轮进行中（2026-11-07 00:19 PST）

基线开发头 87953ed 的 CI53 全套通过；以下新改动尚未推送/未取得本轮浏览器 CI：发送清单专用分块哈希 Worker（含取消/错误/本机进度）、23项公开输入构建、owning-browser 进程 RSS/PSS/CPU 观察、真实慢读者 WS 保护及墙钟 soak 工具。本地 Node 223 项与构建通过。实时传输/断点前缀哈希仍在主线程。

1 小时/64连接实测已于08:12:05 UTC启动，结束及真实 grace 回收前不判通过。短 CLI 已真实等待124秒、原生 sweep 将连接/session/房间全部清零。原始数据和源码哈希见 [SERVER_SOAK](SERVER_SOAK.md)。新代码必须取得自身 CI，下面保留上一完整候选证据而不冒充新结果。

## 上一完整候选结论

[CI52全套通过](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42349478384)，运行代码 `a1dfef939cb2af1ab64fc987a84a9a18b996f685`、revision `6a2caec304bbd413`。196/196 Node、完整依赖审计、构建/PWA、实际临时Nginx HTTPS/WSS、三引擎发送清单、Chromium1GiB/Firefox100MiB、OPFS/恢复、WebKit UI及六组合双向文件/独立SHA-256均通过。

可交付用户在**独立测试主机**部署验证的开发候选，**不是正式RC或稳定版**。main未合并，生产和用户电脑未操作；仓库最后由用户手动更名，不假定拥有zeydrop.com。完整范围见 [TEST_REPORT_20261107](TEST_REPORT_20261107.md)。

## 已实现且本轮验证

| 范围 | 当前行为与证据 |
|---|---|
| 邀请/直连 | 高熵双人邀请、锁定身份/期限、精确Origin与信令白名单、实际selected非relay、DTLS人工核码；同机真实WS/WebRTC验证 |
| 协议握手 | 每通道随机nonce/实际处理后ACK/最多10次重发，新peer双向就绪后才能核码或发送；旧wire/epoch/nonce/计时器隔离、legacy v2兼容；10项回归及六组合通过 |
| 文件 | 16KiB分块、256KiB写入ACK、背压、完整SHA-256、暂停/取消/多文件、64MiB合计回退；1GiB/100MiB/0B/中文特殊文件名通过 |
| 失败任务 | 暂停并保留后续队列、独立手动重发/新ID/新接收同意、最多30引用/15分钟、断线释放；held清空与Blob ready-next屏障通过 |
| 恢复/清单 | 同页120秒；接收方自愿OPFS断点；发送方自愿100项/128KiB/24小时元数据清单，完整哈希重选/新配对/手动发送/最终成功逐项移除；Web Locks/CAS/取消/配额/损坏与三引擎刷新通过 |
| UI/兼容 | 响应式明暗/PWA/二维码/授权/进度/诊断；Firefox表单/BFCache不恢复许可，锁callback错误锁外传回；三引擎清单errors为空，390px组件无溢出 |
| 资源 | 修复hello会话容量竞态/满表合法恢复；64/256/1000实际连接短基线；Chromium页面CDP有界采样。不是公网容量、总RSS/整机CPU或长期soak |
| 构建/交付 | 21项公共输入快照、隐藏路径防护、干净源码/manifest/有限秘密扫描/可重复归档；203文件独立解压、重装196测试及无.git重建通过，CI归档逐字节一致 |

文件正文/名称/哈希/恢复元数据只在RTCDataChannel或明确选择的本机存储；无HTTP上传、WebSocket文件代理、TURN或DERP。网页/信令/心跳/STUN仍有少量流量，不能宣传服务器总流量为零。信令观察未见测试正文不等于真实部署抓包证明。

## 精确候选与证据

[CI52源码候选](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42349478384/artifacts/13564752556)，保留至2026-11-14。tar.gz SHA-256：

```text
972e76dbb6b389ed4abd47489d02ba80a14bb4d5c4c448f1d50db08e07ccf851
```

外部manifest记录CI临时合并commit045db8f，branch source是a1dfef9；全部文件和tar与独立核验的本地候选一致。SHA-256不是签名，有限扫描不保证识别所有秘密。原始去敏JSON与汇总见evidence/ci52-*；无Git解压核验见candidate-extraction-a1dfef9-20261107.json。以后运行时代码改动须重验，不能沿用本次绿灯。

## 未完成与验收阻断

| 项目 | 状态 |
|---|---|
| 真实跨网络/NAT/IPv6/双栈/严格防火墙/切网 | **正式RC阻断**；需两个真实设备与链路，成功/失败样本、selected非relay、双方哈希及服务器正文观测，Issue #4 |
| Edge/macOS与iOS Safari/Android、真实picker/磁盘/驱逐/后台/PWA/无障碍 | **正式RC阻断**；Linux WebKit不是Safari硬件，Issue #5 |
| 独立主机可信证书/续期、WSS/systemd、安装升级/迁移/重启/失败恢复/回滚 | **正式RC阻断**；需用户自有已授权测试主机；当前只有隔离夹具 |
| 小时级soak、慢读者WS背压、真实等待后回收、全进程RSS/CPU | 未完整验收；短基线推进恢复时钟，CDP仅页面采样，不冒充这些指标 |
| 大文件/前缀哈希移到专用Worker | 尚未实现；当前主线程增量且有界，OPFS写入Worker不等于哈希Worker。性能增强，真机卡顿需据实优化 |
| 显式授权LAN自动发现 | 尚未实现；邀请/二维码可用，不以相同公网IP/CGNAT冒充可信邻居，非Web MVP硬前提 |

实际步骤见 [REAL_DEVICE_TESTING](REAL_DEVICE_TESTING.md)、[RELEASE_GATES](RELEASE_GATES.md)、[DEPLOYMENT](DEPLOYMENT.md)。main仍是旧版本，部署请使用上述精确候选/commit。

## 历史与交接

CI47/48是139项旧完整基线；CI49首条E2E TypeError未获得完整定位，后续增强驱动时序/安全源码定位后未复现，原失败保留。CI50暴露Firefox勾选恢复与应用hello未就绪；CI51清单功能完成但Firefox锁callback全局error失败。均保留原始证据，未删测试或降低路径/授权门槛；CI52对应实际修复后完整通过。

main的既有历史计划原文与开发分支逐字相同；86c6ae4只将main同步入开发分支并保留历史说明，解决add/add冲突，未修改main。Git历史与前期审计保留，旧报告见TEST_REPORT_20261106及history/；当前状态以本文件和CI52报告为准。
