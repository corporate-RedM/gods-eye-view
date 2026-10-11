# Child's Eye integration

This upgrade combines Child's Eye at `1d68be3`, God's Eye upstream at
`591f299`, and selected Osiris features from
`83b8cd1be24d0d6134c0c1f775625330fcb87996`. Local `main` remains the upstream
reference. The recovery tag is
`backup/childs-eye-before-integration-2026-10-10`.

## Start and use

On BK's machine, run `childs-eye` and open http://localhost:4173.
Run `osiris` separately and open http://localhost:3005. Both launchers bind to
loopback and use the installed Node 24 runtime. Neither opens a browser window.
Keep each server in a monitored terminal task; stopping that task stops its app.
`PORT=4174 childs-eye` or `PORT=3006 osiris` overrides the respective port.

The **Workspace** button opens the Intelligence desk: Overview, News, Cameras, Areas,
Investigate, Forecast, and Tools. Child's Eye operates independently of the
Osiris server. The original globe controls, voice tools, layers, and AI Watch
remain available.

## What changed

- Upstream's Street Level/Mapillary integration, camera navigation and surface
  improvements, resizable panels, expanded tool catalogue, MCP, voice fixes,
  Norway cameras, and other upstream fixes are merged.
- The default optical view removes the circular mask, decorative HUD and bloom.
  Overview offers Balanced, High detail, and Monitoring rendering presets and a
  **Use clean optical view** action. Saved/shared view choices remain available.
  These presets set rendering budgets; their frame-rate targets are not promises.
- A neutral dark interface adds a four-camera desk with native stream leases,
  snapshots, explicit unavailable states, and cleanup when the desk closes.
  Ontario, Caltrans HLS and Iowa fragmented-MP4 HLS were checked with live feeds.
- The corrected camera catalogue includes all 56 registered Osiris regions and
  all 19 native provider groups. The standalone app imposes no camera-count caps
  and loads all California and Texas districts. Exact shared feeds are merged
  with aliases retained. Embedded players and operator-hosted cameras remain
  accessible, with their feed type labeled accurately.
- News combines public RSS and Telegram reports with source links. Approximate
  report locations are labeled; a report is not independent confirmation.
- Areas can save the current view or a drawn polygon, query available records,
  and export GeoJSON/CSV. Areas are stored in this browser's local storage.
- Investigate provides public DNS, RDAP, IP, certificate-transparency, CVE,
  wallet and sanctions lookups. Active scanning is disabled.
- Camera **Analyze frame** and **Watch 30 s** run YOLOX-nano locally through a
  single-thread browser WASM worker. This counts visible object categories;
  it does not identify people. Counts can miss objects or be wrong, and slow
  snapshot refreshes may repeat the same picture.
- Forecast offers explicitly started, source-linked research with cancellation,
  progress, export, and Quick as the default depth. Only one run may be active.
  Provider credentials are kept in memory, not saved with browser preferences.
- News, investigation, and forecast-option tools join the shared native tool
  catalogue used by Tools, voice, and MCP. Tools accepts structured JSON inputs;
  it is not a new conversational chat interface.

Child's Eye's expanded CCTV providers, Ontario authentication, English place
names/WhereAmI, local AI Watch models, 20% GPU budget, notifications-only behavior,
and explicit-start requirement are retained. The short browser camera analysis
is separate from the existing GPU-backed area AI Watch. AI Watch remains off at
startup.

## Graphics, keys and cost

Cesium remains the renderer. The default imagery and terrain do not require a
new paid account. No paid imagery or cloud inference was enabled for this
upgrade, and validation made no paid model requests.

The upstream demo's detailed Google buildings depend on its imagery provider,
not a different rendering engine. Free imagery does not reproduce those meshes.
Google photorealistic tiles, Cesium ion assets, cloud voice and research may have
provider charges if configured. Review the chosen provider's current terms.

Street Level is Mapillary street photography, not live video. Set
`MAPILLARY_CLIENT_TOKEN` in the ignored `.env` or the app's key setup, then restart
the server. There is no token configured on BK's installation, so live Mapillary
photos could not be validated. Its integration and fixture tests pass.

Forecast requires a supported provider and credential. The UI shows estimated
call counts, not a guaranteed dollar amount. It never starts automatically.
Network and camera availability vary; a catalogue entry is not proof of a
working stream. Some Netherlands snapshots were unavailable during live checks.

## Configuration and maintenance

The existing ignored `.env` is preserved. `EYE_EXTRA_CAMERAS=0` explicitly
disables the imported regions; by default they are enabled. The standalone app's
full-inventory mode bypasses the old global and per-provider camera caps and
district restrictions. `EYE_CAMERA_PACK_CAP` and `EYE_EXTRA_CAMERA_CAP` are no
longer used. Reusable provider-library consumers retain their existing bounded
mode unless they explicitly request `fullCatalog`.

Inventories persist in ignored `.cache/cctv-full-catalog.json` and survive
restarts/provider failures. Initial collection shows progress; subsequent starts
can use the saved inventory while refreshing. Cameras offers pagination and an
**Export provider coverage** action. Coverage distinguishes unavailable, stale,
and partial sources; a registered record does not establish working playback.
See [INTEGRATION_AUDIT.md](INTEGRATION_AUDIT.md) for the first delivery's other
omissions, which are not represented as finished by the camera correction.

Local research endpoints reject foreign origins and nonlocal access. API modules
are selected from an explicit allowlist. Import directions preserve the portable
globe package boundary. Each worktree has its own `.cache/vite` optimizer cache.
Model/runtime folders and credentials remain ignored by Git.

Osiris-derived source and license details are in [OSIRIS-NOTICE.md](OSIRIS-NOTICE.md).
The vendored YOLOX model's license accompanies the asset under `public/vendor/`.
`scripts/import-osiris.mjs` is an import aid, not an automatic updater: future
imports must retain the native catalogue, local-request guards, cancellation,
WASM asset handling, and credential changes made in this integration.

## Validation and limits

Before integration, Child's Eye passed 5,553 main tests with one skip; upstream
passed 6,242 with one skip. Both also passed their allocation checks. The combined
suite has 6,438 main tests (6,437 passing, one skip), plus 14 allocation checks.
Production build, formatting, package boundaries and layer-token compatibility
are checked separately. A socket test now waits for the second AIS fix before
asserting a two-point trail, avoiding a race between separate WebSocket frames.

Headless scripts under `scripts/qa-eye-*.mjs` exercise the workspace, live camera
playback, browser inference, origin rejection, and before/after views of Toronto,
Manhattan and the Alps. Screenshot evidence and run logs are kept in the ignored
`output/ultimate-eye-2026-10-10` directory in BK's working repository. These
screenshots use SwiftShader; their frame rates are not hardware benchmarks.

Standalone Osiris builds and serves successfully. Its untouched upstream test
baseline has 1,249 passing tests, two failures and 20 skips: a dated news-context
fixture and a cached CCTV-region test. Those failures were observed before any
integration and are not represented as a clean Osiris suite.

Live paid forecasting and live Mapillary imagery remain untested without keys.
Forecast orchestration, progress/replay and cancellation are tested with scripted
fixtures. Public source content, geolocation and model outputs still require
human evaluation.
