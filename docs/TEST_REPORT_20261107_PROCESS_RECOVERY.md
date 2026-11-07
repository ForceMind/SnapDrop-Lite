# Zeydrop 进程中断、并发初始化与现场核验加固

记录：2026-11-07 UTC。开发分支 `feat/direct-first-workspace-20261019`，Draft PR #2；本轮构建 revision `06d9143aa3bbb8fe`。本报告先记录本地已验结果与待执行原生测试；运行代码提交为 `26aed4136ee849a84689c1915e59feb891f00ca7`；GitHub Actions 与候选包校验值由集成验收补齐。未发布正式 RC，不沿用此前 CI62/CI63 的绿灯认证本轮代码。main、生产和用户电脑未操作，仓库更名留给用户。

## 已修复的问题

| 问题 | 实际修复 | 已有证据与边界 |
|---|---|---|
| BFCache 返回后本机断点清理停止 | `pagehide` 停止并清空 sweep 句柄；仅 `pageshow.persisted` 幂等立即清理并重新启动一个小时周期。普通 pageshow 不重复启动，无可用 Recovery 时不启动。 | 实际 controller 源码的 4 项新回归；旧源负向控制 3 项失败。恢复不重开面板，不恢复 hash、下载 URL、历史身份或文件授权；不是实际浏览器 BFCache 验收。 |
| 现场核验可将读取期间变化的文件误报一致，错误文本可能泄漏路径 | 每个输入从一次打开的普通文件句柄读取，最多 1 MiB 缓冲；初始大小内读取加一字节增长探针，核对句柄与路径的设备/文件标识、大小及修改时间，双方结束后再核对路径；异常等待两侧关闭。诊断 JSON 同样有界，先验诊断再读大文件。CLI 只输出固定错误提示。 | 11 项新增真实本地文件回归，相关 18 项通过；涵盖截短、同尺寸改写、路径替换/符号链接改指、增长、短读、另一端仍在读取、FIFO 和隐私。检查不是原子快照，也不独立证明路径或运营商拓扑。 |
| 另一标签已提交同 ID 记录后，迟到 start 仍截断其正文 | 取得独占数据句柄后、任何 truncate/write 前再次检查是否存在元数据；即使元数据损坏也拒绝，关闭本次新句柄且不擦除已有记录。 | 两个独立 Worker 上下文运行实际恢复 Worker 源码，含 partial/complete/corrupt 三态、查找/close 失败与独立记录；新增 9 项通过，相关 104 项通过。文件系统边界夹具不等于原生 OPFS。 |
| 初始化发布失败后先 close 再 erase，可能删除后继标签新建的记录 | 不在释放数据锁后调用 erase；保留初始化原错误，尝试关闭本次句柄。没有接受正文的空桩可留待过期清理；损坏元数据可在本机管理中手动删除。 | 同一组 9 项回归包含发布失败、释放锁后后继初始化以及迟到删除竞态。close 失败不保证物理解锁；没有将保留空桩宣称为完整断点。 |

涉及运行文件：`client/scripts/ui.js`、`client/scripts/recovery-worker.js`、`scripts/field-verify.cjs`。服务器实现未改，`server/index.js` SHA-256 仍为 `b3aa2d2f4a3f6a547f3e6bb7661f010bcbf326702461c425657fddadd850e52f`。没有新增文件上传、WS 正文、TURN、DERP 或服务器恢复数据接口。

## 本地验证结果

完整 Node 测试 **369/369 通过，0 失败、0 跳过**：原 342 项加 BFCache 4 项、现场文件核验 11 项、start 竞态 9 项、专属进程信号守卫 3 项。独立集成焦点组合 31/31 通过；这些组合与完整集有重合，不相加计数。构建与 `scripts/check-build.mjs` 通过，revision 为 `06d9143aa3bbb8fe`；根目录及 server 的 npm audit 均为 0 已报告漏洞，shell 语法与 diff 检查通过。本地汇总见 [process-recovery-local-20261107.json](evidence/process-recovery-local-20261107.json)。有限扫描和回归不证明不存在其他安全问题。

3 项进程信号守卫测试只使用新建、隔离的无害 Node 子进程：拒绝当前/初始化/缺失 PID、错误 profile/陈旧 OS 身份，在正确隔离组内实际 SIGKILL 并观察退出。它们证明守卫行为，不能当作 Chromium 或存储崩溃恢复成功。

## 原生浏览器组合：待 CI 执行

新增 `tests/recovery-start-race-browser.cjs`：同源两个页面各用真实恢复 Worker 和共享原生 OPFS；仅用测试专属异步门延迟 B 的原生 `getFileHandle` 边界，让 A 先提交 16 KiB 的 partial/complete/corrupt 记录。释放后要求 B 拒绝，原 metadata 逐字节保留、正文大小及独立 SHA 不变、无 erase，并在不导航/重载/终止存储 Worker 的情况下立即重新取得原生锁；正常断点另做前缀独立 SHA。其文件系统和 Worker 代码均为真实实现，计时门不是产品接口，也没有放宽授权或路径校验。

`tests/browser-crash-recovery.cjs` 已加入 CI，等待原生验证：只启动并核验测试专属 Chromium profile/隔离进程组，在真实 OPFS 已提交 1 MiB、额外 16 KiB 已写入而尚未哈希/ACK 时实际 SIGKILL，不先 pagehide/park/优雅关闭；同一专属持久化 profile 启动新进程、新页面和新身份。后续必须新邀请、重新核码、重选原件并明确选择本机断点，验证旧检查点/前缀、仅补发剩余正文及最终独立完整 SHA。未提交尾部可能保留或消失，不能作为提交进度。此用例尚不能记为通过。

本地实际启动系统 Chromium 遭遇 `socket() EPERM`；start 竞态用例停在 startup，未执行原生 OPFS 验收。未将启动失败当作通过。以上两个原生组合的最终日志、脱敏 JSON、CI 链接、精确提交与新候选归档/SHA **待集成验收补充**；本地新增测试数量、旧 CI 和测试脚本存在均不能替代这些结果。

## 验收边界及下一项

当前可重复夹具处理的是应用异步生命周期与锁内一致性；受控 Chromium 进程退出即使通过，也不是断电、OS 崩溃、磁盘损坏、移动后台、Safari 或真实公网证据。现场工具要求输入静止：不能在核验期间改写、替换或同步文件；元数据围栏不是原子文件快照，客户端导出的 selected route 仍属自报诊断。

下一项是读取本轮实际 GitHub Runner 日志/原始 JSON，修复真实失败后再生成并独立核验当前候选包。真实 WAN/NAT/IPv6/双栈/CGNAT/UDP 限制、Windows Edge/Android/iOS/macOS Safari、真实磁盘/配额/驱逐/后台与 PWA 升级、独立主机 TLS/systemd/部署回滚继续开放，见 Issues #4/#5、TEST_MATRIX、RELEASE_GATES 和 REAL_DEVICE_TESTING。保持 Draft，不合并 main，不发布正式 Release。
