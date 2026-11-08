# Zeydrop · 闪投

**Direct by design.**

Zeydrop sends files directly between browsers over a reliable WebRTC DataChannel. HTTPS serves the application; WSS coordinates temporary pairing and exchanges SDP/ICE. There is no file upload endpoint, server file storage, TURN/DERP relay, or WebSocket file fallback. If a selected non-relay path cannot be verified, file transfer stays blocked.

## Current status

This is **0.3.0-dev.1, an unreleased development candidate** on [Draft PR #2](https://github.com/ForceMind/SnapDrop-Lite/pull/2). Runtime `3cdbeae` / build `c75833843f0b324f` passed [CI68](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42409023529): **410/410 Node checks**, both dependency audits, reproducible builds, temporary HTTPS/WSS/Nginx, three native Worker/checklist engines, Chromium 1 GiB / Firefox 100 MiB, all six strict bidirectional pairings, OPFS/recovery, offline and upgrade/rollback PWA checks, and UI tests. [Current report](docs/TEST_REPORT_20261107_LIFECYCLE.md) · [exact candidate/checksums](docs/PROJECT_STATUS.md).

Stale ICE continuations bind to the exact connection and negotiation generation. Short native directory/data locks prevent stale retirement from deleting a replacement checkpoint. Fresh-install failures preserve the actual previous target without creating a self-loop. Complete retained release directories can be reused after exact read-only validation; current, incomplete, different or unsafe trees are refused unchanged. Finish transfers and close all old tabs before upgrading; old Workers do not acquire the new lock protocol automatically.

Native PWA tests preserve A when B installation fails, keep B waiting while old clients remain, then activate only after all close. Upgrade B and rollback A each verify every cached asset, all three same-revision Workers offline, independent SHA and unchanged native OPFS data without historical-file binding. Native Chromium process-exit and explicit-consent recovery also pass. These are controlled hosted-browser checks, not power-loss, physical storage, installed/mobile PWA or real-host certification.

The exact 419-file runtime candidate was independently dependency-reinstalled, tested (410 checks) and rebuilt without Git. All 29 generated outputs match byte-for-byte; actual CI tar bytes match that independent archive. Live/prefix hashes remain bounded local Workers with explicit failure and no silent fallback.

All browser transfer evidence is from one Linux CI host with STUN disabled and substituted picker selection. It does not establish WAN/NAT success, real Safari/mobile behavior or production capacity. Whole-file benchmarks use 100 MiB OPFS on Chromium/Firefox and only 8 MiB Blob fallback on Linux WebKit. Offline PWA tests use actual SW/cache/Workers under browser emulation, not physical network outages or hardware upgrade-lifecycle tests. Native close/RPC hangs may still delay physical lock release; checkpoint retention is not a backup guarantee.

Real networks, devices/storage behavior and an authorized independent deployment remain release gates ([Issue #4](https://github.com/ForceMind/SnapDrop-Lite/issues/4), [Issue #5](https://github.com/ForceMind/SnapDrop-Lite/issues/5)). Keep the PR Draft and main unchanged. Rename remains the owner's final manual step; the remote is ForceMind/SnapDrop-Lite and zeydrop.com is not confirmed owned. [Release gates](docs/RELEASE_GATES.md) and [test matrix](docs/TEST_MATRIX.md).

## Transfer flow and limits

1. Create an invitation and share its link or locally generated QR code.
2. Wait for a verified selected non-relay ICE path. Signaling availability alone is insufficient.
3. Compare the DTLS fingerprint safety code through a trusted channel and approve on both devices.
4. Select files; the receiver explicitly accepts each offer and chooses its save mode.
5. Completion requires exact length, full SHA-256 agreement, and successful sink completion.

Invitations have 128-bit random credentials in the URL fragment, expire after 15 minutes while unpaired, and admit two members. Once paired, identities are locked for a fixed maximum 12-hour session; a third device cannot replace a member. Server-generated 256-bit resume tokens remain in page memory and never enter URLs or localStorage. Offline seats are reserved for two minutes. Refreshing requires a new invitation and safety-code confirmation.

Files use 16 KiB chunks, a 256 KiB receiver-write ACK window, DataChannel backpressure, bounded receive queues, incremental SHA-256, and a multi-file queue. Live and prefix hashes use local stateful Workers: at most four handles per page, four pending operations per handle, copies of at most 256 KiB per chunk, and a default 30-second operation timeout. Only browsers without Worker support use bounded main-thread fallback; a Worker failure stops the task without silent recomputation. Pause/resume and cancellation work within a live connection. Supported desktop save pickers stream to the selected file; fallback memory reception is capped at **64 MiB in total**, including pending downloads.

Same-page recovery is bounded to 120 seconds and requires the same locked identities/session, a newly verified direct path, fresh safety-code confirmation, and independent prefix hashing. Unaccepted offers need fresh receiver approval. A pending Blob download is not silently skipped. Queued sending File objects do not survive page refresh. The opt-in local checklist can rebuild the order only after the user reselects all originals and full-content hashing matches; see the send queue update below.

Experimental persistent recovery is **opt-in on the receiver**. Raw partial bytes are stored locally in browser OPFS, with committed checkpoints and exclusive handles. Records expire after 24 hours; cleanup is attempted while the site is open, so closing all pages does not schedule background deletion. After refresh the devices pair again, the sender reselects the original file, and the receiver explicitly chooses the matching local partial. Both endpoints verify the stored prefix; the full file is checked again at completion. Quota, permission loss, browser eviction, crashes and clearing site data may prevent recovery. Session expiry ends the pairing without deleting opt-in committed local checkpoints or carrying forward the old identity. If a disk write succeeds but its hash fails, cleanup releases only that handle and leaves the last committed offset/SHA unchanged; explicit recovery truncates the unverified tail. Completed local files are checked again for exact size and SHA before saving. Panel verification is cancellable and download URLs are bounded. Hiding/refreshing releases unclicked links; clicked links retain a bounded download-start grace period. Deletion or page exit releases them. Failed underlying cleanup is consumed and reported without claiming the local file was deleted. [Storage details and cleanup](docs/RECOVERY_STORAGE.md).

## Privacy and direct-only behavior

**Quick text:** choose “发送文字” on the verified peer card. Up to 4096 UTF-16 code units travel over the same direct DataChannel, never signaling; failed sends retain the draft. The notification means the channel accepted the message, not a remote read/save receipt.

**Local text QR:** open the home-page tool without pairing, or convert a sending/received text. The locally bundled encoder creates a plain-text QR and downloadable PNG, with an 800 UTF-8 byte limit and no truncation, URL rewriting or QR service. Editing immediately removes the old code; closing clears the tool. Conversion works offline after the app loads. A QR image reveals its original text to anyone who scans it.

STUN can reveal mapping addresses but cannot overcome every NAT/CGNAT/firewall combination. Default STUN addresses and their official sources are documented in [STUN_CONFIGURATION](docs/STUN_CONFIGURATION.md). No third-party analytics or runtime CDN is used. Users can download bounded, allowlisted connection diagnostics locally; exports omit IPs, raw SDP, invitations, credentials, safety codes and file metadata/content.

Zero server **file-body** traffic does not mean zero server traffic: pages, signaling, heartbeats and STUN probes consume bandwidth. The server cannot prevent every covert encoding inside otherwise bounded signaling; it does not implement a file-relay protocol.

## Development

Requires Node.js 22+:

```bash
npm ci --ignore-scripts
npm --prefix server ci --ignore-scripts
npm test
npm run build
node scripts/check-build.mjs
npm run dev
```

Open `http://localhost:8080`. Remote devices require HTTPS/WSS. Build output is generated into ignored `dist/`; it is not a source snapshot. Service Worker updates wait for old tabs to close, avoiding forced refresh during transfers.

```bash
npx playwright install --with-deps chromium firefox webkit
LARGE_FILE_TEST=1 npm run test:browser
BROWSER_TYPE=firefox npm run test:browser
BROWSER_TYPE=webkit npm run test:smoke
node tests/interoperability.cjs
node tests/recovery-browser.cjs
node tests/recovery-start-race-browser.cjs
node tests/recovery-retirement-browser.cjs
node tests/pwa-upgrade-browser.cjs
node tests/browser-crash-recovery.cjs
node tests/persistent-flow-browser.cjs
node tests/stream-hash-browser.cjs
BROWSER_TYPE=firefox node tests/stream-hash-browser.cjs
BROWSER_TYPE=webkit node tests/stream-hash-browser.cjs
node tests/stream-hash-recovery-browser.cjs
BROWSER_PAIRS=chromium-chromium,firefox-firefox,chromium-firefox,chromium-webkit,firefox-webkit,webkit-webkit node tests/webkit-transfer.cjs
node tests/webrtc-primitives.cjs
```

The strict browser matrix fails when a route/file check fails. Bare RTC probes collect sanitized native-control evidence and do not override that gate. They are not WAN tests.

## Staging, packaging and rollback

Use an isolated Linux staging host with systemd, Nginx, Node.js 22+, OpenSSL, Git, tar and flock, plus a domain/certificate you actually control. No account, domain, production deployment or device access is created automatically. Follow [DEPLOYMENT](docs/DEPLOYMENT.md) and [release notes](docs/RELEASE_NOTES.md).

```bash
sudo DOMAIN=transfer.example.com \
  TLS_CERT=/etc/letsencrypt/live/transfer.example.com/fullchain.pem \
  TLS_KEY=/etc/letsencrypt/live/transfer.example.com/privkey.pem \
  bash deploy.sh
```

The example is not a configured site. The script does not buy domains, issue certificates, open firewalls or stop an existing Snapdrop service. Signaling listens on loopback behind WSS. Deployment/rollback share a host lock and require an actual allowed-Origin WS hello; that readiness check does not prove P2P file delivery. Rollback changes release pointers and attempts recovery on failure; configuration/certificate migration needs separate backups.

From a clean committed source tree, after installing and building:

```bash
node scripts/package-candidate.mjs
cd test-results/candidate
sha256sum -c zeydrop-candidate.tar.gz.sha256
```

The archive includes tracked allowlisted source, verified built assets, licenses and a per-file SHA-256 manifest. It rejects dirty tracked input, credential paths, symlinks, unexpected build files and bounded secret patterns. Pattern scanning cannot prove the absence of every credential. SHA-256 is not code signing or release approval. CI uploads `zeydrop-unreleased-source-candidate` before browser installation and keeps it for seven days, allowing isolated source/build testing when browser setup is unavailable. The artifact is not a browser-validation certificate; check the exact run and all known limitations before use.

Real cross-network devices, mobile/Safari storage/PWA behavior, production-trusted TLS renewal and real host/systemd upgrade/rollback remain external acceptance gates. [Real-device procedure](docs/REAL_DEVICE_TESTING.md) and the offline `scripts/field-verify.cjs` tool help record evidence without uploads.

## License

Derived from Snapdrop; the combined application is licensed under [GPL-3.0](LICENSE). Provenance and dependency notices are in [NOTICE](NOTICE) and [LICENSE_PROVENANCE](docs/LICENSE_PROVENANCE.md). The old Apache text is retained as historical provenance. Git history is preserved.

## Send queue recovery

A rejected/failed file pauses and preserves the remaining in-page queue. Retry is manual, uses a fresh transfer ID, and requires receiver consent again. Failed File references are bounded to 30 entries/15 minutes and cleared on disconnect.

The opt-in local send checklist stores only filenames, sizes, MIME, timestamps and full SHA-256, at most 100 entries / 128 KiB for a fixed 24 hours. It never stores file bodies, handles, peer identities or invitations. After refresh, explicitly reselect all originals for full-content matching, establish/verify a new pairing, then click send; each receiver still consents. Only a fully verified completion removes an item. Web Locks/revision checks prevent silent cross-tab overwrites; unavailable storage leaves ordinary in-page transfers usable. See [local recovery](docs/RECOVERY_STORAGE.md). Hardware eviction, real Safari and WAN acceptance remain open.

The default main branch is still the older application. For isolated deployment tests, use the exact candidate/commit in PROJECT_STATUS and verify its matching full CI; the moving branch name alone is not acceptance evidence.
