# Zeydrop（闪投）Codex 接手说明

交接日期：2026-11-09（America/Los_Angeles）。用户要求本Work停止新增开发并交接Codex；此次只提交文档与核验摘要，不修改产品实现。不要从零重建，不丢失未合并分支进展。

## 接手位置

- 仓库：https://github.com/ForceMind/SnapDrop-Lite ，用户最后手动更名为Zeydrop；不要自行更名或购买域名。
- 开发分支：`feat/direct-first-workspace-20261019`；[Draft PR #2](https://github.com/ForceMind/SnapDrop-Lite/pull/2)。main仍是旧版，禁止只从main重建或合并覆盖开发成果。
- 最后完整验收源码：`c87712753ac4f25e71dd20af75e8798c72a3eb05`，应用revision `266604dbfe70dbfa`，版本0.3.0-dev.1未发布开发候选。
- [CI76](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42668552946)已完整成功，job129338645082：442/442 Node、0失败/跳过、三引擎、严格六组合、Chromium1GiB/Firefox100MiB、恢复、HTTPS/WSS、PWA等。最终日志及42份JSON已核对；见[证据摘要](evidence/ci76-handoff-summary.json)。
- 此文件所在的后续交接提交仅文档/证据，不能写“CI76测试了未来交接提交”。接手时重新查询远程最新HEAD、review、Issue、CI和包；交接提交的CI结果以PR对应运行记录为准。

## 先读与运行

依次读取AGENTS.md、README.md/README.en.md、[统一验收状态](ACCEPTANCE_STATUS.md)、PROJECT_STATUS.md、ARCHITECTURE.md、TEST_MATRIX.md、RELEASE_GATES.md、REAL_DEVICE_TESTING.md、DEPLOYMENT.md，再按相关功能读报告。历史报告只证明对应提交；旧章节中的数量/“待验证”不覆盖最新验收入口。

已有工作目录先检查git status并保留本地修改，再fetch远程分支；不要hard reset、强推、删除或覆盖他人提交。全新目录可使用：

```sh
git clone --branch feat/direct-first-workspace-20261019 https://github.com/ForceMind/SnapDrop-Lite.git zeydrop
cd zeydrop
npm ci --ignore-scripts
npm --prefix server ci --ignore-scripts
npm test
npm run build
node scripts/check-build.mjs
```

本机开发预览可执行`npm run dev`。更完整浏览器测试与mDNS/依赖要求见CI工作流和测试矩阵；Linux WebKit的Avahi/NSS准备属于测试环境，不可往产品注入候选重写或mDNS关闭策略。不要未经授权操作用户真实服务器或电脑。本Work环境曾不能启动本地Chromium，最终原生证据来自Actions；新Codex环境必须自行测试，不能继承这个能力结论。

## 已交付的核心功能

邀请/二维码配对、实际selected非relay路径核验、人工安全码确认、接收授权；分块/背压/队列/暂停/取消/重试/最终SHA；原生保存及有界内存回退；显式OPFS暂存、前缀校验、同页及跨刷新重新授权恢复、自愿发送清单；深浅响应式UI/PWA/诊断/本机暂存管理；快速文字和不上传的文字二维码PNG。

重要边界：

- 服务器只提供静态页面与有限信令；文件/文字正文只走RTCDataChannel。无上传/服务器文件存储/WS正文代理/TURN/DERP，直连失败明确报错。网页、心跳、信令及STUN仍有流量。
- 信令连接不代表P2P成功。非relay实际选中路径、安全码与接收同意不可删除或绕过；旧通道/连接代次消息不得污染新连接。
- OPFS必须明确同意，最多20项、24小时过期；网站关闭不承诺后台清理。刷新后新邀请/核码/重选原件/手动选择断点及前缀SHA均保留。64MiB是内存回退合计上限，不为了测试放大。
- 文字4096 UTF-16单位；发送成功只代表提交通道，不是远端已读。文字二维码800 UTF-8字节、明文、不上传、不自动保存原文。
- 下载没有可靠完成回执。接收弹窗与暂存管理各最多20个本机下载URL，已点击保留60秒启动宽限，未点击关闭不分配/撤旧URL，页面退出清理；不删除暂存原件。file-saved是交互事件，不是写盘成功证明。
- [已关闭调查#10](https://github.com/ForceMind/SnapDrop-Lite/issues/10)保留无间隔批量失败：Chromium156.0.8078.4应用与独立原生anchor均10次下载、第11次无事件，与所引Chromium突发门槛一致。三引擎有节奏生命周期各23次通过；没有把突发20次记成成功，不关闭浏览器安全策略。

## 关键代码和回归入口

| 范围 | 代码与测试 |
|---|---|
| 连接/旧消息/路径 | client/scripts/network.js、tests/ice-async-lifecycle.test.cjs及tests/late-channel.test.cjs |
| 文件/哈希 | client/scripts/transfer.js、stream-hash.js/stream-hash-worker.js、file-hash.js/file-hash-worker.js及对应测试 |
| OPFS/锁/检查点 | client/scripts/recovery.js、recovery-worker.js，tests/recovery-*.cjs、persistent-flow-browser.cjs、stream-hash-recovery-browser.cjs |
| UI/文字/下载 | client/scripts/ui.js、client/index.html、styles.css；text-tools-ui、receive-download-ui、text-qr和receive-download浏览器脚本 |
| 部署/候选/现场核验 | deploy.sh、scripts/rollback.sh、package-candidate.mjs、field-verify.cjs、docs/DEPLOYMENT.md |

不要将候选source ZIP或dist与不同提交混用。Public输入白名单位于scripts/public-assets.mjs；新增公开文件必须显式登记，维持Git-free构建和PWA一致性。保留GPL和上游NOTICE。

## 仍未完成：下一轮优先项

[Issue #4](https://github.com/ForceMind/SnapDrop-Lite/issues/4)与[Issue #5](https://github.com/ForceMind/SnapDrop-Lite/issues/5)继续开放。按ACCEPTANCE_STATUS和REAL_DEVICE_TESTING收集实际成功与失败证据：

1. 两台不同真实网络设备：家庭/蜂窝/不同运营商、IPv4/IPv6/CGNAT/严格NAT、UDP阻断、切网。核对每端selected非relay路径与文件SHA，建立有分母的样本；同机STUN关闭的CI不证明公网成功率。
2. 真实macOS/iOS Safari、Android及Windows Edge；系统picker/下载/权限、后台冻结、软键盘/触控/辅助技术、存储配额/驱逐、已安装PWA升级/回滚。
3. 用户授权的独立测试主机：真实TLS/证书续期、systemd开机/重启、迁移/升级失败/回滚、日志/权限和文件传输期间服务器侧流量观测。
4. 弱设备和12小时/多日负载；已有本机一小时信令测试不代表生产容量、文件吞吐或SLA。

`node scripts/field-verify.cjs --help`提供本机无上传证据比较工具；输入记录自报，不能独立认证公网拓扑。不要把私密文件、IP、邀请或令牌上传Issue。发现真实缺陷时先复现、修复、回归并更新现有PR。若设备条件不具备，应保留“未测”，不要重复生成新计划或把云端仿真当完成。

## 候选与停止边界

CI76 [504文件开发候选](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42668552946/artifacts/13697378347)已核验ZIP、内部tar及成员摘要/大小/模式，临时merge与源码tree一致。ZIP SHA为`201dfaaf8d1175b8ccd0edc37d88c78d8bc5c2fd6fe944f88357fa417937a555`；内部tar SHA为`7b4edb687381530725f28adb4fa348003ff5ff7ee69cb933cb53afe4b8d6c5ba`。本轮没有另做CI76包独立解压重装，勿误报；此前CI75包独立重装及无Git重建有记录。Actions附件有保留期限；过期请重建/校验，不套用旧摘要。

仍为未发布开发候选，不是正式RC/稳定版。保持PR Draft，不合并main、不发布稳定Release、不部署生产；更名最后由用户手动完成，域名未确认拥有。本Work交接后停止执行，不创建定时任务、不承诺后台持续研发。后续Codex在用户新授权的环境内接续。
