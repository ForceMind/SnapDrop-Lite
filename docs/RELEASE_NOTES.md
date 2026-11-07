# Zeydrop 0.3.0-dev.1 · unreleased development candidate

## 2026-11-07 生命周期加固（新原生CI待验）

本地400项、构建cc281863f488aa68与审计通过；修复旧ICE异步出口、短目录/数据锁下的过期删除与首次部署活动指针。新增PWA升级/回滚和原生暂存删除组合待CI；服务器与Direct-only原则保持，详见TEST_REPORT_20261107_LIFECYCLE。失败release仍保留且可能阻止同版本重试（Issue #9），不能冒险自动删除可能在用代码。尚未发布正式RC，main未合并。

## 0.3.0-dev.1 · 2026-11-07 进程恢复与并发初始化加固（CI65 全套通过）

运行代码26aed41、文档头e8ac72c、revision06d9143aa3bbb8fe；本地369项和341文件独立重装/无Git重建通过，原生双Worker争用、整Chromium组SIGKILL/新授权恢复与完整CI全套通过，最终日志/原始JSON已读。见TEST_REPORT_20261107_PROCESS_RECOVERY；未发布、未合并main。

- 修复同ID OPFS新建在等待数据锁后覆盖另一标签已提交内容：持锁后再次检查元数据，partial/complete/损坏记录都不覆盖。
- 初始化失败后不在释放锁后异步按旧ID删除，避免删除后继标签记录；只保留尚未接受正文的空桩供过期或手动清理。原始失败保留，物理close失败不虚报解锁。
- BFCache返回时幂等恢复暂存过期清理，不恢复旧文件授权或下载链接。
- 本机现场核验从固定普通文件句柄有界读取，检测实际读取期间内容/路径/大小变化，拒绝不稳定证据；固定CLI错误不泄漏私有路径/输入片段。仍非原子快照或独立网络拓扑证明。
- 新增原生双页/双Worker OPFS三态争用，以及仅针对验证归属的测试专属Chromium进程组实际SIGKILL、持久化profile重开、新身份/新邀请/手动断点恢复测试。本地启动EPERM未算通过，原生验收来自CI65；不能外推断电/OS崩溃或真实设备成功率。

## 0.3.0-dev.1 · 2026-11-07 状态式哈希与清理验收（CI62）

88ebde0/revision50be36dcf5f9d638完成CI62全套342项、原生OPFS故障恢复、三引擎Worker、六组合及大文件；319文件候选独立重装/无Git复验通过。未发布、未合并main；真实WAN/设备/Safari/主机仍阻断正式RC。见TEST_REPORT_20261107_STREAM_HASH。

- 实时发送/接收与恢复前缀改用本机状态式SHA Worker，最多4句柄、每句柄4操作/256KiB分块，默认单操作30秒截止；快照可继续，最终摘要释放。原始发送缓冲不detach，Worker失败停止而不静默回退。
- 文件块已写入但哈希失败时，安全释放精确OPFS句柄并保留旧metadata/offset/SHA，不将旧摘要配上新偏移；重新授权恢复时截断未提交尾部。普通保存、明确取消/删除和确证损坏策略保持。
- 修复自然会话到期先peers=[]导致暂存被删除的路径；永久配对退出保留自愿本机检查点，但不保留旧身份或自动恢复权限。
- 明确取消、held及准备阶段清理中的同步/异步abort错误被消费并显示固定本机清理失败提示，不泄露原文、不影响新传输，也不虚报文件已删除。
- 已完成本机暂存通过全文件Worker核对字节数和完整SHA后才提供下载，失败仍可管理。面板校验绑定代次与各自AbortController，URL及计时器有界释放；列表切换释放未点击URL，已点击保留有界下载启动宽限，删除/pagehide释放，旧异步结果不能发布新链接。公共输入增至25项，新增状态式Worker随revision进入本地构建/PWA缓存。
- 发送侧本机前缀读取/Worker失败只取消当前发送文件，保护同时接收的另一文件；新增故障/取消/资源上限、自然会话过期和三引擎状态式Worker验证；实际结果以本轮报告为准。WAN、真机Safari/移动、真实存储故障与独立主机部署/回滚仍是正式RC阻断项。

- 显式删除请求失败的通知先于面板代次检查；关闭/重开面板不会吞掉失败，用户可检查可能保留的文件，新列表和旧hash/URL仍严格隔离。

## 历史云端基线

## 0.3.0-dev.1 · 2026-11-07 云端验收更新

未发布开发候选，代码172adc8 / revision10c5794070ac6a1b，CI57全套285项与浏览器矩阵通过；完整范围见TEST_REPORT_20261107_FINAL。正式RC仍由真实WAN/设备/主机门槛阻断。

- 保存/重选清单用专用本机SHA Worker，256KiB分块、可取消/有界队列；全量内容匹配后仍需新配对/核码/接收同意。该CI57时点实时/前缀SHA尚未迁移；本轮新实现见顶部。
- 修复断点读取/存储/park失败误删和锁泄漏，活动/过期/跨peer清理等待已授权旧write正确记账；保留已提交offset/SHA，迟到finish按原state处理。主动取消/删除、确证损坏、普通sink策略单独保持。
- 恢复Worker继承已加载脚本版本，当前版离线SW/cache/原生Worker仿真通过；恢复RPC限32项，不强行终止共享Worker或假报磁盘I/O取消。
- 修复深色暂存白底近白字、弱文字/placeholder/焦点对比度；真实记录组件light/dark复验通过。
- 新增owning-browser RSS/PSS/CPU覆盖报告、真实慢读者和永久不读者超时，64连接一小时本机信令与真实grace。它们不是WAN成功率、整机内存界限或生产容量保证。
- 干净源码manifest/哈希、246文件独立解压/重装285项/无Git重建验证。最终文档候选须使用自身manifest，不混归档哈希。

Chrome/Firefox哈希基准100MiB OPFS，Linux WebKit仅8MiB Blob回退；所有物理设备/存储驱逐/独立部署限制公开保留，用户文件不进入服务器中继。

## 历史开发记录

以下保留此前时点的范围与编号；当前以顶部报告为准。

This development branch provides private two-device invitations, manual DTLS-code verification, selected non-relay ICE-path validation and explicit receiver consent. File bytes, transfer metadata, hashes and recovery exchanges use RTCDataChannel, with no TURN/DERP or server file upload/storage/proxy fallback.

The transfer engine includes bounded chunking/backpressure, persisted-write ACKs, complete SHA-256 verification, multi-file queuing, pause/cancel and explicit failure states. Same-page recovery and opt-in OPFS checkpoints support the documented browser capabilities and reauthorization requirements; they do not guarantee survival of storage eviction or recovery on all mobile devices.

The candidate includes responsive light/dark UI, invitations/QR, local recovery management and privacy-filtered connection diagnostics, build inputs and deployment templates. Browser test outcomes must be read for the exact commit; The Linux Playwright WebKit six-pair gate passed in CI45 after verified mDNS environment preparation; real Safari/mobile/WAN validation remains external.

Core correctness and interaction changes in this review:

- Stale async sends, hashes, failures and ICE generations cannot mutate a recovered connection; storage checkpoint errors cancel only the file. Preparing local prefixes remains private until authorized and verified. Failed adopted receivers follow their current state owner, and colliding bidirectional IDs are rejected before allocating storage.
- OPFS worker requests serialize; metadata is reread under the data lock and complete publication retains that lock. Expired/invalid copies remain manageable.
- Visible enabled dialog controls form the keyboard cycle. A denied/missing clipboard keeps text selected for manual copying; temporary local retention is explained accurately.
- Recent bounded persisted-progress samples drive throughput/ETA after a pause or recovery.
- Six strict browser pairings and privacy-filtered native controls retain failures. Linux mDNS setup is an explicit test environment, not a claim of Safari support.

Release-path changes in this review:

- Candidate source comes from clean HEAD-tracked files, with verified build output and a per-file SHA-256/origin manifest. Untracked local content, credentials, symlinks and unexpected generated resources are rejected or excluded.
- A bounded private-key/token-pattern scan rejects known dangerous inputs without printing values. It does not replace complete secret review or signing.
- Deployments and rollbacks serialize pointer/configuration changes with a shared lock. The lock begins before npm installation/build, and explicit root-owned runtime permissions work with restrictive installer umasks. A canonical system Node path and a bounded authorized loopback WS hello must succeed before success is reported.
- Failed rollback restarts/readiness checks attempt restoration of the original target and preserve the previous-release marker. Isolated failure-injection tests cover that transaction.

The `zeydrop-unreleased-source-candidate` artifact is generated after Node/build/temporary-TLS checks and before browser installation/E2E. Its availability is not browser acceptance; inspect the corresponding workflow results separately. This is not a stable Release, production deployment or public NAT-success-rate claim. Users should verify the archive SHA-256 and manifest before testing on an isolated host. Actual ISP combinations, Windows/macOS/Android/iOS browsers, real file-picker/disk permissions, TLS renewal, systemd restart and deployment/rollback still require the published external acceptance matrix. Repository rename remains the owner's final manual action.

Cloud acceptance for code `cfdda0c`: CI45 passed 134 Node tests, all six strict browser pairings with downloaded-file hashes, Chromium 1 GiB / Firefox 100 MiB, OPFS recovery, UI and TLS/WSS. The default-native WebKit failure cleared after verified Linux Avahi/NSS preparation, without changing product mDNS/path/consent gates. See TEST_REPORT_20261106 for exact source/archive identity and the remaining external gates.

Static publication hardening follows the cloud baseline: only20 approved client inputs are snapshotted, hashed and published; local unapproved .env/notes never enter dist or affect the revision. File/ancestor symlinks and special files fail before removing the prior build. Nginx independently blocks dotpaths and preserves.well-known; real temporary HTTPS regressions cover readable fixture secrets. Five additional build regressions bring Node coverage to139. Code848d16c passed full CI47, including the new HTTPS boundary and all six strict browser pairings; it remains an unreleased isolation-test candidate.

### Send task engineering follow-up (verified in CI52)

Manual retry now retains a failed File reference briefly, generates a fresh transfer ID and requests fresh receiver consent. Failures pause and retain the remaining queue. Opt-in cross-refresh send checklists store bounded metadata/full SHA-256 only, require explicit original re-selection/new pairing/manual send, and remove entries only after fully verified completion. No file handles, contents or identities are persisted by the checklist. The existing receiver OPFS prefix checks remain separate.

A confirmed server capacity race is fixed at hello allocation; a full session table no longer blocks bounded transports for legitimate offline identity resumption. Isolated signaling load/RSS/CPU/cleanup evidence is added, separate from public networking or long-run certification. No release gate or main merge is implied.

Follow-up browser fixes: local checklist consent and file inputs reset across Firefox form restoration/BFCache; Web Locks callbacks return a result envelope and rethrow the original storage error outside the callback. Final browser error checks remain strict. DataChannel v2 hello now has optional per-wire nonce ACKs and at most10 retries; modern peers require two-way protocol readiness before manual verification or payloads, while plain legacy v2 remains compatible. Obsolete wire/epoch/nonce callbacks cannot authorize a replacement channel. Protocol readiness failures are diagnosed separately from ICE/NAT. Browser CDP resource sampling is test-only, bounded, and explicitly not total RSS/CPU or WAN performance.

Cloud acceptance update: code a1dfef9 / revision 6a2caec304bbd413 passed full CI52 with196 tests, all three checklist engines, all six bidirectional pairings and the large-file checks. Final report: TEST_REPORT_20261107. External gates remain open; no main merge, production deployment or formal Release.
