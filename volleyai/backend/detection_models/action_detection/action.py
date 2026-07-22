import os
import json
import argparse
from ultralytics import YOLO
import cv2

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_MODEL_PATH = os.path.join(SCRIPT_DIR, "best_volleyVision_finetune.pt")

CONF_ACTION = 0.36
IMG_SIZE = 640
ACTION_CLASSES = [0, 1, 3, 4, 5]  # excludes class 2 (ball)

# Model's actual class names (checked directly against the .pt file's metadata):
# 0=Defense-Move, 1=attack, 2=ball, 3=block, 4=service, 5=setting
ACTION_COLORS = {
    "attack":       (0, 0, 255),     # red
    "block":        (255, 0, 255),   # magenta
    "service":      (0, 165, 255),   # orange
    "setting":      (0, 255, 255),   # yellow
    "defense-move": (0, 128, 255),   # light orange
}
DEFAULT_COLOR = (200, 200, 200)


def parse_args():
    parser = argparse.ArgumentParser(description="Standalone action-detection stage")
    parser.add_argument("--video", required=True, help="Path to input video")
    parser.add_argument("--output", required=True, help="Path to write action_detections.json")
    parser.add_argument("--output-video", default=None, help="Optional path to write an annotated video (boxes + labels)")
    parser.add_argument("--model", default=DEFAULT_MODEL_PATH, help="Path to action YOLO weights")
    parser.add_argument("--conf", type=float, default=CONF_ACTION)
    parser.add_argument("--device", default=None, help="cpu, cuda, cuda:0, etc.")
    return parser.parse_args()


def main():
    args = parse_args()

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {args.video}")
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
    fps          = cap.get(cv2.CAP_PROP_FPS) or 30
    frame_w      = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    frame_h      = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    cap.release()

    writer = None
    if args.output_video:
        os.makedirs(os.path.dirname(os.path.abspath(args.output_video)), exist_ok=True)
        writer = cv2.VideoWriter(args.output_video, cv2.VideoWriter_fourcc(*'mp4v'),
                                 fps, (frame_w, frame_h))

    print(f"[ACTION] Loading model: {args.model}")
    model = YOLO(args.model)

    print(f"[ACTION] Analyzing {args.video} ({total_frames} frames)...")

    predict_kwargs = {
        "source": args.video,
        "conf": args.conf,
        "imgsz": IMG_SIZE,
        "classes": ACTION_CLASSES,
        "stream": True,
        "verbose": False,
    }
    if args.device:
        predict_kwargs["device"] = args.device

    results = model.predict(**predict_kwargs)

    detections = []
    frame_idx = 0
    last_percent = -1

    for result in results:
        frame_idx += 1
        frame = result.orig_img.copy() if writer is not None else None

        if result.boxes is not None:
            for box in result.boxes:
                cls_id = int(box.cls[0])
                cls_name = result.names[cls_id].lower()
                if "player" in cls_name or "ball" in cls_name:
                    continue
                x1, y1, x2, y2 = map(int, box.xyxy[0].cpu().numpy().tolist())
                conf = float(box.conf[0])
                detections.append({
                    "frame": frame_idx,
                    "action": cls_name,
                    "conf": round(conf, 4),
                    "x1": x1, "y1": y1, "x2": x2, "y2": y2,
                })

                if frame is not None:
                    color = ACTION_COLORS.get(cls_name, DEFAULT_COLOR)
                    cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
                    label = f"{cls_name} {conf:.2f}"
                    cv2.putText(frame, label, (x1, max(20, y1 - 8)),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)

        if frame is not None:
            cv2.putText(frame, f"Frame {frame_idx}", (20, 32),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
            writer.write(frame)

        if total_frames > 0:
            percent = int((frame_idx / total_frames) * 100)
            if percent != last_percent:
                print(f"[ACTION] {percent}%")
                last_percent = percent

    if writer is not None:
        writer.release()
        print(f"[ACTION] Annotated video saved -> {args.output_video}")

    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    with open(args.output, "w") as f:
        json.dump({"frames_analyzed": frame_idx, "detections": detections}, f, indent=2)

    print(f"[ACTION] Done. {len(detections)} detections across {frame_idx} frames -> {args.output}")


if __name__ == "__main__":
    main()
