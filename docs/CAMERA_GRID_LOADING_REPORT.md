# Progressive camera grid verification — 2026-10-14

Verified against the existing application at **http://127.0.0.1:4173** using its real camera API and Cesium billboard collection. No fixture catalogue, response interception, substitute server, or server restart was used. No `server/**` files were edited. The existing catalogue admission rules, live-only filtering, and full-catalogue search behaviour are preserved.

## What now happens

The startup cover finishes fading before CCTV preparation begins. Preparation yields between groups of 128 records. Billboards are created by the geometry queue, nearest to the initial view first, instead of being created as a hidden collection and revealed together. Initial placement visits the **entire** catalogue, in batches of up to 64 with a 6 ms work budget and a 16 ms yield. The counter says **loading frames** during placement and **camera grid ready** on completion.

The later, view-local terrain refinement still uses its existing 256-camera budget. That does not limit initial placement: the final recording proves all 13,975 records received markers. Video connections remain on demand; the grid counter measures camera placement, not thousands of simultaneous video downloads.

The full picker retains every camera and the existing search labels/matching. Its option nodes are prepared in small, detached batches before being attached, avoiding the large synchronous UI handoff at completion. Search is enabled when the complete list is available; no subset or search cap was reintroduced.

## Real warm-start recording

Evidence directory: [`output/camera-grid-final-evidence`](../output/camera-grid-final-evidence/).

- [All 250 ms samples, long tasks, first API status, screenshot timing, and renderer](../output/camera-grid-final-evidence/recording.json)
- [Early placement: 1,728 / 13,975](../output/camera-grid-final-evidence/progress-0.1.png)
- [Middle placement: 6,208 / 13,975](../output/camera-grid-final-evidence/progress-0.4.png)
- [Later placement: 10,048 / 13,975](../output/camera-grid-final-evidence/progress-0.7.png)
- [Grid ready](../output/camera-grid-final-evidence/ready.png)
- [CPU profile](../output/camera-grid-final-evidence/cpu-profile.json)

The browser's first `/api/cctv/sources?status=1` response reported **13,975**, `snapshotReady: true`, `loading: false`, revision 200. This exercises the warm catalogue case, not a cold-provider countdown. The catalogue count is the real server count in this recording; it is not a hard-coded target.

The test used a separate headless Windows Chrome window with **NVIDIA GeForce RTX 3090 / ANGLE Direct3D11**, 1440 × 1000 pixels. A real share link restored the satellite globe to 30.27° N, 97.74° W at 10,000 km altitude so the expanding North American grid is visible. Coordinates were checked before each progress screenshot. This did not change the user's browser session or saved view.

Times below are measured from page navigation. The timer requested a sample every 250 ms; actual timestamps are retained rather than interpolated.

| Time | GUI counter | Markers placed worldwide | Markers visible in this view |
| --- | --- | ---: | ---: |
| 3.276 s | loading frames — 0 / 13,975; cover gone | 0 | 0 |
| 5.639 s | loading frames — 0 / 13,975 | 64 | 64 |
| 6.547 s | loading frames — 1,728 / 13,975 | 2,240 | 2,240 |
| 8.051 s | loading frames — 6,848 / 13,975 | 7,040 | 6,365 |
| 9.299 s | loading frames — 10,688 / 13,975 | 10,944 | 6,365 |
| 10.675 s | camera grid ready — 13,975 / 13,975 | 13,975 | 6,365 |

The progress label is coalesced between batches, so it can lag the instantaneous marker count; completion reports the exact final count. The remaining worldwide markers are outside this view or behind the globe, not omitted from the grid. There were **20 recorded partial-grid samples** and zero page errors. No sampled markers appeared behind the loading cover. The harness also waited for the enabled picker to contain all 13,975 options; it finished at approximately **11.83 s**.

The longest measured main-thread task after the cover disappeared was **210 ms**; the largest actual interval between requested 250 ms samples was **361 ms**. The recording did not reproduce the previous 1.5-second registration freeze, but these measurements do not mean zero long tasks or guaranteed frame rates on every device. The evidence covers this real warm-start view, not every map style or machine.

An earlier software-rendered run had graphics compilation/readback stalls. An intervening attempt encountered a cold provider collection and failed the warm-start assertion; it is not used as final proof. The final recording above asserts that the first source response was already ready.

## Validation and reproduction

- `PATH=/home/bk/.nvm/versions/node/v24.21.0/bin:$PATH npm test`: **6,460 passed, 1 skipped**, plus **14 allocation checks passed**, zero failures. Log: `/tmp/eye-grid-final-tests.log`.
- Production build passed; the existing large-chunk advisory remains. Log: `/tmp/eye-grid-release-build.log`.
- Formatting checked 1,376 source files; `git diff --check` passed.
- Regression tests cover full initial placement beyond 256 cameras, nearest-first ordering, view-settle events not resetting the drain, actual progress counts, cancellation, and retaining the complete search list while its UI is prepared in batches.

The committed harness is [`scripts/qa-camera-grid-loading.mjs`](../scripts/qa-camera-grid-loading.mjs). With the application already running and a separate browser exposing CDP on port 9231, reproduce with:

```sh
GRID_QA_BROWSER_URL=http://127.0.0.1:9231 \
GRID_QA_OUT=output/camera-grid-final-evidence \
PATH=/home/bk/.nvm/versions/node/v24.21.0/bin:$PATH \
node scripts/qa-camera-grid-loading.mjs
```

This command does not launch the app server. It records aggregate counts and screenshots, not camera inventory files. Evidence files remain local under the ignored `output/` directory; the harness and this report are committed.
