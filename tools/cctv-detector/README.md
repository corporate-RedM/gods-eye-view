# CCTV Watch detector

The local model service behind CCTV Watch. The Vite dev server starts it only
when BK presses **Start AI Watch** in the app (the AI Watch pill under the
globe actions) after choosing an area, talks to it on `127.0.0.1` only, and
ends the process when he presses **Stop AI Watch**, when no open app has kept
Watch alive for five minutes, or when the dev server closes. Watch is off at
every startup; polls, opened cameras, reports and restarts never start it or
restore an earlier run. Nothing here runs on its own schedule.

- **Areas:** cameras are grouped by region (the state their agency serves),
  city (the metro of a city of 100,000+ people within 30 km, from
  `src/data/local_data/cctv_places/area_cities.json`, built by
  `node scripts/build-cctv-places.mjs --areas-only`) and municipality (the
  catalog's place label). Watch fetches, screens and reads only the chosen
  area's cameras.
- **GPU budget:** every model call (screening, readings, verification, people
  counts) waits for a shared budget and is charged the GPU time the detector
  reports, so Watch keeps the GPU busy at most `CCTV_WATCH_GPU_BUDGET` of the
  time (default `0.2`) over any minute and then sits idle.
- **Notifications:** one per incident in the AI Watch panel, marked
  unverified unless a narrow check confirmed it, and all held at possible.
  They never fly the globe, open a camera or take focus; "View camera" opens
  one only on BK's click, the same way the CCTV dropdown does.

It answers questions about pictures; every decision about observations,
conditions and incidents is made on the Node side
(`server/providers/cctv/watch/`).

| Model | Role | License | Weights |
|---|---|---|---|
| `google/siglip2-so400m-patch16-384` | screener: scores every fresh frame against the phrases in `config/cctv_watch_events.json`; scene embeddings for novelty | Apache-2.0 | 4.5 GB |
| `Qwen/Qwen3-VL-4B-Instruct` | describer: reads stills, still pairs and short clips; camera profiles; burned-in clocks | Apache-2.0 | 8.9 GB |
| `PekingU/rtdetr_v2_r50vd` | person counts where people are large enough | Apache-2.0 | 0.2 GB |
| `Qwen/Qwen3-VL-8B-Instruct` | the larger describer under comparison (`--describer 8b`) | Apache-2.0 | 17.5 GB |

Revisions are pinned in `detector.py`. With the 4B describer they hold about
11–14 GB of GPU memory while watching. The service uses the 4B unless
`--describer 8b` (or `CCTV_WATCH_DESCRIBER=8b`) is given.

## Setup

Everything lives inside this folder; nothing touches the machine's other
Python installs.

```sh
python3 -m venv tools/cctv-detector/venv
tools/cctv-detector/venv/bin/pip install -r tools/cctv-detector/requirements.txt
tools/cctv-detector/venv/bin/python tools/cctv-detector/detector.py --download
```

`--download` fetches the pinned weights into `tools/cctv-detector/models/`
(gitignored, about 13 GB). Serving never downloads: the dev server starts the
detector with Hugging Face offline mode on and without any provider keys in
its environment.

`venv/` and `models/` are gitignored, ignored by Vite's file watcher and never
served by the dev server.

## Checking it by hand

```sh
tools/cctv-detector/venv/bin/python tools/cctv-detector/detector.py --classify path/or/url.jpg ...
```

prints the screener's top scores and the describer's reading for each image.

## Evaluation (the quality and capacity gate)

Thresholds in `config/cctv_watch_thresholds.json` start provisional. They are
replaced only from measurements:

1. Run the app with `CCTV_WATCH_EVAL_CAPTURE=1` for a while. The watch then
   logs every screened frame's scores and saves one frame in 40, plus the
   frames behind each describer reading, under `output/cctv-eval/`
   (gitignored, pruned after 7 days).
2. With watching stopped (both need the GPU), run the sets:

   ```sh
   tools/cctv-detector/venv/bin/python -I tools/cctv-detector/evaluate.py --set commons
   tools/cctv-detector/venv/bin/python -I tools/cctv-detector/evaluate.py --set hpwren
   tools/cctv-detector/venv/bin/python -I tools/cctv-detector/evaluate.py --set ucf
   tools/cctv-detector/venv/bin/python -I tools/cctv-detector/evaluate.py --set live
   ```

3. Score them with the server's own evidence rules:

   ```sh
   node tools/cctv-detector/metrics.mjs --propose
   ```

   This reports recall and precision per observation type, precision by
   stated confidence, screener recall against the live candidate budget,
   video-level recall, and how 511-reported incidents were seen. `--propose`
   writes `output/cctv-eval/results/proposed_thresholds.json`; it never edits
   the config. UCF-Crime only says which event a video holds, so it is scored
   per event and stays out of calibration.

4. Compare screening phrase sets on the same frames:

   ```sh
   tools/cctv-detector/venv/bin/python -I tools/cctv-detector/screen_experiment.py --phrases candidate.json
   ```

## Comparing describer configurations

Before more threshold tuning, BK asked which limit is real: model size or
evidence quality. `compare.py` answers it on the same cases for each size:

- **read**: today's reading from today's inputs;
- **same**: each claim's narrow question (`verify` in the events config)
  asked of the same scene, the control for re-asking one model about one
  frame;
- **closer**: the same question with a close-up cropped from the camera's
  original frame around the claim, and the same crop from the case's other
  frames when the question turns on motion or persistence.

```sh
tools/cctv-detector/venv/bin/python -I tools/cctv-detector/cases.py --since <capture start, ISO> --until <capture end, ISO>
tools/cctv-detector/venv/bin/python -I tools/cctv-detector/compare.py run --describer 4b --cases output/cctv-eval/compare/cases.jsonl --out output/cctv-eval/compare/4b.jsonl
tools/cctv-detector/venv/bin/python -I tools/cctv-detector/compare.py run --describer 8b --cases output/cctv-eval/compare/cases.jsonl --out output/cctv-eval/compare/8b.jsonl
tools/cctv-detector/venv/bin/python -I tools/cctv-detector/compare.py score output/cctv-eval/compare/4b.jsonl output/cctv-eval/compare/8b.jsonl --cases output/cctv-eval/compare/cases.jsonl --split test
```

The 2026-10-08 comparison kept the 4B as the baseline (BK). On the held-out
cases the 8B found a few more positives but made over three times the live
false calls when reading (51 against 16 on 916 sweep frames, 40 against 4
on 201 focus clips), and still more than the 4B once both were verified
(14 against 9, 5 against 2). Production now asks each claim's narrow question only
where the comparison measured a benefit for that event type
(`verification` in `config/cctv_watch_thresholds.json`: `same` scene,
`closer` look, or none); `score` reports that configuration as `policy`,
and `--benefit` counts per type the false calls a question removed, the
true finds it lost, and the unclear claims it rightly or wrongly made
present. A type the comparison never measured gets no question.

Motion, glare and work-zone checks are supporting evidence, never blanket
confirmation or rejection rules. A work zone seen at the same camera
(`supportAgainst` in the thresholds config) holds the claims it is commonly
mistaken for at possible; `score` prints how many false calls and true
finds it would have held back. The verify response's measurements
(movement inside the claimed box and across the frame, bright colourless
pixels) are saved with each claim but not weighed: on the comparison cases
they separated true from false only by data source.

The current set (`cases.jsonl`, live captures bounded by `--until`) stays
the regression set. Automatic confidence upgrades wait for validation on
data nothing was tuned on: `cases.py --validation` builds
`cases-validation.jsonl` from UCF-Crime videos no evaluation had used
(event moments found by eye, `labels/ucf_new_events.json`, and labelled by
what their frames show, `labels/ucf_new_visible.json`) and live captures
from a fresh run (claims checked in `labels/live_validation.json`).

Cases are split by whole group (a camera's sequence, a video, a fire, a
photo) so neighbouring frames never count twice. The live frames that shaped
the verification questions are tuning cases only. Fresh live captures (with
`CCTV_WATCH_EVAL_CAPTURE=1`, each sampled sweep frame is followed by the
camera's next two fresh frames, and keyframes keep their native resolution)
are judged after every claim any configuration made has been checked by eye
(`output/cctv-eval/labels/`). UCF-Crime events are labelled by what their
frame actually shows, not by the video's class.

The evaluation footage stays local and is never redistributed:

- `commons/`: Wikimedia Commons photos under public-domain or Creative
  Commons licenses; each file's license and author are in `manifest.jsonl`,
  and its label was checked by eye (`labels.json`).
- `hpwren/`: sequences from the HPWREN Fire Ignition images Library,
  https://www.hpwren.ucsd.edu/ (credit required in derivative work).
- `ucf-crime/`: UCF-Crime (Sultani, Chen and Shah, CVPR 2018), released for
  research; Fighting, RoadAccidents and Explosion videos only.
