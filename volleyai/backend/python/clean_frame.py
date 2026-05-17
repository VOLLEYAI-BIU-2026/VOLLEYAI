import argparse
import os
import cv2
import numpy as np

def person_area(model, frame):
    h, w = frame.shape[:2]
    results = model.predict(frame, verbose=False)
    r = results[0]

    if r.masks is None or r.boxes is None:
        return 0

    cls = r.boxes.cls.cpu().numpy().astype(int)
    masks = r.masks.data.cpu().numpy()

    union = np.zeros((h, w), dtype=np.uint8)

    for i in range(len(cls)):
        if cls[i] != 0:
            continue
        m = (masks[i] > 0.5).astype(np.uint8) * 255
        if m.shape[0] != h or m.shape[1] != w:
            m = cv2.resize(m, (w, h), interpolation=cv2.INTER_NEAREST)
        union = cv2.bitwise_or(union, m)

    return int(np.count_nonzero(union))

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--start", type=float, default=2.0)
    parser.add_argument("--end", type=float, default=15.0)
    parser.add_argument("--step", type=float, default=1.0)
    args = parser.parse_args()

    from ultralytics import YOLO

    if not os.path.exists(args.input):
        raise FileNotFoundError(args.input)

    model = YOLO("yolov8n-seg.pt")

    cap = cv2.VideoCapture(args.input)
    if not cap.isOpened():
        raise RuntimeError("Cannot open input video")

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)

    start_sec = max(0.0, args.start)
    end_sec = max(start_sec, args.end)
    step_sec = max(0.2, args.step)

    best_score = None
    best_frame = None

    t = start_sec
    while t <= end_sec + 1e-9:
        frame_idx = int(t * fps)
        if total > 0 and (frame_idx < 0 or frame_idx >= total):
            t += step_sec
            continue

        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
        ret, frame = cap.read()
        if not ret:
            t += step_sec
            continue

        score = person_area(model, frame)

        if best_score is None or score < best_score:
            best_score = score
            best_frame = frame

        if best_score == 0:
            break

        t += step_sec

    if best_frame is None:
        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
        ret, best_frame = cap.read()
        if not ret:
            raise RuntimeError("Cannot read any frame")

    ok = cv2.imwrite(args.output, best_frame)
    if not ok:
        raise RuntimeError("Failed to write output image")

    cap.release()

if __name__ == "__main__":
    main()