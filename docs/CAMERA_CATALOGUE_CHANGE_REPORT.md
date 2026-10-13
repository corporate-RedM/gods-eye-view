# Camera catalogue change report — updated 2026-10-13

The Child's Eye standalone catalogue now retains provider-listed HLS, MJPEG,
MP4/WebM and embedded players. It excludes still-image records and website-only
operator links on the server. Existing stream-health verdicts marked dead are
respected; merely unverified feeds remain. The panel already supported iframe players; the earlier
claim that it could not play them was incorrect. MJPEG now uses one continuous
multipart stream in the displayed IMG, without a preloader or periodic restarts.

The catalogue no longer reads or writes a disk inventory. Its refresh TTL remains
15 minutes; provider failures can retain records only within the current process.
A restart collects again. Count polling uses a small status envelope, followed by
one full catalogue download. Empty video catalogues do not create seed cameras.
The globe rendering, Street Level, Osiris tools and AI Watch rules were not changed.
AI Watch was checked off before server edits.

## Measured counts and download sizes

Baseline measured 2026-10-12T18:54:20.312Z; the after capture comes from the
final-policy browser run started at 2026-10-13T16:53:47.196Z, once collection completed.
These are observations of changing provider inventories, not playback guarantees.

| Feed type | Before | After |
| --- | ---: | ---: |
| hls | 10,174 | 9,942 |
| mjpeg | 1,354 | 1,360 |
| mp4 | 1,659 | 1,663 |
| webm | 0 | 0 |
| iframe | 952 | 918 |
| image | 60,799 | 0 |
| external | 5,052 | 0 |
| **Total** | **79,990** | **13,883** |

- Full `/api/cctv/sources` JSON body: **43,414,347 bytes before**, **7,530,501 bytes after** (82.7% smaller). These are decoded JSON body sizes, not compressed wire-transfer sizes.
- Final cold-start browser capture: **95 status checks of 121–123 bytes each** (11,497 bytes in total), then **one** full-list download.
- Browser counter: **13,883 / 13,883 cameras**; all downloaded catalogue records were video types. No image or external records reached the browser catalogue.
- **Zero** video feeds or embedded players were removed for being unverified. There are no WebM records in this measured provider response, but the admission filter retains that type.

The superseded 2026-10-12 capture with the dead checks bypassed contained 15,105
video records. The final-policy count is 13,883. Provider inventories also changed
between runs, so that difference is not an exact count of excluded dead feeds.
The original baseline contained 14,139 video records and 65,851 image/external records.
The after count is not simply subtraction from a frozen dataset: providers
refreshed between measurements, and deduplication now compares video/embed URLs
rather than discarding distinct videos that happen to share a snapshot URL.
All configured provider packs remain registered, with no camera cap added.
On 2026-10-13 BK requested restoration of the Caltrans, DelDOT and state-511
dead-stream checks. The merged catalogue also reads their existing dead verdicts
without scheduling new probes, preventing aliases or stale pack records from
reintroducing a known-dead URL. Unverified video and embeds remain eligible.

## Files deleted

1. `/home/bk/gods-eye-view/.cache/cctv-full-catalog.json`
2. `/home/bk/childs-eye-integration/.cache/cctv-full-catalog.json`
3. `/home/bk/CyberSecurity/osiris/.next/standalone/.cache/cctv-catalog.json`

The third file was an older inventory in the separate Osiris installation.
Its upstream application code was left unchanged as requested; launching that
separate app can recreate its own cache. Child's Eye does not use that file.
The older integration checkout's application code was also left unchanged;
launching the old branch can recreate its old cache. The memory-only implementation
is on `childs_eye` in `/home/bk/gods-eye-view`.

## Camera-bearing caches left alone

In `/home/bk/gods-eye-view`:

- `.gev-cache/cctv-stream-health.json`: camera IDs and stream-health results.
- `.gev-cache/caltrans-streams.json`: legacy stream-health data, not a catalogue.
- `.gev-cache/terrain-heights.json`: terrain samples, including camera locations.
- `.gev-cache/cctv-watch/profiles.json` and `.gev-cache/cctv-watch/baselines.npz`: AI Watch camera profiles/baselines.
- `src/data/local_data/cctv_ground_heights/cctv_ground_heights.json`: authored camera height metadata.

The integration checkout's `.gev-cache/cctv-stream-health.json`,
`.gev-cache/terrain-heights.json` and authored camera height metadata were also
left alone. Aircraft, satellite and other caches were not edited or deleted.
Stream-health files were not deleted or manually edited. The restored existing
health checks can update their verdicts through the application's normal refresh;
the merged-catalogue reader itself only reads those verdicts.
Existing AI Watch incident/evaluation data under `output/cctv-evidence/` and
`output/cctv-eval/` was preserved as well.
Authored provider configurations were preserved; they are input configuration,
not collected inventories. QA outputs contain aggregate counts and individual
playback evidence, never a saved full camera list.

## Counts by source/provider

Counts are after cross-pack deduplication and the restored dead-stream checks.

| Provider | Before | After | Before types | After types |
| --- | ---: | ---: | --- | --- |
| 511 Iowa (Iowa DOT) | 701 | 640 | hls: 647; image: 54 | hls: 640 |
| 511 Louisiana (LA DOTD) | 335 | 320 | hls: 321; image: 14 | hls: 320 |
| 511 Minnesota (MnDOT) | 1,251 | 1,055 | image: 192; hls: 1,059 | hls: 1,055 |
| 511 Ontario | 3 | 0 | image: 3 | — |
| 511 Wisconsin (WisDOT) | 456 | 441 | hls: 442; image: 14 | hls: 441 |
| ADOT | 644 | 0 | image: 644 | — |
| AMSS / GKPP | 1 | 1 | hls: 1 | hls: 1 |
| ANN News / YouTube | 1 | 1 | iframe: 1 | iframe: 1 |
| APRR | 20 | 0 | external: 20 | — |
| AREA | 7 | 0 | external: 7 | — |
| ASFINAG | 1,820 | 0 | image: 1,820 | — |
| Attiki Odos | 2 | 2 | iframe: 2 | iframe: 2 |
| Austin Transportation & Public Works | 821 | 0 | image: 821 | — |
| Autostrade per l'Italia | 979 | 983 | mp4: 979 | mp4: 983 |
| Butler County, OH | 2 | 0 | image: 2 | — |
| Caltrans | 3,642 | 1,521 | hls: 1,510; image: 2,132 | hls: 1,521 |
| CamStreamer | 47 | 47 | iframe: 47 | iframe: 47 |
| Cincinnati, OH | 2 | 0 | external: 2 | — |
| City of Edmonton | 58 | 58 | hls: 58 | hls: 58 |
| City of Ottawa | 428 | 0 | image: 428 | — |
| City of Tallinn | 255 | 0 | image: 255 | — |
| City of Toronto | 336 | 0 | image: 336 | — |
| DGT | 1,934 | 0 | image: 1,934 | — |
| DelDOT | 349 | 335 | hls: 349 | hls: 335 |
| DriveBC | 2,112 | 0 | image: 2,112 | — |
| FDOT | 4,967 | 30 | image: 4,959; hls: 8 | hls: 30 |
| Fintraffic | 2,269 | 0 | image: 2,269 | — |
| GDOT | 4,330 | 0 | image: 4,330 | — |
| HK Transport Dept | 1,013 | 0 | image: 1,013 | — |
| INDOT TrafficWise | 741 | 707 | hls: 741 | hls: 707 |
| LADOTD | 1 | 0 | image: 1 | — |
| LTA Singapore | 8 | 0 | image: 8 | — |
| Live Traffic | 1 | 0 | image: 1 | — |
| Live Traffic NSW | 248 | 0 | image: 248 | — |
| MDOT MiDrive | 795 | 0 | image: 795 | — |
| MLIT river.go.jp | 33 | 0 | image: 33 | — |
| NCDOT | 1,034 | 25 | image: 1,009; hls: 25 | hls: 25 |
| NDOT | 24 | 0 | image: 24 | — |
| NVroads (NDOT) | 628 | 507 | image: 115; hls: 513 | hls: 507 |
| NZTA | 250 | 0 | image: 250 | — |
| Neotel / GKPP | 2 | 2 | hls: 2 | hls: 2 |
| ODOT TripCheck | 1,141 | 0 | image: 1,141 | — |
| Ontario 511 | 925 | 0 | image: 925 | — |
| OpenCCTV / airlive | 2 | 2 | iframe: 2 | iframe: 2 |
| OpenCCTV / airportwebcams | 18 | 12 | iframe: 11; image: 6; mjpeg: 1 | iframe: 11; mjpeg: 1 |
| OpenCCTV / airservices | 4 | 0 | image: 4 | — |
| OpenCCTV / ansan | 89 | 89 | hls: 89 | hls: 89 |
| OpenCCTV / arcgis_cams | 1 | 1 | hls: 1 | hls: 1 |
| OpenCCTV / asahan | 19 | 19 | hls: 19 | hls: 19 |
| OpenCCTV / astrakhan | 46 | 46 | hls: 46 | hls: 46 |
| OpenCCTV / atv | 3 | 0 | image: 3 | — |
| OpenCCTV / balikesir | 26 | 26 | iframe: 26 | iframe: 26 |
| OpenCCTV / balticlivecam | 3 | 3 | iframe: 3 | iframe: 3 |
| OpenCCTV / bandung-pelindung | 271 | 257 | hls: 271 | hls: 257 |
| OpenCCTV / bantul | 41 | 41 | hls: 41 | hls: 41 |
| OpenCCTV / belarus-customs | 7 | 0 | image: 7 | — |
| OpenCCTV / biodic | 35 | 0 | image: 35 | — |
| OpenCCTV / bondowoso | 19 | 19 | mjpeg: 19 | mjpeg: 19 |
| OpenCCTV / bpjt | 1 | 1 | hls: 1 | hls: 1 |
| OpenCCTV / busan | 353 | 354 | hls: 353 | hls: 354 |
| OpenCCTV / camscape-curated | 14 | 10 | iframe: 12; hls: 2 | iframe: 8; hls: 2 |
| OpenCCTV / camstreamer | 202 | 189 | iframe: 202 | iframe: 189 |
| OpenCCTV / castlerock | 1 | 1 | hls: 1 | hls: 1 |
| OpenCCTV / changwon | 136 | 135 | hls: 136 | hls: 135 |
| OpenCCTV / chungju | 55 | 55 | hls: 55 | hls: 55 |
| OpenCCTV / daegu | 177 | 177 | hls: 177 | hls: 177 |
| OpenCCTV / dsat | 83 | 89 | hls: 83 | hls: 89 |
| OpenCCTV / dwr-nakhonsri | 10 | 0 | image: 10 | — |
| OpenCCTV / earthcam | 10 | 11 | hls: 10 | hls: 11 |
| OpenCCTV / forecastweather | 7 | 11 | hls: 7 | hls: 11 |
| OpenCCTV / freecam-ro | 17 | 17 | hls: 17 | hls: 17 |
| OpenCCTV / geoje | 49 | 49 | hls: 49 | hls: 49 |
| OpenCCTV / gimpo | 63 | 63 | hls: 63 | hls: 63 |
| OpenCCTV / goyang | 173 | 173 | hls: 173 | hls: 173 |
| OpenCCTV / gwangju | 113 | 114 | hls: 113 | hls: 114 |
| OpenCCTV / hanshin-expressway | 17 | 0 | image: 17 | — |
| OpenCCTV / hatyai-climate | 1 | 0 | image: 1 | — |
| OpenCCTV / himawari | 3 | 0 | image: 3 | — |
| OpenCCTV / hko-webcams | 34 | 0 | image: 34 | — |
| OpenCCTV / home-solutions-bg | 1 | 0 | image: 1 | — |
| OpenCCTV / hongkong | 2 | 0 | image: 2 | — |
| OpenCCTV / ibb-istanbul | 350 | 349 | hls: 350 | hls: 349 |
| OpenCCTV / incheon | 225 | 226 | hls: 225 | hls: 226 |
| OpenCCTV / infoclimat | 1 | 0 | image: 1 | — |
| OpenCCTV / itic | 70 | 69 | hls: 70 | hls: 69 |
| OpenCCTV / jogjaprov | 499 | 304 | hls: 499 | hls: 304 |
| OpenCCTV / jp-airports | 2 | 0 | image: 2 | — |
| OpenCCTV / kahramanmaras | 20 | 20 | hls: 20 | hls: 20 |
| OpenCCTV / kaiho | 70 | 70 | hls: 70 | hls: 70 |
| OpenCCTV / kg-camera | 20 | 20 | hls: 20 | hls: 20 |
| OpenCCTV / kkr | 324 | 0 | image: 324 | — |
| OpenCCTV / meter-ac | 6 | 0 | image: 6 | — |
| OpenCCTV / middle-east-yt | 1 | 1 | iframe: 1 | iframe: 1 |
| OpenCCTV / mlit-kanto | 68 | 0 | image: 68 | — |
| OpenCCTV / mlit-yamagata | 17 | 0 | image: 17 | — |
| OpenCCTV / moldova-roads | 12 | 0 | image: 12 | — |
| OpenCCTV / mudik | 161 | 161 | hls: 161 | hls: 161 |
| OpenCCTV / nasa-worldview | 3 | 0 | image: 3 | — |
| OpenCCTV / nexco-japan | 129 | 0 | image: 129 | — |
| OpenCCTV / niigata | 175 | 0 | image: 175 | — |
| OpenCCTV / novosibirsk | 9 | 9 | hls: 9 | hls: 9 |
| OpenCCTV / numazu-snow | 15 | 0 | image: 15 | — |
| OpenCCTV / ny511 | 1 | 1 | hls: 1 | hls: 1 |
| OpenCCTV / opensnow | 38 | 0 | image: 38 | — |
| OpenCCTV / opentopia | 29 | 0 | image: 29 | — |
| OpenCCTV / openwebcamdb | 326 | 250 | iframe: 243; image: 64; hls: 19 | iframe: 230; hls: 20 |
| OpenCCTV / osm-webcams | 29 | 25 | iframe: 24; image: 4; mjpeg: 1 | iframe: 24; mjpeg: 1 |
| OpenCCTV / panomax | 12 | 0 | image: 12 | — |
| OpenCCTV / phenocam | 15 | 0 | image: 15 | — |
| OpenCCTV / pohang | 140 | 140 | hls: 140 | hls: 140 |
| OpenCCTV / rivergojp | 10,819 | 0 | image: 10,819 | — |
| OpenCCTV / road-info-prvs | 1,755 | 0 | image: 1,755 | — |
| OpenCCTV / rta-telecom | 65 | 65 | hls: 65 | hls: 65 |
| OpenCCTV / sakura-live-cams | 151 | 151 | iframe: 151 | iframe: 151 |
| OpenCCTV / saoras | 4 | 0 | image: 4 | — |
| OpenCCTV / sejong | 48 | 48 | hls: 48 | hls: 48 |
| OpenCCTV / selangor-flood | 34 | 0 | image: 34 | — |
| OpenCCTV / singapore | 8 | 0 | image: 8 | — |
| OpenCCTV / singapore-weather | 1 | 0 | image: 1 | — |
| OpenCCTV / sochi-camera | 153 | 0 | image: 153 | — |
| OpenCCTV / starvisor | 3 | 0 | image: 3 | — |
| OpenCCTV / state511 | 1 | 0 | image: 1 | — |
| OpenCCTV / stringmeteo | 9 | 0 | image: 9 | — |
| OpenCCTV / stv | 20 | 0 | image: 20 | — |
| OpenCCTV / tabi-cam | 2 | 2 | iframe: 2 | iframe: 2 |
| OpenCCTV / taiwan-freeway | 55 | 77 | mjpeg: 55 | mjpeg: 77 |
| OpenCCTV / tangerang | 26 | 27 | hls: 26 | hls: 27 |
| OpenCCTV / tasikmalaya | 19 | 19 | hls: 19 | hls: 19 |
| OpenCCTV / thai-drr | 3 | 3 | hls: 3 | hls: 3 |
| OpenCCTV / thailand-doh | 90 | 88 | hls: 90 | hls: 88 |
| OpenCCTV / tik-lithuania | 18 | 0 | image: 18 | — |
| OpenCCTV / topis-seoul | 493 | 493 | hls: 493 | hls: 493 |
| OpenCCTV / twipcam | 5,864 | 1,261 | image: 4,587; mjpeg: 1,277 | mjpeg: 1,261 |
| OpenCCTV / uab-bg | 1 | 0 | image: 1 | — |
| OpenCCTV / ukraine-webcams | 1 | 1 | iframe: 1 | iframe: 1 |
| OpenCCTV / ulsan | 232 | 232 | hls: 232 | hls: 232 |
| OpenCCTV / uludaginfo | 10 | 0 | image: 10 | — |
| OpenCCTV / vietnam-traffic | 695 | 0 | image: 695 | — |
| OpenCCTV / webcamtaxi | 92 | 88 | iframe: 92 | iframe: 88 |
| OpenCCTV / windy | 1,571 | 1 | image: 1,570; iframe: 1 | iframe: 1 |
| OpenCCTV / windy-providers | 756 | 82 | image: 674; iframe: 82 | iframe: 82 |
| OpenCCTV / worldcam | 1 | 0 | image: 1 | — |
| OpenCCTV / xcom-aktau | 17 | 17 | hls: 17 | hls: 17 |
| Public Webcam | 300 | 11 | external: 289; iframe: 3; hls: 8 | iframe: 3; hls: 8 |
| Quebec 511 | 680 | 680 | mp4: 680 | mp4: 680 |
| Rijkswaterstaat | 26 | 0 | image: 26 | — |
| SkylineWebcams | 681 | 0 | image: 250; external: 431 | — |
| Smart Burgas | 1 | 1 | hls: 1 | hls: 1 |
| Stadt Warendorf | 1 | 0 | image: 1 | — |
| Statens vegvesen | 859 | 134 | image: 725; hls: 134 | hls: 134 |
| THB Highway Bureau | 2,220 | 0 | image: 2,220 | — |
| TfL | 87 | 0 | image: 87 | — |
| The City of Calgary | 214 | 0 | image: 214 | — |
| The Real Samui Webcam | 6 | 6 | iframe: 6 | iframe: 6 |
| Transpordiamet (Tarktee) | 176 | 0 | image: 176 | — |
| Transport for London | 804 | 0 | image: 804 | — |
| TxDOT | 8,428 | 0 | image: 4,125; external: 4,303 | — |
| UAB / KAMEPA | 1 | 0 | image: 1 | — |
| UDOT | 2,082 | 0 | image: 2,082 | — |
| Urząd Miasta Słupsk | 1 | 1 | mjpeg: 1 | mjpeg: 1 |
| Uzivo Beograd | 1 | 0 | image: 1 | — |
| Vegagerðin | 496 | 0 | image: 496 | — |
| Via Lietuva | 306 | 0 | image: 306 | — |
| YouTube | 21 | 21 | iframe: 21 | iframe: 21 |
| YouTube Live | 19 | 19 | iframe: 19 | iframe: 19 |
| chuv.ch | 1 | 0 | image: 1 | — |
| home-solutions.bg | 1 | 0 | image: 1 | — |
| meteo.chavo.biz | 1 | 0 | image: 1 | — |
| nadmorski24.pl | 71 | 71 | hls: 71 | hls: 71 |

## Counts by collection pack

Counts are after cross-pack deduplication and the restored dead-stream checks.

| Pack | Before | After | Before types | After types |
| --- | ---: | ---: | --- | --- |
| austin | 821 | 0 | image: 821 | — |
| calgary | 214 | 0 | image: 214 | — |
| caltrans | 3,390 | 1,521 | hls: 1,510; image: 1,880 | hls: 1,521 |
| deldot | 349 | 335 | hls: 349 | hls: 335 |
| drivebc | 1,045 | 0 | image: 1,045 | — |
| fintraffic | 2,266 | 0 | image: 2,266 | — |
| iowa511 | 701 | 640 | hls: 647; image: 54 | hls: 640 |
| louisiana511 | 335 | 320 | hls: 321; image: 14 | hls: 320 |
| minnesota511 | 1,251 | 1,055 | image: 192; hls: 1,059 | hls: 1,055 |
| nevada511 | 628 | 507 | image: 115; hls: 513 | hls: 507 |
| nsw | 248 | 0 | image: 248 | — |
| ontario | 925 | 0 | image: 925 | — |
| osiris-africa-live | 27 | 0 | image: 20; external: 7 | — |
| osiris-arizona | 644 | 0 | image: 644 | — |
| osiris-asia | 8 | 0 | image: 8 | — |
| osiris-asia-live | 260 | 0 | image: 26; external: 234 | — |
| osiris-australia | 1 | 0 | image: 1 | — |
| osiris-bulgaria | 3 | 1 | image: 2; hls: 1 | hls: 1 |
| osiris-canada | 2,514 | 680 | image: 1,834; mp4: 680 | mp4: 680 |
| osiris-czechia | 3 | 3 | iframe: 3 | iframe: 3 |
| osiris-eastasia | 23,261 | 4,416 | iframe: 543; image: 18,859; mjpeg: 1,334; hls: 2,525 | iframe: 543; mjpeg: 1,340; hls: 2,533 |
| osiris-edmonton | 58 | 58 | hls: 58 | hls: 58 |
| osiris-europe | 1,846 | 0 | image: 1,846 | — |
| osiris-europe-live | 152 | 0 | image: 66; external: 86 | — |
| osiris-finland | 3 | 0 | image: 3 | — |
| osiris-florida | 4,967 | 30 | image: 4,959; hls: 8 | hls: 30 |
| osiris-france | 40 | 4 | iframe: 4; image: 8; external: 28 | iframe: 4 |
| osiris-georgia | 4,330 | 0 | image: 4,330 | — |
| osiris-germany | 2 | 2 | iframe: 2 | iframe: 2 |
| osiris-greece | 2 | 2 | iframe: 2 | iframe: 2 |
| osiris-hongkong | 1,013 | 0 | image: 1,013 | — |
| osiris-iceland | 496 | 0 | image: 496 | — |
| osiris-indiana | 741 | 707 | hls: 741 | hls: 707 |
| osiris-italy | 995 | 983 | image: 7; external: 9; mp4: 979 | mp4: 983 |
| osiris-japan | 51 | 18 | iframe: 18; image: 33 | iframe: 18 |
| osiris-latam-live | 162 | 0 | external: 87; image: 75 | — |
| osiris-lithuania | 306 | 0 | image: 306 | — |
| osiris-louisiana | 1 | 0 | image: 1 | — |
| osiris-macedonia | 2 | 2 | hls: 2 | hls: 2 |
| osiris-michigan | 795 | 0 | image: 795 | — |
| osiris-middle-east | 4 | 4 | iframe: 4 | iframe: 4 |
| osiris-nevada | 24 | 0 | image: 24 | — |
| osiris-newzealand | 250 | 0 | image: 250 | — |
| osiris-northcarolina | 1,034 | 25 | image: 1,009; hls: 25 | hls: 25 |
| osiris-oregon | 1,141 | 0 | image: 1,141 | — |
| osiris-poland | 73 | 73 | iframe: 1; mjpeg: 1; hls: 71 | iframe: 1; mjpeg: 1; hls: 71 |
| osiris-public-webcams-americas | 32 | 0 | external: 32 | — |
| osiris-public-webcams-europe | 43 | 0 | external: 43 | — |
| osiris-public-webcams-nl | 216 | 11 | external: 205; iframe: 3; hls: 8 | iframe: 3; hls: 8 |
| osiris-public-webcams-rest | 9 | 0 | external: 9 | — |
| osiris-romania | 1 | 0 | image: 1 | — |
| osiris-seasia | 3,263 | 1,063 | image: 1,963; hls: 1,195; mjpeg: 19; iframe: 86 | hls: 985; mjpeg: 19; iframe: 59 |
| osiris-serbia | 2 | 1 | image: 1; hls: 1 | hls: 1 |
| osiris-slovakia | 2 | 2 | iframe: 2 | iframe: 2 |
| osiris-spain | 1,987 | 3 | iframe: 3; image: 1,981; external: 3 | iframe: 3 |
| osiris-sweden | 47 | 47 | iframe: 47 | iframe: 47 |
| osiris-switzerland | 6 | 0 | image: 2; external: 4 | — |
| osiris-taiwan | 2,224 | 4 | iframe: 4; image: 2,220 | iframe: 4 |
| osiris-texas | 4,303 | 0 | external: 4,303 | — |
| osiris-thailand | 6 | 6 | iframe: 6 | iframe: 6 |
| osiris-uk | 87 | 0 | image: 87 | — |
| osiris-us-east | 4 | 0 | image: 2; external: 2 | — |
| osiris-us-west | 252 | 0 | image: 252 | — |
| osiris-utah | 2,082 | 0 | image: 2,082 | — |
| osiris-westasia | 1,366 | 785 | image: 578; hls: 564; iframe: 224 | hls: 568; iframe: 217 |
| tallinn | 255 | 0 | image: 255 | — |
| tarktee | 176 | 0 | image: 176 | — |
| tfl | 804 | 0 | image: 804 | — |
| txdot | 4,125 | 0 | image: 4,125 | — |
| vegvesen | 859 | 134 | image: 725; hls: 134 | hls: 134 |
| warendorf | 1 | 0 | image: 1 | — |
| wisconsin511 | 456 | 441 | hls: 442; image: 14 | hls: 441 |

## Verification

The headless browser audit completed at 2026-10-12T23:47:48.386Z, covering **89 provider/type samples across 84 providers**. It compared panel screenshots at least 3.5 seconds apart. For HLS/MP4/embedded video it also required the video clock to advance by more than one second. Motion detection required more than 0.5% of sampled pixel channels to change by over 8 intensity levels. The QA globe render loop was paused after catalogue checks; application globe code was unchanged.

**39 samples showed moving video; 30 did not show confirmable motion; 20 did not start within the 20-second playback wait.** A static scene is not proof of a dead stream. These browser results do not write stream-health verdicts. They were captured before the 2026-10-13 dead-check restoration; that correction changes catalogue admission, not playback. The final-policy counter check completed at 2026-10-13T16:57:13.171Z; it confirmed 13,883 browser records, no image/external records, and a moving MJPEG sample. Evidence is under `output/live-camera-review/dead-stream-final/`. The registered `osiris-us-central` and `osiris-turkey` packs returned no usable records; their full inventories could not be verified.

| Type | Samples | Moving confirmed | Not confirmed |
| --- | ---: | ---: | ---: |
| HLS | 59 | 35 | 24 |
| MJPEG | 6 | 3 | 3 |
| MP4 | 2 | 1 | 1 |
| Embedded iframe | 22 | 0 | 22 |

No WebM feed was present to sample. **None of the 22 sampled embedded players was confirmed moving**; embeds are retained when unverified, unless an existing dead verdict says otherwise. The panel does render them in iframes with autoplay permission. The 50 unconfirmed samples must not be represented as verified working feeds. No all-camera playback claim is made.

Human inspection also confirmed vehicles changed position in the paired [Caltrans HLS frame A](../output/live-camera-review/final/sample-7-a.png) / [frame B](../output/live-camera-review/final/sample-7-b.png), and the [Taiwan MJPEG tunnel frame A](../output/live-camera-review/pass-0/sample-3-a.png) / [frame B](../output/live-camera-review/pass-0/sample-3-b.png) from the earlier supplemental run. MP4 motion was confirmed in Autostrade. Full aggregate/sample diagnostics and paired PNGs are under `output/live-camera-review/final/`; that directory contains no full camera inventory.

| Provider / type | Sample result | Evidence or limitation |
| --- | --- | --- |
| Urząd Miasta Słupsk / mjpeg | moving frames confirmed | [A](../output/live-camera-review/final/sample-1-a.png) / [B](../output/live-camera-review/final/sample-1-b.png) |
| OpenCCTV / airportwebcams / mjpeg | moving video not confirmed | [A](../output/live-camera-review/final/sample-2-a.png) / [B](../output/live-camera-review/final/sample-2-b.png) |
| OpenCCTV / osm-webcams / mjpeg | moving video not confirmed | [A](../output/live-camera-review/final/sample-3-a.png) / [B](../output/live-camera-review/final/sample-3-b.png) |
| OpenCCTV / taiwan-freeway / mjpeg | moving frames confirmed | [A](../output/live-camera-review/final/sample-4-a.png) / [B](../output/live-camera-review/final/sample-4-b.png) |
| OpenCCTV / twipcam / mjpeg | playback not verified | Waiting failed: 20000ms exceeded |
| OpenCCTV / bondowoso / mjpeg | moving frames confirmed | [A](../output/live-camera-review/final/sample-6-a.png) / [B](../output/live-camera-review/final/sample-6-b.png) |
| Caltrans / hls | moving frames confirmed | [A](../output/live-camera-review/final/sample-7-a.png) / [B](../output/live-camera-review/final/sample-7-b.png) |
| DelDOT / hls | moving frames confirmed | [A](../output/live-camera-review/final/sample-8-a.png) / [B](../output/live-camera-review/final/sample-8-b.png) |
| 511 Wisconsin (WisDOT) / hls | moving frames confirmed | [A](../output/live-camera-review/final/sample-9-a.png) / [B](../output/live-camera-review/final/sample-9-b.png) |
| 511 Louisiana (LA DOTD) / hls | moving frames confirmed | [A](../output/live-camera-review/final/sample-10-a.png) / [B](../output/live-camera-review/final/sample-10-b.png) |
| NVroads (NDOT) / hls | playback not verified | Waiting failed: 20000ms exceeded |
| 511 Minnesota (MnDOT) / hls | playback not verified | Waiting failed: 20000ms exceeded |
| 511 Iowa (Iowa DOT) / hls | moving frames confirmed | [A](../output/live-camera-review/final/sample-13-a.png) / [B](../output/live-camera-review/final/sample-13-b.png) |
| Statens vegvesen / hls | playback not verified | Waiting failed: 20000ms exceeded |
| YouTube Live / iframe | moving video not confirmed | [A](../output/live-camera-review/final/sample-15-a.png) / [B](../output/live-camera-review/final/sample-15-b.png) |
| Quebec 511 / mp4 | playback not verified | Waiting failed: 20000ms exceeded |
| Smart Burgas / hls | moving frames confirmed | [A](../output/live-camera-review/final/sample-17-a.png) / [B](../output/live-camera-review/final/sample-17-b.png) |
| Attiki Odos / iframe | moving video not confirmed | [A](../output/live-camera-review/final/sample-18-a.png) / [B](../output/live-camera-review/final/sample-18-b.png) |
| AMSS / GKPP / hls | moving video not confirmed | [A](../output/live-camera-review/final/sample-19-a.png) / [B](../output/live-camera-review/final/sample-19-b.png) |
| Neotel / GKPP / hls | moving video not confirmed | [A](../output/live-camera-review/final/sample-20-a.png) / [B](../output/live-camera-review/final/sample-20-b.png) |
| Autostrade per l'Italia / mp4 | moving frames confirmed | [A](../output/live-camera-review/final/sample-21-a.png) / [B](../output/live-camera-review/final/sample-21-b.png) |
| nadmorski24.pl / hls | playback not verified | Waiting failed: 20000ms exceeded |
| ANN News / YouTube / iframe | moving video not confirmed | [A](../output/live-camera-review/final/sample-23-a.png) / [B](../output/live-camera-review/final/sample-23-b.png) |
| YouTube / iframe | moving video not confirmed | [A](../output/live-camera-review/final/sample-24-a.png) / [B](../output/live-camera-review/final/sample-24-b.png) |
| CamStreamer / iframe | moving video not confirmed | [A](../output/live-camera-review/final/sample-25-a.png) / [B](../output/live-camera-review/final/sample-25-b.png) |
| The Real Samui Webcam / iframe | moving video not confirmed | [A](../output/live-camera-review/final/sample-26-a.png) / [B](../output/live-camera-review/final/sample-26-b.png) |
| City of Edmonton / hls | moving frames confirmed | [A](../output/live-camera-review/final/sample-27-a.png) / [B](../output/live-camera-review/final/sample-27-b.png) |
| INDOT TrafficWise / hls | moving frames confirmed | [A](../output/live-camera-review/final/sample-28-a.png) / [B](../output/live-camera-review/final/sample-28-b.png) |
| FDOT / hls | playback not verified | Waiting failed: 20000ms exceeded |
| NCDOT / hls | moving frames confirmed | [A](../output/live-camera-review/final/sample-30-a.png) / [B](../output/live-camera-review/final/sample-30-b.png) |
| OpenCCTV / airlive / iframe | moving video not confirmed | [A](../output/live-camera-review/final/sample-31-a.png) / [B](../output/live-camera-review/final/sample-31-b.png) |
| OpenCCTV / airportwebcams / iframe | moving video not confirmed | [A](../output/live-camera-review/final/sample-32-a.png) / [B](../output/live-camera-review/final/sample-32-b.png) |
| OpenCCTV / ansan / hls | moving frames confirmed | [A](../output/live-camera-review/final/sample-33-a.png) / [B](../output/live-camera-review/final/sample-33-b.png) |
| OpenCCTV / busan / hls | moving frames confirmed | [A](../output/live-camera-review/final/sample-34-a.png) / [B](../output/live-camera-review/final/sample-34-b.png) |
| OpenCCTV / camscape-curated / iframe | moving video not confirmed | [A](../output/live-camera-review/final/sample-35-a.png) / [B](../output/live-camera-review/final/sample-35-b.png) |
| OpenCCTV / camstreamer / iframe | moving video not confirmed | [A](../output/live-camera-review/final/sample-36-a.png) / [B](../output/live-camera-review/final/sample-36-b.png) |
| OpenCCTV / changwon / hls | playback not verified | Waiting failed: 20000ms exceeded |
| OpenCCTV / chungju / hls | moving frames confirmed | [A](../output/live-camera-review/final/sample-38-a.png) / [B](../output/live-camera-review/final/sample-38-b.png) |
| OpenCCTV / castlerock / hls | moving frames confirmed | [A](../output/live-camera-review/final/sample-39-a.png) / [B](../output/live-camera-review/final/sample-39-b.png) |
| OpenCCTV / daegu / hls | moving frames confirmed | [A](../output/live-camera-review/final/sample-40-a.png) / [B](../output/live-camera-review/final/sample-40-b.png) |
| OpenCCTV / dsat / hls | moving frames confirmed | [A](../output/live-camera-review/final/sample-41-a.png) / [B](../output/live-camera-review/final/sample-41-b.png) |
| OpenCCTV / geoje / hls | moving frames confirmed | [A](../output/live-camera-review/final/sample-42-a.png) / [B](../output/live-camera-review/final/sample-42-b.png) |
| OpenCCTV / gimpo / hls | moving frames confirmed | [A](../output/live-camera-review/final/sample-43-a.png) / [B](../output/live-camera-review/final/sample-43-b.png) |
| OpenCCTV / earthcam / hls | playback not verified | Waiting failed: 20000ms exceeded |
| OpenCCTV / goyang / hls | playback not verified | Waiting failed: 20000ms exceeded |
| OpenCCTV / gwangju / hls | playback not verified | Waiting failed: 20000ms exceeded |
| OpenCCTV / incheon / hls | playback not verified | Waiting failed: 20000ms exceeded |
| OpenCCTV / kaiho / hls | moving video not confirmed | [A](../output/live-camera-review/final/sample-48-a.png) / [B](../output/live-camera-review/final/sample-48-b.png) |
| OpenCCTV / kg-camera / hls | playback not verified | Waiting failed: 20000ms exceeded |
| OpenCCTV / openwebcamdb / iframe | moving video not confirmed | [A](../output/live-camera-review/final/sample-50-a.png) / [B](../output/live-camera-review/final/sample-50-b.png) |
| OpenCCTV / osm-webcams / iframe | moving video not confirmed | [A](../output/live-camera-review/final/sample-51-a.png) / [B](../output/live-camera-review/final/sample-51-b.png) |
| OpenCCTV / pohang / hls | moving frames confirmed | [A](../output/live-camera-review/final/sample-52-a.png) / [B](../output/live-camera-review/final/sample-52-b.png) |
| OpenCCTV / sakura-live-cams / iframe | moving video not confirmed | [A](../output/live-camera-review/final/sample-53-a.png) / [B](../output/live-camera-review/final/sample-53-b.png) |
| OpenCCTV / sejong / hls | moving frames confirmed | [A](../output/live-camera-review/final/sample-54-a.png) / [B](../output/live-camera-review/final/sample-54-b.png) |
| OpenCCTV / tabi-cam / iframe | moving video not confirmed | [A](../output/live-camera-review/final/sample-55-a.png) / [B](../output/live-camera-review/final/sample-55-b.png) |
| OpenCCTV / thailand-doh / hls | playback not verified | Waiting failed: 20000ms exceeded |
| OpenCCTV / topis-seoul / hls | playback not verified | Waiting failed: 20000ms exceeded |
| OpenCCTV / ulsan / hls | moving frames confirmed | [A](../output/live-camera-review/final/sample-58-a.png) / [B](../output/live-camera-review/final/sample-58-b.png) |
| OpenCCTV / webcamtaxi / iframe | moving video not confirmed | [A](../output/live-camera-review/final/sample-59-a.png) / [B](../output/live-camera-review/final/sample-59-b.png) |
| OpenCCTV / windy-providers / iframe | moving video not confirmed | [A](../output/live-camera-review/final/sample-60-a.png) / [B](../output/live-camera-review/final/sample-60-b.png) |
| OpenCCTV / asahan / hls | moving frames confirmed | [A](../output/live-camera-review/final/sample-61-a.png) / [B](../output/live-camera-review/final/sample-61-b.png) |
| OpenCCTV / bandung-pelindung / hls | playback not verified | Waiting failed: 20000ms exceeded |
| OpenCCTV / bantul / hls | moving frames confirmed | [A](../output/live-camera-review/final/sample-63-a.png) / [B](../output/live-camera-review/final/sample-63-b.png) |
| OpenCCTV / bpjt / hls | moving frames confirmed | [A](../output/live-camera-review/final/sample-64-a.png) / [B](../output/live-camera-review/final/sample-64-b.png) |
| OpenCCTV / itic / hls | moving frames confirmed | [A](../output/live-camera-review/final/sample-65-a.png) / [B](../output/live-camera-review/final/sample-65-b.png) |
| OpenCCTV / jogjaprov / hls | moving frames confirmed | [A](../output/live-camera-review/final/sample-66-a.png) / [B](../output/live-camera-review/final/sample-66-b.png) |
| OpenCCTV / mudik / hls | moving frames confirmed | [A](../output/live-camera-review/final/sample-67-a.png) / [B](../output/live-camera-review/final/sample-67-b.png) |
| OpenCCTV / tangerang / hls | moving frames confirmed | [A](../output/live-camera-review/final/sample-68-a.png) / [B](../output/live-camera-review/final/sample-68-b.png) |
| OpenCCTV / tasikmalaya / hls | moving frames confirmed | [A](../output/live-camera-review/final/sample-69-a.png) / [B](../output/live-camera-review/final/sample-69-b.png) |
| OpenCCTV / thai-drr / hls | moving frames confirmed | [A](../output/live-camera-review/final/sample-70-a.png) / [B](../output/live-camera-review/final/sample-70-b.png) |
| OpenCCTV / arcgis_cams / hls | moving frames confirmed | [A](../output/live-camera-review/final/sample-71-a.png) / [B](../output/live-camera-review/final/sample-71-b.png) |
| OpenCCTV / astrakhan / hls | playback not verified | Waiting failed: 20000ms exceeded |
| OpenCCTV / balikesir / iframe | moving video not confirmed | [A](../output/live-camera-review/final/sample-73-a.png) / [B](../output/live-camera-review/final/sample-73-b.png) |
| OpenCCTV / balticlivecam / iframe | moving video not confirmed | [A](../output/live-camera-review/final/sample-74-a.png) / [B](../output/live-camera-review/final/sample-74-b.png) |
| OpenCCTV / camscape-curated / hls | moving frames confirmed | [A](../output/live-camera-review/final/sample-75-a.png) / [B](../output/live-camera-review/final/sample-75-b.png) |
| OpenCCTV / forecastweather / hls | playback not verified | Waiting failed: 20000ms exceeded |
| OpenCCTV / freecam-ro / hls | moving frames confirmed | [A](../output/live-camera-review/final/sample-77-a.png) / [B](../output/live-camera-review/final/sample-77-b.png) |
| OpenCCTV / ibb-istanbul / hls | moving frames confirmed | [A](../output/live-camera-review/final/sample-78-a.png) / [B](../output/live-camera-review/final/sample-78-b.png) |
| OpenCCTV / kahramanmaras / hls | moving video not confirmed | [A](../output/live-camera-review/final/sample-79-a.png) / [B](../output/live-camera-review/final/sample-79-b.png) |
| OpenCCTV / middle-east-yt / iframe | moving video not confirmed | [A](../output/live-camera-review/final/sample-80-a.png) / [B](../output/live-camera-review/final/sample-80-b.png) |
| OpenCCTV / novosibirsk / hls | playback not verified | Waiting failed: 20000ms exceeded |
| OpenCCTV / ny511 / hls | moving frames confirmed | [A](../output/live-camera-review/final/sample-82-a.png) / [B](../output/live-camera-review/final/sample-82-b.png) |
| OpenCCTV / openwebcamdb / hls | moving video not confirmed | [A](../output/live-camera-review/final/sample-83-a.png) / [B](../output/live-camera-review/final/sample-83-b.png) |
| OpenCCTV / rta-telecom / hls | moving frames confirmed | [A](../output/live-camera-review/final/sample-84-a.png) / [B](../output/live-camera-review/final/sample-84-b.png) |
| OpenCCTV / ukraine-webcams / iframe | moving video not confirmed | [A](../output/live-camera-review/final/sample-85-a.png) / [B](../output/live-camera-review/final/sample-85-b.png) |
| OpenCCTV / windy / iframe | moving video not confirmed | [A](../output/live-camera-review/final/sample-86-a.png) / [B](../output/live-camera-review/final/sample-86-b.png) |
| OpenCCTV / xcom-aktau / hls | playback not verified | Waiting failed: 20000ms exceeded |
| Public Webcam / iframe | moving video not confirmed | [A](../output/live-camera-review/final/sample-88-a.png) / [B](../output/live-camera-review/final/sample-88-b.png) |
| Public Webcam / hls | moving video not confirmed | [A](../output/live-camera-review/final/sample-89-a.png) / [B](../output/live-camera-review/final/sample-89-b.png) |

`PATH=/home/bk/.nvm/versions/node/v24.21.0/bin:$PATH npm test` passed: 6,455
ordinary tests passed, one skipped, plus all 14 allocation checks passed; no
failures. The production build and formatting check also passed. Regression
coverage includes recorded-dead aliases, stale records, unverified video/embeds,
and preservation of the source loaders' dead-stream behavior. Logs are in
`/tmp/eye-dead-stream-tests.log`, `/tmp/eye-dead-stream-build.log` and
`/tmp/eye-dead-stream-format.log`.
