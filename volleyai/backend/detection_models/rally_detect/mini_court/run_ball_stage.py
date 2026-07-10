import os
import sys
import json
import argparse

import cv2
from ultralytics import YOLO

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BALL_MODEL_PATH = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "..", "ball_tracking", "ball_model.pt"))

CONF_BALL = 0.35
IMG_SIZE = 640


def parse_args():
    parser = argparse.ArgumentParser(
        description="Ball-only detection stage — writes ball_track.json, consumed by "
                    "merge_pipeline.py (landing/scoring) and render_video.py (mini court)."
    )
    parser.add_argument("--video", required=True, help="Path to input video")
    parser.add_argument("--output", required=True, help="Path to write ball_track.json")
    return parser.parse_args()


def main():
    args = parse_args()

    ball_model = YOLO(BALL_MODEL_PATH)

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {args.video}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0

    ball_track = []
    frame_idx = 0
    last_percent = -1

    print(f"[BALL] Processing {total_frames} frames...")
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        frame_idx += 1

        results = ball_model.predict(frame, conf=CONF_BALL, imgsz=IMG_SIZE, verbose=False)

        best_box, best_conf = None, 0.0
        for r in results:
            if r.boxes is None:
                continue
            for box in r.boxes:
                conf = float(box.conf[0])
                if conf > best_conf:
                    best_conf = conf
                    best_box = box.xyxy[0].cpu().numpy().tolist()

        if best_box is not None:
            x1, y1, x2, y2 = best_box
            cx, cy = (x1 + x2) / 2.0, (y1 + y2) / 2.0
            ball_track.append({
                "frame": frame_idx,
                "x1": round(x1, 1), "y1": round(y1, 1),
                "x2": round(x2, 1), "y2": round(y2, 1),
                "cx": round(cx, 1), "cy": round(cy, 1),
                "conf": round(best_conf, 4),
            })

        if total_frames > 0:
            percent = int(frame_idx / total_frames * 100)
            if percent != last_percent:
                print(f"{percent}%")
                last_percent = percent

    cap.release()

    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    with open(args.output, "w") as f:
        json.dump({"fps": fps, "ball_track": ball_track}, f)
    print(f"[BALL] {len(ball_track)}/{frame_idx} frames with a ball detection -> {args.output}")


if __name__ == "__main__":
    main()
