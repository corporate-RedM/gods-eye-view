# Camera search and English labels — 2026-10-16

Applied locally to `/home/bk/gods-eye-view`, branch `childs_eye`. No push was
performed. The full scrollable search remains installed in the actual app on
`http://127.0.0.1:4173`. No server files were changed for the label correction.

## Display behavior

The menu contains the complete loaded catalogue, with a virtual window of rows
to keep DOM size bounded. There is no search-result or scrolling cap.

The shared English formatter now translates Taiwan road classes, directions,
route suffixes and road details. For example, `國道10號 W 33K+590` displays as
`National Freeway 10 westbound 33 km + 590`. Other observed non-Latin camera
names and locality labels have English descriptions or romanized proper names.
Route terminology follows the [Taiwan Freeway Bureau's English map](https://www.freeway.gov.tw/english/Publish.aspx?cnid=1914&p=4607);
lettered highway suffixes follow the [Highway Bureau's bilingual report](https://ws.thb.gov.tw/001/Upload/436/ebook/ebook_146618/pdf/full.pdf).

`src/data/englishNames.js` delegates these imported labels to
`englishCameraLabels.js`. This is a translation dictionary, not a saved camera
inventory. No translation service, credentials or paid API is needed.
The catalogue keeps upstream IDs and feed URLs. `originalName` and
`originalCity` pass through the public UI state as search aliases, so both
English and original text can find the same camera. They do not replace the
English display text.

## Real-app verification

The final headless browser run used the actual running app and its real provider
response, with no fixture catalogue or substituted response. The capture kept
IDs in memory only and compared the UI with the exact response it loaded.

| Check | Result |
| --- | --- |
| Loaded catalogue | 46,237 records |
| Records actually rendered and checked while scrolling | 46,237 |
| Taiwan records included in the label audit | 2,819 |
| Display names, localities, providers and short codes containing audited untranslated scripts | 0 |
| Scrollbar pointer interaction | Passed; menu stayed open |
| Last, middle and first camera selection | Passed |
| Broad NCDOT search | 1,008 matches; final match reached |
| Browser page errors | 0 |

The script checks Han, Hangul, Japanese kana, Cyrillic, Greek, Thai, Arabic,
Georgian and Devanagari scripts. This detects untranslated scripts; it is not
an independent linguistic review of every romanized place name or every
Latin-script description. New upstream labels can require new dictionary rules;
unknown names are preserved rather than silently discarded or assigned an
invented location. No feed playback claim is made by this label verification.

Screenshots were visually inspected: provincial highway names and the last
freeway rows are English. Saved evidence:

- `/home/bk/camera-label-verification/taiwan-english.png`
- `/home/bk/camera-label-verification/final-row.png`
- `/home/bk/camera-label-verification/results.json` (aggregate checks and three
  selected sample IDs, not a camera inventory)

Reproduce with Node 24 and a dedicated headless Chrome listening on port 9227:

```sh
PATH=/home/bk/.nvm/versions/node/v24.21.0/bin:$PATH \
PICKER_QA_BASE=http://127.0.0.1:4173 \
PICKER_QA_OUT=/tmp/childs-eye-search-check \
node scripts/qa-camera-catalogue-picker.mjs
```

Do not open a second Puppeteer connection with its default viewport while this
runs. It resizes the active test page and invalidates mouse coordinates. A
monitoring connection must specify `defaultViewport: null`. Earlier failed
scrollbar checks were traced to that test setup mistake; the successful final
run had a stable viewport. An earlier catalogue comparison also fetched a later
provider snapshot and falsely reported missing IDs. The final harness captures
the exact response delivered to the app instead. Its response clone avoids the
DevTools inspector cache limit encountered with the full catalogue response.

## Tests and scope

Full command: `PATH=/home/bk/.nvm/versions/node/v24.21.0/bin:$PATH npm test`.
Final result: **6,502 passed, 1 skipped, 0 failed**, exit 0 (including allocation
tests). The first sandboxed attempt encountered fixture/network restrictions
and was stopped; the complete suite passed with local test-server permissions.

No camera was removed or added by the English-label change. Counts changed
between preliminary runs as the existing backend refreshed providers; the
46,237 figure is the final browser's exact loaded snapshot. Backend verification,
paging and other earlier staged work are separate from this applied search and
label change. No server restart was performed for the label correction.

The temporary English-label evidence directories
`/tmp/childs-eye-english-search-evidence` and
`/tmp/childs-eye-english-search-final` were removed after retaining the final
evidence above. Existing camera health and other application caches were not
touched.
