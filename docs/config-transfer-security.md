# Configuration transfer security follow-up

Follow-up to PR #3. Imported entries still start disabled. This patch makes that stored state an upstream-use boundary, and binds preview consent to the actual import.

## Boundaries audited

- All ordinary Hermes consumers resolve `hermesConn()` (Brain/capabilities/jobs routes, session/run service, source adapter, and `runStructured`). It now rejects disabled integrations before returning the URL or authorization key.
- `runStructured` covers preserved enabled Skylight and Daily Compass reads and Compass completion. No disabled override was added to this shared path. Dependent adapter connection checks require enabled Hermes too.
- All Home Assistant consumers resolve `haConn()` (source adapter, controls, devices/lights, camera proxy, and the HA-backed todos adapter). It now rejects disabled integrations. The camera's direct `fetch` also follows this guard.
- Only the Hermes and Home Assistant adapters' own `test()` methods opt into the explicitly named `admin-connection-test` purpose. The sole production adapter-test caller is the existing admin/CSRF/same-origin protected integration-test route. Testing a dependent source does not authorize its disabled dependencies. Tests do not enable an integration; snapshot warming still uses the ordinary disabled-aware source gate.
- Environment precedence is unchanged: environment-only configured connections remain enabled; a stored disabled row wins over environment auto-enablement. Environment credentials are never included in exports and are not sent automatically to disabled imported URLs.

## Preview binding

The existing `revision` wire field is now an HMAC-SHA256 token over canonical validated payload (including secrets), replacement mode, and the destination revision. Integration entries and record keys are sorted; their order is not import semantics. Apply recomputes the same token inside the existing immediate SQLite transaction before any writes. Changed file contents, changed mode, and changed destination are rejected with 409. Equivalent re-encryption or reordered keys do not change consent semantics.

The HMAC uses a random process-wide key, not a plain secret-containing payload hash. A process restart invalidates pending previews and requires preview again. This deployment is a single-process SQLite application; a future multi-process deployment would need a shared signing-key strategy. This is consent binding, not a one-use or expiring capability; existing admin/CSRF authorization remains required.

## Verification and limits

- RED: changed payload/mode were accepted; preserved enabled dependent sources and ordinary HA devices attempted mocked upstream requests despite disabled imports. API changed-file apply returned 200 instead of 409.
- New tests use real SQLite/import logic and stub the network boundary, including no-fetch assertions, direct route authentication checks, transitive reads/writes, and the own-connection-test exception.
- Existing mock-server integration cases exercise enabled structured Skylight/Compass, HA controls/devices, and home composition.
- No production configuration, credentials, or upstreams were used. No deployment or merge. These guards do not cancel already-running requests or invalidate historical cached answers; they block newly resolved ordinary connections. No global change to the low-level clients' explicit-connection APIs.
- No local full suite, build, browser, or broad typecheck on the shared busy host. Focused checks reuse a sibling node_modules with identical manifests/lockfile; clean-checkout CI supplies broader validation.
