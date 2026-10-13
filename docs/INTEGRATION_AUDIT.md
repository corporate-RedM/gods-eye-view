# Integration audit — 2026-10-11

The first delivery overstated how completely the agreed integration was finished.
Its passing tests established the behavior that was implemented, not feature parity
with Osiris. This audit distinguishes actual implementation from omissions.

| Area | First delivery | Gap |
| --- | --- | --- |
| CCTV | Twelve added Osiris adapters, capped at 400 each and 5,000 total, with the native 10,000 cap retained | Missing most of Osiris's regions, public-webcam lists and embedded/operator-hosted cameras; native provider and district caps also reduced coverage |
| Typed assistant | A structured JSON tool runner sharing the native tool catalogue | Not Osiris's conversational OI Assist |
| Forecast | Working orchestration API, start/cancel/status and source-linked reports | No file/pasted context input, interactive steering UI or simulated-world globe playback; live paid inference was not tested |
| Live broadcasts | News/RSS/public Telegram reports | Osiris's 23-channel broadcast network was not integrated |
| Conflict zones | Existing Child's Eye/upstream awareness layers retained | Osiris's dedicated conflict-zone layer was not integrated |
| Investigations | Seven public-record lookups | No active port scanner; current result presentation is mainly JSON rather than Osiris's richer panels |
| Graphics | Upstream merge, optical default, neutral workspace, rendering presets | No new building-mesh source or hardware performance proof; free imagery does not recreate Google's photorealistic buildings |
| Street Level | Upstream Mapillary feature and fixture tests | Live photos require a token and were not verified |
| Saved areas | Local polygons, queries and GeoJSON/CSV export | Does not imply all Osiris area-related workflow features are present |
| Local analysis | YOLOX-nano frame analysis/short watch, original area AI Watch retained | Counts are model estimates; embedded third-party players do not expose frames for local analysis |

The 6,435 figure reported previously was the passing main **test count**, not a
camera count. Camera totals depend on the returned inventories and their current
availability. Counts alone are not an acceptance test for coverage.

The camera correction must demonstrate that every registered provider is included,
that native and imported inventories are not trimmed by count, that shared-camera
deduplication retains provenance, and that unavailable providers remain visible in
coverage reporting. No arbitrary advertised count will substitute for this check.

Items above remain gaps until their implementation and validation are recorded.

## Camera correction

The replacement includes all 56 regions registered in the pinned Osiris source
and all 19 native groups, without camera-count trimming. California's twelve
districts and all Texas districts are requested. The OpenCCTV index is fetched
in full instead of using Osiris's region samples, with three concurrent batch
requests, retries and explicit partial-inventory reporting. This is why the
combined count can exceed Osiris's advertised 17,000 significantly.

The completed inventory audit on 2026-10-11 returned **78,773 registered records**
after 8,908 exact shared records were merged. All 649 OpenCCTV batch requests
completed without a failed batch. The result includes 59,816 still-image records,
9,907 HLS, 1,655 MP4, 1,373 MJPEG, 968 embedded players and 5,054 operator links.
These are catalogue records, not a count of independently verified online cameras
or unique physical devices. Separate views of a device may be separate records.

The audit preserved 176 cached Tarktee records during a failed refresh. Osiris's
Turkey module is an empty array in the pinned source; its US-central Illinois
endpoint returned no camera records. Both regions remain registered and visible
in coverage reporting. They have not been replaced with fabricated entries.

The coverage JSON, browser check and screenshots are under
`output/camera-coverage/`. The browser test compares catalogue and actual globe
counts, checks pagination, embedded players, operator links and player cleanup.
That historical version persisted inventories. On 2026-10-12, BK requested
memory-only inventories with the original 15-minute TTL, server-side exclusion
of images and website-only links, and lightweight collection-status polling.
All provider-listed video types (including MJPEG, MP4/WebM and unverified embeds)
remain available for BK to judge unless an existing stream-health verdict records
them as dead (BK's 2026-10-13 correction). The browser sample checks are diagnostic;
they do not write those verdicts. The next section records the earlier implementation.

## Completion and CCTV regression repair

The first-delivery table above is historical. The following gaps now have native
Child's Eye implementations; the separate Osiris server is not needed:

- Conversational Assistant with provider/key selection, shared query tools,
  globe movement, layer toggles, workspace navigation, cancellation and a bounded
  tool loop. No paid forecast or active network scan starts through this loop.
- Forecast text/file context, input-token estimates, brief/panel context scope,
  event injection, follow-up questions, and world/event playback on the globe.
  Forecast event exports now retain coordinates instead of discarding them.
- All 23 frontend broadcast channels and all 15 conflict-region anchors from the
  pinned Osiris source. The earlier table's 13 conflict zones was an inaccurate
  count. Region matches use actual source headlines, without fabricating exact
  event coordinates. Users can retain these overlays on the globe.
- Expandable investigation results, linked source fields, raw JSON export,
  and an explicitly started TCP connection/passive-banner check with cancellation.

CCTV Nearest now selects a different matching feed near the view centre, with
viewer position as the fallback when looking off the globe. The Focus control
continues to return to the selected feed. Search retains access to every record;
only visible DOM suggestions are bounded. The camera index is reused by frame
and media requests until the catalogue changes, and provider completions are
coalesced before rebuilding the inventory. Terrain work is limited to nearby
cameras and the selection, and follows camera movement.

The sequential headless comparison measured CCTV activation at **20,429 ms before
and 10,808 ms after**, with 78,956 and 80,026 available records respectively.
Dropdown options dropped from 78,956 to 250; terrain refinement queued 256 local
records instead of all 78,956. These are single-run SwiftShader measurements,
not guarantees for BK's GPU. A separate 30-request local frame-route comparison
measured median overhead of **21.18 ms before and 0.81 ms after** (95th percentiles
33.33 ms and 1.34 ms). That isolates local routing and does not measure upstream
camera download time. Cold provider collection still depends on external
services. The later memory-only policy recollects on every server restart.

Evidence is in `output/completion/`: browser control/assistant checks, scenario
file/injection/question/playback checks, conflict cleanup, screenshots and the
startup timing comparison. Model endpoints in browser tests were intercepted;
server orchestration uses scripted fixtures. The TCP check is tested against an
owned local service. No paid inference was performed.

Provider-dependent limits remain explicit: there is no configured Mapillary token
for live street photography, no new photorealistic building-mesh subscription,
and no hardware FPS benchmark. Free satellite imagery and terrain, graphics
presets, and upstream Street Level integration remain available. Those limits
must not be represented as verified live imagery or free Google buildings.
