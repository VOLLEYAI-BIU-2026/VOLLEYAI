import os
import cv2
from ultralytics import YOLO

print("--- Starting Clean Action Test ---")

# 1. Setup Exact Paths
MODEL_PATH = "../TrackNetV2/runs/detect/runs/action_model/train_smoke_test-2/weights/best.pt"
VIDEO_PATH = "../videos/test_clip.mp4"
OUTPUT_PATH = "clean_action_test.mp4"

# 2. Check that files actually exist before we try to use them
if not os.path.exists(MODEL_PATH):
    print(f"[ERROR] Cannot find '{MODEL_PATH}' right next to this script!")
    exit()
if not os.path.exists(VIDEO_PATH):
    print(f"[ERROR] Cannot find the video at '{VIDEO_PATH}'!")
    exit()

# 3. Load the Model
print(f"Loading local brain: {MODEL_PATH}...")
model = YOLO(MODEL_PATH)

# 4. Prepare the Video
cap = cv2.VideoCapture(VIDEO_PATH)
fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
writer = cv2.VideoWriter(OUTPUT_PATH, cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))

frame_idx = 0
print("Processing... (Press Ctrl+C in terminal to stop early)")

# 5. Process Loop
try:
    while True:
        ret, frame = cap.read()
        if not ret:
            break

        frame_idx += 1

        # Run the AI (We set confidence to 0.20 to filter out weak guesses)
        results = model.predict(source=frame, conf=0.20, verbose=False)

        # Magic YOLO function: Automatically draws all boxes and labels for us!
        annotated_frame = results[0].plot()

        writer.write(annotated_frame)

        if frame_idx % 30 == 0:
            print(f"  -> Processed {frame_idx} frames...")

except KeyboardInterrupt:
    print("\nRun stopped early! Saving what we have...")

# 6. Cleanup
cap.release()
writer.release()
print(f"\nDone! Video saved as: {OUTPUT_PATH}")