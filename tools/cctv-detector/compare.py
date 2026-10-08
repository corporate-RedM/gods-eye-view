#!/usr/bin/env python3
"""Compare describer configurations on the same cases.

BK's gate review (2026-10-07) asked which limit is real, model size or
evidence quality, before any more threshold tuning. One run uses one
describer size; every case goes through the same three stages:

- read: the reading the pipeline makes today, from the inputs it has today
  (a still at the production size, or a clip). Each listed type also says
  where it is.
- verify-same: each claim gets its narrow question, asked of the same scene.
  This is the control: re-asking the same model about the same frame is not
  independent evidence, and this measures what it is worth.
- verify-closer: the same question with a close-up cropped from the camera's
  original frame around the claim, plus the same crop from the case's other
  frames when the question turns on motion or persistence.

Processing time is kept per stage, so focus and verification capacity can be
set in seconds of describer time rather than as a share of frames.

  venv/bin/python -I compare.py run --describer 8b --cases cases.jsonl --out out-8b.jsonl
  venv/bin/python -I compare.py score out-4b.jsonl out-8b.jsonl --split test

A case is one JSON line: {"id", "group", "split", "source", "mode": "still" |
"clip", "frames": [{"path", "offsetSec", "kind"}], "cameraName", "truth":
{"present": [...], "unsure": [...]}}. The first frame of a still case is the
one read; the others only supply sequences. A clip case is read whole and
anchored on its last frame.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import defaultdict
from pathlib import Path

TOOL_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOL_DIR))

import detector  # noqa: E402

# Production inputs: sweep keyframes are decoded at most 640 wide before the
# describer fits them; stills arrive at the agency's own size.
KEYFRAME_EDGE = 640


def load_events():
    events = json.loads(detector.EVENTS_PATH.read_text())
    observations = events["observations"]
    vocabulary = [
        {"id": key, "describe": spec["describe"], "evidence": spec["evidence"]}
        for key, spec in observations.items()
    ]
    return observations, vocabulary, events.get("verify", {})


def load_policy():
    """Production's per-type checks from the thresholds config: the measured
    verification arm for each type, and the contexts counted against claims."""
    thresholds = json.loads(detector.EVENTS_PATH.with_name("cctv_watch_thresholds.json").read_text())
    verification = thresholds.get("verification", {})
    arms = {type_id: arm for arm in ("same", "closer") for type_id in verification.get(arm, [])}
    contexts = {
        context: set(entry["types"])
        for context, entry in thresholds.get("supportAgainst", {}).get("contexts", {}).items()
    }
    return arms, contexts


def needs_motion(spec) -> bool:
    return spec.get("evidence") in ("motion", "clip")


def enforce(reading, mode, observations):
    """The server's evidence rule: a single still cannot assert motion."""
    if not reading.get("ok"):
        return reading
    out = []
    for item in reading["observations"]:
        spec = observations.get(item["type"], {})
        too_little = (mode == "still" and needs_motion(spec)) or (
            spec.get("evidence") == "clip" and mode != "clip"
        )
        if too_little and item["result"] == "present":
            item = {**item, "result": "unclear", "enforced": "needs-motion"}
        out.append(item)
    return {**reading, "observations": out}


def open_frame(frame):
    image = detector.read_input(frame["path"])
    if frame.get("kind") == "keyframe" and image.size[0] > KEYFRAME_EDGE:
        # What the production sweep would have decoded.
        scale = KEYFRAME_EDGE / image.size[0]
        production = image.resize((KEYFRAME_EDGE, max(1, round(image.size[1] * scale))))
    else:
        production = image
    return image, production


def request_pixels(images) -> int:
    """Image workload of one request: the pixels the describer receives."""
    return sum(image.size[0] * image.size[1] for image in images)


class Checkpoint:
    """Results saved as each batch completes.

    A slow or stopped run keeps everything finished before it, and --resume
    picks up where it left off. One JSON line per result: {"id", "stage",
    "type"?, ...}; batch timings are saved the same way under id "_batch".
    """

    def __init__(self, path: Path, resume: bool):
        self.path = path
        self.rows = {}
        self.batches = []
        if resume and path.exists():
            for line in path.read_text().splitlines():
                if not line.strip():
                    continue
                row = json.loads(line)
                if row["id"] == "_batch":
                    self.batches.append(row)
                else:
                    self.rows[(row["id"], row["stage"], row.get("type"))] = row
        elif path.exists():
            path.unlink()
        self.sink = open(path, "a")

    def get(self, case_id, stage, type_id=None):
        return self.rows.get((case_id, stage, type_id))

    def save(self, row):
        if row["id"] == "_batch":
            self.batches.append(row)
        else:
            self.rows[(row["id"], row["stage"], row.get("type"))] = row
        self.sink.write(json.dumps(row) + "\n")
        self.sink.flush()


def run_stage(name, work, build, handle, models, checkpoint, max_items, max_pixels):
    """Stream work into batches sized by image workload; save each batch as it finishes.

    build(item) -> (images, content, max_tokens); handle(item, generated, ms,
    batch_size) records one result (generated is None when even a single
    request did not fit). Batches stop at max_items requests or max_pixels of
    images, whichever comes first.
    """
    torch = models.torch
    total, done = len(work), 0
    started = last_print = time.time()
    batch, pixels = [], 0

    def run_batch(entries):
        torch.cuda.reset_peak_memory_stats()
        begun = time.time()
        try:
            results = models.generate_json_batch([entry[1] for entry in entries])
        except torch.cuda.OutOfMemoryError:
            # The memory cap is a backstop, not the plan: split and retry.
            torch.cuda.empty_cache()
            if len(entries) == 1:
                return [(entries[0], None, 0.0)]
            half = len(entries) // 2
            return run_batch(entries[:half]) + run_batch(entries[half:])
        elapsed = time.time() - begun
        checkpoint.save({
            "id": "_batch",
            "stage": name,
            "s": round(elapsed, 3),
            "n": len(entries),
            "pixels": sum(entry[2] for entry in entries),
            "peakGB": round(torch.cuda.max_memory_allocated() / 1e9, 2),
        })
        return [(entry, result, elapsed / len(entries)) for entry, result in zip(entries, results)]

    def flush():
        nonlocal batch, pixels, done, last_print
        if not batch:
            return
        size = len(batch)
        for entry, generated, per_item_s in run_batch(batch):
            handle(entry[0], generated, round(per_item_s * 1000), size)
        done += size
        batch, pixels = [], 0
        if time.time() - last_print >= 30 or done == total:
            last = checkpoint.batches[-1] if checkpoint.batches else {}
            print(
                f"  {name}: {done}/{total} done in {time.time() - started:.0f} s "
                f"(last batch {last.get('n')} items, {last.get('s')} s, "
                f"{last.get('pixels', 0) / 1e6:.1f} MP, peak {last.get('peakGB')} GB)",
                flush=True,
            )
            last_print = time.time()

    for item in work:
        try:
            request = build(item)
        except Exception as error:  # unreadable input: recorded, never silently dropped
            handle(item, {"error": f"{type(error).__name__}: {error}"}, 0, 0)
            done += 1
            continue
        size = request_pixels(request[0])
        if batch and (len(batch) >= max_items or pixels + size > max_pixels):
            flush()
        batch.append((item, request, size))
        pixels += size
    flush()


def run(args) -> None:
    observations, vocabulary, verify_specs = load_events()
    allowed = {v["id"] for v in vocabulary}
    cases = [json.loads(line) for line in args.cases.read_text().splitlines() if line.strip()]
    if args.split:
        cases = [case for case in cases if case.get("split") == args.split]
    if args.limit:
        cases = cases[: args.limit]
    checkpoint = Checkpoint(args.out.with_suffix(".progress.jsonl"), args.resume)

    import torch

    # A backstop only: past this share of the card, PyTorch raises an
    # out-of-memory error (and the batch is split) instead of growing further.
    torch.cuda.set_per_process_memory_fraction(args.memory_fraction)
    models = detector.Models(args.model_dir, describer=args.describer)
    started = time.time()
    models.load(parts=("describer", *args.also_load))
    load_s = time.time() - started
    print(
        f"{args.describer}: {len(cases)} cases; loaded describer"
        f"{' + ' + ', '.join(args.also_load) if args.also_load else ''} in {load_s:.1f} s; "
        f"{torch.cuda.memory_allocated() / 1e9:.1f} GB on the GPU before any work",
        flush=True,
    )

    def apply_read(case, row):
        if row.get("error"):
            case["error"] = row["error"]
            return
        case["reading"] = row["reading"]
        case["readMs"] = row["readMs"]
        case["readBatch"] = row["readBatch"]
        case["outputTokens"] = row["outputTokens"]
        if row.get("raw"):
            case["raw"] = row["raw"]

    def build_read(case):
        mode = case["mode"]
        edge = detector.STILL_MAX_EDGE if mode == "still" else detector.CLIP_MAX_EDGE
        used = case["frames"][:1] if mode == "still" else case["frames"]
        # Frames are opened per batch and dropped after it.
        images = [detector.fit(open_frame(frame)[1], edge) for frame in used]
        meta = [{"captureTime": None}] if mode == "still" else [
            {"offsetSec": frame.get("offsetSec", 0)} for frame in case["frames"]
        ]
        content = detector.reading_prompt(
            mode, meta, vocabulary, {"cameraName": case.get("cameraName", "")}, boxes=True
        )
        return images, content, detector.READING_MAX_TOKENS

    def handle_read(case, generated, ms, batch_size):
        if generated is None or "error" in generated:
            row = {"id": case["id"], "stage": "read", "error": (generated or {}).get("error", "out of GPU memory alone")}
        else:
            reading = enforce(detector.clean_reading(generated["parsed"], allowed), case["mode"], observations)
            row = {
                "id": case["id"],
                "stage": "read",
                "reading": reading,
                "readMs": ms,
                "readBatch": batch_size,
                "outputTokens": generated["outputTokens"],
                "raw": None if reading["ok"] else generated["raw"][:1500],
            }
        checkpoint.save(row)
        apply_read(case, row)

    for case in cases:
        saved = checkpoint.get(case["id"], "read")
        if saved:
            apply_read(case, saved)
    for mode, limit in (("still", args.read_batch), ("clip", args.clip_batch)):
        work = [case for case in cases if case["mode"] == mode and not checkpoint.get(case["id"], "read")]
        run_stage(f"read-{mode}", work, build_read, handle_read, models, checkpoint, limit, args.batch_pixels)

    # Claims to check: present claims, and unclear ones whose question turns
    # on a sequence the case has (a still suspects, the sequence decides).
    claims = []
    for case in cases:
        reading = case.get("reading") or {}
        for item in reading.get("observations", []) if reading.get("ok") else []:
            spec = verify_specs.get(item["type"])
            if not spec:
                continue
            has_sequence = len(case["frames"]) > 1
            if item["result"] == "present" or (item["result"] == "unclear" and spec["sequence"] and has_sequence):
                claims.append((case, item, spec))

    for arm in ("same", "closer"):
        stage = f"verify-{arm}"

        def build_verify(claim, arm=arm):
            case, item, spec = claim
            anchor_index = 0 if case["mode"] == "still" else len(case["frames"]) - 1
            order = [anchor_index] + [i for i in range(len(case["frames"])) if i != anchor_index]
            frames = []
            for position, index in enumerate(order[: 1 + detector.SEQUENCE_CLOSE_UPS]):
                original, production = open_frame(case["frames"][index])
                # The scene the claim was made on is the production frame;
                # close-ups always come from the original.
                frames.append({
                    "image": original,
                    "offsetSec": case["frames"][index].get("offsetSec", 0),
                    "production": production if position == 0 else None,
                })
            images, close_ups = detector.verify_inputs(frames, item.get("box"), spec, arm == "closer")
            images[0] = detector.fit(frames[0]["production"], detector.STILL_MAX_EDGE)
            content = detector.verify_prompt(spec, close_ups, {"cameraName": case.get("cameraName", "")}, item.get("box"))
            return images, content, detector.VERIFY_MAX_TOKENS

        def handle_verify(claim, generated, ms, batch_size, arm=arm, stage=stage):
            case, item, spec = claim
            if generated is None or "error" in generated:
                verdict = {"ok": False, "answer": None, "result": "unclear", "confidence": None,
                           "reason": "", "error": (generated or {}).get("error", "out of GPU memory alone")}
            else:
                verdict = detector.clean_verification(generated["parsed"], spec)
                if not verdict["ok"]:
                    verdict["raw"] = generated["raw"][:400]
            verdict["ms"] = ms
            verdict["batch"] = batch_size
            verdict["hadCloseUp"] = arm == "closer" and bool(item.get("box"))
            checkpoint.save({"id": case["id"], "stage": stage, "type": item["type"], "verdict": verdict})
            case.setdefault("verify", {}).setdefault(item["type"], {})[arm] = verdict

        work = []
        for claim in claims:
            case, item, spec = claim
            saved = checkpoint.get(case["id"], stage, item["type"])
            if saved:
                case.setdefault("verify", {}).setdefault(item["type"], {})[arm] = saved["verdict"]
            elif not detector.verify_askable(
                spec, min(len(case["frames"]), 1 + detector.SEQUENCE_CLOSE_UPS), item.get("box"), arm == "closer"
            ):
                # A movement question with one moment: recorded, never sent.
                verdict = {**detector.not_asked_verification(), "ms": 0, "batch": 0,
                           "hadCloseUp": arm == "closer" and bool(item.get("box"))}
                checkpoint.save({"id": case["id"], "stage": stage, "type": item["type"], "verdict": verdict})
                case.setdefault("verify", {}).setdefault(item["type"], {})[arm] = verdict
            else:
                work.append(claim)
        run_stage(stage, work, build_verify, handle_verify, models, checkpoint, args.verify_batch, args.batch_pixels)

    summary = {}
    for row in checkpoint.batches:
        entry = summary.setdefault(row["stage"], {"batches": 0, "items": 0, "s": 0.0, "peakGB": 0.0, "maxPixels": 0})
        entry["batches"] += 1
        entry["items"] += row["n"]
        entry["s"] += row["s"]
        entry["peakGB"] = max(entry["peakGB"], row["peakGB"])
        entry["maxPixels"] = max(entry["maxPixels"], row["pixels"])
    for entry in summary.values():
        entry["msPerItem"] = round(1000 * entry["s"] / max(1, entry["items"]))
        entry["msPerBatch"] = round(1000 * entry["s"] / max(1, entry["batches"]))
        entry["s"] = round(entry["s"], 1)
    with open(args.out, "w") as sink:
        for case in cases:
            sink.write(json.dumps({**case, "describer": args.describer}) + "\n")
        sink.write(json.dumps({
            "summary": summary,
            "describer": args.describer,
            "loadS": round(load_s, 1),
            "alsoLoaded": args.also_load,
            "limits": {
                "readBatch": args.read_batch,
                "clipBatch": args.clip_batch,
                "verifyBatch": args.verify_batch,
                "batchPixels": args.batch_pixels,
            },
        }) + "\n")
    print(json.dumps(summary, indent=2), flush=True)
    print(f"wrote {args.out}", flush=True)


def arm_for(arm, type_id, policy):
    """The verification that decides a type: the arm itself, or under the
    policy arm the one production uses for that type (None: read alone)."""
    return (policy or {}).get(type_id) if arm == "policy" else arm


def after_check(item, verdict) -> bool:
    """Whether a claim stands after its check, as production applies it
    (BK, 2026-10-08: unverified observations stay available as possible).
    Only an answer that it is not there withdraws a present claim; an unclear
    or missing answer leaves it standing, unverified. An unclear reading
    becomes present only when its check says so."""
    if verdict is None:
        return item["result"] == "present"
    if item["result"] == "present":
        return verdict["result"] != "absent"
    return verdict["result"] == "present"


def verdicts_for(case, arm, policy=None):
    """Types each arm calls present for one case."""
    reading = case.get("reading") or {}
    if not reading.get("ok"):
        return set()
    present = set()
    for item in reading["observations"]:
        checked = (case.get("verify") or {}).get(item["type"], {}).get(arm_for(arm, item["type"], policy))
        if after_check(item, checked):
            present.add(item["type"])
    return present


def assertable(case, arm, observations, verify_specs, policy=None):
    """Types this arm could possibly call present for this case.

    A single still never shows motion, so the reading of a still case is not
    charged for motion types; a verification with a sequence can show them.
    """
    # Normal-scene observations (traffic flowing, road clear) never open a
    # condition, so they are neither incident claims nor false alarms.
    incident_types = {t for t, spec in observations.items() if spec.get("condition", True) is not False}
    if case["mode"] == "clip":
        return incident_types
    types = {t for t in incident_types if not needs_motion(observations[t])}
    if len(case["frames"]) > 1:
        types |= {
            t
            for t in incident_types
            if needs_motion(observations[t])
            and observations[t].get("evidence") != "clip"
            and verify_specs.get(t, {}).get("sequence")
            and arm_for(arm, t, policy) == "closer"
        }
    return types


def support_against(cases, arm, observations, verify_specs, policy, contexts):
    """Per context: of the claims of its types this arm makes, how many have
    the context in the same reading, by checked truth. A context only holds a
    claim back (production keeps it at possible); it never removes it."""
    table = {context: {"falseHeld": 0, "falseAll": 0, "trueHeld": 0, "trueAll": 0} for context in contexts}
    for case in cases:
        truth = case.get("truth")
        reading = case.get("reading") or {}
        if truth is None or not reading.get("ok"):
            continue
        unsure = set(truth.get("unsure", []))
        real = set(truth.get("present", [])) - unsure
        said = (verdicts_for(case, arm, policy) - unsure) & assertable(case, arm, observations, verify_specs, policy)
        seen = {item["type"] for item in reading["observations"] if item["result"] == "present"}
        for context, types in contexts.items():
            row = table[context]
            for type_id in said & types:
                kind = "true" if type_id in real else "false"
                row[f"{kind}All"] += 1
                if context in seen:
                    row[f"{kind}Held"] += 1
    return table


def verify_benefit(cases, arm, observations, verify_specs):
    """Per event type: false calls the verification removed and true finds it
    lost, and unclear claims it made present (a still that suspects, settled
    by a sequence), right or wrong.

    Counted over every case with checked truth, against the reading alone.
    """
    table = defaultdict(
        lambda: {"falseRemoved": 0, "falseKept": 0, "trueLost": 0, "trueKept": 0, "upgradeRight": 0, "upgradeWrong": 0}
    )
    for case in cases:
        truth = case.get("truth")
        reading = case.get("reading") or {}
        if truth is None or not reading.get("ok"):
            continue
        unsure = set(truth.get("unsure", []))
        real = set(truth.get("present", [])) - unsure
        possible = assertable(case, arm, observations, verify_specs)
        for item in reading["observations"]:
            verdict = (case.get("verify") or {}).get(item["type"], {}).get(arm)
            if verdict is None or item["type"] in unsure or item["type"] not in possible:
                continue
            row = table[item["type"]]
            kept = after_check(item, verdict)
            if item["result"] == "unclear":
                if kept:
                    row["upgradeRight" if item["type"] in real else "upgradeWrong"] += 1
                continue
            if item["result"] != "present":
                continue
            if item["type"] in real:
                row["trueKept" if kept else "trueLost"] += 1
            else:
                row["falseKept" if kept else "falseRemoved"] += 1
    return dict(table)


def score(args) -> None:
    observations, _, verify_specs = load_events()
    policy, contexts = load_policy()
    truth_by_id = {}
    if args.cases:
        for line in args.cases.read_text().splitlines():
            if line.strip():
                case = json.loads(line)
                truth_by_id[case["id"]] = case.get("truth")
    for path in args.results:
        rows = [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]
        summary = next((row for row in rows if "summary" in row), None)
        cases = [row for row in rows if "id" in row and (not args.split or row.get("split") == args.split)]
        if args.cases:
            for case in cases:
                case["truth"] = truth_by_id.get(case["id"], case.get("truth"))
        name = rows[-1].get("describer", path) if rows else path
        print(f"\n# {name} — {path} ({len(cases)} cases)")
        if summary:
            for stage, stats in summary["summary"].items():
                print(f"  {stage}: {stats['msPerItem']} ms per item ({stats['items']} items, {stats['msPerBatch']} ms per batch)")
        # policy: each type checked the way production checks it, with the
        # arm its measured benefit chose (thresholds config), or not at all.
        for arm in ("read", "same", "closer", "policy"):
            by_source = defaultdict(lambda: defaultdict(lambda: [0, 0, 0]))
            false_cases = defaultdict(int)
            totals = defaultdict(int)
            for case in cases:
                truth = case.get("truth")
                if truth is None or "reading" not in case:
                    continue
                unsure = set(truth.get("unsure", []))
                possible = assertable(case, arm, observations, verify_specs, policy)
                said = (verdicts_for(case, arm, policy) - unsure) & possible
                real = (set(truth.get("present", [])) - unsure) & possible
                source = case.get("source", "?")
                totals[source] += 1
                if said - real:
                    false_cases[source] += 1
                for type_id in said | real:
                    cell = by_source[source][type_id]
                    if type_id in said and type_id in real:
                        cell[0] += 1
                    elif type_id in said:
                        cell[1] += 1
                    else:
                        cell[2] += 1
            if arm != "read":
                # Which reading claims this arm overturned or upheld, and
                # whether the checked truth agrees: what a verification adds.
                flips = defaultdict(int)
                for case in cases:
                    truth = case.get("truth")
                    if truth is None or not (case.get("reading") or {}).get("ok"):
                        continue
                    unsure = set(truth.get("unsure", []))
                    real = set(truth.get("present", []))
                    for item in case["reading"]["observations"]:
                        verdict = (case.get("verify") or {}).get(item["type"], {}).get(arm_for(arm, item["type"], policy))
                        if verdict is None or item["type"] in unsure:
                            continue
                        before = item["result"] == "present"
                        after = after_check(item, verdict)
                        if before == after:
                            flips["upheld, right" if before == (item["type"] in real) else "upheld, wrong"] += 1
                        else:
                            flips["changed, now right" if after == (item["type"] in real) else "changed, now wrong"] += 1
                if flips:
                    print(f"\n  [{arm}] verification against the reading: " + ", ".join(f"{k} {v}" for k, v in sorted(flips.items())))
            if arm in ("same", "closer") and args.benefit:
                print(f"\n  [{arm}] per type: false calls removed / kept, true finds lost / kept")
                for type_id, row in sorted(verify_benefit(cases, arm, observations, verify_specs).items()):
                    upgrades = row["upgradeRight"] + row["upgradeWrong"]
                    print(
                        f"      {type_id}: false removed {row['falseRemoved']}, kept {row['falseKept']}; "
                        f"true lost {row['trueLost']}, kept {row['trueKept']}"
                        + (f"; unclear made present: right {row['upgradeRight']}, wrong {row['upgradeWrong']}" if upgrades else "")
                    )
            print(f"\n  [{arm}]")
            for source in sorted(totals):
                cells = by_source[source]
                tp = sum(c[0] for c in cells.values())
                fp = sum(c[1] for c in cells.values())
                fn = sum(c[2] for c in cells.values())
                print(
                    f"  {source}: {totals[source]} cases | found {tp}/{tp + fn} | false calls {fp} "
                    f"| cases with a false call {false_cases[source]}"
                )
                if args.types:
                    for type_id, (tp_, fp_, fn_) in sorted(cells.items()):
                        print(f"      {type_id}: tp {tp_} fp {fp_} fn {fn_}")
            if arm in ("read", "policy"):
                for context, row in support_against(cases, arm, observations, verify_specs, policy, contexts).items():
                    print(
                        f"  {context} in the same reading would hold back {row['falseHeld']} of "
                        f"{row['falseAll']} false calls and {row['trueHeld']} of {row['trueAll']} true finds "
                        "of the types it counts against"
                    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    run_parser = sub.add_parser("run")
    run_parser.add_argument("--describer", choices=sorted(detector.DESCRIBERS), required=True)
    run_parser.add_argument("--cases", type=Path, required=True)
    run_parser.add_argument("--out", type=Path, required=True)
    run_parser.add_argument("--split", choices=["tune", "test"])
    run_parser.add_argument("--limit", type=int, default=0)
    run_parser.add_argument("--read-batch", type=int, default=8, help="most still readings per batch")
    run_parser.add_argument("--clip-batch", type=int, default=4, help="most clip readings per batch")
    run_parser.add_argument(
        "--verify-batch",
        type=int,
        default=1,
        help="most verifications per batch; one at a time until peak memory has been measured",
    )
    run_parser.add_argument(
        "--batch-pixels",
        type=int,
        default=4_000_000,
        help="image workload cap per batch, in pixels the describer receives",
    )
    run_parser.add_argument(
        "--memory-fraction",
        type=float,
        default=0.94,
        help="backstop: share of GPU memory PyTorch may use before it raises and the batch is split",
    )
    run_parser.add_argument(
        "--also-load",
        nargs="*",
        default=[],
        choices=["screener", "people"],
        help="load these production models too, so peak memory reflects the whole pipeline",
    )
    run_parser.add_argument("--resume", action="store_true", help="continue from the saved progress file")
    run_parser.add_argument("--model-dir", type=Path, default=detector.DEFAULT_MODEL_DIR)
    score_parser = sub.add_parser("score")
    score_parser.add_argument("results", nargs="+")
    score_parser.add_argument("--cases", type=Path, help="take truth from this manifest (labels made after the runs)")
    score_parser.add_argument("--split", choices=["tune", "test"])
    score_parser.add_argument("--types", action="store_true", help="per-type rows")
    score_parser.add_argument("--benefit", action="store_true", help="per-type effect of each verification arm")
    args = parser.parse_args()
    if args.command == "run":
        run(args)
    else:
        score(args)


if __name__ == "__main__":
    main()
