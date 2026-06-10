import os
import cv2
import json
import math
from ultralytics import YOLO
from roboflow import Roboflow  # <-- Integrated the Hosted API Client
from tqdm import tqdm

VIDEO_PATH = "../videos/test_clip.mp4"

# Local Tracking Brains
PLAYERS_MODEL_PATH = "../player_detection/yolo11n.pt"
BALL_MODEL_PATH = "../ball_tracking/ball_model.pt"

# Cloud Action Brain Configuration
ROBOFLOW_API_KEY = "zhaNQA68oDKv3Jx4jaT2" # <-- Paste your private token here
WORKSPACE_ID = "jesis-workspace-tjclp"
PROJECT_ID = "volleyball-actions-kbdff"
VERSION_NUM = 1

OUTPUT_DIR = "runs/ball_players_link"
OUTPUT_VIDEO = os.path.join(OUTPUT_DIR, "active_player.mp4")
# ------------------------------------

CONF_PLAYERS = 0.35 # Try lowering this to 0.20
CONF_BALL = 0.35    # Try lowering this to 0.20
IMG_SIZE = 640
MIN_BOX_AREA = 2500
MAX_PLAYERS_PER_FRAME = 20

os.makedirs(OUTPUT_DIR, exist_ok=True)

# 1. Initialize Local Tracking Models
players_model = YOLO(PLAYERS_MODEL_PATH)
ball_model = YOLO(BALL_MODEL_PATH)

# 2. Initialize Cloud API Client
rf = Roboflow(api_key=ROBOFLOW_API_KEY)
action_project = rf.workspace(WORKSPACE_ID).project(PROJECT_ID)
action_api_model = action_project.version(VERSION_NUM).model

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
    ids = boxes_obj.id.cpu().numpy() if boxes_obj.id is not None else None
    confs = boxes_obj.conf.cpu().numpy() if boxes_obj.conf is not None else None

    for i, box in enumerate(boxes_xyxy):
        x1, y1, x2, y2 = map(int, box[:4])
        if int(clss[i]) != 0:
            continue

        x1, y1 = max(0, x1), max(0, y1)
        x2, y2 = min(w_img - 1, x2), min(h_img - 1, y2)
        box_w, box_h = x2 - x1, y2 - y1
        
        if box_w * box_h < MIN_BOX_AREA or box_w <= 0 or box_h <= 0:
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
w, h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

writer = cv2.VideoWriter(OUTPUT_VIDEO, cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))

tracking_data = []
frame_idx = 0
last_active_id = None 

print(f"Running Hybrid API Pipeline over {total_frames} frames...")

try:
    for _ in tqdm(range(total_frames), desc="Processing Video", unit="frame"):
        ret, frame = cap.read()
        if not ret:
            break

        frame_idx += 1

        # Step 1: Local Ball Tracking
        ball_results = ball_model.predict(source=frame, conf=CONF_BALL, imgsz=IMG_SIZE, verbose=False)
        ball_box, best_ball_conf = None, 0.0
        for r in ball_results:
            if r.boxes is not None:
                for box in r.boxes:
                    conf = float(box.conf[0])
                    if conf > best_ball_conf:
                        best_ball_conf = conf
                        ball_box = box.xyxy[0].cpu().numpy().tolist()

        # Step 2: Local Player Tracking
        player_results = players_model.track(source=frame, classes=[0], conf=CONF_PLAYERS, imgsz=IMG_SIZE, max_det=20, tracker="bytetrack.yaml", persist=True, verbose=False)
        players = []
        if player_results and len(player_results) > 0:
            for p in filter_player_boxes(frame, player_results[0].boxes):
                players.append({"id": p["id"], "box": [p["x1"], p["y1"], p["x2"], p["y2"]], "conf": p["conf"]})

        active_player = None
        min_dist = None
        current_action = "none"
        action_conf = 0.0
        ball_x, ball_y = None, None

        # Link Logic
        if ball_box is not None and len(players) > 0:
            ball_c = box_center(ball_box)
            ball_x, ball_y = ball_c
            for p in players:
                d = distance(ball_c, box_center(p["box"]))
                if min_dist is None or d < min_dist:
                    min_dist = d
                    active_player = p
            if active_player is not None:
                last_active_id = active_player["id"]
        elif ball_box is None and len(players) > 0 and last_active_id is not None:
            for p in players:
                if p["id"] == last_active_id:
                    active_player = p
                    break

        # Step 3: Hosted Cloud API Inference (Only fired if a player is active!)
        if active_player is not None:
            # Send the frame matrix directly to Roboflow's API endpoints
            api_response = action_api_model.predict(frame, confidence=10).json()
            
            if "predictions" in api_response and len(api_response["predictions"]) > 0:
                active_c = box_center(active_player["box"])
                min_action_dist = float('inf')
                
                for pred in api_response["predictions"]:
                    cls_name = pred["class"].lower()
                    if "player" in cls_name or "ball" in cls_name:
                        continue
                    
                    # Roboflow cloud API returns center coordinates (x, y) directly
                    act_c = (pred["x"], pred["y"])
                    dist_to_action = distance(active_c, act_c)
                    
                    if dist_to_action < 600 and dist_to_action < min_action_dist:
                        min_action_dist = dist_to_action
                        current_action = cls_name
                        action_conf = float(pred["confidence"])
            
            if current_action != "none":
                tqdm.write(f"   -> CLOUD API HIT: {current_action.upper()} | Player {active_player['id']} ({action_conf:.2f})")

        # Record Data Structures
        tracking_data.append({
            "frame": frame_idx,
            "ball": {"x": ball_x, "y": ball_y} if ball_box else None,
            "active_player_id": active_player["id"] if active_player else None,
            "distance_to_ball": min_dist,
            "action": current_action,
            "action_confidence": action_conf
        })

        # --- VISUALIZATION DRAWING ---
        # --- DRAWING EVERYTHING ---
        
        # 1. ALWAYS draw the ball (if detected)
        if ball_box is not None:
            x1, y1, x2, y2 = map(int, ball_box)
            cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 255), 2)
            cv2.putText(frame, "BALL", (x1, max(20, y1 - 10)), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 255), 2)

        # 2. ALWAYS draw players
        for p in players:
            x1, y1, x2, y2 = map(int, p["box"])
            
            # Default box color (Blue)
            color = (255, 0, 0)
            
            # If this player is doing an action, change color to Green
            is_active_action = (active_player is not None and p["id"] == active_player["id"] and current_action != "none")
            if is_active_action:
                color = (0, 255, 0)
            
            # Draw player box
            cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
            cv2.putText(frame, f"ID {p['id']}", (x1, max(20, y1 - 10)), cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)
            
            # Draw Action Banner ONLY if action is happening
            if is_active_action:
                banner_y1, banner_y2 = max(0, y1 - 45), max(20, y1 - 10)
                cv2.rectangle(frame, (x1, banner_y1), (x1 + 180, banner_y2), (0, 255, 0), -1)
                cv2.putText(frame, f"{current_action.upper()}!", (x1 + 5, banner_y2 - 5), cv2.FONT_HERSHEY_DUPLEX, 0.9, (0, 0, 0), 2)

        cv2.putText(frame, f"Frame {frame_idx}", (20, 32), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
        writer.write(frame)

except KeyboardInterrupt:
    print("\nProcessing interrupted early. Saving tracking analytics data...")

# --- CLEANUP ---
cap.release()
writer.release()
with open("volley_analytics.json", "w") as f:
    json.dump(tracking_data, f, indent=4)

print("Done! Hybrid pipeline execution successful. Video saved to:", OUTPUT_VIDEO)