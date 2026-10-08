#!/usr/bin/env python3
"""Build the case manifest for compare.py.

Cases come from:
- live diagnostic frames checked by eye on 2026-10-07 (tune only: they shaped
  the verification questions, so they never count in judged results);
- Wikimedia Commons photos with checked labels;
- HPWREN wildfire sequences (each frame carries the two before it);
- UCF-Crime annotated events, labelled by what the frame actually shows
  (labels/ucf_visible.json), as a still with two earlier frames and as a clip;
- fresh live captures: sampled sweep frames with the same camera's next two
  fresh frames, and focus clips from report-triggered sessions (test only).

Splits are made by whole group (a camera's sequence, a video, a fire, a
photo), so neighbouring frames never land on both sides. Live test cases are
labelled after the runs by checking every claim any configuration made
(labels/live_test.json); a case with no claim from any configuration counts
as showing nothing and is marked as assumed rather than checked.

  venv/bin/python -I cases.py --since 2026-10-07T22:45:00Z --until 2026-10-08T00:00:00Z

With --validation the manifest holds only data nothing was tuned on, for
validating before automatic confidence upgrades (BK, 2026-10-08): UCF-Crime
videos no evaluation had used, their event moments found by eye
(labels/ucf_new_events.json) and labelled by what the frames show
(labels/ucf_new_visible.json), plus live captures from a fresh run, labelled
on claims in labels/live_validation.json. Every case is split "validation".

  venv/bin/python -I cases.py --validation --since <fresh capture start>
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime
from pathlib import Path

TOOL_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOL_DIR))

import evaluate  # noqa: E402

ROOT = evaluate.EVAL_ROOT
LABELS = ROOT / "labels"
OUT = ROOT / "compare"
TUNE_SHARE = 30  # percent of groups
UCF_CLIP_FRAMES = 8
UCF_CLIP_SPAN_S = 6.0
UCF_SEQUENCE_STEP_S = 2.0
REPO_LOGS = TOOL_DIR.parent.parent / ".gev-logs" / "cctv-watch"


def split_of(group: str) -> str:
    bucket = int(hashlib.sha1(group.encode()).hexdigest(), 16) % 100
    return "tune" if bucket < TUNE_SHARE else "test"


def read_json(path: Path, default):
    return json.loads(path.read_text()) if path.exists() else default


def live_diagnostic():
    labels = read_json(LABELS / "live_diagnostic.json", {"cases": {}})["cases"]
    for relative, label in labels.items():
        path = ROOT / relative
        if not path.exists():
            continue
        camera = path.stem.rsplit("-", 1)[0] if relative.startswith("screens/") else "-".join(path.stem.split("-")[:-3])
        yield {
            "id": f"live-diag-{path.stem}",
            "group": f"live-diag:{camera}",
            "split": "tune",
            "source": "live",
            "mode": "still",
            "frames": [{"path": str(path), "offsetSec": 0, "kind": "still"}],
            "cameraName": camera,
            "truth": {"present": label["present"], "unsure": label["unsure"]},
        }


def commons():
    for item in evaluate.commons_items(ROOT / "commons"):
        group = item["id"]
        yield {
            "id": item["id"],
            "group": group,
            "split": split_of(group),
            "source": "commons",
            "mode": "still",
            "frames": [{"path": item["path"], "offsetSec": 0, "kind": "still"}],
            "truth": {"present": item["present"], "unsure": item["unsure"]},
        }


def hpwren(step: int):
    for sequence in sorted((ROOT / "hpwren" / "sequences").iterdir()):
        images = sorted(sequence.rglob("*.jpg"), key=lambda p: int(p.stem.split("_")[-1]))
        offsets = [int(p.stem.split("_")[-1]) for p in images]
        extra_unsure = []
        if "JEEP" in sequence.name.upper():
            extra_unsure.append("vehicle_fire")
        if "STRUCTURE" in sequence.name.upper():
            extra_unsure.append("structural_damage")
        group = f"hpwren:{sequence.name}"
        for index in range(2, len(images), step):
            offset = offsets[index]
            if -60 < offset < 180:
                continue  # plume just appearing: neither label is safe
            frames = [{"path": str(images[index]), "offsetSec": 0, "kind": "still"}]
            for back in (1, 2):
                frames.append({"path": str(images[index - back]), "offsetSec": offsets[index - back] - offset, "kind": "still"})
            yield {
                "id": f"hpwren-{sequence.name}-{offset}",
                "group": group,
                "split": split_of(group),
                "source": "hpwren",
                "mode": "still",
                "frames": frames,
                "truth": {
                    "present": ["smoke"] if offset >= 180 else [],
                    "unsure": ["low_visibility", "flames", *extra_unsure],
                },
            }


def save_frames(video: Path, start: float, count: int, span: float, folder: Path, tag: str):
    folder.mkdir(parents=True, exist_ok=True)
    frames = evaluate.video_frames(video, start, count, span, 4096)
    paths = []
    for index, image in enumerate(frames):
        target = folder / f"{tag}-{index}.jpg"
        if not target.exists():
            image.save(target, quality=92)
        paths.append(target)
    return paths


def ucf_frames(video: Path, middle: float):
    """The still the pipeline would read at an event moment, with two earlier
    frames, and the clip around it: (still frames, clip frames)."""
    folder = OUT / "frames" / "ucf" / video.stem
    stills = []
    for back in (0, 1, 2):
        at = max(0.0, middle - back * UCF_SEQUENCE_STEP_S)
        paths = save_frames(video, at, 1, 1.0, folder, f"still-{at:.2f}")
        if paths:
            stills.append({"path": str(paths[0]), "offsetSec": at - middle, "kind": "still"})
    start = max(0.0, middle - UCF_CLIP_SPAN_S / 2)
    clip = save_frames(video, start, UCF_CLIP_FRAMES, UCF_CLIP_SPAN_S, folder, f"clip-{start:.2f}")
    step = UCF_CLIP_SPAN_S / max(1, len(clip))
    return stills, [{"path": str(p), "offsetSec": round(i * step, 2), "kind": "still"} for i, p in enumerate(clip)]


def ucf_cases(video: Path, middle: float, truth: dict, cls: str, prefix: str, source: str, split: str):
    """A still case and a clip case for one event moment."""
    stills, clip = ucf_frames(video, middle)
    group = f"ucf:{video.stem}"
    if stills:
        yield {
            "id": f"{prefix}-{video.stem}-still",
            "group": group,
            "split": split,
            "source": source,
            "mode": "still",
            "frames": stills,
            "truth": truth,
            "cls": cls,
        }
    if len(clip) >= 4:
        yield {
            "id": f"{prefix}-{video.stem}-clip",
            "group": group,
            "split": split,
            "source": source,
            "mode": "clip",
            "frames": clip,
            "truth": truth,
            "cls": cls,
        }


def ucf():
    labels = read_json(LABELS / "ucf_visible.json", {"videos": {}})["videos"]
    for item in evaluate.ucf_items(ROOT / "ucf-crime", 0):
        if item["kind"] != "video-still":
            continue
        video = Path(item["path"])
        label = labels.get(video.stem)
        if label is None:
            continue
        truth = {"present": label["present"], "unsure": label["unsure"]}
        yield from ucf_cases(video, item["start"], truth, item["cls"], "ucf", "ucf", split_of(f"ucf:{video.stem}"))


def ucf_new_videos():
    """(stem, video path, class, event moment) for every unused UCF video
    whose event was found by eye; excluded videos are left out."""
    events = read_json(LABELS / "ucf_new_events.json", {"videos": {}})["videos"]
    for stem, event in sorted(events.items()):
        if event.get("eventAt") is None:
            continue
        cls = re.match(r"[A-Za-z]+", stem).group(0)
        yield stem, ROOT / "ucf-crime" / "videos" / cls / f"{stem}.mp4", cls, event["eventAt"]


def ucf_new():
    """Unused UCF videos labelled by what their event frames show: validation only."""
    labels = read_json(LABELS / "ucf_new_visible.json", {"videos": {}})["videos"]
    for stem, video, cls, middle in ucf_new_videos():
        label = labels.get(stem)
        if label is None:
            continue
        truth = {"present": label["present"], "unsure": label["unsure"]}
        yield from ucf_cases(video, middle, truth, cls, "ucf-new", "ucf-new", "validation")


def live_truth(labels, case_id):
    """Checked labels where a claim was made; otherwise an assumed negative.

    Every claim any configuration made on a live test case is checked by eye.
    A case nobody claimed anything on counts as showing nothing, marked as
    assumed: an event no configuration saw cannot be counted as missed.
    """
    label = labels.get(case_id)
    if label is not None:
        return {**label, "checked": True}
    return {"present": [], "unsure": [], "checked": False}


def live_captures(since_ms: int, until_ms: float, labels_name: str, split: str):
    """Sampled sweep sequences and report-triggered focus clips captured
    between two times."""
    labels = read_json(LABELS / labels_name, {"cases": {}})["cases"]
    sequences = {}
    for log in sorted(ROOT.glob("screens-*.jsonl")):
        for line in log.read_text().splitlines():
            record = json.loads(line)
            sequence = record.get("sequence")
            if not sequence or not record.get("evalFrame") or not since_ms <= record.get("at", 0) < until_ms:
                continue
            sequences.setdefault(sequence["of"], []).append(record)
    for key, records in sequences.items():
        records.sort(key=lambda r: r["sequence"]["index"])
        if records[0]["sequence"]["index"] != 0:
            continue
        first = records[0]
        t0 = first.get("captureTime") or first["fetchedAt"]
        case_id = f"live-{key.replace('@', '-')}"
        yield {
            "id": case_id,
            "group": f"live:{first['cameraId']}",
            "split": split,
            "source": "live",
            "mode": "still",
            "frames": [
                {
                    "path": str(ROOT / r["evalFrame"]),
                    "offsetSec": round(((r.get("captureTime") or r["fetchedAt"]) - t0) / 1000, 1),
                    "kind": r.get("kind") or "still",
                }
                for r in records
            ],
            "cameraName": first["cameraId"],
            "truth": live_truth(labels, case_id),
        }
    for log in sorted(REPO_LOGS.glob("readings-*.jsonl")):
        for line in log.read_text().splitlines():
            record = json.loads(line)
            if record.get("kind") != "reading" or record.get("mode") != "clip" or not since_ms <= record.get("at", 0) < until_ms:
                continue
            frames = record.get("evalFrames") or []
            if len(frames) < 4:
                continue
            case_id = f"focus-{record['cameraId']}-{record['fetchedAt']}"
            yield {
                "id": case_id,
                "group": f"live:{record['cameraId']}",
                "split": split,
                "source": "live-focus",
                "mode": "clip",
                "frames": [
                    {"path": str(ROOT / path), "offsetSec": (record.get("frames") or [{}] * len(frames))[i].get("offsetSec", i), "kind": "keyframe"}
                    for i, path in enumerate(frames)
                ],
                "cameraName": record.get("cameraName") or record["cameraId"],
                "truth": live_truth(labels, case_id),
            }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--since", required=True, help="ISO time: live captures from this time on are cases")
    parser.add_argument("--until", help="ISO time: live captures from this time on are left out")
    parser.add_argument("--validation", action="store_true", help="only data nothing was tuned on (see above)")
    parser.add_argument("--hpwren-step", type=int, default=4)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()

    def ms(text):
        return int(datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp() * 1000)

    since_ms, until_ms = ms(args.since), ms(args.until) if args.until else float("inf")
    if args.validation:
        args.out = args.out or OUT / "cases-validation.jsonl"
        sources = (ucf_new(), live_captures(since_ms, until_ms, "live_validation.json", "validation"))
    else:
        args.out = args.out or OUT / "cases.jsonl"
        sources = (
            live_diagnostic(),
            commons(),
            hpwren(args.hpwren_step),
            ucf(),
            live_captures(since_ms, until_ms, "live_test.json", "test"),
        )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    counts = {}
    with open(args.out, "w") as sink:
        for source in sources:
            for case in source:
                sink.write(json.dumps(case) + "\n")
                key = f"{case['source']}/{case['split']}"
                counts[key] = counts.get(key, 0) + 1
    print(json.dumps(counts, indent=1, sort_keys=True))
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
