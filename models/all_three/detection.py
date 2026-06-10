import os
import cv2
import json
import math
from ultralytics import YOLO
from tqdm import tqdm  # <-- Imported tqdm

VIDEO_PATH = "../videos/test_clip.mp4"

# 1. Player Model (Up one level, then into player_detection)
PLAYERS_MODEL_PATH = "../player_detection/yolo11n.pt"

# 2. Ball Model (Up one level, then into ball_tracking)
BALL_MODEL_PATH = "../ball_tracking/ball_model.pt"

# 3. Action Model (Absolute path to your archive folder in the home directory)
ACTION_MODEL_PATH = "yolo11n_action.pt"
OUTPUT_DIR = "runs/ball_players_link"
OUTPUT_VIDEO = os.path.join(OUTPUT_DIR, "active_player.mp4")
# ------------------------------------

CONF_PLAYERS = 0.35
CONF_BALL = 0.35
IMG_SIZE = 640
MIN_BOX_AREA = 2500
MAX_PLAYERS_PER_FRAME = 20

os.makedirs(OUTPUT_DIR, exist_ok=True)

# Load all three brains
players_model = YOLO(PLAYERS_MODEL_PATH)
ball_model = YOLO(BALL_MODEL_PATH)
action_model = YOLO(ACTION_MODEL_PATH)

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

        if area < MIN_BOX_AREA or box_w <= 0 or box_h <= 0:
            continue
        if (box_h / max(box_w, 1)) > 4.2 or box_w < 18 or y2 < int(0.18 * h_img):
            continue

        filtered.append({
            "x1": x1, "y1": y1, "x2": x2, "y2": y2,
            "conf": float(confs[i]) if confs is not None else 0.0,
            "id": int(ids[i]) if ids is not None else -1,
        })

    filtered.sort(key=lambda b: b["conf"], reverse=True)
    return filtered[:MAX_PLAYERS_PER_FRAME]

cap = cv2.VideoCapture(VIDEO_PATH)
if not cap.isOpened():
    raise RuntimeError(f"Cannot open video: {VIDEO_PATH}")

fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) # <-- Extracted total frames for the bar

writer = cv2.VideoWriter(OUTPUT_VIDEO, cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))

# Memory Variables
tracking_data = []
frame_idx = 0
last_active_id = None 

print(f"Initializing pipeline for {total_frames} frames. Press 'Ctrl+C' to stop early.")

try:
    # <-- Wrapped the loop in tqdm
    for _ in tqdm(range(total_frames), desc="Processing Pipeline", unit="frame"):
        ret, frame = cap.read()
        if not ret:
            break

        frame_idx += 1

        # 1. Detect Ball
        ball_results = ball_model.predict(source=frame, conf=CONF_BALL, imgsz=IMG_SIZE, verbose=False)
        ball_box = None
        best_ball_conf = 0.0

        for r in ball_results:
            if r.boxes is not None:
                for box in r.boxes:
                    conf = float(box.conf[0])
                    if conf > best_ball_conf:
                        best_ball_conf = conf
                        ball_box = box.xyxy[0].cpu().numpy().tolist()

        # 2. Track Players
        player_results = players_model.track(source=frame, classes=[0], conf=CONF_PLAYERS, imgsz=IMG_SIZE, max_det=20, tracker="bytetrack.yaml", persist=True, verbose=False)
        players = []
        if player_results and len(player_results) > 0:
            filtered_players = filter_player_boxes(frame, player_results[0].boxes)
            for p in filtered_players:
                players.append({"id": p["id"], "box": [p["x1"], p["y1"], p["x2"], p["y2"]], "conf": p["conf"]})

        # --- THE NEW LOGIC ARCHITECTURE ---
        active_player = None
        min_dist = None
        current_action = "none"
        action_conf = 0.0
        ball_x, ball_y = None, None

        # Scenario A: We clearly see the ball this frame
        if ball_box is not None and len(players) > 0:
            ball_c = box_center(ball_box)
            ball_x, ball_y = ball_c

            for p in players:
                player_c = box_center(p["box"])
                d = distance(ball_c, player_c)
                if min_dist is None or d < min_dist:
                    min_dist = d
                    active_player = p
            
            # Save this player to memory
            if active_player is not None:
                last_active_id = active_player["id"]

        # Scenario B: We lost the ball due to blur, but we remember who had it!
        elif ball_box is None and len(players) > 0 and last_active_id is not None:
            for p in players:
                if p["id"] == last_active_id:
                    active_player = p
                    break

        # 3. Action Inference 
        if active_player is not None:
            # Lowered confidence to 0.10 to catch high-speed, blurry spikes
            action_results = action_model.predict(source=frame, conf=0.10, imgsz=IMG_SIZE, verbose=False)
            
            if len(action_results) > 0 and action_results[0].boxes is not None:
                a_boxes = action_results[0].boxes
                a_names = action_results[0].names 
                
                active_c = box_center(active_player["box"])
                min_action_dist = float('inf')
                
                for i, box in enumerate(a_boxes.xyxy.cpu().numpy()):
                    cls_name = a_names[int(a_boxes.cls[i])].lower()
                    
                    if "player" in cls_name or "ball" in cls_name:
                        continue
                        
                    act_c = box_center(box)
                    dist_to_action = distance(active_c, act_c)
                    
                    # WIDENED RADIUS: Increased from 300 to 600 to catch massive bounding boxes
                    if dist_to_action < 600 and dist_to_action < min_action_dist:
                        min_action_dist = dist_to_action
                        current_action = cls_name
                        action_conf = float(a_boxes.conf[i])
            
            if current_action != "none":
                # <-- Changed to tqdm.write to preserve the progress bar layout
                tqdm.write(f"   -> ACTION CAUGHT: {current_action.upper()} by Player {active_player['id']} (Conf: {action_conf:.2f})")

        # Record Data
        tracking_data.append({
            "frame": frame_idx,
            "ball": {"x": ball_x, "y": ball_y} if ball_box else None,
            "active_player_id": active_player["id"] if active_player else None,
            "distance_to_ball": min_dist,
            "action": current_action,
            "action_confidence": action_conf
        })

        # --- DRAWING EVERYTHING ---
        for p in players:
            # Check if this specific player is the one performing an action
            if active_player is not None and p["id"] == active_player["id"] and current_action != "none":
                x1, y1, x2, y2 = map(int, p["box"])
                
                # 1. Draw a clean green box ONLY around the active player
                cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 0), 3)
                
                # 2. Draw the Action Banner
                banner_y1 = max(0, y1 - 45)
                banner_y2 = max(20, y1 - 10)
                cv2.rectangle(frame, (x1, banner_y1), (x1 + 180, banner_y2), (0, 255, 0), -1)
                cv2.putText(frame, f"{current_action.upper()}!", (x1 + 5, banner_y2 - 5), cv2.FONT_HERSHEY_DUPLEX, 0.9, (0, 0, 0), 2)

        # Keep the frame counter in the corner so you can track progress
        cv2.putText(frame, f"Frame {frame_idx}", (20, 32), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
        writer.write(frame)

except KeyboardInterrupt:
    print("\nRun stopped early! Saving progress gracefully...")

# --- CLEANUP ---
cap.release()
writer.release()
with open("volley_analytics.json", "w") as f:
    json.dump(tracking_data, f, indent=4)

print("Done! Video saved to:", OUTPUT_VIDEO)