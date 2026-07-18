import os
import sys
import json
import argparse
from collections import Counter

import cv2
import numpy as np
import easyocr
from ultralytics import YOLO

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
# Full-frame-trained model (home_guest.pt: guest_points, home_points,
# score_board) — detects digit regions directly on the raw frame, no
# crop+upscale stage needed at all. Verified directly against real footage:
# clean, accurate boxes and strong confidence (home_points ~0.85, guest_points
# ~0.5-0.67, score_board ~0.88) with zero preprocessing. This is the only
# board-locating model in active use — the original two-stage board_model/
# digit_model path (score_board.pt/score.pt) it replaced was deleted once
# this model was validated across many real runs; --board-model/--digit-model
# below are now optional hooks for a future replacement, not a live fallback.
FULLFRAME_MODEL_PATH = os.path.join(SCRIPT_DIR, "home_guest.pt")
# Dedicated single-digit (0-9) classifier trained on real scoreboard crops —
# same rationale as home_guest.pt vs the generic OCR it replaced: EasyOCR is a
# general-purpose text reader, not tuned to this exact LED font at this exact
# blur/scale, which is exactly where it was inconsistent. Verified directly:
# tracks a believable, mostly-monotonic real score progression (0->22 across
# a full set) and correctly detects two separate digit boxes for most
# double-digit values. Opt-in via --led-model — EasyOCR (read_digits below)
# stays the default and fully intact, same rollback pattern as everything else.
LED_MODEL_PATH = os.path.join(SCRIPT_DIR, "led_read.pt")

# score.pt classes: guest_points, guest_set, home_points, home_set, score_board.
# Only the points matter for the app's "Us/Opp" score and stats — sets are
# never used downstream, so they're not tracked here at all (not merely
# de-prioritized: home_set/guest_set boxes are ignored entirely, they're
# never read, voted on, or written out).
SCORE_CLASSES = {"guest_points", "home_points"}

# Extra padding around the detected board box, as a fraction of its size — a tight
# crop risks clipping a digit that sits right at the board's edge.
CROP_MARGIN = 0.15
# Matches the scale score.pt was actually validated at (a 4x upscale of a
# hand-picked board-sized crop is what got 70-90% confidence in testing).
CROP_UPSCALE = 4


def parse_args():
    parser = argparse.ArgumentParser(
        description="Scoreboard reading: locate guest_points/home_points regions directly "
                    "on the full frame (--fullframe-model, e.g. home_guest.pt), then read "
                    "each region's digits (--led-model, e.g. led_read.pt). A value only ever "
                    "gets accepted once the digit's own crop is confirmed to look visually "
                    "different from the last known state — OCR alone is never trusted to "
                    "notice a change."
    )
    parser.add_argument("--video", required=True)
    parser.add_argument("--output", required=True, help="Path to write scoreboard_readings.json")
    parser.add_argument("--output-video", default=None, help="Optional annotated preview video (draws detected boxes + OCR'd value)")
    parser.add_argument("--rally-windows", default=None,
                         help="rally_windows.json from run_rally_stage.py. When given, switches "
                              "to rally-boundary attribution mode: rally-point volleyball means "
                              "exactly one point per completed rally, so timing comes from the "
                              "rally boundary (not OCR vote-accumulation), and attribution comes "
                              "from comparing which digit region's image actually changed across "
                              "that boundary — a much narrower, more robust question than reading "
                              "the exact new number.")
    parser.add_argument("--board-model", default=None,
                         help="Optional: two-stage board locator, only used when --fullframe-model "
                              "is omitted. No default model ships for this anymore (score_board.pt "
                              "was deleted once home_guest.pt was validated) — pass a path explicitly "
                              "to use this path.")
    parser.add_argument("--digit-model", default=None,
                         help="Optional: two-stage digit detector, only used when --fullframe-model "
                              "is omitted. No default model ships for this anymore (score.pt was "
                              "deleted once home_guest.pt was validated) — pass a path explicitly to "
                              "use this path.")
    parser.add_argument("--fullframe-model", default=None,
                         help="Optional: a model trained to detect guest_points/home_points/score_board "
                              "directly on full frames (e.g. home_guest.pt). When given, skips the "
                              "board-locate + crop + upscale steps entirely and detects digit regions "
                              "directly. Opt-in — omit to keep using --board-model/--digit-model exactly "
                              "as before.")
    parser.add_argument("--led-model", default=None,
                         help="Optional: a single-digit (0-9) classifier trained on real scoreboard "
                              "crops (e.g. led_read.pt). When given, replaces EasyOCR for reading a "
                              "digit crop's value — detected digit boxes are composed left-to-right "
                              "into the full number. Opt-in — omit to keep using EasyOCR exactly as before.")
    parser.add_argument("--conf", type=float, default=0.5)
    parser.add_argument("--sample-every", type=int, default=1,
                         help="Only run detection/OCR every N frames — the scoreboard rarely "
                              "changes every frame, so for a full-video pass a larger value "
                              "(e.g. fps/2) is much cheaper. Default 1 for this first check.")
    parser.add_argument("--device", default=None, help="cpu or cuda device index; default lets ultralytics pick")
    return parser.parse_args()


def preprocess_for_ocr(crop):
    if crop is None or crop.size == 0:
        return None
    h, w = crop.shape[:2]
    if h < 40 or w < 30:
        scale = max(40 / max(h, 1), 30 / max(w, 1))
        crop = cv2.resize(crop, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_CUBIC)
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return binary


def _box_iou(a, b):
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


# Two different digit classes can each independently detect a box at roughly
# the same position (e.g. "1" and "2" both proposed for one ambiguous digit
# shape) — YOLO's NMS is class-aware, so it won't merge these since they're
# different classes, and composing both left-to-right by x-position turns one
# real digit into two, corrupting the whole number (verified directly: a real
# "10" got read as "210" this way). Any box overlapping an already-kept one
# above this threshold is treated as a second guess for the same position,
# not a second digit, and only the higher-confidence guess survives.
DIGIT_DEDUP_IOU = 0.3


def read_digits(reader, crop, led_model=None, led_conf=0.2):
    """Reads the number in a crop. When led_model is given, uses the dedicated
    single-digit classifier instead of EasyOCR: detects each digit character,
    sorts left-to-right by x-position, and composes them into the full number
    (e.g. a "1" box at x=10 and a "6" box at x=40 -> 16). Falls back to
    EasyOCR exactly as before when led_model is None.
    """
    if led_model is not None:
        if crop is None or crop.size == 0:
            return None
        # led_read.pt was trained on crops upscaled 4x (see extract_digit_crops.py
        # and CROP_UPSCALE) — but a fullframe-detected digit region can be tiny
        # (as small as ~25x25px for a distant/small board) and was being fed to
        # the model at that native size, a real train/inference scale mismatch.
        # Verified directly against real footage: an ambiguous low-confidence
        # second digit flickered between being read as absent, "1", or "2" from
        # frame to frame at native scale, producing a wildly unstable value
        # (9/10/20/0 across a handful of frames for what should be one real,
        # unchanging score); upscaling to match training scale made the same
        # candidate win consistently across every frame.
        big = cv2.resize(crop, None, fx=CROP_UPSCALE, fy=CROP_UPSCALE, interpolation=cv2.INTER_CUBIC)
        results = led_model(big, conf=led_conf, verbose=False)[0]
        if len(results.boxes) == 0:
            return None

        candidates = sorted(
            ((float(b.conf[0]), tuple(b.xyxy[0].tolist()), led_model.names[int(b.cls[0])])
             for b in results.boxes),
            key=lambda c: c[0], reverse=True,
        )
        kept = []  # (box, cls_name), highest-confidence guess per position
        for conf, box, cls_name in candidates:
            if any(_box_iou(box, kb) >= DIGIT_DEDUP_IOU for kb, _ in kept):
                continue  # a higher-confidence guess already claimed this position
            kept.append((box, cls_name))

        digits = sorted((box[0], cls_name) for box, cls_name in kept)
        composed = "".join(d[1] for d in digits)
        return int(composed) if composed.isdigit() else None

    processed = preprocess_for_ocr(crop)
    if processed is None:
        return None
    results = reader.readtext(processed, allowlist="0123456789", detail=0)
    for text in results:
        text = text.strip()
        if text.isdigit():
            return int(text)
    return None


# ── Change detection (independent of OCR) ───────────────────────────────────
# A digit region's *appearance* is a much easier, more robust signal than its
# *reading*: "does this look different from before" only needs a plain image
# comparison, whereas "what number is this" is where all the misread noise
# lives. Reusing the same Otsu binarization already used for OCR gives a
# representation that's already normalized against lighting/contrast, so a
# genuine digit change shows up as a large shape difference while brightness
# flicker or minor jitter mostly washes out.
SIGNATURE_SIZE = (32, 48)
DIFF_THRESHOLD = 0.12  # fraction of differing pixels (0-1) to call it "changed"


def crop_signature(crop):
    processed = preprocess_for_ocr(crop)
    if processed is None:
        return None
    return cv2.resize(processed, SIGNATURE_SIZE, interpolation=cv2.INTER_AREA)


def signature_diff(a, b):
    """Fraction of pixels that differ between two same-sized binary signatures.
    1.0 (maximally different) if either is missing — "can't compare" should
    never be mistaken for "looks the same"."""
    if a is None or b is None:
        return 1.0
    return float(np.mean(a != b))


# Votes needed to confirm a value, NOT required to be consecutive — verified
# against real footage that a strict "N in a row" scheme fails: missed
# detections and occasional misreads routinely interrupt even the objectively
# dominant/correct value before it strings together a useful streak.
CONFIRM_VOTES = 15

# A real score reading is never a 3-digit number — 3-digit misreads (e.g. "157")
# showed up often enough in real footage to matter, and matter more once jumps
# of more than +1 are allowed (a value only needs to clear the vote bar once,
# not literally be current+1 — otherwise the tracker gets permanently stuck if
# any single intermediate value is never individually confirmed in time).
MAX_PLAUSIBLE_POINTS = 50


class FieldTracker:
    """Tracks one scoreboard field (e.g. home_points) as a confirmed running
    value. A reading only ever gets to accumulate a vote if the digit crop
    ALSO looks visually different from the reference image of the last
    confirmed value — an OCR misread of a digit that never actually changed
    is rejected before OCR's opinion even matters, regardless of how
    plausible or how repeated that misread is.
    """

    def __init__(self):
        self.value = None
        self.reference_sig = None
        self.votes = Counter()
        self.changes = []

    def update(self, frame_idx, value, sig):
        if sig is None:
            return  # nothing detected this frame — not evidence either way

        if self.value is None:
            # Bootstrap: the video may start mid-match, so seed from whatever
            # the board actually shows first, not an assumed 0. No prior
            # reference exists yet, so there's nothing to diff against.
            if value is None or not (0 <= value <= MAX_PLAUSIBLE_POINTS):
                return
            self.votes[value] += 1
            if self.votes[value] >= CONFIRM_VOTES:
                self.value = value
                self.reference_sig = sig
                self.votes = Counter()
            return

        if signature_diff(sig, self.reference_sig) < DIFF_THRESHOLD:
            return  # crop still matches the last confirmed state — nothing to see

        if value is None or not (0 <= value <= MAX_PLAUSIBLE_POINTS) or value <= self.value:
            return  # visually different, but no plausible new reading to credit it to yet

        self.votes[value] += 1
        if self.votes[value] >= CONFIRM_VOTES:
            old = self.value
            self.value = value
            self.reference_sig = sig
            self.votes = Counter()
            # A confirmed jump of more than +1 means some individual point in
            # between was never itself confirmed before the board moved past
            # it (e.g. two points scored in quick succession) — split it into
            # one +1 event per point rather than one combined "+2" event, so
            # the *count* of points is still right for statistics purposes,
            # even though the exact timing of the merged one is approximate
            # (all attributed to this same confirming frame).
            for step in range(old + 1, value + 1):
                self.changes.append({"frame": frame_idx, "from": step - 1, "to": step})


def locate_board(board_model, frame, conf):
    """Returns the highest-confidence score_board box (x1,y1,x2,y2), padded by
    CROP_MARGIN and clamped to the frame, or None if not found this frame."""
    results = board_model(frame, conf=conf, verbose=False)[0]
    if len(results.boxes) == 0:
        return None
    best = max(results.boxes, key=lambda b: float(b.conf[0]))
    x1, y1, x2, y2 = best.xyxy[0].tolist()
    bw, bh = x2 - x1, y2 - y1
    mx, my = bw * CROP_MARGIN, bh * CROP_MARGIN
    fh, fw = frame.shape[:2]
    x1 = max(0, int(x1 - mx))
    y1 = max(0, int(y1 - my))
    x2 = min(fw, int(x2 + mx))
    y2 = min(fh, int(y2 + my))
    return x1, y1, x2, y2


def detect_digit_crops(board_model, digit_model, frame, conf, device_kwargs, fullframe_model=None):
    """Shared by both modes: locate each SCORE_CLASSES digit region in frame.
    Returns {field: crop_image}, or {} if nothing was found.

    When fullframe_model is given, detects digit regions directly on the raw
    frame — no board-locate + crop + upscale needed at all (see
    FULLFRAME_MODEL_PATH above). Otherwise falls back to the original
    two-stage board_model/digit_model approach exactly as before.
    """
    if fullframe_model is not None:
        results = fullframe_model(frame, conf=conf, verbose=False, **device_kwargs)[0]
        crops, best_conf = {}, {}
        for box in results.boxes:
            cls_name = fullframe_model.names[int(box.cls[0])]
            if cls_name not in SCORE_CLASSES:
                continue
            box_conf = float(box.conf[0])
            if cls_name in best_conf and box_conf <= best_conf[cls_name]:
                continue  # keep only the highest-confidence box per field — duplicates observed in testing
            best_conf[cls_name] = box_conf
            x1, y1, x2, y2 = map(int, box.xyxy[0])
            crops[cls_name] = frame[max(0, y1):y2, max(0, x1):x2]
        return crops

    board_box = locate_board(board_model, frame, conf)
    if board_box is None:
        return {}
    bx1, by1, bx2, by2 = board_box
    crop = frame[by1:by2, bx1:bx2]
    big = cv2.resize(crop, None, fx=CROP_UPSCALE, fy=CROP_UPSCALE, interpolation=cv2.INTER_CUBIC)

    digit_results = digit_model(big, conf=conf, verbose=False, **device_kwargs)[0]
    crops = {}
    for box in digit_results.boxes:
        cls_name = digit_model.names[int(box.cls[0])]
        if cls_name not in SCORE_CLASSES:
            continue
        dx1, dy1, dx2, dy2 = map(int, box.xyxy[0])
        crops[cls_name] = big[max(0, dy1):dy2, max(0, dx1):dx2]
    return crops


def read_frame_at(cap, frame_idx):
    cap.set(cv2.CAP_PROP_POS_FRAMES, max(0, frame_idx - 1))
    ok, frame = cap.read()
    return frame if ok else None


# Separate from DIFF_THRESHOLD (used by the continuous-scan mode, already
# validated at 0.12): this mode compares two burst-median signatures rather
# than accumulating votes over an entire video, so its noise floor is measurably
# higher. Verified directly against a clip whose real score never changes: even
# after burst-sampling, non-changes still measured 0.04-0.16 — 0.12 alone let
# 3 of 4 false positives through. Set with margin above that observed ceiling.
RALLY_DIFF_THRESHOLD = 0.20

# A single frame is not a safe basis for "did this change" — motion blur, a
# player briefly walking past the board, camera jitter, or the board's own
# per-frame re-detection shifting slightly can each alone make one instant
# look very different from another, regardless of the actual digits (verified
# directly: real test showed both fields "differing" by 0.24-0.39 on every
# single rally boundary, when the true score never changed at all). Sampling
# a burst of frames across the settled portion of the gap and taking the
# per-pixel majority cancels out whichever of those a single unlucky frame
# hit.
BURST_STEP_FRAMES = 3
# Upper bound on how many frames get sampled from one window, so a very long
# gap (a slow between-set break) doesn't turn into hundreds of extra YOLO
# calls — the majority vote saturates well before this many samples anyway.
MAX_WINDOW_SAMPLES = 40

# One frame can land on glare, motion blur, or a box that's a hair
# misaligned on this specific board's digit spacing (verified directly on a
# real match: the guest_points crop came back as a solid color block with no
# digit in it on one sampled frame, at the exact same crop size as frames
# immediately before/after that read cleanly — a localization miss on that
# one frame, not a broken field). A single fixed sample point has no way to
# outvote that. Scanning densely across the whole settled window instead
# means an unlucky frame is just one vote among many rather than the only
# data point.
WIDE_BURST_MULTIPLIER = 4


def _window_sample_indices(start, end):
    span = max(1, end - start)
    step = max(1, min(BURST_STEP_FRAMES, span // MAX_WINDOW_SAMPLES or 1))
    idxs = list(range(start, end + 1, step))
    if len(idxs) > MAX_WINDOW_SAMPLES:
        # Evenly thin down to the cap rather than just truncating, so the
        # sample still spans the full window instead of only its first part.
        keep_every = len(idxs) / MAX_WINDOW_SAMPLES
        idxs = [idxs[int(i * keep_every)] for i in range(MAX_WINDOW_SAMPLES)]
    return idxs


def representative_reading(cap, board_model, digit_model, reader, conf, window, fullframe_model=None, led_model=None):
    """Majority vote across every frame in the given (start, end) window for
    two things at once: the image signature (used for diff-based change
    detection) and the OCR-read digit value (used for the OCR-fallback when
    diff-based detection isn't confident) — one scan serves both."""
    start, end = window
    sigs_by_field = {}
    values_by_field = {}
    for idx in _window_sample_indices(start, end):
        frame = read_frame_at(cap, idx)
        if frame is None:
            continue
        crops = detect_digit_crops(board_model, digit_model, frame, conf, {}, fullframe_model=fullframe_model)
        for field, crop in crops.items():
            sig = crop_signature(crop)
            if sig is not None:
                sigs_by_field.setdefault(field, []).append(sig)
            value = read_digits(reader, crop, led_model=led_model)
            if value is not None and 0 <= value <= MAX_PLAUSIBLE_POINTS:
                values_by_field.setdefault(field, Counter())[value] += 1

    # A field with zero valid reads across the whole settled window (not
    # just one unlucky frame) means the problem isn't sampling luck — widen
    # into the less-safe edges of the gap as a last resort rather than
    # reporting the field as unreadable outright. Scoped to only the
    # field(s) that actually came up empty, so this never changes anything
    # for the common case where the settled window already found a majority.
    missing_fields = SCORE_CLASSES - values_by_field.keys()
    if missing_fields:
        wide_span = int((end - start) * WIDE_BURST_MULTIPLIER)
        wide_start = max(0, start - wide_span)
        wide_end = end + wide_span
        for idx in _window_sample_indices(wide_start, wide_end):
            frame = read_frame_at(cap, idx)
            if frame is None:
                continue
            crops = detect_digit_crops(board_model, digit_model, frame, conf, {}, fullframe_model=fullframe_model)
            for field in missing_fields:
                crop = crops.get(field)
                if crop is None:
                    continue
                value = read_digits(reader, crop, led_model=led_model)
                if value is not None and 0 <= value <= MAX_PLAUSIBLE_POINTS:
                    values_by_field.setdefault(field, Counter())[value] += 1

    reps = {}
    for field, sigs in sigs_by_field.items():
        stacked = np.stack(sigs, axis=0).astype(np.int16)
        reps[field] = (np.median(stacked, axis=0) > 127).astype(np.uint8) * 255

    values = {field: counter.most_common(1)[0][0] for field, counter in values_by_field.items() if counter}
    return reps, values


def run_rally_attribution(args, board_model, digit_model, reader, cap, fps, fullframe_model=None, led_model=None):
    """Rally-boundary attribution: exactly one point per completed rally,
    timed to the rally's own end (not OCR vote-accumulation), attributed to
    whichever digit region's image changed more across that boundary.

    Each side of the comparison is measured late in the dead-time gap flanking
    the rally (see gap_reference_frame), not a fixed offset from the rally's
    own start/end — the boundary itself is still often mid-motion (players
    celebrating, walking back, ref resetting), and biasing late gives the
    scoreboard operator most of the gap's duration to actually update.
    Consecutive rallies share a dead-time gap (rally i's "after" is rally i+1's
    "before") and must sample that shared gap at the exact same point, so
    readings are cached by center frame to avoid recomputing the same one.

    Image-diff isn't always confident (verified in practice — it sometimes
    finds no clear change even when a real point was scored). Rather than
    just accepting "no change" at face value, consecutive rallies where diff
    stayed inconclusive are grouped into a run and cross-checked with OCR
    across the *whole* run: since exactly one point is awarded per completed
    rally, if OCR confirms the total change across N consecutive rallies is
    exactly N points for one team, that's not a guess — it's the only
    possibility, so 1 point gets attributed to each rally in the run. If OCR
    instead confirms a split between the two teams (e.g. 1 each across a
    2-rally run), which specific rally belongs to which team can't be
    resolved here — this script has no action/team data (it runs before the
    merge step that combines them) — so those get flagged as "ambiguous" for
    a later stage to resolve using the rally's last action.
    """
    with open(args.rally_windows) as f:
        rally_data = json.load(f)
    rally_windows = rally_data.get("rally_windows", [])
    dead_segments = sorted(rally_data.get("dead_segments", []), key=lambda d: d["start_frame"])
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0

    def dead_segment_before(frame_idx):
        candidates = [d for d in dead_segments if d["end_frame"] <= frame_idx]
        return max(candidates, key=lambda d: d["end_frame"]) if candidates else None

    def dead_segment_after(frame_idx):
        candidates = [d for d in dead_segments if d["start_frame"] >= frame_idx]
        return min(candidates, key=lambda d: d["start_frame"]) if candidates else None

    def gap_reference_frame(gap):
        # A dead-time gap between two rallies serves double duty: it's the
        # "after" reference for the rally that just ended AND the "before"
        # reference for the rally about to start — there is only one real,
        # physical settled state during that gap, so both roles must sample
        # the SAME point, not two different ones. Biased *late* so the
        # scoreboard operator gets most of the gap's duration to actually
        # update before we look (an early-biased "before" was verified
        # directly to race a fast update: in one real clip the operator
        # updated within the first ~10% of the gap, so an early "before"
        # sample landed a hair before the update completed, making that
        # rally's own diff get diluted by a leftover change that actually
        # belonged to the *previous* rally). Stops short of the boundary to
        # avoid the next rally's own build-up motion.
        start, end = gap["start_frame"], gap["end_frame"]
        return start + int((end - start) * 0.75)

    def gap_stable_window(gap):
        # The settled portion of the gap to scan densely for a majority-vote
        # read, instead of resting on the single reference frame above. Same
        # "bias late" reasoning applies (see gap_reference_frame) so this
        # stays clear of the early risk of catching the board mid-update —
        # it widens the reference point into a real range rather than moving
        # it earlier, so one misaligned/occluded frame is just one vote
        # among many instead of the only data point.
        start, end = gap["start_frame"], gap["end_frame"]
        span = end - start
        return (start + int(span * 0.65), start + int(span * 0.97))

    # Span used for the two edge cases with no real dead-time gap on one side
    # (video opens/closes mid-action) — see the before_window/after_window
    # construction below.
    EDGE_WINDOW_FRAMES = 60

    reading_cache = {}
    def cached_reading(window):
        if window not in reading_cache:
            reading_cache[window] = representative_reading(
                cap, board_model, digit_model, reader, args.conf, window,
                fullframe_model=fullframe_model, led_model=led_model)
        return reading_cache[window]

    home_score = guest_score = 0
    changes = []
    events = []
    ambiguous_groups = []
    pending = []  # rallies whose diff was inconclusive, awaiting the OCR-fallback

    def flush_pending():
        """Resolve a run of diff-inconclusive rallies via OCR across the whole
        run at once (see function docstring)."""
        nonlocal home_score, guest_score
        if not pending:
            return
        first, last = pending[0], pending[-1]
        _, before_values = cached_reading(first["before_window"])
        _, after_values  = cached_reading(last["after_window"])

        home_delta = after_values.get("home_points", None)
        guest_delta = after_values.get("guest_points", None)
        if home_delta is not None and "home_points" in before_values:
            home_delta -= before_values["home_points"]
        else:
            home_delta = None
        if guest_delta is not None and "guest_points" in before_values:
            guest_delta -= before_values["guest_points"]
        else:
            guest_delta = None

        n = len(pending)
        # A single pending rally whose own window covers a clean, one-sided
        # jump bigger than 1 point isn't ambiguous -- there's only one real
        # signal here, not several rallies to distribute it across --  see
        # the matching comment above the per-rally led_model check for why a
        # rally *window* can legitimately span more than one real point.
        clean_one_sided = (home_delta is not None and guest_delta is not None
                            and home_delta >= 0 and guest_delta >= 0
                            and (home_delta == 0) != (guest_delta == 0))
        valid = (home_delta is not None and guest_delta is not None
                 and home_delta >= 0 and guest_delta >= 0
                 and (home_delta + guest_delta == n or (n == 1 and clean_one_sided)))

        if not valid:
            for p in pending:
                events.append({"rally_index": p["index"], "frame": p["win"]["end_frame"], "field": None,
                                "note": "no change detected (OCR cross-check inconclusive)", "diffs": p["diffs"]})
            pending.clear()
            return

        if n == 1 and clean_one_sided and home_delta != n and guest_delta != n:
            only = pending[0]
            field = "home_points" if home_delta > 0 else "guest_points"
            amount = home_delta if home_delta > 0 else guest_delta
            if field == "home_points":
                home_score += amount
            else:
                guest_score += amount
            changes.append({
                "frame": only["after_idx"], "field": field,
                "from": (home_score if field == "home_points" else guest_score) - amount,
                "to": home_score if field == "home_points" else guest_score,
            })
            events.append({"rally_index": only["index"], "frame": only["after_idx"], "field": field,
                            "note": f"resolved via OCR cross-check ({amount} points read in one rally window)",
                            "home_score": home_score, "guest_score": guest_score})
            pending.clear()
            return

        if home_delta == n or guest_delta == n:
            # Only one team could possibly have scored across this whole run —
            # not a guess, the "one point per rally" rule forces this.
            field = "home_points" if home_delta == n else "guest_points"
            for p in pending:
                if field == "home_points":
                    home_score += 1
                else:
                    guest_score += 1
                changes.append({
                    "frame": p["after_idx"], "field": field,
                    "from": (home_score if field == "home_points" else guest_score) - 1,
                    "to": home_score if field == "home_points" else guest_score,
                })
                events.append({"rally_index": p["index"], "frame": p["after_idx"], "field": field,
                                "note": "resolved via OCR cross-check over the run (one-sided)",
                                "home_score": home_score, "guest_score": guest_score})
        else:
            # A genuine split between the two teams across this run — WHICH
            # rally belongs to which team needs action/team data this script
            # doesn't have. Flag it for a later stage instead of guessing.
            ambiguous_groups.append({
                "rally_indices": [p["index"] for p in pending],
                "start_frame": first["win"]["start_frame"],
                "end_frame": last["win"]["end_frame"],
                "home_points_delta": home_delta,
                "guest_points_delta": guest_delta,
            })
            for p in pending:
                events.append({"rally_index": p["index"], "frame": p["win"]["end_frame"], "field": None,
                                "note": "ambiguous — resolved via OCR cross-check but split between "
                                        "teams, needs action-based disambiguation downstream"})
        pending.clear()

    for i, win in enumerate(rally_windows):
        before_gap = dead_segment_before(win["start_frame"])
        after_gap  = dead_segment_after(win["end_frame"])
        is_last_rally  = (i == len(rally_windows) - 1)
        is_first_rally = (i == 0)

        # No genuine dead-time reference on one side (e.g. the video itself
        # starts mid-rally, so there's no real "before" at all) — don't guess
        # with a fixed-offset fallback landing inside some OTHER rally's own
        # action, which is an apples-to-oranges comparison and produced
        # exactly this kind of false positive in testing. Skip rather than
        # risk it — UNLESS this is the first rally with no before_gap, or the
        # last rally with no after_gap, in which case there's real
        # information available, not a guess:
        #  - First rally, no before_gap: the video opens mid-action, but the
        #    scoreboard physically cannot have changed before any rally has
        #    even concluded yet, so any frame near the very start of the
        #    recording — even mid-action — is a safe, certain "before" value,
        #    not an apples-to-oranges guess. Verified this mattered directly:
        #    a real, large 9->10 change attributable to the first rally was
        #    otherwise silently skipped with zero attempt, even though the
        #    change itself was easily readable.
        #  - Last rally, no after_gap: the video just ends here, and the last
        #    available frames are real information too (handled below).
        if before_gap is None and not is_first_rally and not (is_last_rally and after_gap is None):
            flush_pending()
            events.append({"rally_index": i, "frame": win["end_frame"], "field": None,
                            "note": "no dead-time reference before this rally — skipped rather than guess"})
            continue
        if after_gap is None and not is_last_rally:
            flush_pending()
            events.append({"rally_index": i, "frame": win["end_frame"], "field": None,
                            "note": "no dead-time reference after this rally — skipped rather than guess"})
            continue

        if before_gap:
            before_idx = gap_reference_frame(before_gap)
            before_window = gap_stable_window(before_gap)
        elif is_first_rally:
            before_idx = min(win["start_frame"] + EDGE_WINDOW_FRAMES, win["end_frame"])
            before_window = (win["start_frame"], before_idx)
        else:
            before_idx = max(1, total_frames - EDGE_WINDOW_FRAMES)
            before_window = (before_idx, total_frames - 1)
        # Last rally, no dead-time gap after it (video just ends) — rather than
        # jumping straight to the very last frame regardless of how much real
        # time that represents past the rally's own end, wait ~10s past the
        # rally's end first (same reasoning as gap_reference_frame: give the
        # scoreboard operator realistic time to update), clamped to whatever
        # footage actually remains. The window itself starts 3s in rather than
        # at the rally's own end frame, skipping the immediate
        # whistle/celebration chaos so the dense scan isn't diluted by frames
        # from before the board is even settled (verified directly on a real
        # clip: this exact edge case — the only rally with no after_gap —
        # came back with a nonsensical negative delta when the window
        # started right at the boundary).
        after_idx = gap_reference_frame(after_gap) if after_gap else min(total_frames, win["end_frame"] + int(fps * 10))
        after_window = gap_stable_window(after_gap) if after_gap else (
            min(total_frames - 1, win["end_frame"] + int(fps * 3)), after_idx)

        before_reps, before_values = cached_reading(before_window)
        after_reps, after_values   = cached_reading(after_window)
        if not before_reps or not after_reps:
            flush_pending()
            events.append({"rally_index": i, "frame": win["end_frame"], "field": None, "note": "board not found at boundary"})
            continue

        # When a dedicated per-digit classifier is available, prefer comparing
        # the actual read values over the image-diff signature. Verified
        # directly against real footage that the signature has two failure
        # modes the value comparison doesn't: it can under-fire on a genuine
        # adjacent-digit change (a real 5->6 produced a diff far below
        # RALLY_DIFF_THRESHOLD), and it can over-fire on a crop that merely
        # flickers between detections without its value ever changing
        # (producing a diff *higher* than the field that actually changed,
        # flipping which field looks like the winner). A same-vs-different
        # value comparison is immune to both.
        scoring_field = None
        scoring_amount = 1
        diffs = {}
        if (led_model is not None and "home_points" in before_values and "home_points" in after_values
                and "guest_points" in before_values and "guest_points" in after_values):
            home_delta = after_values["home_points"] - before_values["home_points"]
            guest_delta = after_values["guest_points"] - before_values["guest_points"]
            diffs = {"home_points": home_delta, "guest_points": guest_delta}
            if home_delta >= 1 and guest_delta == 0:
                scoring_field, scoring_amount = "home_points", home_delta
            elif guest_delta >= 1 and home_delta == 0:
                scoring_field, scoring_amount = "guest_points", guest_delta
            # else: no change, or a noisy/ambiguous read (both changed, or a
            # negative delta) — leave scoring_field unset and fall through to
            # the run-level OCR cross-check in flush_pending. A clean
            # same-team jump bigger than 1 point IS accepted directly above
            # (rather than only ever +1) -- volleyball itself can't award 2
            # points for 1 completed rally, but this rally *window*, as
            # produced upstream, can legitimately span more real points than
            # the classifier drew a boundary for (verified directly: a
            # window covering two genuinely close-together points read a
            # clean, unambiguous +2 for one side here, and used to get
            # thrown away as "inconclusive" for not matching exactly 1,
            # silently losing both real points from the final score).
        else:
            for field in SCORE_CLASSES:
                if field in before_reps and field in after_reps:
                    diffs[field] = signature_diff(after_reps[field], before_reps[field])
            if diffs:
                candidate = max(diffs, key=diffs.get)
                if diffs[candidate] >= RALLY_DIFF_THRESHOLD:
                    scoring_field = candidate

        if not diffs:
            flush_pending()
            events.append({"rally_index": i, "frame": win["end_frame"], "field": None, "note": "no comparable digit regions"})
            continue

        if scoring_field is None:
            # Inconclusive on its own — don't conclude "no change" yet, queue
            # it for the OCR cross-check once this run ends.
            pending.append({"index": i, "win": win, "before_idx": before_idx, "after_idx": after_idx,
                             "before_window": before_window, "after_window": after_window, "diffs": diffs})
            continue

        flush_pending()
        if scoring_field == "home_points":
            home_score += scoring_amount
        else:
            guest_score += scoring_amount
        changes.append({
            "frame": after_idx, "field": scoring_field,
            "from": (home_score if scoring_field == "home_points" else guest_score) - scoring_amount,
            "to": home_score if scoring_field == "home_points" else guest_score,
        })
        events.append({
            "rally_index": i, "frame": after_idx, "field": scoring_field,
            "diffs": diffs, "home_score": home_score, "guest_score": guest_score,
        })

    flush_pending()

    return {
        "fps": fps,
        "mode": "rally_attribution",
        "rally_events": events,
        "final_values": {"home_points": home_score, "guest_points": guest_score},
        "score_changes": changes,
        "ambiguous_groups": ambiguous_groups,
    }


def main():
    args = parse_args()
    fullframe_model = YOLO(args.fullframe_model) if args.fullframe_model else None
    if fullframe_model is None and not (args.board_model and args.digit_model):
        raise RuntimeError("No --fullframe-model given, and no default ships for the older "
                            "two-stage --board-model/--digit-model path anymore — pass "
                            "--fullframe-model, or explicitly pass both --board-model and "
                            "--digit-model to use the two-stage path.")
    board_model = YOLO(args.board_model) if args.board_model else None
    digit_model = YOLO(args.digit_model) if args.digit_model else None
    led_model = YOLO(args.led_model) if args.led_model else None
    reader = easyocr.Reader(["en"], gpu=True, verbose=False)

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {args.video}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30

    if args.rally_windows:
        result = run_rally_attribution(args, board_model, digit_model, reader, cap, fps,
                                        fullframe_model=fullframe_model, led_model=led_model)
        cap.release()
        os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
        with open(args.output, "w") as f:
            json.dump(result, f, indent=2)
        print(f"[SCORE] rally attribution: {len(result['rally_events'])} rallies, "
              f"final values: {result['final_values']} -> {args.output}")
        return

    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0

    writer = None
    if args.output_video:
        os.makedirs(os.path.dirname(os.path.abspath(args.output_video)), exist_ok=True)
        writer = cv2.VideoWriter(args.output_video, cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))

    device_kwargs = {"device": args.device} if args.device is not None else {}
    trackers = {field: FieldTracker() for field in SCORE_CLASSES}

    readings = []
    frame_idx = 0
    boards_found = 0
    print("[SCORE] Processing video...")
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        frame_idx += 1

        if (frame_idx - 1) % args.sample_every == 0:
            reading = {"frame": frame_idx}

            if fullframe_model is not None:
                # New path: detect digit regions directly on the raw frame —
                # no board-locate + crop + upscale needed (see FULLFRAME_MODEL_PATH).
                results = fullframe_model(frame, conf=args.conf, verbose=False, **device_kwargs)[0]
                best_boxes = {}
                for box in results.boxes:
                    cls_name = fullframe_model.names[int(box.cls[0])]
                    if cls_name not in SCORE_CLASSES:
                        continue
                    box_conf = float(box.conf[0])
                    if cls_name in best_boxes and box_conf <= best_boxes[cls_name][1]:
                        continue  # keep only the highest-confidence box per field
                    best_boxes[cls_name] = (box, box_conf)

                if best_boxes:
                    boards_found += 1
                for cls_name, (box, _) in best_boxes.items():
                    x1, y1, x2, y2 = map(int, box.xyxy[0])
                    digit_crop = frame[max(0, y1):y2, max(0, x1):x2]
                    value = read_digits(reader, digit_crop, led_model=led_model)
                    sig = crop_signature(digit_crop)
                    trackers[cls_name].update(frame_idx, value, sig)
                    reading[cls_name] = value

                    if writer is not None:
                        color = (0, 255, 0) if value is not None else (0, 0, 255)
                        cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
                        label = f"{cls_name}={trackers[cls_name].value}"
                        cv2.putText(frame, label, (x1, max(20, y1 - 8)),
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)

            else:
                # Original two-stage path — untouched.
                board_box = locate_board(board_model, frame, args.conf)

                if board_box is not None:
                    boards_found += 1
                    bx1, by1, bx2, by2 = board_box
                    crop = frame[by1:by2, bx1:bx2]
                    big = cv2.resize(crop, None, fx=CROP_UPSCALE, fy=CROP_UPSCALE, interpolation=cv2.INTER_CUBIC)

                    digit_results = digit_model(big, conf=args.conf, verbose=False, **device_kwargs)[0]
                    for box in digit_results.boxes:
                        cls_name = digit_model.names[int(box.cls[0])]
                        if cls_name not in SCORE_CLASSES:
                            continue
                        dx1, dy1, dx2, dy2 = map(int, box.xyxy[0])
                        digit_crop = big[max(0, dy1):dy2, max(0, dx1):dx2]
                        value = read_digits(reader, digit_crop, led_model=led_model)
                        sig = crop_signature(digit_crop)
                        trackers[cls_name].update(frame_idx, value, sig)
                        reading[cls_name] = value

                        if writer is not None:
                            # Map the upscaled-crop box back to original-frame coordinates for drawing.
                            ox1 = bx1 + dx1 // CROP_UPSCALE
                            oy1 = by1 + dy1 // CROP_UPSCALE
                            ox2 = bx1 + dx2 // CROP_UPSCALE
                            oy2 = by1 + dy2 // CROP_UPSCALE
                            color = (0, 255, 0) if value is not None else (0, 0, 255)
                            cv2.rectangle(frame, (ox1, oy1), (ox2, oy2), color, 2)
                            label = f"{cls_name}={trackers[cls_name].value}"
                            cv2.putText(frame, label, (ox1, max(20, oy1 - 8)),
                                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)

                    if writer is not None:
                        cv2.rectangle(frame, (bx1, by1), (bx2, by2), (255, 200, 0), 1)

            if any(k != "frame" for k in reading):
                readings.append(reading)

        if writer is not None:
            writer.write(frame)

        if frame_idx % 100 == 0:
            pct = int(frame_idx / total_frames * 100) if total_frames else 0
            print(f"{pct}%")

    cap.release()
    if writer is not None:
        writer.release()

    changes = sorted(
        (dict(c, field=field) for field, t in trackers.items() for c in t.changes),
        key=lambda c: c["frame"],
    )
    final_values = {field: t.value for field, t in trackers.items() if t.value is not None}

    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    with open(args.output, "w") as f:
        json.dump({
            "fps": fps,
            "readings": readings,
            "final_values": final_values,
            "score_changes": changes,
        }, f, indent=2)
    print(f"[SCORE] board located in {boards_found} sampled frames, "
          f"final values: {final_values}, {len(changes)} confirmed score changes -> {args.output}")


if __name__ == "__main__":
    main()
