import os
import sys
import json
import argparse
import subprocess

import cv2

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
RALLY_DETECT_DIR = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))

if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)
from convert_rally_output import build_ball_track, build_rally_windows

# Mirrors rally_detect's own ensure_30fps() threshold exactly (src/utils/manipulate_video.py)
# — we need to know precisely what internal fps IT used, not guess, since the frame-index
# conversion in convert_rally_output.py depends on this being exactly right.
RALLY_DETECT_FPS_CAP = 30.0
RALLY_DETECT_RESAMPLE_THRESHOLD = 30.5


def parse_args():
    parser = argparse.ArgumentParser(
        description="Runs rally_detect's own pipeline (ball detection through rally prediction, "
                    "video-render stage skipped) as a subprocess, then converts its CSV output "
                    "into ball_track.json / rally_windows.json for the rest of this pipeline."
    )
    parser.add_argument("--video", required=True, help="Path to input video")
    parser.add_argument("--output-ball-track", required=True)
    parser.add_argument("--output-rally-windows", required=True)
    parser.add_argument("--work-dir", default=None, help="Scratch dir for rally_detect's own CSV output (default: alongside --output-ball-track)")
    parser.add_argument("--device", default="cpu", help="cpu or cuda — passed through to rally_detect")
    return parser.parse_args()


def main():
    args = parse_args()

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {args.video}")
    original_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    original_total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
    cap.release()

    internal_fps = RALLY_DETECT_FPS_CAP if original_fps > RALLY_DETECT_RESAMPLE_THRESHOLD else original_fps

    work_dir = args.work_dir or os.path.join(os.path.dirname(os.path.abspath(args.output_ball_track)), "rally_detect_work")
    os.makedirs(work_dir, exist_ok=True)

    print(f"[RALLY] Running rally_detect pipeline (device={args.device}, "
          f"original_fps={original_fps:.2f} -> internal_fps={internal_fps:.2f})...")
    subprocess.run(
        [
            "uv", "run", "main.py",
            "--video_path", os.path.abspath(args.video),
            "--output_dir", os.path.abspath(work_dir),
            "--device", args.device,
            "--stop_at", "prediction",
            "--keep_all",
        ],
        cwd=RALLY_DETECT_DIR,
        check=True,
    )

    base_name = os.path.basename(args.video).rsplit(".", 1)[0]
    table_dir = os.path.join(work_dir, "table_data")
    cleaned_csv = os.path.join(table_dir, f"{base_name}_cleaned.csv")
    features_csv = os.path.join(table_dir, f"{base_name}_features.csv")
    predictions_csv = os.path.join(table_dir, f"{base_name}_predictions.csv")
    for p in (cleaned_csv, features_csv, predictions_csv):
        if not os.path.exists(p):
            raise RuntimeError(f"Expected rally_detect output missing: {p}")

    ball_track = build_ball_track(cleaned_csv, internal_fps, original_fps)
    rally_windows, dead_segments, stats = build_rally_windows(
        features_csv, predictions_csv, internal_fps, original_fps, original_total_frames
    )

    os.makedirs(os.path.dirname(os.path.abspath(args.output_ball_track)), exist_ok=True)
    with open(args.output_ball_track, "w") as f:
        json.dump({"fps": original_fps, "ball_track": ball_track}, f)
    os.makedirs(os.path.dirname(os.path.abspath(args.output_rally_windows)), exist_ok=True)
    with open(args.output_rally_windows, "w") as f:
        json.dump({
            "fps": original_fps,
            "total_frames": original_total_frames,
            "rally_windows": rally_windows,
            "dead_segments": dead_segments,
            "stats": stats,
        }, f, indent=2)

    print(f"[RALLY] {len(ball_track)} ball positions -> {args.output_ball_track}")
    print(f"[RALLY] {len(rally_windows)} rally windows, {len(dead_segments)} dead segments -> {args.output_rally_windows}")
    print(f"[RALLY] stats: {stats}")


if __name__ == "__main__":
    main()
