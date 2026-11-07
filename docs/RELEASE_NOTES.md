# Zeydrop 0.3.0-dev.1 · unreleased development candidate

## 0.3.0-dev.1 · 2026-11-07 云端验收更新

未发布开发候选，代码172adc8 / revision10c5794070ac6a1b，CI57全套285项与浏览器矩阵通过；完整范围见TEST_REPORT_20261107_FINAL。正式RC仍由真实WAN/设备/主机门槛阻断。

- 保存/重选清单用专用本机SHA Worker，256KiB分块、可取消/有界队列；全量内容匹配后仍需新配对/核码/接收同意。实时/前缀SHA尚未迁移。
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
