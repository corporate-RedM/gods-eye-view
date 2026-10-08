#!/usr/bin/env python3
"""Compare screening phrase sets on labelled positives and live camera frames.

The screener alone loads in seconds, so phrase changes can be measured before
anything else depends on them. For each observation type it reports the
threshold at which only `--budget` of ordinary live frames would become
candidates, and the recall on labelled positives at that threshold, for the
current phrases and for a candidate phrase file.

A phrase file is JSON: {"types": {type: [phrases]}, "neutral": [phrases]}.
With neutral phrases, a type's score is its best phrase's logit minus the best
neutral logit (how much more the frame looks like the event than like an
ordinary road), passed through a sigmoid.

  tools/cctv-detector/venv/bin/python -I tools/cctv-detector/screen_experiment.py \
      --phrases candidate_phrases.json
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

TOOL_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOL_DIR))

import detector  # noqa: E402
import evaluate  # noqa: E402


def labelled_stills(root: Path):
    items = list(evaluate.commons_items(root / "commons"))
    items += list(evaluate.hpwren_items(root / "hpwren", 2))
    return items


def ucf_event_stills(root: Path):
    """One frame from the middle of each annotated UCF-Crime event, scored by class."""
    items, images = [], []
    for item in evaluate.ucf_items(root / "ucf-crime", 0):
        if item["kind"] != "video-still":
            continue
        frames = evaluate.video_frames(Path(item["path"]), item["start"], 1, 1.0, detector.STILL_MAX_EDGE)
        if frames:
            items.append(item)
            images.append(frames[0])
    return items, images


def live_frames(root: Path, limit: int):
    files = sorted((root / "screens").rglob("*.jpg"))
    random.Random(3).shuffle(files)
    return files[:limit]


def score_sets(models, images, phrase_sets, neutral):
    """Per-image dict of type -> score for one phrase configuration."""
    torch = models.torch
    phrases = [p for _, ps in phrase_sets for p in ps] + list(neutral)
    text = models._text_embeddings(phrases)
    with torch.inference_mode():
        scale = models.screen_model.logit_scale.exp().float()
        bias = models.screen_model.logit_bias.float()
    results = []
    for start in range(0, len(images), detector.SCREEN_BATCH):
        batch = images[start : start + detector.SCREEN_BATCH]
        inputs = models.screen_processor(images=batch, return_tensors="pt").to(models.device)
        inputs["pixel_values"] = inputs["pixel_values"].half()
        with torch.inference_mode():
            features = detector.pooled(models.screen_model.get_image_features(**inputs)).float()
            features = torch.nn.functional.normalize(features, dim=-1)
            logits = (features @ text.T * scale + bias).cpu()
        neutral_count = len(neutral)
        for row in logits:
            scores = {}
            column = 0
            neutral_best = row[len(phrases) - neutral_count :].max() if neutral_count else None
            for type_id, ps in phrase_sets:
                best = row[column : column + len(ps)].max()
                column += len(ps)
                value = best - neutral_best if neutral_best is not None else best
                scores[type_id] = float(torch.sigmoid(value))
            results.append(scores)
    return results


def report(name, labelled, labelled_scores, live_scores, budget):
    """Print per-type recall at the live budget; return the budget thresholds."""
    print(f"\n## {name}")
    print("type | positives | budget threshold | recall at budget | live share at 90%-recall threshold")
    thresholds = {}
    types = sorted({t for s in live_scores for t in s})
    for type_id in types:
        live = sorted((s[type_id] for s in live_scores), reverse=True)
        threshold = live[min(len(live) - 1, int(len(live) * budget))]
        thresholds[type_id] = threshold
        positives = sorted(
            s[type_id]
            for item, s in zip(labelled, labelled_scores)
            if type_id in item["present"] and type_id not in item.get("unsure", [])
        )
        if not positives:
            continue
        recall = sum(v >= threshold for v in positives) / len(positives)
        t90 = positives[int(len(positives) * 0.1)]
        live90 = sum(v >= t90 for v in live) / len(live)
        print(f"{type_id} | {len(positives)} | {threshold:.4f} | {recall*100:.0f}% | {live90*100:.2f}%")
    # What the describer actually receives: frames over any type's threshold.
    union = sum(any(s[t] >= thresholds[t] for t in thresholds) for s in live_scores) / len(live_scores)
    print(f"live frames over any threshold (candidate share): {union*100:.2f}%")
    return thresholds


def report_classes(items, scores, thresholds):
    """UCF events passed on: any of the class's types over its budget threshold."""
    by_class = {}
    for item, row in zip(items, scores):
        types = evaluate.UCF_CLASSES[item["cls"]]
        passed = any(t in thresholds and row.get(t, 0.0) >= thresholds[t] for t in types)
        n, hit = by_class.get(item["cls"], (0, 0))
        by_class[item["cls"]] = (n + 1, hit + (1 if passed else 0))
    print("UCF-Crime event stills passed on (any class type over its budget threshold):")
    for cls, (n, hit) in by_class.items():
        print(f"  {cls}: {hit}/{n}")


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--root", type=Path, default=evaluate.EVAL_ROOT)
    parser.add_argument("--phrases", type=Path, help="candidate phrase file to compare")
    parser.add_argument("--live", type=int, default=2000)
    parser.add_argument("--budget", type=float, default=0.004)
    args = parser.parse_args()

    models = detector.Models(detector.DEFAULT_MODEL_DIR)
    # Screener only: the describer is not needed and would compete for the GPU.
    import torch
    from transformers import AutoModel, AutoProcessor

    models.torch = torch
    repo, revision = detector.MODELS["screener"]
    common = {"cache_dir": str(models.model_dir), "local_files_only": True}
    models.screen_processor = AutoProcessor.from_pretrained(repo, revision=revision, **common)
    models.screen_model = AutoModel.from_pretrained(repo, revision=revision, dtype=torch.float16, **common).to("cuda").eval()

    labelled = labelled_stills(args.root)
    labelled_images = [evaluate.open_image(Path(item["path"])) for item in labelled]
    live_paths = live_frames(args.root, args.live)
    live_images = [evaluate.open_image(p) for p in live_paths]
    ucf, ucf_images = ucf_event_stills(args.root)
    print(f"labelled stills: {len(labelled)}; UCF event stills: {len(ucf)}; live frames: {len(live_images)}; budget {args.budget*100:.2f}% of live frames")

    events = json.loads(detector.EVENTS_PATH.read_text())["observations"]
    current = [(k, v["phrases"]) for k, v in events.items() if v.get("phrases")]
    thresholds = report("current phrases", labelled, score_sets(models, labelled_images, current, []), score_sets(models, live_images, current, []), args.budget)
    report_classes(ucf, score_sets(models, ucf_images, current, []), thresholds)

    if args.phrases:
        candidate = json.loads(args.phrases.read_text())
        sets = [(k, v) for k, v in candidate["types"].items()]
        neutral = candidate.get("neutral", [])
        thresholds = report(f"candidate: {args.phrases.name}", labelled, score_sets(models, labelled_images, sets, neutral), score_sets(models, live_images, sets, neutral), args.budget)
        report_classes(ucf, score_sets(models, ucf_images, sets, neutral), thresholds)


if __name__ == "__main__":
    main()
