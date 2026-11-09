# Zeydrop 统一验收状态

核对日期：2026-11-09（America/Los_Angeles）。本页是现有计划的验收台账，不是新路线图，不代表正式发布许可。

## 已核验基线

- 应用提交：`98291dba5d5749fd4cd6d0b25c1403c75e7e6146`，revision `266604dbfe70dbfa`，0.3.0-dev.1。
- [完整CI75](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42515253012)：442/442 Node、0失败/跳过、完整两侧audit0，三引擎及六组合、1GiB/100MiB、恢复、临时HTTPS/WSS、PWA均通过。最终日志和42份原始JSON已核对；开发分支/PR记录对应实际版本。
- [CI75候选包](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42515253012/artifacts/13631595268)：503文件（474源码/29dist），独立重装442项及无Git重建通过。ZIP SHA-256 `e988a955535a99c9d46fb5478d095a33ad0739cb99cc99f1261d7f7ef4801e06`；内部tar SHA-256 `dc4237d62a4f0d80babd62cbc2b2060eddc4270a36fec1558670f9b2fec9e245`。附件有保留期限，失效后重新构建/核验，不能套用旧包摘要。
- 本次只整理文档，客户端/服务端/协议/依赖/部署实现未修改。新文档提交的CI结果必须单独看PR，不能冒称CI75测试了后续提交。

## 对照持续研发计划

| 计划 | 已有实现及云端证据 | 尚未验收的边界 |
|---|---|---|
| M1 核心架构 | 选中非relay路径、安全码、早到信令、连接/代次隔离、重连/资源清理回归 | 实际网络切换、移动后台和复杂NAT |
| M2 跨浏览器 | Linux Chromium/Firefox/WebKit严格六组合双向SHA | 真实macOS/iOS Safari、Android和Windows Edge；Linux WebKit不是Safari认证 |
| M3 文件引擎 | 分块、背压、队列、暂停/取消/拒绝/重试、最终SHA、1GiB/100MiB；下载URL有界释放 | 真机picker/下载、真实磁盘不足与低内存、长时间后台保存 |
| M4 断点恢复 | 显式OPFS同意、检查点/前缀SHA、刷新后新邀请/核码/重选原件、锁/并发及进程中断回归 | 真正断电/OS崩溃、存储驱逐、移动冻结、Safari存储行为 |
| M5 UI/UX | 响应式深浅模式、邀请QR、安全码/文件/文字流程、进度/诊断/暂存、文字转PNG二维码 | 真机触控、软键盘、系统下载/剪贴板、辅助技术和已安装PWA体验 |
| M6 公网连接研究 | Direct-only标准ICE/STUN、可配置STUN、选中路径/失败诊断、受控恢复测试 | 真实家庭/蜂窝/运营商、IPv6/CGNAT/严格NAT/UDP阻断样本及成功率分母 |
| M7 安全隐私 | Origin/信令白名单、大小/速率、授权、完整性、存储隔离、CSP/HTTPS测试和依赖审计 | 实际主机权限/TLS/日志配置及真实流量观测；不宣称没有未知漏洞 |
| M8 性能资源 | 有界缓冲/Worker、文件和信令负载、历史一小时本机信令证据 | 弱手机、完整12小时/多日压力、真实主机容量；同机速度不是公网性能承诺 |
| M9 自动化 | 442项、原生浏览器矩阵、协议/安全/恢复/PWA/HTTPS/构建与候选验证 | 真机与真实拓扑用例，不用仿真填为通过 |
| M10 部署发布 | 部署/回滚/完整release只读复用、Nginx/临时证书代理、候选清单/SHA及文档 | 独立测试主机真实证书续期、systemd开机/重启、迁移升级/回滚、正式RC/Release |

每行都有未验收项，所以不能把任一完整里程碑或整个计划标记为完成。

## Direct-only 证据及限制

CI75三引擎各传126976字节并独立匹配SHA；双方记录实际selected UDP非relay路径。观测HTTP正文/上传/WS二进制/文件正文均为0，WSS控制流量分别3668/5170/3730字节。服务器和协议实现没有上传/文件存储/WS文件中转，也无TURN/DERP回退。静态页面、配对、心跳和STUN有流量；实际部署期间服务器侧观测尚待完成。诊断JSON自身不能证明运营商拓扑或服务端无正文。

CI73的高速批量下载失败已保留。[Issue #10](https://github.com/ForceMind/SnapDrop-Lite/issues/10)记录CI75全新Chromium156.0.8078.4进程中的应用与独立anchor对照：两侧均10次下载成功、第11次无事件、页面errors为空，与所引用Chromium突发下载门槛机制一致。三引擎有节奏生命周期检查各23次原生下载通过；没有把无间隔20次记为成功，没有放宽浏览器策略。调查已关闭，已知平台边界仍保留。

## 下一步必须取得的实测证据

由拥有相应设备、独立网络及测试主机的操作者执行；当前云端会话没有这些条件，也未获操作用户真实主机/本机的授权。

1. 按[部署文档](DEPLOYMENT.md)在独立测试主机安装精确候选，核对manifest与SHA；不要检出仍为旧版本的main直接部署。
2. 按[真实设备指南](REAL_DEVICE_TESTING.md)覆盖家庭↔家庭、家庭↔蜂窝、两个运营商、IPv6/双栈、严格NAT/UDP阻断及切网；记录成功和失败，不启用中继。
3. 双方导出脱敏诊断，在每端核对实际选中非relay路径；人工比较安全码，接收方明确授权，完成后独立比对文件SHA。0B/中文名/多文件/100MiB/能力允许时1GiB均取样。
4. 检查Safari/Android/Edge、后台冻结、真实下载权限、配额/驱逐、已安装PWA更新/回滚和恢复重新授权；从部署服务器侧观测正文与信令的区别。
5. 在独立主机演练真实TLS/WSS、续期、systemd重启/开机、升级失败和回滚；补充长时/弱设备资源记录。

可离线核验自有证据（不上传文件）：

```sh
node scripts/field-verify.cjs --help
node scripts/field-verify.cjs --sender-diag A.json --receiver-diag B.json --scenario broadband-cellular --sender-file original.bin --receiver-file received.bin --out local-report.json
```

该命令只比较输入记录和文件，不是独立WAN/运营商认证。参数允许的场景以`--help`为准，私密文件、IP、邀请和令牌不得上传到Issue。结果归入[Issue #4](https://github.com/ForceMind/SnapDrop-Lite/issues/4)及[Issue #5](https://github.com/ForceMind/SnapDrop-Lite/issues/5)，据实际失败修复后再复测。未取得证据继续标未测。

## 当前交付边界

可交付隔离部署测试用开发候选；未达到正式稳定版或正式RC验收。PR #2保持Draft，不合并main、不部署生产。最终仓库更名由所有者手动完成；不购买域名，不假定拥有zeydrop.com。原生客户端端口映射是未来可选研究，不属于当前Web MVP必须实现的功能。
