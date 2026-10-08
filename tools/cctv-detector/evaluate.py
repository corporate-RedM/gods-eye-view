#!/usr/bin/env python3
"""Run the CCTV Watch screener and describer over the evaluation sets.

Writes one JSON line per item with the raw screener scores and the describer
reading, so metrics.mjs can score them with the same evidence rules the
server uses. Nothing here decides thresholds.

Sets (all under output/cctv-eval/, gitignored, never redistributed):
  commons  Wikimedia Commons photos, labels.json checked by eye
  hpwren   HPWREN FIgLib fire sequences; smoke labelled from the plume offset
  ucf      UCF-Crime videos: clips inside and before annotated events,
           plus three clips per unannotated video for video-level recall
  live     frames sampled from BK's own cameras by evaluation capture

Run from the repo root with the detector venv, after watching has stopped
(both use the GPU):
  tools/cctv-detector/venv/bin/python -I tools/cctv-detector/evaluate.py --set commons
"""

from __future__ import annotations

import argparse
import json
import random
import subprocess
import sys
import time
from pathlib import Path

TOOL_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOL_DIR))  # -I drops the script directory; add it back

import detector  # noqa: E402

REPO_ROOT = TOOL_DIR.parent.parent
EVAL_ROOT = REPO_ROOT / "output" / "cctv-eval"
UCF_FPS = 30
UCF_CLASSES = {"Fighting": ["physical_altercation"], "RoadAccidents": ["damaged_vehicles", "overturned_vehicle", "vehicle_off_road"], "Explosion": ["smoke", "flames"]}
CLIP_FRAMES = 8
CLIP_SPAN_S = 6.0


def load_events():
    events = json.loads(detector.EVENTS_PATH.read_text())
    observations = events["observations"]
    prompts = [{"id": k, "phrases": v["phrases"]} for k, v in observations.items() if v.get("phrases")]
    vocabulary = [{"id": k, "describe": v["describe"], "evidence": v["evidence"]} for k, v in observations.items()]
    return prompts, vocabulary


def open_image(path: Path):
    from PIL import Image

    image = Image.open(path)
    image.load()
    return image.convert("RGB")


def video_frames(path: Path, start_s: float, count: int, span_s: float, max_edge: int):
    """Decode `count` frames spread over `span_s` seconds from `start_s`."""
    import io
    from PIL import Image

    fps = count / span_s if count > 1 else 1
    command = [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-ss", f"{max(0.0, start_s):.2f}", "-i", str(path),
        "-vf", f"fps={fps:.4f},scale='min({max_edge},iw)':-2",
        "-frames:v", str(count), "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "4", "pipe:1",
    ]
    data = subprocess.run(command, capture_output=True, check=False, timeout=60).stdout
    frames = []
    start = data.find(b"\xff\xd8")
    while start != -1:
        end = data.find(b"\xff\xd9", start + 2)
        if end == -1:
            break
        frames.append(Image.open(io.BytesIO(data[start : end + 2])).convert("RGB"))
        start = data.find(b"\xff\xd8", end + 2)
    return frames


def video_duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True, check=False, timeout=30,
    ).stdout.strip()
    try:
        return float(out)
    except ValueError:
        return 0.0


def commons_items(root: Path):
    labels = json.loads((root / "labels.json").read_text())
    excluded = set(labels["exclude"])
    rows = [json.loads(line) for line in open(root / "manifest.jsonl")]
    for index, row in enumerate(rows):
        if index in excluded or str(index) not in labels["items"]:
            continue
        item = labels["items"][str(index)]
        yield {
            "id": f"commons-{index}",
            "kind": "still",
            "path": str(root / row["path"]),
            "present": item.get("present", []),
            "unsure": item.get("unsure", []),
            "source": row["source"],
            "license": row["license"],
        }


def hpwren_items(root: Path, step: int):
    for sequence in sorted((root / "sequences").iterdir()):
        images = sorted(sequence.rglob("*.jpg"))
        for image in images[::step]:
            offset = int(image.stem.split("_")[-1])
            if -60 < offset < 180:
                continue  # plume just appearing: neither label is safe
            yield {
                "id": f"hpwren-{sequence.name}-{offset}",
                "kind": "still",
                "path": str(image),
                "present": ["smoke"] if offset >= 180 else [],
                "unsure": ["low_visibility", "flames"],
                "offset": offset,
                "night": "night" in sequence.name.lower(),
            }


def ucf_items(root: Path, unannotated_per_class: int):
    annotations = {}
    for line in open(root / "Temporal_Anomaly_Annotation_for_Testing_Videos.txt"):
        parts = line.split()
        if len(parts) >= 4 and parts[1] in UCF_CLASSES:
            annotations[parts[0]] = (parts[1], int(parts[2]), int(parts[3]))
    rng = random.Random(7)
    for cls, types in UCF_CLASSES.items():
        videos = sorted((root / "videos" / cls).glob("*.mp4"))
        unannotated = [v for v in videos if v.name not in annotations]
        rng.shuffle(unannotated)
        for video in videos:
            if video.name in annotations:
                _, start, end = annotations[video.name]
                start_s, end_s = start / UCF_FPS, end / UCF_FPS
                middle = (start_s + end_s) / 2
                yield {"id": f"ucf-{video.stem}-event", "kind": "clip", "path": str(video), "start": max(start_s, middle - CLIP_SPAN_S / 2), "present": types, "unsure": [], "cls": cls, "annotated": True}
                yield {"id": f"ucf-{video.stem}-event-still", "kind": "video-still", "path": str(video), "start": middle, "present": types, "unsure": [], "cls": cls, "annotated": True}
                if start_s > 25:
                    before = start_s - 20
                    yield {"id": f"ucf-{video.stem}-before", "kind": "clip", "path": str(video), "start": before, "present": [], "unsure": ["crowd", "people_running"], "cls": cls, "annotated": True}
        for video in unannotated[:unannotated_per_class]:
            duration = video_duration(video)
            for share in (0.25, 0.5, 0.75):
                yield {"id": f"ucf-{video.stem}-{int(share * 100)}", "kind": "clip", "path": str(video), "start": max(0.0, duration * share - CLIP_SPAN_S / 2), "present": types, "video_level": True, "unsure": [], "cls": cls, "annotated": False}


def live_items(root: Path, limit: int):
    files = sorted((root / "screens").rglob("*.jpg"))
    rng = random.Random(11)
    rng.shuffle(files)
    for path in files[:limit]:
        yield {"id": f"live-{path.stem}", "kind": "still", "path": str(path), "present": None, "unsure": []}


def main():
    parser = argparse.ArgumentParser(description="Run the screener and describer over an evaluation set.")
    parser.add_argument("--set", required=True, choices=["commons", "hpwren", "ucf", "live"])
    parser.add_argument("--root", type=Path, default=EVAL_ROOT)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--hpwren-step", type=int, default=2)
    parser.add_argument("--ucf-unannotated", type=int, default=15)
    parser.add_argument("--live-limit", type=int, default=600)
    parser.add_argument("--batch", type=int, default=8)
    args = parser.parse_args()

    out = args.out or (args.root / "results" / f"{args.set}.jsonl")
    out.parent.mkdir(parents=True, exist_ok=True)
    prompts, vocabulary = load_events()
    allowed = {v["id"] for v in vocabulary}
    if args.set == "commons":
        items = list(commons_items(args.root / "commons"))
    elif args.set == "hpwren":
        items = list(hpwren_items(args.root / "hpwren", args.hpwren_step))
    elif args.set == "ucf":
        items = list(ucf_items(args.root / "ucf-crime", args.ucf_unannotated))
    else:
        items = list(live_items(args.root, args.live_limit))
    print(f"{args.set}: {len(items)} items", flush=True)

    models = detector.Models(detector.DEFAULT_MODEL_DIR)
    models.load()
    started = time.time()
    with open(out, "w") as sink:
        for begin in range(0, len(items), args.batch):
            batch = items[begin : begin + args.batch]
            requests, screen_images, prepared = [], [], []
            for item in batch:
                if item["kind"] == "still":
                    frames = [open_image(Path(item["path"]))]
                elif item["kind"] == "video-still":
                    frames = video_frames(Path(item["path"]), item["start"], 1, 1.0, detector.STILL_MAX_EDGE)
                else:
                    frames = video_frames(Path(item["path"]), item["start"], CLIP_FRAMES, CLIP_SPAN_S, detector.CLIP_MAX_EDGE)
                if not frames:
                    item["error"] = "no frames decoded"
                    prepared.append((item, None))
                    continue
                mode = "clip" if item["kind"] == "clip" else "still"
                described = [detector.fit(f, detector.CLIP_MAX_EDGE if mode == "clip" else detector.STILL_MAX_EDGE) for f in frames]
                meta = [{"offsetSec": i * CLIP_SPAN_S / max(1, len(frames))} for i in range(len(frames))] if mode == "clip" else [{"captureTime": None}]
                requests.append((described, detector.reading_prompt(mode, meta, vocabulary, {}), detector.READING_MAX_TOKENS))
                screen_images.append(frames[len(frames) // 2])
                item["mode"] = mode
                item["frames"] = len(frames)
                prepared.append((item, len(requests) - 1))
            t0 = time.time()
            readings = models.generate_json_batch(requests) if requests else []
            describe_s = time.time() - t0
            t0 = time.time()
            _, scores = models.screen(screen_images, prompts) if screen_images else (None, [])
            screen_s = time.time() - t0
            for item, index in prepared:
                record = dict(item)
                if index is not None:
                    generated = readings[index]
                    record["reading"] = detector.clean_reading(generated["parsed"], allowed)
                    record["scores"] = scores[index]
                    record["outputTokens"] = generated["outputTokens"]
                    if not record["reading"]["ok"]:
                        record["raw"] = generated["raw"][:1500]
                record["batchDescribeS"] = round(describe_s, 2)
                record["batchScreenS"] = round(screen_s, 2)
                sink.write(json.dumps(record) + "\n")
            sink.flush()
            done = min(begin + args.batch, len(items))
            rate = done / max(time.time() - started, 0.1) * 60
            print(f"  {done}/{len(items)} ({rate:.0f}/min)", flush=True)
    print(f"wrote {out}", flush=True)


if __name__ == "__main__":
    main()
