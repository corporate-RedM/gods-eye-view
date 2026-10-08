#!/usr/bin/env python3
"""Local event detector for God's Eye CCTV Watch.

The Vite server sends camera frames here and gets back what three local models
see in them. Every decision about incidents stays on the Node side; this
process only answers questions about pictures.

- Screener: SigLIP 2 scores each frame against the screening phrases from
  config/cctv_watch_events.json and measures how far its scene embedding sits
  from the camera's usual look.
- Describer: Qwen3-VL reads stills, still pairs, short clips, camera profiles
  and burned-in clocks, and answers in structured JSON.
- Person detector: RT-DETR v2 counts people where they are large enough.

It listens on 127.0.0.1 only and never downloads while serving. Run
`--download` once first.
"""

from __future__ import annotations

import argparse
import base64
import heapq
import io
import itertools
import json
import os
import re
import signal
import sys
import threading
import time
import traceback
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

TOOL_DIR = Path(__file__).resolve().parent
REPO_ROOT = TOOL_DIR.parent.parent
DEFAULT_MODEL_DIR = TOOL_DIR / "models"
DEFAULT_BASELINE_PATH = REPO_ROOT / ".gev-cache" / "cctv-watch" / "baselines.npz"
EVENTS_PATH = REPO_ROOT / "config" / "cctv_watch_events.json"

# Pinned revisions, checked 2026-10-07. All three are Apache-2.0.
MODELS = {
    "screener": (
        "google/siglip2-so400m-patch16-384",
        "dd658faac399427308559e2c3ac1e99cbe43845d",
    ),
    "describer": (
        "Qwen/Qwen3-VL-4B-Instruct",
        "ebb281ec70b05090aa6165b016eac8ec08e71b17",
    ),
    "people": (
        "PekingU/rtdetr_v2_r50vd",
        "282494075698cab9faa1096ae26856890030c817",
    ),
}
# Describer sizes under comparison (BK's gate review, 2026-10-07). "describer"
# above is the 4B; --describer 8b swaps in the larger one. Both Apache-2.0.
DESCRIBERS = {
    "4b": MODELS["describer"],
    "8b": (
        "Qwen/Qwen3-VL-8B-Instruct",
        "0c351dd01ed87e9c1b53cbc748cba10e6187ff3b",
    ),
}

MAX_BODY_BYTES = 64 * 1024 * 1024
SCREEN_BATCH = 32
STILL_MAX_EDGE = 768
CLIP_MAX_EDGE = 448
READING_MAX_TOKENS = 640
BASELINE_SAVE_EVERY_S = 300
VISIBILITY = ("good", "reduced", "poor")
VISIBILITY_ISSUES = (
    "night",
    "glare",
    "fog",
    "rain",
    "snow",
    "blur",
    "obstruction",
    "offline",
    "frozen",
    "low_resolution",
)
DENSITIES = ("sparse", "moderate", "dense", "packed")
SCENES = (
    "highway",
    "arterial",
    "intersection",
    "street",
    "plaza",
    "rural",
    "bridge",
    "tunnel",
    "parking",
    "other",
)
PEOPLE_SCALES = ("none", "tiny", "usable")

SYSTEM_PROMPT = (
    "You review frames from public traffic and city cameras for an awareness "
    "tool. Report only what is directly visible in the frames. Never guess a "
    "cause, or what happened before or after the frames. Answer with one JSON "
    "object and nothing else."
)


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def decode_image(data: str):
    from PIL import Image

    if not isinstance(data, str) or not data:
        raise ValueError("frame is missing its jpeg data")
    try:
        image = Image.open(io.BytesIO(base64.b64decode(data, validate=True)))
        image.load()
    except Exception as error:
        raise ValueError(f"frame is not a readable image: {error}") from error
    return image.convert("RGB")


def fit(image, max_edge: int):
    width, height = image.size
    scale = max_edge / max(width, height)
    if scale >= 1:
        return image
    return image.resize((max(1, round(width * scale)), max(1, round(height * scale))))


def pooled(output):
    """transformers 5 returns pooled-output objects from get_*_features."""
    value = getattr(output, "pooler_output", None)
    if value is not None:
        return value
    if isinstance(output, (tuple, list)):
        return output[1] if len(output) > 1 else output[0]
    return output


def parse_json_object(text: str):
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        return None
    candidate = text[start : end + 1]
    for attempt in (candidate, re.sub(r",\s*([}\]])", r"\1", candidate)):
        try:
            value = json.loads(attempt)
        except json.JSONDecodeError:
            continue
        return value if isinstance(value, dict) else None
    return None


def clamp01(value) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    if number != number:  # NaN
        return 0.0
    return max(0.0, min(1.0, number))


def int_or_none(value):
    try:
        number = int(round(float(value)))
    except (TypeError, ValueError):
        return None
    return number if number >= 0 else None


def clean_reading(parsed, allowed: set[str]) -> dict:
    """Keep only well-formed answers about the types that were asked."""
    if not isinstance(parsed, dict):
        return {"ok": False, "visibility": "unknown", "visibilityIssues": [], "observations": [], "summary": ""}
    observations = []
    seen = set()
    for result in ("present", "unclear"):
        items = parsed.get(result)
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            kind = item.get("type")
            # A type answered twice keeps its first (present) answer.
            if kind not in allowed or kind in seen:
                continue
            seen.add(kind)
            density = item.get("density")
            observations.append(
                {
                    "type": kind,
                    "result": result,
                    "confidence": clamp01(item.get("confidence")),
                    "detail": str(item.get("detail") or "")[:240],
                    "count": int_or_none(item.get("count")),
                    "density": density if density in DENSITIES else None,
                    "box": valid_box(item.get("box")),
                }
            )
    visibility = parsed.get("visibility")
    issues = [i for i in parsed.get("issues") or [] if i in VISIBILITY_ISSUES]
    return {
        "ok": True,
        "visibility": visibility if visibility in VISIBILITY else "unknown",
        "visibilityIssues": issues,
        "observations": observations,
        "summary": str(parsed.get("summary") or "")[:300],
    }


def clean_profile(parsed) -> dict:
    if not isinstance(parsed, dict):
        return {"ok": False}
    scene = parsed.get("scene")
    scale = parsed.get("people_scale")
    return {
        "ok": True,
        "scene": scene if scene in SCENES else "other",
        "roadVisible": bool(parsed.get("road_visible")),
        "pedestrianAreaVisible": bool(parsed.get("pedestrian_area_visible")),
        "peopleScale": scale if scale in PEOPLE_SCALES else "none",
        "slopeOrCliffVisible": bool(parsed.get("slope_or_cliff_visible")),
        "vegetationVisible": bool(parsed.get("vegetation_visible")),
        "clockOverlay": bool(parsed.get("clock_overlay")),
        "confidence": clamp01(parsed.get("confidence")),
        "notes": str(parsed.get("notes") or "")[:240],
    }


def clean_clock(parsed) -> dict:
    if not isinstance(parsed, dict):
        return {"ok": False}
    date = parsed.get("date")
    clock = parsed.get("time")
    return {
        "ok": True,
        "text": str(parsed.get("clock_text") or "")[:80] or None,
        "date": date if isinstance(date, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", date) else None,
        "time": clock if isinstance(clock, str) and re.fullmatch(r"\d{2}:\d{2}(:\d{2})?", clock) else None,
        "confidence": clamp01(parsed.get("confidence")),
    }


def vocabulary_lines(vocabulary: list[dict]) -> str:
    lines = []
    for item in vocabulary:
        motion = item.get("evidence") in ("motion", "clip")
        tag = " [needs motion]" if motion else ""
        lines.append(f"- {item['id']}{tag}: {item.get('describe', '')}")
    return "\n".join(lines)


def reading_prompt(mode: str, frames: list[dict], vocabulary: list[dict], context: dict, boxes: bool = False) -> list:
    """Interleaved chat content for still, pair and clip readings.

    With boxes, each listed type also says where it is, on Qwen3-VL's 0-1000
    scale, so a closer look can crop the original frame around it.
    """
    name = context.get("cameraName") or "unnamed camera"
    place = context.get("place") or "unknown place"
    content = []
    if mode == "still":
        when = frames[0].get("captureTime") or "an unknown time"
        content.append({"type": "text", "text": f"One frame, captured at {when}."})
        content.append({"type": "image"})
    else:
        span = frames[-1].get("offsetSec", 0) - frames[0].get("offsetSec", 0)
        content.append(
            {
                "type": "text",
                "text": f"{len(frames)} frames of the same view over {span:.1f} seconds, in order.",
            }
        )
        for index, frame in enumerate(frames, start=1):
            offset = frame.get("offsetSec", 0) - frames[0].get("offsetSec", 0)
            content.append({"type": "text", "text": f"Frame {index} at {offset:.1f} s:"})
            content.append({"type": "image"})
    content.append(
        {
            "type": "text",
            "text": (
                f"Camera: {name} ({place}).\n"
                "Observation types to look for:\n"
                f"{vocabulary_lines(vocabulary)}\n\n"
                "Rules:\n"
                '- "present": the types you can actually see.\n'
                '- "unclear": at most 3 types that genuinely look possible but the frames cannot settle '
                "(too dark, glare, fog, blur, obstruction, too small or far away).\n"
                "- Leave every other type out. Empty lists are a normal answer for an ordinary scene.\n"
                "- A type marked [needs motion] can only be present when the frames show change over time. "
                'With a single frame it can at most be "unclear".\n'
                "- confidence is your probability, from 0 to 1, that the type really is present.\n"
                "- Keep each detail under 12 words.\n"
                '- Only for crowd, add "count" (approximate number of people) and "density" (sparse, moderate, dense or packed).\n'
                + (
                    '- For every listed type, "box" is where it is: [x1, y1, x2, y2] on a 0 to 1000 scale '
                    "of the frame's width and height (for several frames, where it is in the last frame).\n\n"
                    if boxes
                    else "\n"
                )
                + "Output exactly this JSON shape and nothing else:\n"
                '{"visibility": "good|reduced|poor", '
                '"issues": [any of: night, glare, fog, rain, snow, blur, obstruction, offline, frozen, low_resolution], '
                + (
                    '"present": [{"type": "...", "confidence": 0.0, "detail": "...", "box": [0, 0, 0, 0]}], '
                    '"unclear": [{"type": "...", "confidence": 0.0, "detail": "...", "box": [0, 0, 0, 0]}], '
                    if boxes
                    else '"present": [{"type": "...", "confidence": 0.0, "detail": "..."}], '
                    '"unclear": [{"type": "...", "confidence": 0.0, "detail": "..."}], '
                )
                + '"summary": "one short factual sentence"}'
            ),
        }
    )
    return content


NOT_ASKED_ONE_FRAME = "one frame cannot show movement"


def verify_prompt(spec: dict, close_ups: list[dict], context: dict, box=None):
    """One narrow question about one claim, worded for the images supplied.

    The first image is the whole scene for context. Each close-up is cropped
    from the camera's original frame around the claim; a sequence repeats the
    same crop from other moments, so motion and persistence can be judged.
    With no close-up, the whole-frame wording (`sceneQuestion`) is asked and
    the claimed area is given as a box, so the question never mentions an
    image it does not have. A question about movement (`needsFrames`) cannot
    be answered from one moment: None, and no model call is made.
    """
    if spec.get("needsFrames") and len(close_ups) < 2:
        return None
    name = context.get("cameraName") or "unnamed camera"
    content = [{"type": "text", "text": f"Camera: {name}. The whole scene:"}, {"type": "image"}]
    if close_ups:
        native = close_ups[0].get("nativeScale")
        note = " (enlarged from the camera's own pixels, so it can look soft)" if native and native > 1.2 else ""
        content.append({"type": "text", "text": f"Close-up of the area in question{note}, at 0.0 s:"})
        content.append({"type": "image"})
        for close_up in close_ups[1:]:
            content.append({"type": "text", "text": f"The same area at {close_up['offsetSec']:.0f} s:"})
            content.append({"type": "image"})
        question = spec["question"]
        if len(close_ups) > 1 and spec.get("sequenceNote"):
            question = f"{question} {spec['sequenceNote']}"
    else:
        where = (
            f"The area in question is at [{', '.join(str(round(v)) for v in box)}], "
            "on a 0 to 1000 scale of the frame's width and height.\n"
            if box
            else "The area in question is the whole scene.\n"
        )
        question = where + spec["sceneQuestion"]
    answers = list(spec["answers"])
    content.append(
        {
            "type": "text",
            "text": (
                f"{question}\n"
                f"Answer with exactly one of: {', '.join(answers)}.\n"
                "Choose cannot_tell (or the one-frame answer) when the images do not settle it. "
                "Judge only what is visible.\n"
                'Output exactly this JSON shape and nothing else: {"answer": "...", "confidence": 0.0, '
                '"reason": "under 15 words"}'
            ),
        }
    )
    return content


def verify_askable(spec: dict, frame_count: int, box, closer: bool) -> bool:
    """Whether verify_inputs will supply what the question needs: a movement
    question needs a close-up from at least two moments."""
    if not spec.get("needsFrames"):
        return True
    return bool(closer and box and spec.get("sequence") and frame_count >= 2)


def not_asked_verification() -> dict:
    """The verdict for a movement question that only one moment was supplied for."""
    return {"ok": True, "answer": None, "result": "unclear", "confidence": None, "reason": NOT_ASKED_ONE_FRAME, "asked": False}


def clean_verification(parsed, spec: dict) -> dict:
    """Map a verification answer to present, absent or unclear."""
    if not isinstance(parsed, dict) or parsed.get("answer") not in spec["answers"]:
        return {"ok": False, "answer": None, "result": "unclear", "confidence": None, "reason": ""}
    answer = parsed["answer"]
    return {
        "ok": True,
        "answer": answer,
        "result": spec["answers"][answer],
        "confidence": clamp01(parsed.get("confidence")),
        "reason": str(parsed.get("reason") or "")[:200],
    }


CLOSE_UP_MIN_EDGE = 448
CLOSE_UP_MAX_EDGE = 768
SEQUENCE_CLOSE_UPS = 2
VERIFY_MAX_TOKENS = 96


def close_up(original, box):
    """Crop a frame at its own resolution around a 0-1000 box.

    The crop is twice the box and never tiny. Boxes are relative, so the same
    box crops the same area from a sequence frame of another size. Returns
    the crop and how much it was enlarged for the describer (enlarging adds
    no detail; it gives a small object more of the model's attention).
    """
    width, height = original.size
    x1, y1, x2, y2 = (v / 1000 for v in box)
    cx, cy = (x1 + x2) / 2 * width, (y1 + y2) / 2 * height
    w = max((x2 - x1) * width * 2, min(width, height) * 0.15, 96)
    h = max((y2 - y1) * height * 2, min(width, height) * 0.15, 96)
    left = max(0, min(width - w, cx - w / 2))
    top = max(0, min(height - h, cy - h / 2))
    crop = original.crop((round(left), round(top), round(min(width, left + w)), round(min(height, top + h))))
    long_edge = max(crop.size)
    target = min(max(long_edge, CLOSE_UP_MIN_EDGE), CLOSE_UP_MAX_EDGE)
    scale = target / long_edge
    if abs(scale - 1) > 0.01:
        crop = crop.resize((max(1, round(crop.size[0] * scale)), max(1, round(crop.size[1] * scale))))
    return crop, scale


def verify_inputs(frames: list, box, spec: dict, closer: bool):
    """Images and close-up notes for one verification.

    frames are full frames at the camera's resolution, the first being the
    one the claim was made on; the rest supply a sequence.
    """
    scene = fit(frames[0]["image"], STILL_MAX_EDGE)
    images, close_ups = [scene], []
    if closer and box:
        crop, scale = close_up(frames[0]["image"], box)
        images.append(crop)
        close_ups.append({"offsetSec": 0.0, "nativeScale": scale})
        if spec.get("sequence"):
            anchor_t = frames[0].get("offsetSec", 0)
            for frame in frames[1 : 1 + SEQUENCE_CLOSE_UPS]:
                other, _ = close_up(frame["image"], box)
                images.append(other)
                close_ups.append({"offsetSec": frame.get("offsetSec", 0) - anchor_t})
    return images, close_ups


def region_facts(frames: list, box) -> dict:
    """Measurements of the claimed area, kept as supporting evidence only.

    - regionChange / sceneChange: mean absolute difference between
      consecutive frames inside the box and across the whole frame (0-1). A
      mark on the lens stays put while traffic moves; drifting smoke changes.
    - brightFraction: share of near-white, colourless pixels in the box in the
      claim's frame, the signature of glare.
    None where a measurement needs frames or a box it does not have.
    """
    import numpy as np

    def gray(image, region=None):
        if region is not None:
            w, h = image.size
            x1, y1, x2, y2 = region
            image = image.crop((round(x1 / 1000 * w), round(y1 / 1000 * h), round(x2 / 1000 * w), round(y2 / 1000 * h)))
        return np.asarray(image.convert("L").resize((64, 64)), dtype=np.float32) / 255.0

    facts = {"regionChange": None, "sceneChange": None, "brightFraction": None}
    if box:
        crop = frames[0]["image"].crop(tuple(
            round(v / 1000 * size)
            for v, size in zip(box, (frames[0]["image"].size * 2))
        ))
        hsv = np.asarray(crop.convert("HSV"), dtype=np.float32) / 255.0
        if hsv.size:
            bright = (hsv[..., 2] > 0.92) & (hsv[..., 1] < 0.2)
            facts["brightFraction"] = round(float(bright.mean()), 4)
    if box and len(frames) > 1:
        regions = [gray(frame["image"], box) for frame in frames]
        scenes = [gray(frame["image"]) for frame in frames]
        facts["regionChange"] = round(
            float(np.mean([np.abs(a - b).mean() for a, b in zip(regions, regions[1:])])), 4
        )
        facts["sceneChange"] = round(
            float(np.mean([np.abs(a - b).mean() for a, b in zip(scenes, scenes[1:])])), 4
        )
    return facts


def valid_box(value):
    """A 0-1000 box [x1, y1, x2, y2] with positive area, or None."""
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        return None
    try:
        x1, y1, x2, y2 = (float(v) for v in value)
    except (TypeError, ValueError):
        return None
    x1, x2 = max(0.0, min(x1, x2)), min(1000.0, max(x1, x2))
    y1, y2 = max(0.0, min(y1, y2)), min(1000.0, max(y1, y2))
    if x2 - x1 < 1 or y2 - y1 < 1:
        return None
    return [round(x1), round(y1), round(x2), round(y2)]


def profile_prompt(frames: list[dict]) -> list:
    content = [{"type": "text", "text": f"{len(frames)} frames from this camera at different times:"}]
    for _ in frames:
        content.append({"type": "image"})
    content.append(
        {
            "type": "text",
            "text": (
                "Describe what this camera's view can show, for a monitoring system.\n"
                'people_scale: "usable" if a standing adult would be at least about 40 pixels tall somewhere in view, '
                '"tiny" if people would only be specks, "none" if no area where people walk is visible.\n'
                "Output exactly this JSON shape:\n"
                '{"scene": "highway|arterial|intersection|street|plaza|rural|bridge|tunnel|parking|other", '
                '"road_visible": true, "pedestrian_area_visible": false, "people_scale": "none|tiny|usable", '
                '"slope_or_cliff_visible": false, "vegetation_visible": false, "clock_overlay": false, '
                '"confidence": 0.0, "notes": "short"}'
            ),
        }
    )
    return content


def clock_prompt() -> list:
    return [
        {"type": "image"},
        {
            "type": "text",
            "text": (
                "Read the date and time text burned into this camera image, if there is any. "
                "Copy it exactly; do not estimate a time from the scene.\n"
                'Output exactly this JSON shape: {"clock_text": "exact text or null", '
                '"date": "YYYY-MM-DD or null", "time": "HH:MM:SS or null", "confidence": 0.0}'
            ),
        },
    ]


class Models:
    """The three models, loaded once onto the GPU."""

    def __init__(self, model_dir: Path, device: str = "cuda", describer: str = "4b"):
        self.model_dir = model_dir
        self.device = device
        self.describer = describer
        self.ready = False
        self.loading = None
        self.error = None
        self._text_cache = {}

    def load(self, parts=("screener", "describer", "people")) -> None:
        """Load the models; an offline comparison can load the describer alone."""
        import torch
        from transformers import (
            AutoImageProcessor,
            AutoModel,
            AutoProcessor,
            Qwen3VLForConditionalGeneration,
            RTDetrV2ForObjectDetection,
        )

        self.torch = torch
        common = {"cache_dir": str(self.model_dir), "local_files_only": True}
        started = time.time()

        if "screener" in parts:
            self.loading = "screener"
            repo, revision = MODELS["screener"]
            self.screen_processor = AutoProcessor.from_pretrained(repo, revision=revision, **common)
            self.screen_model = (
                AutoModel.from_pretrained(repo, revision=revision, dtype=torch.float16, **common)
                .to(self.device)
                .eval()
            )

        if "describer" in parts:
            self.loading = "describer"
            repo, revision = DESCRIBERS[self.describer]
            self.describe_processor = AutoProcessor.from_pretrained(repo, revision=revision, **common)
            self.describe_model = Qwen3VLForConditionalGeneration.from_pretrained(
                repo,
                revision=revision,
                dtype=torch.bfloat16,
                device_map=self.device,
                attn_implementation="sdpa",
                **common,
            ).eval()

        if "people" in parts:
            self.loading = "people"
            repo, revision = MODELS["people"]
            self.people_processor = AutoImageProcessor.from_pretrained(repo, revision=revision, **common)
            self.people_model = (
                RTDetrV2ForObjectDetection.from_pretrained(repo, revision=revision, **common)
                .to(self.device)
                .eval()
            )
            labels = {v.lower(): int(k) for k, v in self.people_model.config.id2label.items()}
            self.person_label = labels.get("person", 0)

        self.loading = None
        self.ready = True
        log(f"models ready in {time.time() - started:.1f} s on {self.device}")

    # Screener -----------------------------------------------------------

    def _text_embeddings(self, phrases: list[str]):
        torch = self.torch
        missing = [p for p in dict.fromkeys(phrases) if p not in self._text_cache]
        if missing:
            inputs = self.screen_processor(
                text=[p.lower() for p in missing],
                padding="max_length",
                max_length=64,
                truncation=True,
                return_tensors="pt",
            ).to(self.device)
            with torch.inference_mode():
                features = pooled(self.screen_model.get_text_features(**inputs)).float()
            features = torch.nn.functional.normalize(features, dim=-1)
            for phrase, feature in zip(missing, features):
                self._text_cache[phrase] = feature
        return torch.stack([self._text_cache[p] for p in phrases])

    def screen(self, images: list, prompt_sets: list[dict], neutral: list[str] | None = None):
        """Return (normalized image embeddings on CPU, per-image score dicts).

        With neutral phrases (ordinary road scenes), a type's score is the
        sigmoid of its best phrase's logit minus the best neutral logit: how
        much more the frame looks like the event than like an ordinary scene.
        Without them, it is the sigmoid of the best phrase's logit.
        """
        torch = self.torch
        neutral = list(neutral or [])
        phrases = [p for s in prompt_sets for p in s.get("phrases", [])]
        text = self._text_embeddings(phrases + neutral) if phrases else None
        with torch.inference_mode():
            scale = self.screen_model.logit_scale.exp().float()
            bias = self.screen_model.logit_bias.float()
        embeddings = []
        scores = []
        for start in range(0, len(images), SCREEN_BATCH):
            batch = images[start : start + SCREEN_BATCH]
            inputs = self.screen_processor(images=batch, return_tensors="pt").to(self.device)
            inputs["pixel_values"] = inputs["pixel_values"].half()
            with torch.inference_mode():
                features = pooled(self.screen_model.get_image_features(**inputs)).float()
                features = torch.nn.functional.normalize(features, dim=-1)
                logits = (features @ text.T * scale + bias).cpu() if text is not None else None
            embeddings.append(features.cpu())
            if logits is None:
                scores.extend({} for _ in batch)
                continue
            for row in logits:
                reference = row[len(phrases) :].max() if neutral else None
                column = 0
                per_set = {}
                for prompt_set in prompt_sets:
                    count = len(prompt_set.get("phrases", []))
                    if count:
                        best = row[column : column + count].max()
                        value = best - reference if reference is not None else best
                        per_set[prompt_set["id"]] = round(float(torch.sigmoid(value)), 5)
                    column += count
                scores.append(per_set)
        return torch.cat(embeddings), scores

    # People -------------------------------------------------------------

    def count_people(self, images: list, threshold: float = 0.5) -> list[dict]:
        torch = self.torch
        inputs = self.people_processor(images=images, return_tensors="pt").to(self.device)
        with torch.inference_mode():
            outputs = self.people_model(**inputs)
        sizes = torch.tensor([[im.height, im.width] for im in images])
        detections = self.people_processor.post_process_object_detection(
            outputs, target_sizes=sizes, threshold=threshold
        )
        results = []
        for image, found in zip(images, detections):
            mask = found["labels"].cpu() == self.person_label
            boxes = found["boxes"].cpu()[mask]
            heights = (boxes[:, 3] - boxes[:, 1]).float() if len(boxes) else torch.empty(0)
            results.append(
                {
                    "count": int(mask.sum()),
                    "medianHeightPx": round(float(heights.median()), 1) if len(heights) else None,
                    "imageHeight": image.height,
                }
            )
        return results

    # Describer ----------------------------------------------------------

    def generate_json(self, images: list, content: list, max_new_tokens: int) -> dict:
        return self.generate_json_batch([(images, content, max_new_tokens)])[0]

    def generate_json_batch(self, requests: list) -> list[dict]:
        """Run several readings in one generate call.

        Decoding on this GPU is bound by per-step overhead, not by the batch:
        a batch of 8 takes about as long per token as a single reading, so
        batching multiplies throughput. Prompts are left-padded.
        """
        torch = self.torch
        processor = self.describe_processor
        processor.tokenizer.padding_side = "left"
        texts = []
        images = []
        for request_images, content, _ in requests:
            messages = [
                {"role": "system", "content": [{"type": "text", "text": SYSTEM_PROMPT}]},
                {"role": "user", "content": content},
            ]
            texts.append(
                processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
            )
            images.extend(request_images)
        inputs = processor(
            text=texts, images=images or None, padding=True, return_tensors="pt"
        ).to(self.device)
        max_new_tokens = max(tokens for _, _, tokens in requests)
        with torch.inference_mode():
            output = self.describe_model.generate(
                **inputs, max_new_tokens=max_new_tokens, do_sample=False
            )
        prompt_tokens = int(inputs["input_ids"].shape[1])
        new_tokens = output[:, prompt_tokens:]
        pad_id = processor.tokenizer.pad_token_id
        results = []
        for row, (_, _, tokens) in zip(new_tokens, requests):
            row = row[:tokens]
            raw = processor.decode(row, skip_special_tokens=True)
            produced = int((row != pad_id).sum()) if pad_id is not None else int(row.shape[0])
            results.append(
                {
                    "raw": raw,
                    "parsed": parse_json_object(raw),
                    "promptTokens": prompt_tokens,
                    "outputTokens": produced,
                    "batchSize": len(requests),
                }
            )
        return results


class Baselines:
    """Running mean scene embedding per camera and day part."""

    def __init__(self, path: Path):
        self.path = path
        self.means = {}
        self.counts = {}
        self.dirty = False
        self.lock = threading.Lock()
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        import numpy as np

        try:
            data = np.load(self.path, allow_pickle=False)
            for key, mean, count in zip(data["keys"], data["means"], data["counts"]):
                self.means[str(key)] = mean.astype(np.float32)
                self.counts[str(key)] = int(count)
            log(f"loaded {len(self.means)} scene baselines")
        except Exception as error:
            log(f"could not read baselines ({error}); starting fresh")

    def save(self) -> None:
        import numpy as np

        with self.lock:
            if not self.dirty or not self.means:
                return
            keys = list(self.means)
            means = np.stack([self.means[k] for k in keys]).astype(np.float16)
            counts = np.array([self.counts[k] for k in keys], dtype=np.int64)
            self.dirty = False
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp.npz")
        np.savez_compressed(temporary, keys=np.array(keys), means=means, counts=counts)
        os.replace(temporary, self.path)

    def observe(self, key: str, embedding, learn: bool, learn_max: float, warmup: int):
        import numpy as np

        vector = np.asarray(embedding, dtype=np.float32)
        with self.lock:
            mean = self.means.get(key)
            count = self.counts.get(key, 0)
            novelty = None
            if mean is not None and count >= warmup:
                norm = float(np.linalg.norm(mean)) or 1.0
                novelty = round(float(1.0 - np.dot(vector, mean) / norm), 5)
            if learn and (novelty is None or novelty <= learn_max):
                alpha = max(1.0 / (count + 1), 0.02)
                updated = vector if mean is None else (1 - alpha) * mean + alpha * vector
                self.means[key] = updated.astype(np.float32)
                self.counts[key] = count + 1
                self.dirty = True
            return novelty, count

    def mark_normal(self, key: str, embedding, weight: float = 0.2) -> int:
        import numpy as np

        vector = np.asarray(embedding, dtype=np.float32)
        with self.lock:
            mean = self.means.get(key)
            updated = vector if mean is None else (1 - weight) * mean + weight * vector
            self.means[key] = updated.astype(np.float32)
            self.counts[key] = self.counts.get(key, 0) + 1
            self.dirty = True
            return self.counts[key]

    def reset(self, key: str) -> None:
        with self.lock:
            removed = self.means.pop(key, None) is not None
            self.counts.pop(key, None)
            self.dirty = self.dirty or removed


class Worker(threading.Thread):
    """One GPU worker; lower priority numbers run first, then oldest first.

    Describer readings are batched: when the next job is a reading, other
    queued readings join it, in priority order, up to `max_batch`.
    """

    def __init__(self, batch_runner=None, max_batch: int = 8):
        super().__init__(name="gpu-worker", daemon=True)
        self.heap = []
        self.cv = threading.Condition()
        self.sequence = itertools.count()
        self.stats = {}
        self.busy_ms = 0.0
        self.started_at = time.time()
        self.batch_runner = batch_runner
        self.max_batch = max_batch
        self.batch_sizes = {}

    def submit(self, kind: str, priority: int, fn, timeout_s: float, batch=None):
        job = {"fn": fn, "done": threading.Event(), "queued": time.time(), "kind": kind}
        if batch is not None:
            job["batch"] = batch
        with self.cv:
            heapq.heappush(self.heap, (priority, next(self.sequence), job))
            self.cv.notify()
        if not job["done"].wait(timeout_s):
            job["cancelled"] = True
            raise TimeoutError(f"{kind} waited more than {timeout_s:.0f} s")
        if "error" in job:
            raise job["error"]
        return job["result"], job["queuedMs"], job["runMs"]

    def depth(self) -> int:
        with self.cv:
            return len(self.heap)

    def _take(self) -> list:
        """Pop the next job, plus queued readings that can share its batch."""
        while True:
            _, _, job = heapq.heappop(self.heap)
            if not job.get("cancelled"):
                break
            if not self.heap:
                return []
        group = [job]
        if "batch" in job and self.batch_runner:
            skipped = []
            while self.heap and len(group) < self.max_batch:
                entry = heapq.heappop(self.heap)
                other = entry[2]
                if other.get("cancelled"):
                    continue
                if "batch" in other:
                    group.append(other)
                else:
                    skipped.append(entry)
            for entry in skipped:
                heapq.heappush(self.heap, entry)
        return group

    def run(self) -> None:
        while True:
            with self.cv:
                while not self.heap:
                    self.cv.wait()
                group = self._take()
            if not group:
                continue
            began = time.time()
            for job in group:
                job["queuedMs"] = round((began - job["queued"]) * 1000)
            try:
                if "batch" in group[0] and self.batch_runner:
                    results = self.batch_runner([job["batch"] for job in group])
                    for job, result in zip(group, results):
                        job["result"] = result
                else:
                    group[0]["result"] = group[0]["fn"]()
            except Exception as error:  # reported to every caller in the group
                for job in group:
                    job["error"] = error
            finally:
                run_ms = (time.time() - began) * 1000
                self.busy_ms += run_ms
                size = len(group)
                self.batch_sizes[size] = self.batch_sizes.get(size, 0) + 1
                for job in group:
                    job["runMs"] = round(run_ms)
                    stat = self.stats.setdefault(job["kind"], {"jobs": 0, "ms": 0.0})
                    stat["jobs"] += 1
                    stat["ms"] += run_ms / size
                    job["done"].set()


class Service:
    def __init__(self, models: Models, baselines: Baselines, worker: Worker):
        self.models = models
        self.baselines = baselines
        self.worker = worker

    def health(self) -> dict:
        vram = None
        if self.models.ready:
            torch = self.models.torch
            vram = {
                "allocatedMb": round(torch.cuda.memory_allocated() / 2**20),
                "reservedMb": round(torch.cuda.memory_reserved() / 2**20),
            }
        uptime = max(1.0, time.time() - self.worker.started_at)
        return {
            "ready": self.models.ready,
            "loading": self.models.loading,
            "error": self.models.error,
            "device": self.models.device,
            "models": {name: f"{repo}@{rev[:12]}" for name, (repo, rev) in MODELS.items()},
            "queueDepth": self.worker.depth(),
            "busyShare": round(self.worker.busy_ms / 1000 / uptime, 3),
            # Cumulative GPU-worker time, so a poller can take per-interval shares.
            "busyMs": round(self.worker.busy_ms),
            "uptimeS": round(uptime, 1),
            "jobs": {
                kind: {"jobs": s["jobs"], "avgMs": round(s["ms"] / s["jobs"]), "totalMs": round(s["ms"])}
                for kind, s in self.worker.stats.items()
                if s["jobs"]
            },
            "batchSizes": dict(sorted(self.worker.batch_sizes.items())),
            "vram": vram,
            "baselines": len(self.baselines.means),
        }

    def screen(self, body: dict) -> dict:
        frames = body.get("frames") or []
        prompt_sets = body.get("prompts") or []
        if not frames:
            raise ValueError("screen needs frames")
        learn_max = float(body.get("learnMax", 0.25))
        warmup = int(body.get("warmupSamples", 20))
        images = [decode_image(frame.get("jpeg")) for frame in frames]

        neutral = [p for p in body.get("neutral") or [] if isinstance(p, str) and p]

        def job():
            embeddings, scores = self.models.screen(images, prompt_sets, neutral)
            results = []
            for frame, embedding, score in zip(frames, embeddings.numpy(), scores):
                novelty, samples = None, 0
                if frame.get("baselineKey"):
                    novelty, samples = self.baselines.observe(
                        frame["baselineKey"],
                        embedding,
                        learn=bool(frame.get("learn", True)),
                        learn_max=learn_max,
                        warmup=warmup,
                    )
                results.append(
                    {
                        "id": frame.get("id"),
                        "scores": score,
                        "novelty": novelty,
                        "baselineSamples": samples,
                    }
                )
            return results

        results, queued_ms, run_ms = self.worker.submit(
            "screen", int(body.get("priority", 5)), job, float(body.get("timeoutS", 60))
        )
        return {"results": results, "queuedMs": queued_ms, "runMs": run_ms}

    def count(self, body: dict) -> dict:
        frames = body.get("frames") or []
        if not frames:
            raise ValueError("count needs frames")
        images = [decode_image(frame.get("jpeg")) for frame in frames]
        threshold = float(body.get("threshold", 0.5))
        results, queued_ms, run_ms = self.worker.submit(
            "count",
            int(body.get("priority", 5)),
            lambda: self.models.count_people(images, threshold),
            float(body.get("timeoutS", 60)),
        )
        for frame, result in zip(frames, results):
            result["id"] = frame.get("id")
        return {"results": results, "queuedMs": queued_ms, "runMs": run_ms}

    def verify(self, body: dict) -> dict:
        """One claim's narrow question, with a close-up cut from the native frame."""
        frames = body.get("frames") or []
        spec = body.get("spec") or {}
        answers = spec.get("answers") if isinstance(spec.get("answers"), dict) else {}
        if not frames:
            raise ValueError("verify needs frames")
        if not isinstance(spec.get("question"), str) or not answers:
            raise ValueError("verify needs a question and its answers")
        if not spec.get("needsFrames") and not isinstance(spec.get("sceneQuestion"), str):
            raise ValueError("verify needs a whole-frame wording (sceneQuestion) for one-frame checks")
        if any(result not in ("present", "absent", "unclear") for result in answers.values()):
            raise ValueError("verify answers must map to present, absent or unclear")
        decoded = [
            {"image": decode_image(frame.get("jpeg")), "offsetSec": float(frame.get("offsetSec") or 0)}
            for frame in frames
        ]
        box = valid_box(body.get("box"))
        images, close_ups = verify_inputs(decoded, box, spec, bool(body.get("closer", True)))
        content = verify_prompt(spec, close_ups, body.get("context") or {}, box)
        if content is None:
            # A movement question with one moment: not asked, no GPU time.
            result = not_asked_verification()
            result["hadCloseUp"] = bool(close_ups)
            result["facts"] = region_facts(decoded, box)
            return {"mode": "verify", "result": result, "raw": "", "promptTokens": 0, "outputTokens": 0,
                    "batchSize": 0, "queuedMs": 0, "runMs": 0}
        generated, queued_ms, run_ms = self.worker.submit(
            "describe-verify",
            int(body.get("priority", 5)),
            None,
            float(body.get("timeoutS", 120)),
            batch=(images, content, VERIFY_MAX_TOKENS),
        )
        result = clean_verification(generated["parsed"], spec)
        result["hadCloseUp"] = bool(close_ups)
        # Deterministic measurements beside the model's answer: supporting
        # evidence for the Node side to weigh, never a verdict on their own.
        result["facts"] = region_facts(decoded, box)
        return {
            "mode": "verify",
            "result": result,
            "raw": generated["raw"][:600],
            "promptTokens": generated["promptTokens"],
            "outputTokens": generated["outputTokens"],
            "batchSize": generated.get("batchSize", 1),
            "queuedMs": queued_ms,
            "runMs": run_ms,
        }

    def describe(self, body: dict) -> dict:
        mode = body.get("mode")
        frames = body.get("frames") or []
        if mode == "verify":
            return self.verify(body)
        if mode not in ("still", "pair", "clip", "profile", "clock"):
            raise ValueError("describe mode must be still, pair, clip, profile, clock or verify")
        if not frames:
            raise ValueError("describe needs frames")
        if mode in ("still", "clock") and len(frames) != 1:
            raise ValueError(f"{mode} takes exactly one frame")
        if mode == "pair" and len(frames) != 2:
            raise ValueError("pair takes exactly two frames")
        max_edge = CLIP_MAX_EDGE if mode == "clip" else STILL_MAX_EDGE
        images = [fit(decode_image(frame.get("jpeg")), max_edge) for frame in frames]
        vocabulary = body.get("vocabulary") or []
        allowed = {item["id"] for item in vocabulary if isinstance(item, dict) and item.get("id")}
        if mode in ("still", "pair", "clip") and not allowed:
            raise ValueError(f"{mode} needs a vocabulary")
        context = body.get("context") or {}

        if mode == "profile":
            content, tokens = profile_prompt(frames), 256
        elif mode == "clock":
            content, tokens = clock_prompt(), 96
        else:
            boxes = bool(body.get("boxes", False))
            content, tokens = reading_prompt(mode, frames, vocabulary, context, boxes=boxes), READING_MAX_TOKENS

        generated, queued_ms, run_ms = self.worker.submit(
            f"describe-{mode}",
            int(body.get("priority", 5)),
            None,
            float(body.get("timeoutS", 120)),
            batch=(images, content, int(body.get("maxNewTokens", tokens))),
        )
        parsed = generated["parsed"]
        if mode == "profile":
            result = clean_profile(parsed)
        elif mode == "clock":
            result = clean_clock(parsed)
        else:
            result = clean_reading(parsed, allowed)
        return {
            "mode": mode,
            "result": result,
            "raw": generated["raw"][:2000],
            "promptTokens": generated["promptTokens"],
            "outputTokens": generated["outputTokens"],
            "batchSize": generated.get("batchSize", 1),
            "queuedMs": queued_ms,
            "runMs": run_ms,
        }

    def baseline(self, body: dict) -> dict:
        key = body.get("key")
        action = body.get("action")
        if not isinstance(key, str) or not key:
            raise ValueError("baseline needs a key")
        if action == "reset":
            self.baselines.reset(key)
            return {"key": key, "samples": 0}
        if action != "mark_normal":
            raise ValueError("baseline action must be mark_normal or reset")
        if not self.models.ready:
            raise RuntimeError("models are still loading")
        image = decode_image(body.get("jpeg"))
        (embeddings, _), _, _ = self.worker.submit(
            "baseline", int(body.get("priority", 7)), lambda: self.models.screen([image], []), 60
        )
        return {"key": key, "samples": self.baselines.mark_normal(key, embeddings.numpy()[0])}


def make_handler(service: Service):
    routes = {
        "/screen": service.screen,
        "/count": service.count,
        "/describe": service.describe,
        "/baseline": service.baseline,
    }

    class Handler(BaseHTTPRequestHandler):
        server_version = "gev-cctv-detector/1"

        def log_message(self, *_args) -> None:
            return

        def send_json(self, status: int, payload: dict) -> None:
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            if self.path == "/health":
                self.send_json(200, service.health())
            else:
                self.send_json(404, {"error": "not found"})

        def do_POST(self) -> None:
            route = routes.get(self.path)
            if route is None:
                self.send_json(404, {"error": "not found"})
                return
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_BODY_BYTES:
                self.send_json(413, {"error": "body missing or too large"})
                return
            try:
                body = json.loads(self.rfile.read(length))
            except (json.JSONDecodeError, UnicodeDecodeError):
                self.send_json(400, {"error": "body is not JSON"})
                return
            if not isinstance(body, dict):
                self.send_json(400, {"error": "body must be a JSON object"})
                return
            if not service.models.ready and self.path != "/baseline":
                self.send_json(503, {"error": "models are still loading", "loading": service.models.loading})
                return
            try:
                self.send_json(200, route(body))
            except ValueError as error:
                self.send_json(400, {"error": str(error)})
            except TimeoutError as error:
                self.send_json(504, {"error": str(error)})
            except Exception as error:
                log(f"{self.path} failed: {error}\n{traceback.format_exc()}")
                self.send_json(500, {"error": f"{type(error).__name__}: {error}"})

    return Handler


def serve(args) -> None:
    models = Models(args.model_dir, describer=args.describer)
    baselines = Baselines(args.baselines)
    worker = Worker(batch_runner=models.generate_json_batch, max_batch=args.max_batch)
    worker.start()
    service = Service(models, baselines, worker)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(service))
    server.daemon_threads = True

    def load_models():
        try:
            models.load()
        except Exception as error:
            models.error = f"{type(error).__name__}: {error}"
            models.loading = None
            log(f"model load failed: {models.error}\n{traceback.format_exc()}")

    def save_periodically():
        while True:
            time.sleep(BASELINE_SAVE_EVERY_S)
            try:
                baselines.save()
            except Exception as error:
                log(f"baseline save failed: {error}")

    def stop(_signum, _frame):
        log("stopping")
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    threading.Thread(target=load_models, name="model-loader", daemon=True).start()
    threading.Thread(target=save_periodically, name="baseline-saver", daemon=True).start()
    log(f"listening on 127.0.0.1:{args.port}")
    try:
        server.serve_forever()
    finally:
        server.server_close()
        baselines.save()
        log("stopped")
        # Exit without tearing down the CUDA context under live worker
        # threads, which aborts noisily; baselines are already saved.
        os._exit(0)


def download(args) -> None:
    from huggingface_hub import snapshot_download

    args.model_dir.mkdir(parents=True, exist_ok=True)
    wanted = {**MODELS, "describer": DESCRIBERS[args.describer]}
    for name, (repo, revision) in wanted.items():
        log(f"downloading {name}: {repo}@{revision[:12]} into {args.model_dir}")
        snapshot_download(
            repo_id=repo,
            revision=revision,
            cache_dir=str(args.model_dir),
            allow_patterns=["*.json", "*.safetensors", "*.txt", "*.model", "*.jinja"],
        )
    log("all models downloaded")


def read_input(source: str):
    from PIL import Image

    if re.match(r"^https?://", source):
        request = urllib.request.Request(
            source, headers={"User-Agent": "gods-eye-view-cctv-detector/1 (local evaluation)"}
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            data = response.read()
    else:
        data = Path(source).read_bytes()
    image = Image.open(io.BytesIO(data))
    image.load()
    return image.convert("RGB")


def classify(args) -> None:
    """Print screen scores and a still reading for each local file or URL."""
    events = json.loads(EVENTS_PATH.read_text())
    observations = events["observations"]
    prompt_sets = [
        {"id": key, "phrases": spec.get("phrases", [])}
        for key, spec in observations.items()
        if spec.get("phrases")
    ]
    vocabulary = [
        {"id": key, "describe": spec["describe"], "evidence": spec["evidence"]}
        for key, spec in observations.items()
    ]
    models = Models(args.model_dir, describer=args.describer)
    models.load()
    for source in args.classify:
        try:
            image = read_input(source)
        except Exception as error:
            print(json.dumps({"input": source, "error": str(error)}), flush=True)
            continue
        started = time.time()
        _, scores = models.screen([image], prompt_sets)
        screen_ms = round((time.time() - started) * 1000)
        frames = [{"captureTime": None}]
        started = time.time()
        generated = models.generate_json(
            [fit(image, STILL_MAX_EDGE)],
            reading_prompt("still", frames, vocabulary, {}),
            READING_MAX_TOKENS,
        )
        describe_ms = round((time.time() - started) * 1000)
        top = sorted(scores[0].items(), key=lambda item: item[1], reverse=True)[:5]
        reading = clean_reading(generated["parsed"], {v["id"] for v in vocabulary})
        record = {
            "input": source,
            "size": list(image.size),
            "screenTop": top,
            "screenMs": screen_ms,
            "reading": reading,
            "describeMs": describe_ms,
            "outputTokens": generated["outputTokens"],
            "tokensPerSecond": round(generated["outputTokens"] / max(describe_ms / 1000, 0.001), 1),
        }
        if not reading["ok"]:
            record["raw"] = generated["raw"][:2000]
        print(json.dumps(record), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--port", type=int, default=int(os.environ.get("CCTV_WATCH_DETECTOR_PORT", "4191")))
    parser.add_argument("--model-dir", type=Path, default=Path(os.environ.get("CCTV_WATCH_MODEL_DIR", DEFAULT_MODEL_DIR)))
    parser.add_argument("--baselines", type=Path, default=DEFAULT_BASELINE_PATH)
    parser.add_argument(
        "--max-batch",
        type=int,
        default=int(os.environ.get("CCTV_WATCH_DESCRIBE_BATCH", "8")),
        help="most describer readings run together in one batch",
    )
    parser.add_argument(
        "--describer",
        choices=sorted(DESCRIBERS),
        default=os.environ.get("CCTV_WATCH_DESCRIBER", "4b"),
        help="describer model size (4b is the default; 8b is under comparison)",
    )
    parser.add_argument("--download", action="store_true", help="download the pinned model weights and exit")
    parser.add_argument("--classify", nargs="+", metavar="FILE_OR_URL", help="screen and describe images, then exit")
    args = parser.parse_args()
    if args.download:
        download(args)
    elif args.classify:
        classify(args)
    else:
        serve(args)


if __name__ == "__main__":
    main()
