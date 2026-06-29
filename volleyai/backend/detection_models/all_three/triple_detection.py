import os
import sys
import cv2
import json
import math
import argparse
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from ultralytics import YOLO
from tqdm import tqdm
import easyocr

# --- ABSOLUTE CONFIGURATION PATHS ---

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

parser = argparse.ArgumentParser()
parser.add_argument("--video", default=r"C:\Users\user\Downloads\match5 - Trim - Trim.mp4", help="Path to input video")
parser.add_argument("--jerseys", default="", help="Comma-separated known jersey numbers, e.g. 5,7,9,11")
parser.add_argument("--names",   default="", help="Comma-separated jersey:name pairs, e.g. 7:Yahav,9:Dana")
parser.add_argument("--net_y",   default="", help="Net Y position as fraction of frame height (e.g. 0.48)")
parser.add_argument("--near_y",  default="", help="Near baseline Y (our side ground level, e.g. 0.82)")
parser.add_argument("--far_y",   default="", help="Far baseline Y (opponent side ground level, e.g. 0.18)")
args = parser.parse_args()
VIDEO_PATH = args.video
KNOWN_JERSEYS = [int(x) for x in args.jerseys.split(",") if x.strip().isdigit()]
# Build jersey→name lookup from --names arg
JERSEY_NAMES = {}
for _pair in args.names.split(","):
    _pair = _pair.strip()
    if ":" in _pair:
        _jn, _nm = _pair.split(":", 1)
        if _jn.strip().isdigit():
            JERSEY_NAMES[int(_jn.strip())] = _nm.strip()
# Local Tracking & Action Recognition Brains
PLAYERS_MODEL_PATH = os.path.abspath(os.path.join(SCRIPT_DIR, "../player_detection/yolo11s.pt"))
POSE_MODEL_PATH    = os.path.abspath(os.path.join(SCRIPT_DIR, "../player_detection/yolo11s-pose.pt"))
BALL_MODEL_PATH    = os.path.abspath(os.path.join(SCRIPT_DIR, "../ball_tracking/ball_model.pt"))
ACTION_MODEL_PATH  = os.path.abspath(os.path.join(SCRIPT_DIR, "../action_detection/best_robo_with_git.pt"))
# Output tracking artifacts will generate directly inside your current script workspace directory
OUTPUT_DIR = os.path.abspath(os.path.join(SCRIPT_DIR, "runs"))
OUTPUT_VIDEO     = os.path.join(OUTPUT_DIR, "active_player.mp4")
OUTPUT_VIDEO_RAW = os.path.join(OUTPUT_DIR, "active_player_raw.avi")
OUTPUT_JSON = os.path.join(OUTPUT_DIR, "volley_analytics.json")
THUMBS_DIR = os.path.join(OUTPUT_DIR, "player_thumbs")
REGISTRY_JSON = os.path.join(OUTPUT_DIR, "player_registry.json")

# Confidence thresholds
CONF_PLAYERS = 0.35 
CONF_BALL = 0.35    
CONF_ACTION = 0.2  # Threshold for custom actions (bump, spike, set, etc.)

IMG_SIZE = 640
MIN_BOX_AREA = 2500
MAX_PLAYERS_PER_FRAME = 20

# --- TEAM FILTER ---
# "bottom" = הקבוצה שלנו בחצי התחתון של הפריים (הכי נפוץ)
# "top"    = הקבוצה שלנו בחצי העליון של הפריים
OUR_TEAM_SIDE = "bottom"
# שחקנים מעל ה-y הזה (כאחוז מגובה הפריים) = קבוצה יריבה → מסוננים
NET_Y_THRESHOLD = float(args.net_y) if args.net_y.strip() else 0.50
# שופטים בדרך כלל בקצוות הפריים - מסנן שחקנים בקצוות
REFEREE_X_MARGIN = 0.07

# --- DYNAMIC ACTION COLORS (BGR Format) ---
ACTION_COLORS = {
    "serve": (0, 165, 255),    # Orange
    "spike": (0, 0, 255),      # Red
    "block": (255, 0, 255),    # Magenta
    "bump": (255, 255, 0),     # Cyan
    "set": (0, 255, 255),      # Yellow
    "dig": (0, 128, 255),      # Light Orange
    "none": (255, 0, 0)        # Default Tracked Player Color (Blue)
}

os.makedirs(OUTPUT_DIR, exist_ok=True)
os.makedirs(THUMBS_DIR, exist_ok=True)

# Initialize ALL 3 Local Tracking Models
print("Loading local AI architectures...")
players_model = YOLO(PLAYERS_MODEL_PATH)
ball_model    = YOLO(BALL_MODEL_PATH)
action_model  = YOLO(ACTION_MODEL_PATH)

# Pose model for precise jersey-number cropping (shoulders→hips keypoints)
try:
    _pose_src = POSE_MODEL_PATH if os.path.exists(POSE_MODEL_PATH) else "yolo11s-pose.pt"
    pose_model = YOLO(_pose_src)
    HAS_POSE = True
    print("Pose model loaded – jersey OCR will use keypoint crop")
except Exception as _pe:
    pose_model = None
    HAS_POSE = False
    print(f"Pose model unavailable ({_pe}), using fallback chest crop")

print("Loading OCR engine...")
ocr_reader = easyocr.Reader(['en'], gpu=False, verbose=False)


def _extract_pose_map(pose_results):
    """Return list of (xyxy_box, kpts_17x3) from a pose model result."""
    out = []
    for r in (pose_results or []):
        if r.boxes is None or r.keypoints is None:
            continue
        boxes = r.boxes.xyxy.cpu().numpy()
        kpts  = r.keypoints.data.cpu().numpy()  # [N, 17, 3]
        for i, box in enumerate(boxes):
            out.append((box[:4].tolist(), kpts[i]))
    return out


def _match_kpts(player_box, pose_map):
    """Find pose keypoints for a tracked player by best-IOU match."""
    if not pose_map:
        return None
    px1, py1, px2, py2 = player_box
    best_iou, best_kpts = 0.0, None
    for pb, kpts in pose_map:
        ix1 = max(px1, pb[0]); iy1 = max(py1, pb[1])
        ix2 = min(px2, pb[2]); iy2 = min(py2, pb[3])
        if ix2 <= ix1 or iy2 <= iy1:
            continue
        inter = (ix2 - ix1) * (iy2 - iy1)
        union = (px2-px1)*(py2-py1) + (pb[2]-pb[0])*(pb[3]-pb[1]) - inter
        iou = inter / max(union, 1)
        if iou > best_iou:
            best_iou, best_kpts = iou, kpts
    return best_kpts if best_iou > 0.25 else None


def _jersey_crop(frame, box, kpts):
    """
    Return the sub-image most likely to contain the jersey number.
    Uses shoulder (5,6) → hip (11,12) keypoints when available;
    falls back to fixed 20-65% chest slice of the player bbox.
    """
    x1, y1, x2, y2 = map(int, box)
    H, W = frame.shape[:2]
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(W, x2), min(H, y2)

    if kpts is not None and len(kpts) >= 13:
        try:
            # Shoulder: 5=left, 6=right | Hip: 11=left, 12=right
            shoulders = [kpts[5], kpts[6]]
            hips      = [kpts[11], kpts[12]]
            valid_sh  = [p for p in shoulders if p[0] > 1 and p[1] > 1 and p[2] > 0.25]
            valid_hip = [p for p in hips      if p[0] > 1 and p[1] > 1 and p[2] > 0.25]
            if valid_sh and valid_hip:
                top_y  = int(min(p[1] for p in valid_sh))  - 4
                bot_y  = int(max(p[1] for p in valid_hip)) + 4
                all_x  = [p[0] for p in valid_sh + valid_hip]
                left_x = int(min(all_x)) - 10
                right_x= int(max(all_x)) + 10
                top_y  = max(0, top_y);  bot_y  = min(H, bot_y)
                left_x = max(0, left_x); right_x= min(W, right_x)
                if bot_y > top_y and right_x > left_x:
                    return frame[top_y:bot_y, left_x:right_x]
        except (IndexError, TypeError):
            pass

    # Fallback: fixed chest slice of the player bbox
    full = frame[y1:y2, x1:x2]
    fh   = full.shape[0]
    return full[int(fh * 0.20):int(fh * 0.65), :]


def detect_jersey_number(crop) -> int | None:
    """Run OCR on a pre-cropped jersey region and return the number."""
    if crop is None or crop.size == 0:
        return None
    results = ocr_reader.readtext(crop)
    best_num, best_conf = None, 0.0
    for (_, text, conf) in results:
        digits = ''.join(c for c in text if c.isdigit())
        if digits and 1 <= len(digits) <= 2 and conf > best_conf:
            num = int(digits)
            if 1 <= num <= 99:
                best_num, best_conf = num, conf
    if best_conf < 0.25:
        return None
    if KNOWN_JERSEYS and best_num is not None:
        closest = min(KNOWN_JERSEYS, key=lambda j: abs(j - best_num))
        if abs(closest - best_num) <= 2:
            return closest
        return None
    return best_num


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

        center_y = (y1 + y2) / 2 / h_img
        center_x = (x1 + x2) / 2 / w_img

        # סנן שופטים בקצוות הפריים
        if center_x < REFEREE_X_MARGIN or center_x > (1 - REFEREE_X_MARGIN):
            continue

        # סנן קבוצה יריבה לפי צד הרשת
        if OUR_TEAM_SIDE == "bottom" and center_y < NET_Y_THRESHOLD:
            continue
        if OUR_TEAM_SIDE == "top" and center_y > NET_Y_THRESHOLD:
            continue

        filtered.append({
            "x1": x1, "y1": y1, "x2": x2, "y2": y2,
            "conf": float(confs[i]) if confs is not None else 0.0,
            "id": int(ids[i]) if ids is not None else -1,
        })
    filtered.sort(key=lambda b: b["conf"], reverse=True)
    return filtered[:MAX_PLAYERS_PER_FRAME]


# --- VIDEO CAPTURE ---
cap = cv2.VideoCapture(VIDEO_PATH)
if not cap.isOpened():
    raise RuntimeError(f"Cannot open video: {VIDEO_PATH}")

fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
w, h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

writer = cv2.VideoWriter(OUTPUT_VIDEO_RAW, cv2.VideoWriter_fourcc(*"XVID"), fps, (w, h))

tracking_data = []
frame_idx = 0
last_active_id = None
seen_player_ids: set = set()
id_to_jersey: dict = {}           # bytetrack_id → jersey_number (confirmed)
jersey_to_thumb: dict = {}        # jersey_number → saved thumbnail path (one per jersey)
ocr_attempts: dict = defaultdict(int)
pending_ocr: dict = {}            # bytetrack_id → Future (running OCR task)
MAX_OCR_ATTEMPTS = 20
ocr_executor = ThreadPoolExecutor(max_workers=1)  # OCR runs async, never blocks main loop
inference_executor = ThreadPoolExecutor(max_workers=3)  # reused across all frames

# --- BALL LANDING DETECTION ---
BALL_TRAJ_WINDOW = 12        # frames of trail visualization history
LANDING_COOLDOWN = 90        # minimum frames between two landing events (3 sec at 30fps)

# Y-threshold landing detection
_ny = args.near_y.strip(); _fy = args.far_y.strip()
NEAR_Y = float(_ny) if _ny else 0.82   # near baseline (our side)  – high Y in image
FAR_Y  = float(_fy) if _fy else 0.18   # far baseline (opp side)   – low Y in image
APPROACH_FRAMES = 4                     # frames of trajectory needed to confirm approach
APPROACH_THRESH = 0.012                 # min Y-delta per frame to count as "approaching baseline"

ball_traj: list = []         # short window for trail visualization
ball_arc:  list = []         # full arc for current rally [(frame, x_norm, y_norm)]
landing_events: list = []
last_landing_frame: int = -LANDING_COOLDOWN - 1
last_nonball_frames: int = 0
last_recorded_action: str = "none"

print(f"Running Fully Local 3-Model Pipeline over {total_frames} frames...")

try:
    for _ in tqdm(range(total_frames), desc="Processing Video", unit="frame"):
        ret, frame = cap.read()
        if not ret:
            break

        frame_idx += 1

        # Run all models in parallel
        future_ball    = inference_executor.submit(ball_model.predict,    frame, **{"conf": CONF_BALL,    "imgsz": IMG_SIZE, "verbose": False})
        future_players = inference_executor.submit(players_model.track,   frame, **{"classes": [0], "conf": CONF_PLAYERS, "imgsz": IMG_SIZE, "max_det": 20, "tracker": os.path.join(SCRIPT_DIR, "botsort_volleyball.yaml"), "persist": True, "verbose": False})
        future_action  = inference_executor.submit(action_model.predict,  frame, **{"conf": CONF_ACTION,  "imgsz": IMG_SIZE, "verbose": False})
        if HAS_POSE:
            future_pose = inference_executor.submit(pose_model.predict, frame, **{"classes": [0], "conf": CONF_PLAYERS, "imgsz": IMG_SIZE, "verbose": False})
        ball_results   = future_ball.result()
        player_results = future_players.result()
        action_results = future_action.result()
        pose_map = _extract_pose_map(future_pose.result()) if HAS_POSE else []

        # Step 1: Parse Ball results
        ball_box, best_ball_conf = None, 0.0
        for r in ball_results:
            if r.boxes is not None:
                for box in r.boxes:
                    conf = float(box.conf[0])
                    if conf > best_ball_conf:
                        best_ball_conf = conf
                        ball_box = box.xyxy[0].cpu().numpy().tolist()

        # Step 2: Parse Player results
        players = []
        if player_results and len(player_results) > 0:
            for p in filter_player_boxes(frame, player_results[0].boxes):
                players.append({"id": p["id"], "box": [p["x1"], p["y1"], p["x2"], p["y2"]], "conf": p["conf"]})

                pid = p["id"]
                x1, y1, x2, y2 = p["x1"], p["y1"], p["x2"], p["y2"]

                # Full-body crop for thumbnail (with slight padding)
                pad_x = int((x2 - x1) * 0.2)
                pad_y = int((y2 - y1) * 0.15)
                cx1 = max(0, x1 - pad_x); cy1 = max(0, y1 - pad_y)
                cx2 = min(frame.shape[1], x2 + pad_x)
                cy2 = min(frame.shape[0], y2 + pad_y)
                full_crop = frame[cy1:cy2, cx1:cx2]
                if full_crop.size == 0:
                    continue

                # Collect completed async OCR results
                if pid in pending_ocr and pending_ocr[pid].done():
                    num = pending_ocr.pop(pid).result()
                    if num is not None and pid not in id_to_jersey:
                        id_to_jersey[pid] = num
                        if num not in jersey_to_thumb:
                            thumb_path = os.path.join(THUMBS_DIR, f"jersey_{num}.jpg")
                            cv2.imwrite(thumb_path, full_crop.copy())
                            jersey_to_thumb[num] = thumb_path

                # Submit OCR task async using keypoint-guided crop
                if pid not in id_to_jersey and pid not in pending_ocr and ocr_attempts[pid] < MAX_OCR_ATTEMPTS:
                    ocr_attempts[pid] += 1
                    kpts = _match_kpts([x1, y1, x2, y2], pose_map)
                    jersey_region = _jersey_crop(frame, [x1, y1, x2, y2], kpts)
                    pending_ocr[pid] = ocr_executor.submit(detect_jersey_number, jersey_region.copy() if jersey_region is not None and jersey_region.size > 0 else full_crop.copy())

                # Save one fallback thumbnail per bytetrack ID
                if pid not in seen_player_ids:
                    seen_player_ids.add(pid)
                    if id_to_jersey.get(pid) is None:
                        cv2.imwrite(os.path.join(THUMBS_DIR, f"unknown_id{pid}.jpg"), full_crop)

        active_player = None
        min_dist = None
        current_action = "none"
        action_conf = 0.0
        ball_x, ball_y = None, None

        # --- Ball trajectory + landing detection ---
        if ball_box is not None:
            bx_n = (ball_box[0] + ball_box[2]) / 2 / w
            by_n = (ball_box[1] + ball_box[3]) / 2 / h

            ball_arc.append((frame_idx, bx_n, by_n))
            ball_traj.append((frame_idx, bx_n, by_n))
            if len(ball_traj) > BALL_TRAJ_WINDOW:
                ball_traj.pop(0)
            last_nonball_frames = 0

            can_land = frame_idx - last_landing_frame > LANDING_COOLDOWN
            if can_land and len(ball_arc) >= APPROACH_FRAMES:
                arc_ys = [p[2] for p in ball_arc[-APPROACH_FRAMES:]]
                min_dy = APPROACH_THRESH * (APPROACH_FRAMES - 1)

                # Near side (our team's baseline) — ball Y is HIGH and INCREASING
                if by_n > NEAR_Y and (arc_ys[-1] - arc_ys[0]) > min_dy:
                    landing_events.append({
                        "frame": frame_idx,
                        "ball_x_norm": round(bx_n, 4),
                        "ball_y_norm": round(by_n, 4),
                        "last_attacker_id": last_active_id,
                        "last_attacker_jersey": id_to_jersey.get(last_active_id) if last_active_id else None,
                        "last_action": last_recorded_action,
                    })
                    last_landing_frame = frame_idx
                    ball_arc = []

                # Far side (opponent baseline) — ball Y is LOW and DECREASING
                elif by_n < FAR_Y and (arc_ys[0] - arc_ys[-1]) > min_dy:
                    landing_events.append({
                        "frame": frame_idx,
                        "ball_x_norm": round(bx_n, 4),
                        "ball_y_norm": round(by_n, 4),
                        "last_attacker_id": last_active_id,
                        "last_attacker_jersey": id_to_jersey.get(last_active_id) if last_active_id else None,
                        "last_action": last_recorded_action,
                    })
                    last_landing_frame = frame_idx
                    ball_arc = []
        else:
            last_nonball_frames += 1
            if last_nonball_frames > 15:
                ball_traj = []
                ball_arc  = []

        # Proximity Link Logic
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

        # Step 3: Parse Action results (already computed in parallel above)
        # Collect all detected action boxes first
        detected_actions = []
        for r in action_results:
            if r.boxes is not None:
                for box in r.boxes:
                    cls_id = int(box.cls[0])
                    cls_name = r.names[cls_id].lower()
                    if "player" in cls_name or "ball" in cls_name:
                        continue
                    act_xyxy = box.xyxy[0].cpu().numpy().tolist()
                    detected_actions.append((cls_name, box_center(act_xyxy), float(box.conf[0])))

        if active_player is not None and detected_actions:
            active_c = box_center(active_player["box"])
            min_action_dist = float('inf')
            for cls_name, act_c, conf in detected_actions:
                dist_to_action = distance(active_c, act_c)
                if dist_to_action < 600 and dist_to_action < min_action_dist:
                    min_action_dist = dist_to_action
                    current_action = cls_name
                    action_conf = conf

        elif active_player is None and detected_actions and len(players) > 0:
            # No ball found — find the player closest to any detected action box
            best_player, best_action, best_conf, best_dist = None, "none", 0.0, float('inf')
            for cls_name, act_c, conf in detected_actions:
                for p in players:
                    d = distance(box_center(p["box"]), act_c)
                    if d < 300 and d < best_dist:
                        best_dist = d
                        best_player = p
                        best_action = cls_name
                        best_conf = conf
            if best_player is not None:
                active_player = best_player
                current_action = best_action
                action_conf = best_conf

        # Keep track of last non-"none" action for landing attribution
        if current_action not in ("none", ""):
            last_recorded_action = current_action

        # Record Structural Analytics Data
        active_id = active_player["id"] if active_player else None
        active_jersey = id_to_jersey.get(active_id) if active_id else None
        active_y_norm = None
        if active_player is not None:
            by1 = active_player["box"][1]
            by2 = active_player["box"][3]
            active_y_norm = round(((by1 + by2) / 2) / h, 4)
        tracking_data.append({
            "frame": frame_idx,
            "ball": {"x": ball_x, "y": ball_y} if ball_box else None,
            "active_player_id": active_id,
            "active_player_jersey": active_jersey,
            "active_player_y": active_y_norm,
            "distance_to_ball": min_dist,
            "action": current_action,
            "action_confidence": action_conf
        })

        # Save incrementally every 500 frames so data isn't lost if stopped
        if frame_idx % 500 == 0:
            with open(OUTPUT_JSON, "w") as f:
                json.dump({"frames": tracking_data, "ball_landings": landing_events}, f, indent=4)
            # Save registry incrementally too
            _reg = {}
            from collections import Counter as _Counter
            _counts = _Counter(
                d["active_player_id"] for d in tracking_data
                if d.get("active_player_id") is not None and d.get("action", "none") not in ("none", "", None)
            )
            for _bid, _count in _counts.most_common():
                _jersey = id_to_jersey.get(_bid)
                _thumb = jersey_to_thumb.get(_jersey) if _jersey else os.path.join(THUMBS_DIR, f"unknown_id{_bid}.jpg")
                _reg[str(_bid)] = {"jersey": _jersey, "confirmed": _jersey is not None, "thumbnail": _thumb if _thumb and os.path.exists(str(_thumb)) else None, "event_count": _count}
            with open(REGISTRY_JSON, "w") as f:
                json.dump(_reg, f, indent=4)

        # --- VISUALIZATION DRAWING ---
        # 0. Draw ball trail (pink, narrow)
        TRAIL_COLOR = (180, 105, 255)  # Pink BGR
        TRAIL_LEN = 14
        if len(ball_traj) >= 2:
            trail_pts = ball_traj[-TRAIL_LEN:]
            for i in range(1, len(trail_pts)):
                pt1 = (int(trail_pts[i - 1][1] * w), int(trail_pts[i - 1][2] * h))
                pt2 = (int(trail_pts[i][1] * w), int(trail_pts[i][2] * h))
                thickness = 1 if i < len(trail_pts) - 3 else 2
                cv2.line(frame, pt1, pt2, TRAIL_COLOR, thickness)

        # 1. Draw the ball (Yellow)
        if ball_box is not None:
            x1, y1, x2, y2 = map(int, ball_box)
            cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 255), 2)
            cv2.putText(frame, "BALL", (x1, max(20, y1 - 10)), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 255), 2)

        # 2. Draw players
        for p in players:
            x1, y1, x2, y2 = map(int, p["box"])
            
            # Check if this iteration's player is the active one executing an action
            is_active_action = (active_player is not None and p["id"] == active_player["id"] and current_action != "none")
            
            # Assign specific action color from dictionary, fallback to 'none' (Blue) if idle
            color = ACTION_COLORS.get(current_action if is_active_action else "none", (255, 0, 0))
            
            jersey = id_to_jersey.get(p["id"])
            label = f"#{jersey}" if jersey else f"ID {p['id']}"
            cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
            cv2.putText(frame, label, (x1, max(20, y1 - 10)), cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)
            
            # Action Notification Banner with dynamic background color fill
            if is_active_action:
                banner_y1, banner_y2 = max(0, y1 - 45), max(20, y1 - 10)
                # Fills the header box with the action's specific color
                cv2.rectangle(frame, (x1, banner_y1), (x1 + 190, banner_y2), color, -1)
                # Overlays high-contrast text over the color block
                cv2.putText(frame, f"{current_action.upper()}!", (x1 + 5, banner_y2 - 5), cv2.FONT_HERSHEY_DUPLEX, 0.8, (0, 0, 0), 2)

        cv2.putText(frame, f"Frame {frame_idx}", (20, 32), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
        writer.write(frame)

except KeyboardInterrupt:
    print("\nProcessing interrupted early. Saving tracking analytics data...")

# --- CLEANUP ---
cap.release()
writer.release()
ocr_executor.shutdown(wait=True)
inference_executor.shutdown(wait=False)

import subprocess as _sp

# --- DEAD SEGMENT DETECTION ---
# A frame is "dead" if the ball is not visible.
# Consecutive dead frames > DEAD_MIN_SEC = dead segment → cut from video.
DEAD_MIN_SEC = 3.0
_DEAD_MIN_FRAMES = int(DEAD_MIN_SEC * fps)
dead_segments = []
_dead_start = None

for _entry in tracking_data:
    _f = _entry["frame"]
    _has_ball = _entry.get("ball") is not None

    if not _has_ball:
        if _dead_start is None:
            _dead_start = _f
    else:
        if _dead_start is not None:
            if _f - _dead_start >= _DEAD_MIN_FRAMES:
                dead_segments.append({
                    "start_frame": _dead_start,
                    "end_frame":   _f - 1,
                    "start_sec":   round(_dead_start / fps, 3),
                    "end_sec":     round((_f - 1) / fps, 3),
                })
            _dead_start = None

if _dead_start is not None and frame_idx - _dead_start >= _DEAD_MIN_FRAMES:
    dead_segments.append({
        "start_frame": _dead_start,
        "end_frame":   frame_idx,
        "start_sec":   round(_dead_start / fps, 3),
        "end_sec":     round(frame_idx / fps, 3),
    })

print(f"Dead segments found: {len(dead_segments)}")

# Build function: original_sec → trimmed_sec (subtract all dead time before this point)
def _trimmed_sec(orig_sec):
    offset = 0.0
    for ds in dead_segments:
        if orig_sec >= ds["end_sec"]:
            offset += ds["end_sec"] - ds["start_sec"]
        elif orig_sec > ds["start_sec"]:
            offset += orig_sec - ds["start_sec"]
    return round(max(0.0, orig_sec - offset), 3)

# Update tracking_data and landing_events with trimmed timestamps
for _entry in tracking_data:
    _entry["time_sec"] = _trimmed_sec(_entry["frame"] / fps)
for _land in landing_events:
    _land["time_sec"] = _trimmed_sec(_land["frame"] / fps)

# --- CONVERT AVI → H264 MP4 ---
try:
    _r = _sp.run(
        ["ffmpeg", "-y", "-i", OUTPUT_VIDEO_RAW,
         "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
         "-threads", "0", "-movflags", "+faststart",
         OUTPUT_VIDEO],
        capture_output=True, timeout=3600
    )
    if _r.returncode == 0:
        os.remove(OUTPUT_VIDEO_RAW)
        print("Video converted to H264 (browser-compatible)")
    else:
        print("ffmpeg H264 conversion failed")
        print(_r.stderr.decode(errors="ignore")[-300:])
except (FileNotFoundError, _sp.TimeoutExpired, OSError) as _e:
    print(f"ffmpeg H264 step error: {_e}")

# --- TRIM DEAD SEGMENTS FROM VIDEO ---
if dead_segments and os.path.exists(OUTPUT_VIDEO):
    _video_dur = frame_idx / fps
    _keep_segs = []
    _prev_end = 0.0
    for _ds in dead_segments:
        if _ds["start_sec"] > _prev_end + 0.1:
            _keep_segs.append((_prev_end, _ds["start_sec"]))
        _prev_end = _ds["end_sec"]
    if _prev_end < _video_dur - 0.1:
        _keep_segs.append((_prev_end, _video_dur))

    if _keep_segs:
        _concat_txt = os.path.join(OUTPUT_DIR, "_trim_concat.txt")
        _src = OUTPUT_VIDEO.replace("\\", "/")
        with open(_concat_txt, "w", encoding="utf-8") as _cf:
            for _s, _e in _keep_segs:
                _cf.write(f"file '{_src}'\n")
                _cf.write(f"inpoint {_s:.3f}\n")
                _cf.write(f"outpoint {_e:.3f}\n")

        _trimmed = OUTPUT_VIDEO.replace(".mp4", "_trimmed.mp4")
        _tr = _sp.run(
            ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", _concat_txt,
             "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
             "-threads", "0", "-movflags", "+faststart",
             _trimmed],
            capture_output=True, timeout=3600
        )
        if _tr.returncode == 0:
            os.replace(_trimmed, OUTPUT_VIDEO)
            print(f"Video trimmed: removed {len(dead_segments)} dead segments "
                  f"({sum(d['end_sec']-d['start_sec'] for d in dead_segments):.1f}s cut)")
        else:
            print("Video trimming failed - keeping full video")
            print(_tr.stderr.decode(errors="ignore")[-500:])
        try:
            os.remove(_concat_txt)
        except OSError:
            pass

with open(OUTPUT_JSON, "w") as f:
    json.dump({
        "frames":        tracking_data,
        "ball_landings": landing_events,
        "dead_segments": dead_segments,
    }, f, indent=4)

# Build registry keyed by bytetrack_id
from collections import Counter
id_event_count = Counter(
    d["active_player_id"] for d in tracking_data
    if d.get("active_player_id") is not None and d.get("action", "none") not in ("none", "", None)
)

registry = {}
for bid, count in id_event_count.most_common():
    jersey = id_to_jersey.get(bid)
    if jersey and jersey in jersey_to_thumb:
        thumb = jersey_to_thumb[jersey]
    else:
        thumb = os.path.join(THUMBS_DIR, f"unknown_id{bid}.jpg")
        if not os.path.exists(thumb):
            thumb = None

    registry[str(bid)] = {
        "jersey": jersey,
        "name": JERSEY_NAMES.get(jersey, "") if jersey is not None else "",
        "confirmed": jersey is not None,
        "thumbnail": thumb,
        "event_count": count,
    }

with open(REGISTRY_JSON, "w") as f:
    json.dump(registry, f, indent=4)

all_jerseys = sorted(set(id_to_jersey.values()))
print("Execution complete!")
print("Video saved to:", OUTPUT_VIDEO)
print("Analytics JSON saved to:", OUTPUT_JSON)
print(f"Jersey numbers detected: {all_jerseys}")
print(f"Player registry saved to: {REGISTRY_JSON}")