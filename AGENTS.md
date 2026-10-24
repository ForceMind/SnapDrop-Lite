# Zeydrop contributor handoff

Read README.md, docs/PROJECT_STATUS.md, docs/ARCHITECTURE.md and docs/TEST_MATRIX.md before changing behavior. Preserve Git history and work on a development branch / PR.

Product invariants: no server file storage, upload endpoint, WebSocket file relay or TURN fallback. Signaling success is not P2P success. Require an actually selected non-relay ICE path, identity-code confirmation and explicit receiver file consent. Keep memory bounded and verify complete-file SHA-256 before reporting success.

Commands: npm ci --ignore-scripts; npm --prefix server ci --ignore-scripts; npm test; npm run build; node scripts/check-build.mjs. Browser tests: npm run test:browser (LARGE_FILE_TEST=1 for 1 GiB); BROWSER_TYPE=firefox npm run test:browser; BROWSER_TYPE=webkit npm run test:smoke. Never mark hardware / NAT / Safari tests passed based only on simulations.

Generated dist/ and test-results/ are ignored. Runtime dependencies bundle locally. Preserve upstream GPL / notices and original Zeydrop SVG assets. Do not create scheduled tasks. Keep incomplete features and actual external blockers in PROJECT_STATUS; do not end every small task to wait for “continue”.

Repository rename is explicitly deferred to the user as the final manual step (2026-10-19). Continue development in ForceMind/SnapDrop-Lite; do not request browser authentication for renaming.
