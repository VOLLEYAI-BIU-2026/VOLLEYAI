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
    briefly leaving frame is treated as the single rally it actually was."""
    combined = sorted(
        [("rally", dict(w)) for w in rally_windows] + [("dead", dict(d)) for d in dead_segments],
        key=lambda kv: kv[1]["start_frame"],
    )

    merged = []
    for kind, entry in combined:
        prev_is_rally = merged and merged[-1][0] == "rally"
        if kind == "dead" and (entry["end_sec"] - entry["start_sec"]) < MIN_DEAD_TIME_SEC and prev_is_rally:
            # Fold this short gap away — extend the preceding rally through it.
            merged[-1] = ("rally", {**merged[-1][1], "end_frame": entry["end_frame"], "end_sec": entry["end_sec"]})
        elif kind == "rally" and prev_is_rally:
            # The dead segment right before this one just got folded away
            # above, so this rally is a continuation of the same real one.
            merged[-1] = ("rally", {**merged[-1][1], "end_frame": entry["end_frame"], "end_sec": entry["end_sec"]})
        else:
            merged.append((kind, entry))

    new_rally_windows = [e for k, e in merged if k == "rally"]
    new_dead_segments  = [e for k, e in merged if k == "dead"]
    return new_rally_windows, new_dead_segments


def build_rally_windows(features_csv, predictions_csv, internal_fps, original_fps, total_frames):
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

    stats = {
        "Total Rallies": len(rally_windows),
        "Total Playtime (s)": round(sum(w["end_sec"] - w["start_sec"] for w in rally_windows), 2),
    }
    return rally_windows, dead_segments, stats


def main():
    args = parse_args()

    ball_track = build_ball_track(args.cleaned_csv, args.internal_fps, args.original_fps)
    rally_windows, dead_segments, stats = build_rally_windows(
        args.features_csv, args.predictions_csv, args.internal_fps, args.original_fps, args.original_total_frames
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
