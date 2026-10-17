# Camera stability and full-catalogue search

Status: staged in an isolated worktree; not applied to `/home/bk/gods-eye-view`, committed, or pushed. Real-app measurements and panel spot checks are in progress.

## Current retention policy

BK's later instruction, “Actually remove no cameras,” supersedes the earlier request to drop failed or unverified video feeds. Video candidates remain available regardless of the current playback verdict. Known snapshot endpoints and non-video records are still outside the existing video catalogue; this change does not introduce another removal pass. Native Caltrans, DelDOT and 511 loaders keep their original video URL in the full catalogue when a stream is temporarily unavailable.

The existing `streamHealth.js` owns all playback checks and its existing health cache. Catalogues and paging snapshots stay in server memory. No camera inventory is written to disk. Verdicts describe a check at a particular time; they are not a guarantee of future availability or proof of visible motion.

HLS checks resolve public IBI/DriveTexas playback tokens, use the proxy's playlist parser and limits, fetch a media segment (plus fMP4 initialization when required), and decode video bytes. MJPEG requires multipart content and two decodable JPEG frames. MP4/WebM must decode video bytes. Fetching an iframe page does not establish that its embedded player works; those results remain unverified. HTTP 403 is unavailable, never bypassed. Unknown and deferred feeds are not labelled as confirmed live.

Checks use eight workers, at most two active probes per host, and a two-request-per-host limit that also covers public token requests. Host-slot waiting is queue time, not an unreachable strike. HTTP 429/503 honor Retry-After. Unreachable feeds retain the existing two-strike rule; periodic rechecks allow recovery. Dev-server shutdown cancels old probes. Only verdicts persist, through an atomic write to the existing health-cache path. Video decoding requires `ffmpeg`; inability to decode is unverified.

## Loading and search

`/api/cctv/sources` now returns at most 256 records and a `page` envelope. Subsequent requests use `snapshot` and `offset`; the snapshot remains in memory across provider refreshes, expires after 15 minutes idle, and returns HTTP 409 if expired. Consumers must follow `page.next` until it is null. The browser performs sequential requests with a yield between batches. Status polling does not download camera records. The camera workspace uses the same paged source reader.

The globe keeps its existing paced, nearest-first marker placement and startup-cover handshake. Public camera state is prepared during registration batches instead of rebuilt for the entire catalogue on every UI notification.

Both camera controls open the full catalogue browser. There is no result cap: an empty query includes every camera, and matching searches include every match. Only the rows currently in view are rendered. Each row shows the camera name, location/provider, feed format, and check status. Scrolling and keyboard navigation reach the final record; typing searches names, locations, providers, IDs and codes. The native select remains an adapter for the existing camera-selection behavior, rather than a second tens-of-thousands-row DOM list.

## Verification

Full Node 24 suite after the latest application-code changes: **6,506 passed, 1 skipped, 0 failed**. This includes seven added tests for paging stability, media decoding, multipart MJPEG, iframe uncertainty, access refusals/retry delays, hidden projection texture uploads, and searching the final item in a 60,000-record catalogue. Synthetic fixtures are unit tests only; they are not used as real-app playback or loading evidence.

Running app baseline, measured without modifying port 4173: **46,156 records**, **25,832,846 bytes** in one `/api/cctv/sources` response. Feed types: HLS 34,305; iframe 5,137; MP4 2,543; MJPEG 4,171.

The earlier real-app recording on the isolated server at `http://127.0.0.1:4174`, using headless Windows Chrome on the NVIDIA RTX 3090, collected 47,284 cameras. The first 10 markers appeared at 19.252 seconds, after the cover was gone; the complete grid was registered at 63.119 seconds. Partial screenshots showed approximately 6,538, 20,170, and 33,739 markers. The counter lagged marker insertion slightly because its updates are paced. All records were registered; globe culling naturally hides markers on the far side of the planet.

That recording received 186 catalogue/status responses, with a maximum response of 213,882 bytes and 34,329,993 total bytes. Paging reduced the largest response, **not total transfer size**: verification metadata and repeated coverage metadata increased aggregate transfer from the baseline. There were no page errors or request timeouts. The largest main-thread task was 737 ms; this is not completely pause-free. The evidence is in `/tmp/childs-eye-stability-windows-recording` until the work is transferred. Subsequent search interaction changes require their own acceptance check; these timings are not a measurement of the unchanged app on port 4173.

The later real provider refresh yielded 47,276 cameras. The final search acceptance run compared all server IDs with the UI catalogue, scrolled through the entire list in overlapping windows, and **rendered and checked all 47,276 individual rows** against their expected camera IDs. It selected records 1, 23,639 and 47,276 through the real controls, confirmed their active camera IDs, and reached the final result of a 4,331-match GDOT query. The native dropdown opener and actual scrollbar pointer click passed; there were no page errors. Results and screenshots are in `/tmp/childs-eye-search-evidence`; the reproducible harness is `scripts/qa-camera-catalogue-picker.mjs`.

One earlier exhaustive run timed out at its scrollbar-click assertion. Two focused reproductions and the final exhaustive run passed without another application change; the earlier failure's exact cause was not established. Another run was invalidated when cleanup closed its test tab; it is not acceptance evidence. The final exhaustive run completed uninterrupted. These results verify the isolated app on port 4174; the search replacement remains unapplied to the main checkout.

Playback verification is not complete. Earlier automated panel samples include failures despite positive decoder verdicts, and at least one frame pair captured the globe before the panel painted its video. That pair is invalid motion evidence. Automated pixel differences alone are not accepted as proof of moving video. Provider-count comparisons and visually inspected motion spot checks remain outstanding. No claim that every feed works has been made, and no camera was removed because a playback check failed.

## Temporary cleanup

Removed the clean old worktrees `/tmp/childs-eye-before` and `/tmp/childs-eye-worldcam` and the previous task's temporary evidence directories, audit/playback scripts, screenshots, and test logs. The active checkout's stream-health, terrain, aircraft and satellite caches were left untouched. The current worktree and current evidence remain necessary until review/application is complete; they will be removed after the work is safely transferred.
