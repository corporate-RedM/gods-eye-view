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
Source inventories persist across restarts, and failed/partial refreshes retain
previous records. The other gaps in the table remain open.
