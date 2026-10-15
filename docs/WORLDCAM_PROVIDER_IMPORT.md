# WorldCam public-provider additions — 2026-10-15

## Delivery status

Prepared and tested in a separate checkout at `/tmp/childs-eye-worldcam`, based
on Child's Eye `d3de4be`. **Not applied to the running app or the childs_eye branch.**
Applying these server files restarts Vite. Port 4173 has not been restarted.
AI Watch was checked and is off.

This is a substantial but **incomplete** WorldCam import. Do not describe it as
“all WorldCam cameras added,” or describe the counts below as verified-working
streams. The user retains provider-listed unverified video, including MJPEG,
MP4 clips and iframe players. Existing recorded-dead exclusions remain intact.

## Implementation

- `publicVideo.js`: all video candidates from OpenCCTV's global marker index,
  hydrated in 50-ID batches with three workers; Taiwan THB's actual multipart
  URLs rather than snapshots; Taiwan Freeway Bureau's two multipart URL forms.
- `publicIbiVideo.js`: every published video view from Florida, Georgia,
  North Carolina and Pennsylvania. Anonymous public player tokens are negotiated
  when a feed is opened. Each state uses its own published token flow.
- `driveTexasVideo.js`: complete paged DriveTexas inventory, explicit WKT
  coordinates, and fresh signed HLS URLs when a viewer opens a feed.
- `mississippiVideo.js`: every video view on each public MDOT camera site.
- `rhodeIslandVideo.js`: RIDOT's published HLS players joined to OpenCCTV
  location records by the exact published image path. Stills are not registered.
- `castleRock511.js`: retain distinct video views instead of returning only
  the first. Preserve the first view's existing ID; other IDs use a stable
  feed hash. Deduplicate repeated URLs within a site. The audited Louisiana
  contribution increased from 320 to 469; Minnesota added no distinct HLS
  views in the inspected response.
- `stream.js` and `cctv.js`: demand-owned HLS source resolution and public
  publisher headers. Tokens remain in active in-memory sessions and refresh
  after upstream errors. Origin restrictions, cancellation, bounded buffers
  and viewer leases remain enforced. Tokens are not sent in catalogue responses.
- The standalone configuration registers these packs before the global
  aggregator so the original publisher's token-aware adapter wins deduplication.
  `CCTV_PUBLIC_VIDEO_ENABLED=0` disables these new packs.

No UI, globe, search, Street Level, Osiris tools or AI Watch rules changed.
Camera inventories remain in memory with the existing 15-minute catalogue TTL.
No camera-list or inventory file was created or deleted. Existing stream-health
and terrain caches were not removed or manually edited. Normal existing loader
health checks still run. Only test images and aggregate reports were saved.

## Counts and limitations

Counts are observations at different times; providers and recorded health change.

| Capture | HLS | iframe | MP4 | MJPEG | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Earlier running app baseline | 10,129 | 917 | 1,657 | 1,326 | 14,029 |
| Later running app, unchanged code | 9,794 | 914 | 1,660 | 1,352 | 13,720 |
| Final staged provider audit | 35,872 | 5,220 | 2,541 | 4,766 | 48,399 |

The staged audit used real upstream provider responses, the real catalogue
normalizer/deduplicator and the active checkout's recorded-dead cache. It did not
use a fixture catalogue. It is **not** a measurement of the running GUI.
The global provider offered 24,698 records and excluded 38 already-recorded-dead
HLS links. All new provider batches completed in this audit.

The existing `osiris-eastasia` pack timed out at 300 seconds. The global OpenCCTV
pack completed and supplied overlapping cameras, but that does not prove every
old region record was retained. Ontario lacked its configured key; existing
Osiris US-central and Turkey returned no usable records. Cold collection can
still take around five minutes. No claim of complete provider coverage is made.

| New pack | Offered | Recorded-dead excluded | Final contribution after deduplication |
| --- | ---: | ---: | ---: |
| osiris-ibi-video-fl | 4451 | 0 | 4422 |
| osiris-ibi-video-ga | 4331 | 0 | 4331 |
| osiris-ibi-video-nc | 997 | 0 | 972 |
| osiris-ibi-video-pa | 1348 | 0 | 1348 |
| osiris-drivetexas-video | 3528 | 0 | 3528 |
| osiris-mississippi-video | 932 | 0 | 932 |
| osiris-ridot-video | 130 | 0 | 130 |
| osiris-global-video | 24698 | 38 | 19179 |
| osiris-taiwan-video | 2213 | 0 | 2213 |
| osiris-taiwan-freeway-video | 1815 | 0 | 1223 |

A pack's final contribution is not its number of new WorldCam cameras: inventories
overlap, some records have aliases, and these providers also list cameras outside
WorldCam's captured live set.

The unchanged running app's later `/api/cctv/sources` response was 7,444,497 bytes
uncompressed. The final staged HTTP response size and new GUI counter have not
been measured on port 4173; that requires applying the changes and restarting
with permission. Status-only polling was not changed.

## WorldCam comparison

Firecrawl read WorldCam's public app and live marker inventory. The captured
`/api/cameras.geojson?live=1` contained 49,623 records: 37,386 HLS, 7,442 iframe,
and 4,795 MJPEG. WorldCam's public detail responses generally supplied its own
proxy URLs, not unrestricted original streams. Its public playback allowance
was not bypassed. No Enterprise API access was assumed.

Against that captured reference, the staged audit found:
- 27,882 matching mapped provider IDs within 100 m.
- 12,991 records within 100 m of a staged camera but without a confirmed ID match.
- 8,750 with neither match under this comparison.

**8,750 is not an exact “missing cameras” count.** Coordinate agreement cannot
prove the same view, IDs differ across sources, and upstream lists changed after
the reference capture. The crosswalk is incomplete, notably for Minnesota and
OpenCCTV aliases of other state sources. No co-located cameras were deleted
based on proximity.

| WorldCam source | Reference total | Confirmed ID + location | Nearby, unresolved | No match found |
| --- | ---: | ---: | ---: | ---: |
| caltrans | 1659 | 0 | 1533 | 126 |
| deldot | 356 | 354 | 2 | 0 |
| ibi_la | 476 | 0 | 468 | 8 |
| md_chart | 543 | 0 | 498 | 45 |
| ibi_pa | 1313 | 1292 | 1 | 20 |
| windy | 907 | 0 | 36 | 871 |
| cars_in | 2 | 0 | 2 | 0 |
| vdot | 1680 | 0 | 1568 | 112 |
| idrivearkansas | 468 | 0 | 32 | 436 |
| cotrip | 844 | 0 | 815 | 29 |
| ny511 | 1569 | 0 | 1511 | 58 |
| cars_ks | 201 | 0 | 41 | 160 |
| drivetexas | 3220 | 3219 | 0 | 1 |
| ibb_istanbul | 54 | 0 | 41 | 13 |
| ibi_nv | 168 | 0 | 167 | 1 |
| ibi_wi | 445 | 0 | 422 | 23 |
| iowa_dot | 681 | 0 | 662 | 19 |
| macau_dsat | 76 | 0 | 2 | 74 |
| modot | 520 | 0 | 484 | 36 |
| ibi_nc | 976 | 974 | 0 | 2 |
| nmroads | 172 | 0 | 0 | 172 |
| oktraffic | 464 | 0 | 0 | 464 |
| sc511 | 787 | 0 | 771 | 16 |
| tw_hsinchu_county | 23 | 0 | 2 | 21 |
| tw_keelung | 86 | 0 | 4 | 82 |
| tw_nantou | 13 | 0 | 4 | 9 |
| tw_taitung | 59 | 0 | 16 | 43 |
| tw_taichung | 316 | 0 | 29 | 287 |
| tw_freeway | 1805 | 1803 | 1 | 1 |
| tw_thb | 2344 | 2198 | 43 | 103 |
| vvc_flanders | 53 | 0 | 0 | 53 |
| ibi_fl | 4431 | 4417 | 0 | 14 |
| ibi_ga | 3128 | 3128 | 0 | 0 |
| tw_chiayi_city | 11 | 0 | 0 | 11 |
| opencctv | 11673 | 9680 | 349 | 1644 |
| argus | 620 | 0 | 220 | 400 |
| bpjt_id | 332 | 0 | 2 | 330 |
| worldcam_eu | 2710 | 0 | 86 | 2624 |
| ridot | 127 | 0 | 121 | 6 |
| bali_satudata | 51 | 0 | 0 | 51 |
| mdot_ms | 961 | 817 | 9 | 135 |
| cars_mn | 3299 | 0 | 3049 | 250 |

## Remaining work and access findings

- WorldCam.eu and Windy still have unresolved publisher-player URLs. A sampled
  WorldCam.eu record had an empty iframe URL and only the publisher's website.
  That operator link was not added as a live player. Thousands of those records
  still need individual original-player resolution.
- Arkansas's public inventory exposes HLS URLs, but its CDN returned 403 and
  its client requires a browser playback session/WAF flow. The alternate
  ACTIS camera wall displayed a login form. No WAF or login bypass was attempted,
  and those feeds have not been integrated.
- New Mexico's current public site exposes still images; its live-player
  function checks admin mode and passes an admin authentication token.
  The tested HLS origin timed out. Those protected streams were not integrated.
- Oklahoma's public site returned 403 in this environment; it was not integrated.
- Remaining unmatched sources and views in the table, including municipal
  Taiwan, BPJT, Argus and Flanders, are **not implemented or not fully reconciled**.
  Their absence is not evidence that they lack public live video.
- The global provider retains declared video formats, not still-image entries.
  Differences from WorldCam's older classification have not been fully audited.
- Existing dead records remain excluded even if WorldCam lists them.
- No claim is made that all new iframe, MJPEG, MP4 or HLS entries play.

## Verification

Full required command:
```sh
PATH=/home/bk/.nvm/versions/node/v24.21.0/bin:$PATH npm test
```
Result: **6,493 passed, 1 skipped, 0 failed** across the main test run and both
allocation runs. Main run: 6,479 passed / 1 skipped; allocation runs: 1 and 13
passed. Log: `/tmp/childs-eye-worldcam-final-tests.log`. `git diff --check` passed.

Regression coverage includes inventories larger than 256, full pagination,
multiple views, partial batches, snapshot rejection, existing dead exclusions,
correct per-state token endpoints, on-demand refresh, origin refusal, cancellation,
Texas stream identity, MDOT multi-view mapping and RIDOT explicit-player joins.

Actual-feed samples used the staged HLS puller and decoded downloaded segments;
MJPEG samples read two JPEG frames from the same continuous multipart response.
No synthetic catalogue or video was used. Central-pixel comparisons exclude
image borders where timestamp overlays often appear. The paired images were
also inspected visually.

| Source | Sample | Frame gap | Result |
| --- | --- | ---: | --- |
| Florida | `fl:1:1` | 4.572 s | Vehicles visibly moved |
| North Carolina | `nc:4020:4020` | 4.592 s | Vehicles visibly moved |
| Pennsylvania | `pa:4129:6178` | 4.557 s | Vehicles visibly moved |
| Texas | `TX_ELP_007` | 4.563 s | Vehicles visibly moved |
| Mississippi | `010205` | 4.582 s | Vehicles visibly moved |
| Taiwan THB | `CCTV-21-0010-123-003` | 4.577 s | Continuous MJPEG; visible scene/rain changes |
| Taiwan Freeway | `CCTV-N1-S-0.000-M` | 4.617 s | Vehicles visibly moved |

Evidence pairs: `/tmp/childs-eye-worldcam-evidence/<source>-first.jpg` and
`<source>-second.jpg`, with source labels `fl`, `nc`, `pa`, `texas`,
`mississippi`, `taiwan-thb`, `taiwan-freeway`.

Failed/unverified samples:
- Georgia: two public signed-feed samples timed out; no moving frames confirmed.
- Rhode Island: three official HLS links returned HTTP 403 “Not Found”; no
  moving frames confirmed. Retained as provider-listed candidates, not
  represented as verified-live.
- OpenCCTV samples `va511-3958` and `s511-SC-2735`: no playable segments
  before the puller's deadline. Broad aggregator playback remains unverified.
- Texas `TX_ELP_006` succeeded in an earlier three-camera puller test, but failed
  the later frame run's deadline. `TX_ELP_007` supplied the successful pair.
- Samples do not verify entire providers. Embedded players and MP4 candidates
  were not individually reviewed during this addition.

**Real-app installation, GUI counts and panel playback remain pending permission
to restart port 4173.** Do not report that the running app has these additions yet.

## NSTAR license

Use [NSTAR Get Access](https://nstarlive.com/#get-access), select the individual
Founders option and choose the access duration at checkout. The public page says
this includes the camera globe and all nine core sectors, accepts crypto, and
does not auto-renew. Enter the issued key at
[the panel login](https://app.nstarlive.com/login).

For API integration, the public professional comparison advertises API access
on Sapphire and Diamond; individual access does not establish export/API rights.
Ask [NSTAR's sales team](mailto:team@nstarlive.com) whether the license permits
camera-catalogue and original-stream use in Child's Eye before buying for that
purpose. No message was sent and no purchase was made.

Exact current prices were not verified. Automatic approval review rejected
reading a tokenized checkout session as private-session access; that URL was not
read or retried. Public plan details above were checked on 2026-10-15.

