# Zeydrop 0.3.0-dev.1 · unreleased development candidate

This development branch provides private two-device invitations, manual DTLS-code verification, selected non-relay ICE-path validation and explicit receiver consent. File bytes, transfer metadata, hashes and recovery exchanges use RTCDataChannel, with no TURN/DERP or server file upload/storage/proxy fallback.

The transfer engine includes bounded chunking/backpressure, persisted-write ACKs, complete SHA-256 verification, multi-file queuing, pause/cancel and explicit failure states. Same-page recovery and opt-in OPFS checkpoints support the documented browser capabilities and reauthorization requirements; they do not guarantee survival of storage eviction or recovery on all mobile devices.

The candidate includes responsive light/dark UI, invitations/QR, local recovery management and privacy-filtered connection diagnostics, build inputs and deployment templates. Browser test outcomes must be read for the exact commit; Linux Playwright WebKit ICE compatibility and real Safari/mobile/WAN validation remain separate gates.

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
