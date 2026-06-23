import os
import cv2
import csv
from ultralytics import YOLO

# --- CONFIGURATION ---
# Target video input path updated
VIDEO_PATH = "/home/jesicemal/project/VOLLEYAI/models/videos/test_clip.mp4"

# Using local yolo11s.pt model file in the same folder as this script
# Use the exact absolute paths so YOLO doesn't check online repositories
PLAYERS_MODEL_PATH = "/home/jesicemal/project/VOLLEYAI/models/player_detection/yolo11s.pt" 
BALL_MODEL_PATH = "/home/jesicemal/project/VOLLEYAI/models/ball_tracking/ball_model.pt"

# Output folder updated to your requested directory
OUTPUT_DIR = "/home/jesicemal/project/VOLLEYAI/models/player_detection/runs"
OUTPUT_VIDEO = os.path.join(OUTPUT_DIR, "detected_players.mp4")
OUTPUT_CSV = os.path.join(OUTPUT_DIR, "detected_players.csv")

CONF_PLAYERS = 0.35
IMG_SIZE = 640

MIN_BOX_AREA = 2500
MAX_PLAYERS_PER_FRAME = 20

# Creates the player_detection folder automatically if it doesn't exist yet
os.makedirs(OUTPUT_DIR, exist_ok=True)

# Load only the player tracking model
players_model = YOLO(PLAYERS_MODEL_PATH)


def filter_player_boxes(frame, boxes_obj):
    h_img, w_img = frame.shape[:2]
    filtered = []

    if boxes_obj is None or len(boxes_obj) == 0:
        return filtered

    boxes_xyxy = boxes_obj.xyxy.cpu().numpy()
    clss = boxes_obj.cls.cpu().numpy()

    ids = None
    if boxes_obj.id is not None:
        ids = boxes_obj.id.cpu().numpy()

    confs = None
    if boxes_obj.conf is not None:
        confs = boxes_obj.conf.cpu().numpy()

    for i, box in enumerate(boxes_xyxy):
        x1, y1, x2, y2 = map(int, box[:4])
        cls_id = int(clss[i])

        # Class 0 is 'person' in YOLO
        if cls_id != 0:
            continue

        x1 = max(0, x1)
        y1 = max(0, y1)
        x2 = min(w_img - 1, x2)
        y2 = min(h_img - 1, y2)

        box_w = x2 - x1
        box_h = y2 - y1
        area = box_w * box_h

        if area < MIN_BOX_AREA:
            continue
        if box_w <= 0 or box_h <= 0:
            continue

        aspect_ratio = box_h / max(box_w, 1)
        if aspect_ratio > 4.2:
            continue
        if box_w < 18:
            continue
        if y2 < int(0.18 * h_img):
            continue

        filtered.append({
            "x1": x1,
            "y1": y1,
            "x2": x2,
            "y2": y2,
            "conf": float(confs[i]) if confs is not None else 0.0,
            "id": int(ids[i]) if ids is not None else -1,
        })

    filtered.sort(key=lambda b: b["conf"], reverse=True)
    return filtered[:MAX_PLAYERS_PER_FRAME]


# --- VIDEO TRACKING ---
cap = cv2.VideoCapture(VIDEO_PATH)

if not cap.isOpened():
    raise RuntimeError(f"Cannot open video: {VIDEO_PATH}")

fps = cap.get(cv2.CAP_PROP_FPS)
if fps <= 0:
    fps = 30.0

w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

writer = cv2.VideoWriter(
    OUTPUT_VIDEO,
    cv2.VideoWriter_fourcc(*"mp4v"),
    fps,
    (w, h)
)

if not writer.isOpened():
    cap.release()
    raise RuntimeError(f"Cannot create output video: {OUTPUT_VIDEO}")

csv_file = open(OUTPUT_CSV, "w", newline="", encoding="utf-8")
csv_writer = csv.writer(csv_file)

csv_writer.writerow([
    "frame",
    "player_id",
    "x1",
    "y1",
    "x2",
    "y2",
    "confidence"
])

frame_idx = 0

while True:
    ret, frame = cap.read()
    if not ret:
        break

    frame_idx += 1

    # Player Tracking
    player_results = players_model.track(
        source=frame,
        classes=[0],
        conf=CONF_PLAYERS,
        imgsz=IMG_SIZE,
        max_det=20,
        tracker="bytetrack.yaml",
        persist=True,
        verbose=False
    )

    players = []

    if player_results and len(player_results) > 0:
        filtered_players = filter_player_boxes(frame, player_results[0].boxes)

        for p in filtered_players:
            players.append({
                "id": p["id"],
                "box": [p["x1"], p["y1"], p["x2"], p["y2"]],
                "conf": p["conf"]
            })

    # Log players and draw boxes
    for p in players:
        x1, y1, x2, y2 = map(int, p["box"])

        # Write to CSV
        csv_writer.writerow([
            frame_idx,
            p["id"],
            x1, y1, x2, y2,
            f"{p['conf']:.2f}"
        ])

        # Draw Blue boxes for tracked players
        color = (255, 0, 0) 
        cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)

        label = f"ID {p['id']} {p['conf']:.2f}"
        cv2.putText(
            frame,
            label,
            (x1, max(20, y1 - 10)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.7,
            color,
            2
        )

    # Display Frame Number
    cv2.putText(
        frame,
        f"Frame {frame_idx}",
        (20, 32),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.8,
        (255, 255, 255),
        2
    )

    writer.write(frame)

    if frame_idx % 100 == 0:
        print(f"Processed frame {frame_idx}")

cap.release()
writer.release()
csv_file.close()

print("Done")
print("Video saved to:", OUTPUT_VIDEO)
print("CSV saved to:", OUTPUT_CSV)