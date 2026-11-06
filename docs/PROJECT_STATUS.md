# Zeydrop 当前工程状态

更新时间：2026-11-06。版本 0.3.0-dev.1，现有分支 `feat/direct-first-workspace-20261019` / Draft PR #2。本轮重新核验的启动 head 是 `0c7bf14`，交接 `25b7f39` 已不是最新。默认 main 未修改；只交付隔离测试开发候选，不作稳定发布声明。

## 当前结论

- 启动基线本地 77/77 Node 测试通过。整合本轮两批修复后 **134/134** 通过，构建、资源引用和重复构建通过；代码cfdda0c的CI #45已全通过，见 TEST_REPORT_20261106 与 evidence/ci45-summary.json。
- 历史 CI #42（42204473272）核心工程、Chromium 1 GiB / Firefox 100 MiB、跨刷新 OPFS、临时 TLS/WSS 和开发包通过，**整体失败**于 Chromium↔Linux WebKit 无 selected ICE pair。#43 在浏览器安装阶段取消，无新兼容性结论。#44（906a15c）通过105项、构建/审计和TLS/WSS后，在Ubuntu APT依赖下载阶段耗尽18分钟而取消，全部浏览器步骤未运行，见 evidence/ci44-infrastructure-timeout.json。
- CI #45验证六组合双向DataChannel、Chrome1GiB/Firefox100MiB、OPFS恢复及新UI。Linux WebKit原生默认环境失败，补齐并预检Avahi/NSS后同默认策略成功，云端阻断已解除；Issue #5保留真实Safari验收，Issue #4保留真实公网/设备验收。不得在未选中已知非 relay 路径时发送文件，不启用 TURN/DERP/WS/HTTP 文件中继。

## 本轮已修改的实现

1. **传输代次隔离**：同 peer、同状态对象恢复时，旧异步 File 读取、前缀哈希、背压拒绝和旧接收错误不能影响新的恢复尝试。五项回归在基线失败、修复后通过。空 MIME 文件双方规范一致；检查点配额失败只取消文件。
2. **ICE 代次**：保留标准空 candidate 的原始 mid/index/ufrag；忽略 null legacy gathering 事件及已知过时代本地回调。远端 ufrag 与当前 SDP 不匹配时最多缓存64项/10秒，匹配新 SDP 后再应用；旧代结束标记不能结束当前代。getStats 和 ICE transport API 均拒绝协议相互矛盾的候选对。
3. **OPFS 一致性**：Worker 请求串行；取得数据锁后重读元数据；完整记录提交前保持锁；旧 Worker 回调和 messageerror 隔离。修复可复现的旧断点截断与删除/写入竞争，过期/损坏记录可见可删除且不能自动恢复。断点前缀准备期间sink保持局部，全部校验及offset就绪后才发布；断线/取消保留原检查点，错误/损坏清理资源；每次await后重核授权。六项回归覆盖准备中断、取消、损坏、身份失效与同ID新offer。另四项回归修复旧peer在途写入失败时，新owner仍持有失效sink；按相同state对象传播失败，成功在途写入继续计入前缀，不能按ID取消新offer。三个冲突用例证明双向相同ID拒绝于分配sink前，不再泄漏writer或内存预算，正常不同ID双向传输保持。
4. **开发包与部署**：只打包干净 HEAD 追踪源码和一致构建；拒绝敏感路径、符号链接、额外资源及有限敏感内容模式，附逐文件哈希。deploy/rollback共享锁，检查真实允许Origin的WS hello，回滚失败尝试恢复原指针且保留上一版本标记。部署锁前移到首次npm前，发布树规范0755/0644并拒绝特殊文件，只复制服务器入口/包元数据/新依赖，避免本地.env进入公开权限树；Node实际路径不能位于服务隔离目录。夹具测试不等于真实systemd验收。
5. **产品**：普通界面只呈现连接/授权/操作提示，候选类型和RTT移入“连接详情”；过期/损坏暂存标明不可恢复。扩展中文/特殊文件名、空 MIME 真实浏览器恢复用例；补齐 README.en.md、审计和发布说明。
6. **交互与性能**：弹窗键盘焦点只循环真实可见且可用的控件；剪贴板不可用时保留收到的文本并选中供手动复制；暂存说明明确24小时过期及打开本站时清理。速度/ETA采用最近3秒、最多20点的已确认进度，暂停/前缀校验不再稀释速率或把恢复字节记为新流量。
7. **兼容性证据**：严格产品矩阵覆盖 Chromium↔Chromium、Firefox↔Firefox、Chromium↔Firefox、Chromium↔WebKit、Firefox↔WebKit、WebKit↔WebKit。原生 RTC 控制保留独立结果（trickle / gathered SDP / EOC / 隔离 mDNS），不把控制探针退出成功当作产品通过。新增Linux浏览器默认环境与Avahi/NSS准备后对照；临时mDNS预检只保存布尔结果。CI45对照支持此前Linux Runner阻断与系统mDNS环境相关；严格产品六组合全部通过，不代表macOS/iOS Safari。CI固定Ubuntu24.04，限定GitHub-hosted临时Runner精确替换慢Azure源为官方HTTPS archive，保留签名策略并加回归，不在用户主机执行。

## 功能与验收范围

| 范围 | 实际实现 | 当前验证边界 |
|---|---|---|
| 配对/身份 | 128-bit邀请，未配对15分钟；两人锁定会话最长12小时；服务端身份与2分钟离线席位；DTLS安全码/接收同意 | 本地和历史实际WS/浏览器，非真实公网 |
| 直连 | 标准WebRTC/ICE/STUN、实际selected非relay核验、有界restart、诊断 | CI45六组合文件闭环通过；STUN关闭/同机，WAN成功率未知 |
| 文件 | 16KiB分块、256KiB写入ACK、背压、有界队列、SHA-256、多文件/暂停/取消 | CI45 Chrome1GiB、Firefox100MiB、0B/特殊文件名、配额失败与恢复通过；暂停/取消有协议回归，真实保存权限待测 |
| 恢复 | 同页120秒；接收方主动选择的实验性OPFS跨刷新恢复、前缀与完整SHA-256、新邀请/重新授权 | CI45 Chromium原生OPFS/并发与跨刷新通过；Safari/iOS硬件未测 |
| UI/PWA | 工作台、二维码、明暗/手机、状态/错误、本机暂存和诊断 | CI45 WebKit新版UI smoke通过；真实移动、屏幕阅读器与PWA升级待测 |
| 发布工程 | 可重复构建、TLS/WSS代理、systemd/Nginx候选、迁移/回滚/打包/有限扫描 | 云端隔离测试；用户主机、可信证书续期与实际部署回滚未测 |

## 未完成与后续执行

- 云端CI45工程验证已通过并归档，继续保持Draft。下一发布阻断是外部真实设备/网络/主机验收；以后任何运行时代码改动须重新验证，不沿用该绿灯。
- 在真实设备完成跨宽带/蜂窝/运营商、IPv6/NAT64/严格NAT、网络切换、后台冻结、真实文件picker/磁盘/配额和Safari/iOS/Android/PWA验收。当前云端没有这些外部设备，不操作用户本机或服务器。
- 跨刷新发送队列持久化、显式同意的LAN自动发现仍未实现。现有OPFS为自愿本机原始文件暂存，24小时后过期、最多20项；清理仅在站点运行时尽力执行，可能被配额/驱逐/清理影响；不保证恢复。
- 用户自行部署测试；正式可信TLS、systemd重启/迁移/续期/回滚需要真实主机证据。静态health或WS hello都不能证明P2P文件成功。
- 未获用户明确授权不合并main或部署生产；仓库最后更名由用户手动完成。未购买或假定拥有zeydrop.com；不创建定时任务，不承诺会话后后台运行。

## 候选包可复现性实测

代码提交 `906a15c` 的干净源码已在当前云端生成开发包并重新独立解压：142项逐文件SHA-256通过，重新安装依赖、105项Node测试和重建通过，revision `ff3d2585229e0af1`。归档SHA-256 `8f64468425d3295eb2d0fa84f3405ac75e608cb857484db1e1dffe1f8f73caeb`。这只是该提交的源码/构建验证，不包含第二批改动，不等于浏览器、真实主机或公网验收。代码cfdda0c亦完成154项逐文件哈希/权限、实际依赖重装、134测试和重建；归档SHA-256 e07638ba97b232f01add955b6a6adbf3d5e5ccec231d4ec042c88235def679f9，与CI45附件逐字节一致，见 TEST_REPORT_20261106。后续源码改动须另验。CI在浏览器安装前提供明确标注的源码/构建候选归档，浏览器和外部门槛必须单独验收。

完整分类审计见 ENGINEERING_AUDIT_20261106，安全修复见 SECURITY_AUDIT_20261106，部署见 DEPLOYMENT，验收见 RELEASE_GATES / TEST_MATRIX / REAL_DEVICE_TESTING。此前累计记录完整保存在 `history/PROJECT_STATUS_before_20261106_audit.md` 和Git历史中；其中“待CI/尚未实现”等历史用语不可作为当前结论。


## CI46后的静态发布边界复查

9ad文档提交的CI46也完整通过；随后隔离复现了直接部署的client递归复制风险（本地未追踪.env/笔记会被当作静态资源）。源码改为明确公共输入快照，另加Nginx隐藏路径防护和实际HTTPS回归。此前白名单校验通过的候选未观察到这些合成内容；本地整合139/139 Node、可重复构建通过；新加固提交须等最新Actions验证，不能把CI46绿灯当作新发布路径验证。WebRTC协议模块未改，真实设备/公网/主机门槛仍未验收。
