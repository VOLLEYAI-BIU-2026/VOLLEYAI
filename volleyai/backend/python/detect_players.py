import os
import json
import cv2
import argparse
from ultralytics import YOLO
import numpy as np


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output_json", required=True)
    parser.add_argument("--thumbs_dir", required=True)
    parser.add_argument("--video_id", required=True)
    return parser.parse_args()


def expand_box(x1, y1, x2, y2, frame_w, frame_h):
    box_w = x2 - x1
    box_h = y2 - y1

    # הרחבה כדי לראות את כל השחקנית יותר מרחוק
    pad_x = int(box_w * 0.35)
    pad_top = int(box_h * 0.30)
    pad_bottom = int(box_h * 0.18)

    nx1 = max(0, x1 - pad_x)
    ny1 = max(0, y1 - pad_top)
    nx2 = min(frame_w, x2 + pad_x)
    ny2 = min(frame_h, y2 + pad_bottom)

    return nx1, ny1, nx2, ny2


def to_canvas(image, out_w=260, out_h=360):
    h, w = image.shape[:2]
    if h == 0 or w == 0:
        return image

    scale = min(out_w / w, out_h / h)
    new_w = max(1, int(w * scale))
    new_h = max(1, int(h * scale))

    resized = cv2.resize(image, (new_w, new_h), interpolation=cv2.INTER_CUBIC)

    canvas = 220 * np.ones((out_h, out_w, 3), dtype=np.uint8)

    x_offset = (out_w - new_w) // 2
    y_offset = (out_h - new_h) // 2

    canvas[y_offset:y_offset + new_h, x_offset:x_offset + new_w] = resized
    return canvas


def main():
    import numpy as np

    args = parse_args()

    os.makedirs(args.thumbs_dir, exist_ok=True)

    model = YOLO("yolov8n.pt")

    cap = cv2.VideoCapture(args.input)
    if not cap.isOpened():
        raise RuntimeError("Cannot open video")

    fps = cap.get(cv2.CAP_PROP_FPS) or 25
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)

    max_seconds_to_scan = 40
    every_n_frames = max(int(fps * 2), 1)
    max_frame_idx = min(frame_count, int(fps * max_seconds_to_scan))
    max_detections = 60

    detections = []
    frame_idx = 0
    detection_counter = 0

    while True:
        ok, frame = cap.read()
        if not ok:
            break

        if frame_idx > max_frame_idx:
            break

        if detection_counter >= max_detections:
            break

        if frame_idx % every_n_frames != 0:
            frame_idx += 1
            continue

        results = model(frame, classes=[0], verbose=False)

        for r in results:
            boxes = r.boxes
            if boxes is None:
                continue

            for b in boxes:
                conf = float(b.conf[0].item())
                if conf < 0.45:
                    continue

                x1, y1, x2, y2 = map(int, b.xyxy[0].tolist())

                frame_h, frame_w = frame.shape[:2]
                x1, y1, x2, y2 = expand_box(x1, y1, x2, y2, frame_w, frame_h)

                if x2 <= x1 or y2 <= y1:
                    continue

                person_crop = frame[y1:y2, x1:x2]
                if person_crop.size == 0:
                    continue

                # מכניסים לקנבס כדי שהתמונה תיראה מלאה ולא חתוכה
                person_crop = to_canvas(person_crop, out_w=260, out_h=360)

                detection_counter += 1

                detection_id = f"det_{detection_counter}"
                thumb_name = f"{detection_id}_{frame_idx}.jpg"
                thumb_abs = os.path.join(args.thumbs_dir, thumb_name)
                thumb_rel = f"/uploads/player_thumbs_{args.video_id}/{thumb_name}"

                cv2.imwrite(thumb_abs, person_crop)

                detections.append({
                    "detectionId": detection_id,
                    "imageUrl": thumb_rel,
                    "frameTime": round(frame_idx / fps, 2),
                    "confidence": conf,
                    "assignedPlayerId": None
                })

                if detection_counter >= max_detections:
                    break

            if detection_counter >= max_detections:
                break

        frame_idx += 1

    cap.release()

    with open(args.output_json, "w", encoding="utf-8") as f:
        json.dump({"detections": detections}, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()