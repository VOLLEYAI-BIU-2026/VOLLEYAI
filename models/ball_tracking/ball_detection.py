import os
import cv2
from ultralytics import YOLO

# --- PATHS ---
# Assuming you run this from inside: ~/Project/models/ball_tracking/
VIDEO_PATH = "../videos/test_clip.mp4" # Update to "../test_clip.mp4" if you didn't make a videos folder
BALL_MODEL_PATH = "ball_model.pt"
OUTPUT_VIDEO = "ball_only_test.mp4"
# -------------

CONF_BALL = 0.35
IMG_SIZE = 640

print(f"Loading ball model from {BALL_MODEL_PATH}...")
try:
    model = YOLO(BALL_MODEL_PATH)
except FileNotFoundError:
    print(f"\n[ERROR] Could not find {BALL_MODEL_PATH}.")
    print("Make sure you are running this script from inside the 'ball_tracking' folder!")
    exit()

cap = cv2.VideoCapture(VIDEO_PATH)
if not cap.isOpened():
    raise RuntimeError(f"Cannot open video: {VIDEO_PATH}")

fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

writer = cv2.VideoWriter(OUTPUT_VIDEO, cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))

frame_idx = 0

print(f"Processing video... Press Ctrl+C to stop early.")
try:
    while True:
        ret, frame = cap.read()
        if not ret:
            break

        frame_idx += 1

        # 1. Detect Ball
        results = model.predict(source=frame, conf=CONF_BALL, imgsz=IMG_SIZE, verbose=False)
        
        ball_box = None
        best_ball_conf = 0.0

        # Extract the highest-confidence detection
        for r in results:
            if r.boxes is not None:
                for box in r.boxes:
                    conf = float(box.conf[0])
                    if conf > best_ball_conf:
                        best_ball_conf = conf
                        ball_box = box.xyxy[0].cpu().numpy().tolist()

        # 2. Draw the Bounding Box
        if ball_box is not None:
            x1, y1, x2, y2 = map(int, ball_box)
            cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 255), 2) # Yellow Box
            cv2.putText(frame, f"BALL {best_ball_conf:.2f}", (x1, max(20, y1 - 10)), 
                        cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 255), 2)

        # 3. Add Frame Counter & Write
        cv2.putText(frame, f"Frame {frame_idx}", (20, 32), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
        writer.write(frame)

        # Keep terminal clean by updating every 30 frames
        if frame_idx % 30 == 0:
            print(f"  -> Processed {frame_idx} frames...")

except KeyboardInterrupt:
    print("\nRun stopped early! Saving progress gracefully...")

# --- CLEANUP ---
cap.release()
writer.release()
print(f"\nDone! Video saved to: {OUTPUT_VIDEO}")