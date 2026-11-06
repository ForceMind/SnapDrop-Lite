# Zeydrop · 闪投

**Direct by design.**

Zeydrop sends files directly between browsers over a reliable WebRTC DataChannel. HTTPS serves the application; WSS coordinates temporary pairing and exchanges SDP/ICE. There is no file upload endpoint, server file storage, TURN/DERP relay, or WebSocket file fallback. If a selected non-relay path cannot be verified, file transfer stays blocked.

## Current status

This is **0.3.0-dev.1, an unreleased isolation-test candidate** on `feat/direct-first-workspace-20261019`, tracked in [Draft PR #2](https://github.com/ForceMind/SnapDrop-Lite/pull/2). Code `848d16c` passed [CI #47](https://github.com/ForceMind/SnapDrop-Lite/actions/runs/42216448334): 139 Node tests, all six bidirectional browser pairings, Chromium 1 GiB / Firefox 100 MiB, OPFS recovery, new UI, HTTPS/WSS and hidden-path protection. Public builds use an approved 20-file input snapshot; local unapproved files are never published. See the [engineering report](docs/TEST_REPORT_20261106.md); later runtime changes need new verification.

Earlier CI verified Chromium 1 GiB, Firefox 100 MiB, independent file hashes, Chromium/Firefox interoperability, same-page recovery, experimental OPFS recovery after refresh, and a temporary real Nginx HTTPS/WSS proxy. Those tests used one CI host with STUN disabled and substituted picker selection. They do not establish WAN/NAT success rates or real mobile/Safari support. The Linux WebKit blocker reproduced in default native controls, then cleared after a verified Avahi/NSS environment was prepared. All six native and strict application pairings passed with default browser mDNS and unchanged security gates. [Issue #5](https://github.com/ForceMind/SnapDrop-Lite/issues/5) retains real Safari acceptance; passing Linux WebKit is not iOS/macOS proof.

See [current engineering status](docs/PROJECT_STATUS.md), [release gates](docs/RELEASE_GATES.md), [test matrix](docs/TEST_MATRIX.md), and [security review](docs/SECURITY_AUDIT_20261106.md). Repository rename is reserved for the owner as the final manual step. The remote remains `ForceMind/SnapDrop-Lite`; `zeydrop.com` is not confirmed owned.

## Transfer flow and limits

1. Create an invitation and share its link or locally generated QR code.
2. Wait for a verified selected non-relay ICE path. Signaling availability alone is insufficient.
3. Compare the DTLS fingerprint safety code through a trusted channel and approve on both devices.
4. Select files; the receiver explicitly accepts each offer and chooses its save mode.
5. Completion requires exact length, full SHA-256 agreement, and successful sink completion.

Invitations have 128-bit random credentials in the URL fragment, expire after 15 minutes while unpaired, and admit two members. Once paired, identities are locked for a fixed maximum 12-hour session; a third device cannot replace a member. Server-generated 256-bit resume tokens remain in page memory and never enter URLs or localStorage. Offline seats are reserved for two minutes. Refreshing requires a new invitation and safety-code confirmation.

Files use 16 KiB chunks, a 256 KiB receiver-write ACK window, DataChannel backpressure, bounded receive queues, incremental SHA-256, and a multi-file queue. Pause/resume and cancellation work within a live connection. Supported desktop save pickers stream to the selected file; fallback memory reception is capped at **64 MiB in total**, including pending downloads.

Same-page recovery is bounded to 120 seconds and requires the same locked identities/session, a newly verified direct path, fresh safety-code confirmation, and independent prefix hashing. Unaccepted offers need fresh receiver approval. A pending Blob download is not silently skipped. Queued sending File objects do not survive page refresh.

Experimental persistent recovery is **opt-in on the receiver**. Raw partial bytes are stored locally in browser OPFS, with committed checkpoints and exclusive handles. Records expire after 24 hours; cleanup is attempted while the site is open, so closing all pages does not schedule background deletion. After refresh the devices pair again, the sender reselects the original file, and the receiver explicitly chooses the matching local partial. Both endpoints verify the stored prefix; the full file is checked again at completion. Quota, permission loss, browser eviction, crashes and clearing site data may prevent recovery. [Storage details and cleanup](docs/RECOVERY_STORAGE.md).

## Privacy and direct-only behavior

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
node tests/persistent-flow-browser.cjs
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
