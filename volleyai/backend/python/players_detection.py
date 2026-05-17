import os
import cv2
import csv
import math
from ultralytics import YOLO

VIDEO_PATH = r"C:\Users\user\Downloads\match8.mp4"

PLAYERS_MODEL_PATH = r"C:\Users\user\volleyball_project\volleyai\backend\python\yolo11s_openvino_model"
BALL_MODEL_PATH = r"C:\Users\user\volleyball_project\volleyai\backend\runs\ball_yolo11s_cpu\weights\best_openvino_model"

OUTPUT_DIR = r"C:\Users\user\volleyball_project\volleyai\backend\python\runs\ball_players_link"
OUTPUT_VIDEO = os.path.join(OUTPUT_DIR, "active_player.mp4")
OUTPUT_CSV = os.path.join(OUTPUT_DIR, "active_player.csv")

CONF_PLAYERS = 0.35
CONF_BALL = 0.35
IMG_SIZE = 640

MIN_BOX_AREA = 2500
MAX_PLAYERS_PER_FRAME = 20

os.makedirs(OUTPUT_DIR, exist_ok=True)

players_model = YOLO(PLAYERS_MODEL_PATH)
ball_model = YOLO(BALL_MODEL_PATH)


def box_center(box):
    x1, y1, x2, y2 = box
    return ((x1 + x2) / 2, (y1 + y2) / 2)


def distance(p1, p2):
    return math.sqrt((p1[0] - p2[0]) ** 2 + (p1[1] - p2[1]) ** 2)


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
    "ball_x",
    "ball_y",
    "active_player_id",
    "distance_to_ball"
])

frame_idx = 0

while True:
    ret, frame = cap.read()
    if not ret:
        break

    frame_idx += 1

    # זיהוי כדור
    ball_results = ball_model.predict(
        source=frame,
        conf=CONF_BALL,
        imgsz=IMG_SIZE,
        verbose=False
    )

    ball_box = None
    best_ball_conf = 0.0

    for r in ball_results:
        if r.boxes is not None:
            for box in r.boxes:
                conf = float(box.conf[0])
                if conf > best_ball_conf:
                    best_ball_conf = conf
                    ball_box = box.xyxy[0].cpu().numpy().tolist()

    # Tracking שחקנים
    player_results = players_model.track(
        source=frame,
        classes=[0],
        conf=CONF_PLAYERS,
        imgsz=IMG_SIZE,
        max_det=20,
        tracker="bytetrack.yaml",
        persist=True,
        device="intel:cpu",
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

    active_player = None
    min_dist = None

    if ball_box is not None and len(players) > 0:
        ball_c = box_center(ball_box)

        for p in players:
            player_c = box_center(p["box"])
            d = distance(ball_c, player_c)

            if min_dist is None or d < min_dist:
                min_dist = d
                active_player = p

        ball_x, ball_y = ball_c

        csv_writer.writerow([
            frame_idx,
            ball_x,
            ball_y,
            active_player["id"],
            min_dist
        ])

        x1, y1, x2, y2 = map(int, ball_box)
        cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 255), 2)
        cv2.putText(
            frame,
            f"BALL {best_ball_conf:.2f}",
            (x1, max(20, y1 - 10)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.7,
            (0, 255, 255),
            2
        )

    for p in players:
        x1, y1, x2, y2 = map(int, p["box"])

        color = (255, 0, 0)
        if active_player is not None and p["id"] == active_player["id"]:
            color = (0, 0, 255)

        cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)

        label = f"ID {p['id']} {p['conf']:.2f}"
        if active_player is not None and p["id"] == active_player["id"]:
            label = f"ACTIVE ID {p['id']}"

        cv2.putText(
            frame,
            label,
            (x1, max(20, y1 - 10)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.7,
            color,
            2
        )

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