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

The **Workspace** button opens the Intelligence desk: Overview, News, Broadcasts,
Conflicts, Cameras, Areas, Investigate, Forecast, Assistant, and Tools. Child's Eye operates independently of the
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
  wallet and sanctions lookups with expandable records, source links and JSON
  export. Select **TCP ports and service banners** to explicitly check up to 32
  ports on a specified host. It uses TCP connections and passive banners, with
  cancellation; it does not run exploitation or vulnerability verification.
- Camera **Analyze frame** and **Watch 30 s** run YOLOX-nano locally through a
  single-thread browser WASM worker. This counts visible object categories;
  it does not identify people. Counts can miss objects or be wrong, and slow
  snapshot refreshes may repeat the same picture.
- Forecast offers explicitly started, source-linked research with cancellation,
  progress, export, and Quick as the default depth. Only one run may be active.
  Provider credentials are kept in memory, not saved with browser preferences.
  Paste context or load text/CSV/JSON/Markdown (up to 100,000 characters), choose
  whether actors read it each period, inject an event into a running simulation,
  or ask a follow-up using an entered key. Simulated-world playback maps events
  that have coordinates; unlocated events remain in the timeline.
- News, investigation, and forecast-option tools join the shared native tool
  catalogue used by Tools, voice, and MCP. **Assistant** adds conversational
  access to the query tools, globe navigation, layer toggles and workspace tabs.
  It uses a selected provider/key, offers Stop, and limits a message to six
  model steps. Conversation and key are cleared when leaving the tab. Tools
  remains available for direct structured inputs.
- Broadcasts includes all 23 channels from Osiris's frontend list, with a player
  and external broadcaster link. Conflicts includes all 15 editorial region
  anchors, enriched with matching source-linked headlines. Severity labels are
  inherited classifications, not verified live frontlines. Both overlays can
  be kept on the globe using their checkbox. Player availability depends on
  broadcaster embedding restrictions.
- **Nearest** selects another matching camera near the centre of the current
  view. **Focus** returns to the currently selected camera. Camera search covers
  the full inventory while rendering at most 250 suggestions plus the selection.
  Terrain refinement follows the viewed area and selected camera instead of
  preloading terrain for every camera worldwide. This limits work, not cameras.

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

Inventories are memory-only with a 15-minute TTL; every restart collects again.
Collection polls a small status envelope every two seconds and transfers the
camera list once ready. The server excludes images and website-only links;
HLS, MJPEG, MP4/WebM and embeds remain when unverified; existing recorded dead
stream verdicts are respected by both source loaders and the merged catalogue.
MJPEG streams play continuously in the camera panel's IMG element.
Cameras offers pagination and an
**Export provider coverage** action. Coverage distinguishes unavailable, stale,
and partial sources; a registered record does not establish working playback.
See [INTEGRATION_AUDIT.md](INTEGRATION_AUDIT.md) for the first delivery's omissions,
their completed follow-up implementations, and remaining provider-dependent limits.

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
suite has 6,444 main tests (6,443 passing, one skip), plus 14 passing allocation checks.
Production build, formatting, package boundaries and layer-token compatibility
are checked separately. A socket test now waits for the second AIS fix before
asserting a two-point trail, avoiding a race between separate WebSocket frames.

Headless scripts under `scripts/qa-eye-*.mjs` exercise the workspace, live camera
playback, browser inference, origin rejection, and before/after views of Toronto,
Manhattan and the Alps. Screenshot evidence and run logs are kept in the ignored
`output/ultimate-eye-2026-10-10` directory in BK's working repository. These
screenshots use SwiftShader; their frame rates are not hardware benchmarks.
The completion pass adds `output/completion/` for CCTV timing, full-inventory
search and Nearest checks, assistant actions, and forecast/context/playback tests.

Standalone Osiris builds and serves successfully. Its untouched upstream test
baseline has 1,249 passing tests, two failures and 20 skips: a dated news-context
fixture and a cached CCTV-region test. Those failures were observed before any
integration and are not represented as a clean Osiris suite.

Live paid forecasting and live Mapillary imagery remain untested without keys.
Forecast orchestration, progress/replay and cancellation are tested with scripted
fixtures. Public source content, geolocation and model outputs still require
human evaluation.
