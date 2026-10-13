# Camera catalogue change report — 2026-10-12

The Child's Eye standalone catalogue now retains provider-listed HLS, MJPEG,
MP4/WebM and embedded players. It excludes still-image records and website-only
operator links on the server. No video is excluded for failing a playback check
or for being unverified. The panel already supported iframe players; the earlier
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
browser run started at 2026-10-12T23:23:29.562Z, once collection completed.
These are observations of changing provider inventories, not playback guarantees.

| Feed type | Before | After |
| --- | ---: | ---: |
| hls | 10,174 | 11,195 |
| mjpeg | 1,354 | 1,343 |
| mp4 | 1,659 | 1,649 |
| webm | 0 | 0 |
| iframe | 952 | 918 |
| image | 60,799 | 0 |
| external | 5,052 | 0 |
| **Total** | **79,990** | **15,105** |

- Full `/api/cctv/sources` JSON body: **43,414,347 bytes before**, **8,177,883 bytes after** (81.2% smaller). These are decoded JSON body sizes, not compressed wire-transfer sizes.
- Final cold-start browser capture: **66 status checks of 114–123 bytes each** (8,044 bytes in total), then **one** full-list download. Earlier provider failures temporarily produced fewer records; later refreshes recovered them.
- Browser counter: **15,105 / 15,105 cameras**; all downloaded catalogue records were video types. No image or external records reached the browser catalogue.
- **Zero** video feeds or embedded players were removed for being unverified. There are no WebM records in this measured provider response, but the admission filter retains that type.

The baseline contained 14,139 video records and 65,851 image/external records.
The after count is not simply subtraction from a frozen dataset: providers
refreshed between measurements, and deduplication now compares video/embed URLs
rather than discarding distinct videos that happen to share a snapshot URL.
All configured provider packs remain registered, with no camera cap added.
Full-catalogue mode also bypasses the older Caltrans, DelDOT and state-511
health-based removal/still conversion. A previously failed video can therefore
appear as video now even if the baseline counted its fallback as an image.

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
Existing AI Watch incident/evaluation data under `output/cctv-evidence/` and
`output/cctv-eval/` was preserved as well.
Authored provider configurations were preserved; they are input configuration,
not collected inventories. QA outputs contain aggregate counts and individual
playback evidence, never a saved full camera list.

## Counts by source/provider

Counts are after cross-pack deduplication.

| Provider | Before | After | Before types | After types |
| --- | ---: | ---: | --- | --- |
| 511 Iowa (Iowa DOT) | 701 | 701 | hls: 647; image: 54 | hls: 701 |
| 511 Louisiana (LA DOTD) | 335 | 335 | hls: 321; image: 14 | hls: 335 |
| 511 Minnesota (MnDOT) | 1,251 | 1,252 | image: 192; hls: 1,059 | hls: 1,252 |
| 511 Ontario | 3 | 0 | image: 3 | — |
| 511 Wisconsin (WisDOT) | 456 | 456 | hls: 442; image: 14 | hls: 456 |
| ADOT | 644 | 0 | image: 644 | — |
| AMSS / GKPP | 1 | 1 | hls: 1 | hls: 1 |
| ANN News / YouTube | 1 | 1 | iframe: 1 | iframe: 1 |
| APRR | 20 | 0 | external: 20 | — |
| AREA | 7 | 0 | external: 7 | — |
| ASFINAG | 1,820 | 0 | image: 1,820 | — |
| Attiki Odos | 2 | 2 | iframe: 2 | iframe: 2 |
| Austin Transportation & Public Works | 821 | 0 | image: 821 | — |
| Autostrade per l'Italia | 979 | 969 | mp4: 979 | mp4: 969 |
| Butler County, OH | 2 | 0 | image: 2 | — |
| Caltrans | 3,642 | 2,160 | hls: 1,510; image: 2,132 | hls: 2,160 |
| CamStreamer | 47 | 47 | iframe: 47 | iframe: 47 |
| Cincinnati, OH | 2 | 0 | external: 2 | — |
| City of Edmonton | 58 | 58 | hls: 58 | hls: 58 |
| City of Ottawa | 428 | 0 | image: 428 | — |
| City of Tallinn | 255 | 0 | image: 255 | — |
| City of Toronto | 336 | 0 | image: 336 | — |
| DGT | 1,934 | 0 | image: 1,934 | — |
| DelDOT | 349 | 359 | hls: 349 | hls: 359 |
| DriveBC | 2,112 | 0 | image: 2,112 | — |
| FDOT | 4,967 | 27 | image: 4,959; hls: 8 | hls: 27 |
| Fintraffic | 2,269 | 0 | image: 2,269 | — |
| GDOT | 4,330 | 0 | image: 4,330 | — |
| HK Transport Dept | 1,013 | 0 | image: 1,013 | — |
| INDOT TrafficWise | 741 | 705 | hls: 741 | hls: 705 |
| LADOTD | 1 | 0 | image: 1 | — |
| LTA Singapore | 8 | 0 | image: 8 | — |
| Live Traffic | 1 | 0 | image: 1 | — |
| Live Traffic NSW | 248 | 0 | image: 248 | — |
| MDOT MiDrive | 795 | 0 | image: 795 | — |
| MLIT river.go.jp | 33 | 0 | image: 33 | — |
| NCDOT | 1,034 | 25 | image: 1,009; hls: 25 | hls: 25 |
| NDOT | 24 | 0 | image: 24 | — |
| NVroads (NDOT) | 628 | 628 | image: 115; hls: 513 | hls: 628 |
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
| OpenCCTV / bandung-pelindung | 271 | 271 | hls: 271 | hls: 271 |
| OpenCCTV / bantul | 41 | 41 | hls: 41 | hls: 41 |
| OpenCCTV / belarus-customs | 7 | 0 | image: 7 | — |
| OpenCCTV / biodic | 35 | 0 | image: 35 | — |
| OpenCCTV / bondowoso | 19 | 19 | mjpeg: 19 | mjpeg: 19 |
| OpenCCTV / bpjt | 1 | 1 | hls: 1 | hls: 1 |
| OpenCCTV / busan | 353 | 353 | hls: 353 | hls: 353 |
| OpenCCTV / camscape-curated | 14 | 10 | iframe: 12; hls: 2 | iframe: 8; hls: 2 |
| OpenCCTV / camstreamer | 202 | 189 | iframe: 202 | iframe: 189 |
| OpenCCTV / castlerock | 1 | 1 | hls: 1 | hls: 1 |
| OpenCCTV / changwon | 136 | 136 | hls: 136 | hls: 136 |
| OpenCCTV / chungju | 55 | 55 | hls: 55 | hls: 55 |
| OpenCCTV / daegu | 177 | 177 | hls: 177 | hls: 177 |
| OpenCCTV / dsat | 83 | 83 | hls: 83 | hls: 83 |
| OpenCCTV / dwr-nakhonsri | 10 | 0 | image: 10 | — |
| OpenCCTV / earthcam | 10 | 10 | hls: 10 | hls: 10 |
| OpenCCTV / forecastweather | 7 | 7 | hls: 7 | hls: 7 |
| OpenCCTV / freecam-ro | 17 | 17 | hls: 17 | hls: 17 |
| OpenCCTV / geoje | 49 | 49 | hls: 49 | hls: 49 |
| OpenCCTV / gimpo | 63 | 63 | hls: 63 | hls: 63 |
| OpenCCTV / goyang | 173 | 173 | hls: 173 | hls: 173 |
| OpenCCTV / gwangju | 113 | 113 | hls: 113 | hls: 113 |
| OpenCCTV / hanshin-expressway | 17 | 0 | image: 17 | — |
| OpenCCTV / hatyai-climate | 1 | 0 | image: 1 | — |
| OpenCCTV / himawari | 3 | 0 | image: 3 | — |
| OpenCCTV / hko-webcams | 34 | 0 | image: 34 | — |
| OpenCCTV / home-solutions-bg | 1 | 0 | image: 1 | — |
| OpenCCTV / hongkong | 2 | 0 | image: 2 | — |
| OpenCCTV / ibb-istanbul | 350 | 350 | hls: 350 | hls: 350 |
| OpenCCTV / incheon | 225 | 225 | hls: 225 | hls: 225 |
| OpenCCTV / infoclimat | 1 | 0 | image: 1 | — |
| OpenCCTV / itic | 70 | 70 | hls: 70 | hls: 70 |
| OpenCCTV / jogjaprov | 499 | 486 | hls: 499 | hls: 486 |
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
| OpenCCTV / taiwan-freeway | 55 | 54 | mjpeg: 55 | mjpeg: 54 |
| OpenCCTV / tangerang | 26 | 26 | hls: 26 | hls: 26 |
| OpenCCTV / tasikmalaya | 19 | 19 | hls: 19 | hls: 19 |
| OpenCCTV / thai-drr | 3 | 3 | hls: 3 | hls: 3 |
| OpenCCTV / thailand-doh | 90 | 90 | hls: 90 | hls: 90 |
| OpenCCTV / tik-lithuania | 18 | 0 | image: 18 | — |
| OpenCCTV / topis-seoul | 493 | 493 | hls: 493 | hls: 493 |
| OpenCCTV / twipcam | 5,864 | 1,267 | image: 4,587; mjpeg: 1,277 | mjpeg: 1,267 |
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

Counts are after cross-pack deduplication.

| Pack | Before | After | Before types | After types |
| --- | ---: | ---: | --- | --- |
| austin | 821 | 0 | image: 821 | — |
| calgary | 214 | 0 | image: 214 | — |
| caltrans | 3,390 | 2,160 | hls: 1,510; image: 1,880 | hls: 2,160 |
| deldot | 349 | 359 | hls: 349 | hls: 359 |
| drivebc | 1,045 | 0 | image: 1,045 | — |
| fintraffic | 2,266 | 0 | image: 2,266 | — |
| iowa511 | 701 | 701 | hls: 647; image: 54 | hls: 701 |
| louisiana511 | 335 | 335 | hls: 321; image: 14 | hls: 335 |
| minnesota511 | 1,251 | 1,252 | image: 192; hls: 1,059 | hls: 1,252 |
| nevada511 | 628 | 628 | image: 115; hls: 513 | hls: 628 |
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
| osiris-eastasia | 23,261 | 4,391 | iframe: 543; image: 18,859; mjpeg: 1,334; hls: 2,525 | iframe: 543; mjpeg: 1,323; hls: 2,525 |
| osiris-edmonton | 58 | 58 | hls: 58 | hls: 58 |
| osiris-europe | 1,846 | 0 | image: 1,846 | — |
| osiris-europe-live | 152 | 0 | image: 66; external: 86 | — |
| osiris-finland | 3 | 0 | image: 3 | — |
| osiris-florida | 4,967 | 27 | image: 4,959; hls: 8 | hls: 27 |
| osiris-france | 40 | 4 | iframe: 4; image: 8; external: 28 | iframe: 4 |
| osiris-georgia | 4,330 | 0 | image: 4,330 | — |
| osiris-germany | 2 | 2 | iframe: 2 | iframe: 2 |
| osiris-greece | 2 | 2 | iframe: 2 | iframe: 2 |
| osiris-hongkong | 1,013 | 0 | image: 1,013 | — |
| osiris-iceland | 496 | 0 | image: 496 | — |
| osiris-indiana | 741 | 705 | hls: 741 | hls: 705 |
| osiris-italy | 995 | 969 | image: 7; external: 9; mp4: 979 | mp4: 969 |
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
| osiris-seasia | 3,263 | 1,260 | image: 1,963; hls: 1,195; mjpeg: 19; iframe: 86 | hls: 1,182; mjpeg: 19; iframe: 59 |
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
| osiris-westasia | 1,366 | 782 | image: 578; hls: 564; iframe: 224 | hls: 565; iframe: 217 |
| tallinn | 255 | 0 | image: 255 | — |
| tarktee | 176 | 0 | image: 176 | — |
| tfl | 804 | 0 | image: 804 | — |
| txdot | 4,125 | 0 | image: 4,125 | — |
| vegvesen | 859 | 134 | image: 725; hls: 134 | hls: 134 |
| warendorf | 1 | 0 | image: 1 | — |
| wisconsin511 | 456 | 456 | hls: 442; image: 14 | hls: 456 |

## Verification

Playback verification is in progress; final results will be appended before commit.
