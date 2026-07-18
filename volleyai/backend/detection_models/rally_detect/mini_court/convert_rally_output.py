import os
import json
import argparse

import pandas as pd


def parse_args():
    parser = argparse.ArgumentParser(
        description="Convert rally_detect's own CSV output (cleaned ball detections + "
                    "per-frame rally predictions) into the ball_track.json / rally_windows.json "
                    "formats merge_pipeline.py and render_video.py already know how to consume."
    )
    parser.add_argument("--cleaned-csv", required=True, help="<base>_cleaned.csv from rally_detect (ball positions)")
    parser.add_argument("--features-csv", required=True, help="<base>_features.csv from rally_detect (frame column, row-aligned with predictions)")
    parser.add_argument("--predictions-csv", required=True, help="<base>_predictions.csv from rally_detect (label column, row-aligned with features)")
    parser.add_argument("--original-fps", type=float, required=True, help="Real fps of the source video (rally_detect internally resamples to <=30fps, this converts back)")
    parser.add_argument("--original-total-frames", type=int, required=True, help="Total frame count of the source video")
    parser.add_argument("--internal-fps", type=float, required=True, help="fps rally_detect actually processed at (30.0 if it downsampled, else same as --original-fps)")
    parser.add_argument("--output-ball-track", required=True)
    parser.add_argument("--output-rally-windows", required=True)
    return parser.parse_args()


def to_original_frame(internal_frame: float, internal_fps: float, original_fps: float) -> int:
    """Convert a frame index from rally_detect's internal (possibly resampled) timeline
    to the original video's frame numbering, via time in seconds — never compare frame
    indices directly across the two timelines, they are not the same unit."""
    time_sec = internal_frame / internal_fps
    return round(time_sec * original_fps)


def build_ball_track(cleaned_csv, internal_fps, original_fps):
    df = pd.read_csv(cleaned_csv)
    ball_track = []
    for row in df.itertuples():
        ball_track.append({
            "frame": to_original_frame(row.frame, internal_fps, original_fps),
            "x1": round(float(row.x1), 1), "y1": round(float(row.y1), 1),
            "x2": round(float(row.x2), 1), "y2": round(float(row.y2), 1),
            "cx": round(float(row.cx), 1), "cy": round(float(row.cy), 1),
            "conf": round(float(row.conf), 4),
        })
    ball_track.sort(key=lambda b: b["frame"])
    return ball_track


# A genuine point break (players resetting, ref whistle, next-serve prep)
# takes several seconds. A gap shorter than this is far more likely the ball
# briefly leaving the camera's view mid-rally (a deep dig, a high set, a block
# going off-screen) confusing the rally/dead-time classifier than an actual
# point being scored. Verified in practice: an unmerged short gap like this
# split one real, continuous rally (that legitimately ended in a block) into
# two fake ones, and whatever resolved the fake boundary in between
# misattributed a point that never actually happened.
MIN_DEAD_TIME_SEC = 2.0


def merge_brief_dead_segments(rally_windows, dead_segments):
    """Fold any dead-time gap shorter than MIN_DEAD_TIME_SEC back into the
    rally on either side of it, so one real rally fragmented by the ball
    briefly leaving frame is treated as the single rally it actually was.

    Never folds a gap that sits next to a `recovered` rally (one carved out
    of dead time by recover_missed_rallies). Verified directly against real
    footage: a genuinely separate, back-to-back point recovered by that
    function was immediately re-absorbed into its neighboring rally here
    (their own gap fell under MIN_DEAD_TIME_SEC), silently erasing the very
    point boundary it had just been recovered to represent — which then
    surfaced downstream as a scoreboard reading a same one-rally +2 point
    jump instead of two separate +1 events, and the OCR cross-check
    correctly refused to trust that jump and gave up entirely, throwing the
    running score off for every rally after it too."""
    combined = sorted(
        [("rally", dict(w)) for w in rally_windows] + [("dead", dict(d)) for d in dead_segments],
        key=lambda kv: kv[1]["start_frame"],
    )

    fold = [False] * len(combined)
    for i, (kind, entry) in enumerate(combined):
        if kind != "dead" or (entry["end_sec"] - entry["start_sec"]) >= MIN_DEAD_TIME_SEC:
            continue
        prev_rally = combined[i - 1] if i > 0 and combined[i - 1][0] == "rally" else None
        next_rally = combined[i + 1] if i + 1 < len(combined) and combined[i + 1][0] == "rally" else None
        if prev_rally is None or next_rally is None:
            continue
        if prev_rally[1].get("recovered") or next_rally[1].get("recovered"):
            continue
        fold[i] = True

    merged = []
    for i, (kind, entry) in enumerate(combined):
        if kind == "dead" and fold[i]:
            # Fold this short gap away — extend the preceding rally through it.
            merged[-1] = ("rally", {**merged[-1][1], "end_frame": entry["end_frame"], "end_sec": entry["end_sec"]})
        elif kind == "rally" and i > 0 and fold[i - 1]:
            # The dead segment right before this one just got folded away
            # above, so this rally is a continuation of the same real one.
            merged[-1] = ("rally", {**merged[-1][1], "end_frame": entry["end_frame"], "end_sec": entry["end_sec"]})
        else:
            merged.append((kind, entry))

    new_rally_windows = [e for k, e in merged if k == "rally"]
    new_dead_segments  = [e for k, e in merged if k == "dead"]
    return new_rally_windows, new_dead_segments


# The rally/dead-time classifier is a trained model and can occasionally miss
# a real point entirely, calling it dead time — verified directly against real
# footage: a ~6 second segment the classifier called dead time actually
# contained continuous, wide-ranging ball flight (cx traveling from 691 to
# 1319 and back), an unmistakable real rally, while genuine dead time in the
# same clip (a player bouncing the ball before serving) kept the ball within
# a ~45px range the whole time. A segment the model calls dead time never
# legitimately contains that kind of sustained, far-traveling ball movement,
# so this is a reliable way to catch what the classifier missed.
MISSED_RALLY_MIN_RANGE_PX     = 300   # ball must travel at least this far (x or y) to count as real play
MISSED_RALLY_MIN_DURATION_SEC = 1.5   # sustained for at least this long
MISSED_RALLY_MAX_GAP_FRAMES   = 20    # detections spaced further apart than this aren't the same continuous run
MISSED_RALLY_PADDING_SEC      = 0.5   # small buffer added around the recovered window

# Ball movement alone isn't specific enough -- verified directly against real
# footage that a ball being retrieved/tossed back to the server after a point
# already ended can ALSO show sustained, wide-ranging movement (a person
# carrying or rolling it a real distance), and got wrongly recovered as its
# own "rally": the frames showed players in a post-point huddle/celebration
# and casual walking, not active play. A genuine rally has real, confident
# action-classifier hits (attack/block/serve/dig); that same false-positive
# window had only 4 weak "defense-move" hits maxing out at 0.29 confidence,
# while an undisputed real rally of similar length had 58 hits up to 0.66.
# Requiring both signals together (ball movement AND real action activity)
# is far more specific than either alone.
MISSED_RALLY_MIN_ACTIONS       = 8     # minimum action-detector hits inside the candidate window
MISSED_RALLY_MIN_ACTION_CONF   = 0.35  # at least one hit must clear this confidence


def recover_missed_rallies(rally_windows, dead_segments, ball_track, fps, action_detections=None):
    """Cross-checks each dead-time segment against the ball-tracking data. A
    segment with a sustained, wide-ranging burst of ball movement inside it is
    a *candidate* real rally the classifier missed — but ball movement alone
    can also be a ball retrieval/toss between points, so it's only accepted
    once corroborated by real action-classifier activity inside the same
    window (see MISSED_RALLY_MIN_ACTIONS above). Confirmed candidates get
    carved out into their own rally window (padded slightly), splitting the
    dead segment around it."""
    if not ball_track or not dead_segments:
        return rally_windows, dead_segments
    action_detections = action_detections or []

    # Mutated in place below when a candidate run turns out to overlap an
    # existing rally rather than being genuinely separate from it.
    rally_windows = [dict(w) for w in rally_windows]

    def rally_before(frame_idx):
        candidates = [w for w in rally_windows if w["end_frame"] <= frame_idx]
        return max(candidates, key=lambda w: w["end_frame"]) if candidates else None

    def rally_after(frame_idx):
        candidates = [w for w in rally_windows if w["start_frame"] >= frame_idx]
        return min(candidates, key=lambda w: w["start_frame"]) if candidates else None

    padding = int(fps * MISSED_RALLY_PADDING_SEC)
    # A real rally's ball flight can start or end right at a dead-segment
    # boundary rather than cleanly inside it -- verified directly: a genuine
    # missed rally's continuous flight measured 960+px overall, but the slice
    # strictly inside its dead segment (the ball had already been flying for
    # several frames before the segment's official start) measured only
    # 254px, just under MISSED_RALLY_MIN_RANGE_PX. Look slightly past each
    # segment's own boundary when collecting points so a trajectory that
    # straddles the boundary isn't undercounted -- the eventual recovered
    # rally is still clamped to the segment's own bounds either way (see
    # rally_start/rally_end below), so this only affects candidacy detection.
    lookup_buffer = int(fps * 1.0)
    recovered = []
    new_dead_segments = []
    changed_anything = False

    for seg in dead_segments:
        pts = sorted((b for b in ball_track
                      if seg["start_frame"] - lookup_buffer <= b["frame"] <= seg["end_frame"] + lookup_buffer),
                     key=lambda b: b["frame"])

        runs, run = [], []
        for p in pts:
            if run and p["frame"] - run[-1]["frame"] > MISSED_RALLY_MAX_GAP_FRAMES:
                runs.append(run)
                run = []
            run.append(p)
        if run:
            runs.append(run)

        leftover_start = seg["start_frame"]
        found_any = False
        for run in runs:
            if len(run) < 2:
                continue
            duration = (run[-1]["frame"] - run[0]["frame"]) / fps
            x_range = max(p["cx"] for p in run) - min(p["cx"] for p in run)
            y_range = max(p["cy"] for p in run) - min(p["cy"] for p in run)
            if duration < MISSED_RALLY_MIN_DURATION_SEC or max(x_range, y_range) < MISSED_RALLY_MIN_RANGE_PX:
                continue

            # Same boundary-straddling issue as the ball-movement lookup above
            # applies here too -- verified directly: the real service/block
            # actions that open a rally can land just before the ball-flight
            # run's own detected start, and got excluded by an exact-bounds
            # check the same way.
            window_actions = [a for a in action_detections
                               if run[0]["frame"] - lookup_buffer <= a["frame"] <= run[-1]["frame"] + lookup_buffer]
            if (len(window_actions) < MISSED_RALLY_MIN_ACTIONS or
                    max((a["conf"] for a in window_actions), default=0.0) < MISSED_RALLY_MIN_ACTION_CONF):
                continue

            run_start, run_end = run[0]["frame"], run[-1]["frame"]
            rally_start = max(seg["start_frame"], run_start - padding)
            rally_end   = min(seg["end_frame"], run_end + padding)

            # This run's real activity actually began before this dead-time
            # gap even started (or continues past where the next rally
            # already starts) -- that's not a separate missed rally, it's
            # the tail/lead-in of the rally next to this gap, whose own
            # boundary the base classifier just drew a little short. Extend
            # that rally instead of carving out an artificial new one glued
            # right up against it. Verified directly against real footage:
            # treating it as its own window broke the scoreboard reader's
            # one-point-per-rally assumption -- a single real point got
            # double-counted once as each fragment reached its own boundary,
            # since the reader has no way to know the two fragments were
            # never really separate.
            prev_rally = rally_before(seg["start_frame"])
            if prev_rally is not None and run_start <= prev_rally["end_frame"]:
                found_any = True
                changed_anything = True
                prev_rally["end_frame"] = rally_end
                prev_rally["end_sec"] = round(rally_end / fps, 3)
                leftover_start = rally_end
                continue
            next_rally = rally_after(seg["end_frame"])
            if next_rally is not None and run_end >= next_rally["start_frame"]:
                found_any = True
                changed_anything = True
                # Unlike the prev_rally case above, the stretch from this
                # segment's own start up to rally_start is still genuine
                # dead time -- only rally_start onward is being absorbed
                # into next_rally -- so it needs its own leftover entry
                # instead of being silently dropped.
                if rally_start > leftover_start:
                    new_dead_segments.append({
                        "start_frame": leftover_start, "end_frame": rally_start,
                        "start_sec": round(leftover_start / fps, 3), "end_sec": round(rally_start / fps, 3),
                    })
                next_rally["start_frame"] = rally_start
                next_rally["start_sec"] = round(rally_start / fps, 3)
                leftover_start = rally_end
                continue

            found_any = True
            changed_anything = True
            if rally_start > leftover_start:
                new_dead_segments.append({
                    "start_frame": leftover_start, "end_frame": rally_start,
                    "start_sec": round(leftover_start / fps, 3), "end_sec": round(rally_start / fps, 3),
                })
            recovered.append({
                "start_frame": rally_start, "end_frame": rally_end,
                "start_sec": round(rally_start / fps, 3), "end_sec": round(rally_end / fps, 3),
                "recovered": True,
            })
            leftover_start = rally_end

        if not found_any:
            new_dead_segments.append(seg)
        elif leftover_start < seg["end_frame"]:
            new_dead_segments.append({
                "start_frame": leftover_start, "end_frame": seg["end_frame"],
                "start_sec": round(leftover_start / fps, 3), "end_sec": round(seg["end_frame"] / fps, 3),
            })

    if not changed_anything:
        return rally_windows, dead_segments

    if recovered:
        print(f"[CONVERT] recovered {len(recovered)} rally window(s) the classifier had called dead time")
    all_rallies = sorted(rally_windows + recovered, key=lambda w: w["start_frame"])
    all_dead    = sorted(new_dead_segments, key=lambda d: d["start_frame"])
    return all_rallies, all_dead


def build_rally_windows(features_csv, predictions_csv, internal_fps, original_fps, total_frames, ball_track=None,
                         action_detections=None):
    feat = pd.read_csv(features_csv)
    pred = pd.read_csv(predictions_csv)
    if len(feat) != len(pred):
        raise ValueError(f"features.csv ({len(feat)} rows) and predictions.csv ({len(pred)} rows) "
                          f"are not row-aligned — cannot map labels to frames safely.")

    labels = pred["label"].to_numpy()
    frames = feat["frame"].to_numpy()

    # Group consecutive rows with the same label into one run — this is the same
    # run-length-encoding approach used elsewhere in this pipeline (the action
    # merge logic), applied here to a binary rally/dead-time signal instead.
    rally_windows, dead_segments = [], []
    run_start_idx = 0
    for i in range(1, len(labels) + 1):
        if i == len(labels) or labels[i] != labels[run_start_idx]:
            start_of = to_original_frame(frames[run_start_idx], internal_fps, original_fps)
            end_of = to_original_frame(frames[i - 1], internal_fps, original_fps)
            entry = {
                "start_frame": start_of, "end_frame": end_of,
                "start_sec": round(start_of / original_fps, 3),
                "end_sec": round(end_of / original_fps, 3),
            }
            (rally_windows if labels[run_start_idx] == 1 else dead_segments).append(entry)
            run_start_idx = i

    rally_windows, dead_segments = merge_brief_dead_segments(rally_windows, dead_segments)
    rally_windows, dead_segments = recover_missed_rallies(rally_windows, dead_segments, ball_track, original_fps,
                                                           action_detections=action_detections)
    # Recovery can leave a short leftover dead fragment right next to a
    # recovered rally (or next to the rally it was carved out of) — same
    # merge pass as above, just re-run now that the windows have changed.
    rally_windows, dead_segments = merge_brief_dead_segments(rally_windows, dead_segments)

    stats = {
        "Total Rallies": len(rally_windows),
        "Total Playtime (s)": round(sum(w["end_sec"] - w["start_sec"] for w in rally_windows), 2),
    }
    return rally_windows, dead_segments, stats


def main():
    args = parse_args()

    ball_track = build_ball_track(args.cleaned_csv, args.internal_fps, args.original_fps)
    rally_windows, dead_segments, stats = build_rally_windows(
        args.features_csv, args.predictions_csv, args.internal_fps, args.original_fps, args.original_total_frames,
        ball_track=ball_track,
    )

    os.makedirs(os.path.dirname(os.path.abspath(args.output_ball_track)), exist_ok=True)
    with open(args.output_ball_track, "w") as f:
        json.dump({"fps": args.original_fps, "ball_track": ball_track}, f)
    print(f"[CONVERT] {len(ball_track)} ball positions -> {args.output_ball_track}")

    os.makedirs(os.path.dirname(os.path.abspath(args.output_rally_windows)), exist_ok=True)
    with open(args.output_rally_windows, "w") as f:
        json.dump({
            "fps": args.original_fps,
            "total_frames": args.original_total_frames,
            "rally_windows": rally_windows,
            "dead_segments": dead_segments,
            "stats": stats,
        }, f, indent=2)
    print(f"[CONVERT] {len(rally_windows)} rally windows, {len(dead_segments)} dead segments -> {args.output_rally_windows}")


if __name__ == "__main__":
    main()
