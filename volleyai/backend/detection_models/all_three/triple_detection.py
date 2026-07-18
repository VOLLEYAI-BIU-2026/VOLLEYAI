import os
import sys
import cv2
import json
import math
import argparse
import numpy as np
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from ultralytics import YOLO
from tqdm import tqdm

# --- ABSOLUTE CONFIGURATION PATHS ---

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

parser = argparse.ArgumentParser()
parser.add_argument("--video", default=r"C:\Users\user\Downloads\match5 - Trim - Trim.mp4", help="Path to input video")
parser.add_argument("--my-team-color", default="blue_white", help="Preset key for our team's jersey color, e.g. blue_white, all_black")
parser.add_argument("--opponent-color", default="black_white", help="Preset key for the opponent's jersey color, e.g. black_white, all_white")
parser.add_argument("--calib-json", default=None, help="Path to court calibration JSON (enables 2D landing detection)")
parser.add_argument("--frame-jersey-map", default=None, help="Path to frame→bbox→jersey JSON produced by predict_pipeline")
args = parser.parse_args()
VIDEO_PATH = args.video

# Local Tracking & Action Recognition Brains
PLAYERS_MODEL_PATH = os.path.abspath(os.path.join(SCRIPT_DIR, "../player_detection/yolo11s.pt"))
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
CONF_ACTION = 0.2

IMG_SIZE = 640
MIN_BOX_AREA = 2500
MAX_PLAYERS_PER_FRAME = 20

# --- TEAM FILTER ---
OUR_TEAM_SIDE = "bottom"
REFEREE_X_MARGIN = 0.13
REFEREE_HIGH_Y   = 0.38
REFEREE_NET_BAND  = 0.15
REFEREE_EDGE_ZONE = 0.22

# --- DYNAMIC ACTION COLORS (BGR Format) ---
ACTION_COLORS = {
    "serve": (0, 165, 255),    # Orange
    "spike": (0, 0, 255),      # Red
    "block": (255, 0, 255),    # Magenta
    "bump": (255, 255, 0),     # Cyan
    "set": (0, 255, 255),      # Yellow
    "defence": (0, 128, 255),  # Light Orange
    "dig":     (0, 128, 255),  # Legacy alias
    "none": (255, 0, 0)
}

def player_color(pid):
    import colorsys
    hue = (int(pid) * 0.618033988749895) % 1.0
    r, g, b = colorsys.hsv_to_rgb(hue, 0.95, 1.0)
    return (int(b * 255), int(g * 255), int(r * 255))  # BGR

os.makedirs(OUTPUT_DIR, exist_ok=True)
os.makedirs(THUMBS_DIR, exist_ok=True)

# Initialize ALL 3 Local Tracking Models
print("Loading local AI architectures...")
players_model = YOLO(PLAYERS_MODEL_PATH)
ball_model    = YOLO(BALL_MODEL_PATH)
action_model  = YOLO(ACTION_MODEL_PATH)

# --- TEAM-BY-JERSEY-COLOR ---
_WHITE_S_MAX  = 60
_WHITE_V_MIN  = 170
_BLACK_V_MAX  = 60
_TEAM_MIN_FRAC = 0.12

TEAM_COLOR_PRESETS = {
    # White base
    "white_blue":    ["white", "blue"],
    "white_navy":    ["white", "blue"],
    "white_red":     ["white", "red"],
    "white_green":   ["white", "green"],
    "white_black":   ["white", "black"],
    # Blue
    "blue_white":    ["blue", "white"],
    "blue_gold":     ["blue", "yellow"],
    "blue_black":    ["blue", "black"],
    "blue_red":      ["blue", "red"],
    # Navy (mapped to blue in HSV)
    "navy_white":    ["blue", "white"],
    "navy_gold":     ["blue", "yellow"],
    "navy_yellow":   ["blue", "yellow"],
    # Red
    "red_white":     ["red", "white"],
    "red_black":     ["red", "black"],
    "red_gold":      ["red", "yellow"],
    # Maroon (mapped to red in HSV)
    "maroon_white":  ["red", "white"],
    "maroon_gold":   ["red", "yellow"],
    # Black
    "black_white":   ["black", "white"],
    "black_red":     ["black", "red"],
    "black_yellow":  ["black", "yellow"],
    "black_gold":    ["black", "yellow"],
    "black_blue":    ["black", "blue"],
    "black_green":   ["black", "green"],
    "black_orange":  ["black", "orange"],
    "black_purple":  ["black", "purple"],
    # Yellow
    "yellow_white":  ["yellow", "white"],
    "yellow_black":  ["yellow", "black"],
    "yellow_blue":   ["yellow", "blue"],
    # Green
    "green_white":   ["green", "white"],
    "green_black":   ["green", "black"],
    # Orange
    "orange_white":  ["orange", "white"],
    "orange_black":  ["orange", "black"],
    # Purple
    "purple_white":  ["purple", "white"],
    "purple_gold":   ["purple", "yellow"],
    "purple_black":  ["purple", "black"],
    # Gray
    "gray_white":    ["gray", "white"],
    "gray_black":    ["gray", "black"],
    # Solid
    "all_black":     ["black"],
    "all_white":     ["white"],
}

MY_TEAM_COLOR = args.my_team_color if args.my_team_color in TEAM_COLOR_PRESETS else "blue_white"
_MY_TEAM_COMPONENTS = TEAM_COLOR_PRESETS[MY_TEAM_COLOR]

OPPONENT_COLOR = args.opponent_color if args.opponent_color in TEAM_COLOR_PRESETS else "black_white"
if OPPONENT_COLOR == MY_TEAM_COLOR:
    OPPONENT_COLOR = next((k for k in TEAM_COLOR_PRESETS if k != MY_TEAM_COLOR), "black_white")
_OPP_TEAM_COMPONENTS = TEAM_COLOR_PRESETS[OPPONENT_COLOR]


def _base_color_masks(hsv):
    hh, ss, vv = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    return {
        "blue":   (hh >= 95)  & (hh <= 135) & (ss >= 40) & (vv >= 40),
        "red":    ((hh <= 10) | (hh >= 170)) & (ss >= 50) & (vv >= 50),
        "yellow": (hh >= 20)  & (hh <= 35)  & (ss >= 60) & (vv >= 100),
        "green":  (hh >= 40)  & (hh <= 85)  & (ss >= 40) & (vv >= 40),
        "orange": (hh >= 10)  & (hh <= 20)  & (ss >= 60) & (vv >= 100),
        "purple": (hh >= 140) & (hh <= 160) & (ss >= 40) & (vv >= 40),
        "gray":   (ss <= 30) & (vv > _BLACK_V_MAX) & (vv < _WHITE_V_MIN),
        "white":  (ss <= _WHITE_S_MAX) & (vv >= _WHITE_V_MIN),
        "black":  (vv <= _BLACK_V_MAX),
    }


def classify_jersey_color(crop):
    if crop is None or crop.size == 0:
        return None
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    total = hsv.shape[0] * hsv.shape[1]
    if total < 50:
        return None

    masks = _base_color_masks(hsv)
    ours_mask = np.zeros(hsv.shape[:2], dtype=bool)
    for c in _MY_TEAM_COMPONENTS:
        ours_mask |= masks[c]

    opp_mask = np.zeros(hsv.shape[:2], dtype=bool)
    for c in _OPP_TEAM_COMPONENTS:
        opp_mask |= masks[c]
    opp_mask &= ~ours_mask

    ours_frac = np.count_nonzero(ours_mask) / total
    opp_frac  = np.count_nonzero(opp_mask) / total

    if ours_frac < _TEAM_MIN_FRAC and opp_frac < _TEAM_MIN_FRAC:
        return None
    return "my_team" if ours_frac >= opp_frac else "opponent"


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

        if center_x < REFEREE_X_MARGIN or center_x > (1 - REFEREE_X_MARGIN):
            continue
        if center_y < REFEREE_HIGH_Y:
            continue
        if abs(center_y - COURT_MID_Y) < REFEREE_NET_BAND and \
                (center_x < REFEREE_EDGE_ZONE or center_x > 1 - REFEREE_EDGE_ZONE):
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

# --- TEAM-BY-COLOR voting (per bytetrack ID) ---
id_to_team: dict = {}
team_votes: dict = defaultdict(lambda: {"my_team": 0, "opponent": 0})
team_vote_attempts: dict = defaultdict(int)
MIN_TEAM_VOTES    = 5
TEAM_VOTE_MARGIN  = 3
TEAM_VOTE_STRIDE  = 4
MAX_TEAM_VOTE_ATTEMPTS = 30
inference_executor = ThreadPoolExecutor(max_workers=3)

# --- JERSEY MAP (pre-computed by predict_pipeline) ---
frame_jersey_map: dict = {}   # str(frame_idx) -> [{x1,y1,x2,y2,jersey}]
pid_to_jersey:    dict = {}   # tracker pid -> confirmed jersey number (resolved after loop)
pid_jersey_votes: dict = defaultdict(lambda: defaultdict(int))  # pid -> {jersey: vote_count}

if args.frame_jersey_map and os.path.exists(args.frame_jersey_map):
    with open(args.frame_jersey_map) as _f:
        frame_jersey_map = json.load(_f)
    print(f"[JERSEY] Loaded frame-jersey map: {len(frame_jersey_map)} keyed frames")
else:
    print("[JERSEY] No frame-jersey map — labels will show tracker IDs")


def _iou(ax1, ay1, ax2, ay2, bx1, by1, bx2, by2):
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
    if inter == 0:
        return 0.0
    union = (ax2-ax1)*(ay2-ay1) + (bx2-bx1)*(by2-by1) - inter
    return inter / union if union > 0 else 0.0


def _match_jersey(frame_idx, px1, py1, px2, py2):
    """Return jersey number from frame_jersey_map that best overlaps this bbox, or None."""
    if not frame_jersey_map:
        return None
    entries = frame_jersey_map.get(str(frame_idx), [])
    best_iou, best_jersey = 0.0, None
    for e in entries:
        iou = _iou(px1, py1, px2, py2, e["x1"], e["y1"], e["x2"], e["y2"])
        if iou > best_iou:
            best_iou, best_jersey = iou, e["jersey"]
    return best_jersey if best_iou >= 0.15 else None

# --- BALL LANDING DETECTION ---
BALL_TRAJ_WINDOW = 12

COURT_MID_Y = 0.5

ball_traj: list = []
ball_detections_for_viz: list = []   # for rally_detect visualizer (frame,track_id,x1,y1,x2,y2,cx,cy,conf)
landing_events: list = []
last_nonball_frames: int = 0
last_recorded_action: str = "none"

from ball_landing_detector import BallLandingDetector
court_calibrator = None
if args.calib_json and os.path.exists(args.calib_json):
    from court_calibration import CourtCalibrator
    court_calibrator = CourtCalibrator()
    court_calibrator.load(args.calib_json)
    print(f"Court calibration loaded: {args.calib_json}")
else:
    print("[INFO] No calibration — ball landings saved with court_position=null, landed_side='unknown'. No scoring.")

# Always create landing_detector; without calibration it emits landed_side="unknown"
landing_detector = BallLandingDetector(court_calibrator)

print(f"Running Fully Local 3-Model Pipeline over {total_frames} frames...")

# --- MINI COURT OVERLAY ---
_MC_W, _MC_H     = 240, 180   # mini court pixel dimensions
_MC_PAD          = 16          # margin from frame edge
_MC_INNER        = 9           # padding inside dark panel
_MC_HDR          = 18          # top header height (opponent label)
_MC_FTR          = 16          # footer height (camera arrow)


def _draw_mini_court(frame, ball_cp, recent_land):
    """Draw a 2-D mini court in the top-right corner of frame.

    court_y=0 → opponent (top of mini court)
    court_y=1 → my_team  (bottom of mini court)
    """
    fh, fw = frame.shape[:2]

    panel_w = _MC_W + _MC_INNER * 2
    panel_h = _MC_H + _MC_INNER * 2 + _MC_HDR + _MC_FTR
    px0 = fw - panel_w - _MC_PAD
    py0 = _MC_PAD

    # Semi-transparent dark background
    _ov = frame.copy()
    cv2.rectangle(_ov, (px0, py0), (px0 + panel_w, py0 + panel_h), (15, 15, 15), -1)
    cv2.addWeighted(_ov, 0.65, frame, 0.35, 0, frame)

    # Court rectangle top-left corner
    cx0 = px0 + _MC_INNER
    cy0 = py0 + _MC_INNER + _MC_HDR

    # Shade my_team half (bottom, court_y 0.5..1.0) with subtle green tint
    _my = frame.copy()
    cv2.rectangle(_my,
                  (cx0 + 1, cy0 + _MC_H // 2 + 1),
                  (cx0 + _MC_W - 1, cy0 + _MC_H - 1),
                  (20, 45, 20), -1)
    cv2.addWeighted(_my, 0.40, frame, 0.60, 0, frame)

    # Court outline
    cv2.rectangle(frame, (cx0, cy0), (cx0 + _MC_W, cy0 + _MC_H), (200, 200, 200), 1)

    # Net line at court_y=0.5 → 50 % height of mini court
    net_py = cy0 + _MC_H // 2
    cv2.line(frame, (cx0, net_py), (cx0 + _MC_W, net_py), (160, 160, 200), 2)

    # Centre-line dashes (vertical)
    for _dy in range(cy0, cy0 + _MC_H, 8):
        if _dy + 3 < cy0 + _MC_H:
            cv2.line(frame,
                     (cx0 + _MC_W // 2, _dy),
                     (cx0 + _MC_W // 2, _dy + 3),
                     (70, 70, 70), 1)

    # Team labels
    cv2.putText(frame, "OPP",
                (cx0 + 6, cy0 + 18),
                cv2.FONT_HERSHEY_SIMPLEX, 0.50, (130, 130, 200), 1)
    cv2.putText(frame, "MY TEAM",
                (cx0 + 6, cy0 + _MC_H - 8),
                cv2.FONT_HERSHEY_SIMPLEX, 0.50, (60, 220, 100), 1)

    # Footer: camera direction indicator
    cv2.putText(frame, "v CAM",
                (cx0, py0 + panel_h - 4),
                cv2.FONT_HERSHEY_SIMPLEX, 0.40, (110, 110, 110), 1)

    # court_x,court_y → pixel inside mini court
    def _cp(cxx, cyy):
        # court_y=0 → top (opponent), court_y=1 → bottom (my_team)
        mx = cx0 + int(max(0.0, min(1.0, cxx)) * _MC_W)
        my = cy0 + int(max(0.0, min(1.0, cyy)) * _MC_H)
        return (mx, my)

    # Landing event markers (keep visible for ~150 frames after each event)
    for ev in recent_land:
        _ecp  = ev.get("court_position")
        _side = ev.get("landed_side", "outside")
        if _ecp is None:
            continue
        _lpx, _lpy = _cp(_ecp[0], _ecp[1])
        _col = (50, 210, 80) if _side == "my_team" else \
               (60, 60, 240) if _side == "opponent" else \
               (0, 140, 255)
        cv2.circle(frame, (_lpx, _lpy), 9, _col, -1)
        cv2.circle(frame, (_lpx, _lpy), 11, (255, 255, 255), 1)

    # Live ball dot (cyan) — clamped inside court rect so it never escapes
    if ball_cp is not None:
        _bpx, _bpy = _cp(ball_cp[0], ball_cp[1])
        cv2.circle(frame, (_bpx, _bpy), 6, (0, 255, 255), -1)
        cv2.circle(frame, (_bpx, _bpy), 8, (255, 255, 255), 1)


ball_court_pos = None   # (court_x, court_y) for this frame's ball, or None

try:
    for _ in tqdm(range(total_frames), desc="Processing Video", unit="frame"):
        ret, frame = cap.read()
        if not ret:
            break

        frame_idx += 1

        # Run all models in parallel
        future_ball    = inference_executor.submit(ball_model.predict,    frame, **{"conf": CONF_BALL,    "imgsz": IMG_SIZE, "verbose": False})
        future_players = inference_executor.submit(players_model.track,   frame, **{"classes": [0], "conf": CONF_PLAYERS, "imgsz": IMG_SIZE, "max_det": 20, "tracker": os.path.join(SCRIPT_DIR, "botsort_volleyball.yaml"), "persist": True, "verbose": False})
        future_action  = inference_executor.submit(action_model.predict,  frame, **{"conf": CONF_ACTION,  "imgsz": IMG_SIZE, "verbose": False, "classes": [0, 1, 3, 4, 5]})
        ball_results   = future_ball.result()
        player_results = future_players.result()
        action_results = future_action.result()

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

                # Full-body crop for thumbnail
                pad_x = int((x2 - x1) * 0.2)
                pad_y = int((y2 - y1) * 0.15)
                cx1 = max(0, x1 - pad_x); cy1 = max(0, y1 - pad_y)
                cx2 = min(frame.shape[1], x2 + pad_x)
                cy2 = min(frame.shape[0], y2 + pad_y)
                full_crop = frame[cy1:cy2, cx1:cx2]
                if full_crop.size == 0:
                    continue

                # Team color voting using chest region crop
                need_team = (pid not in id_to_team
                             and team_vote_attempts[pid] < MAX_TEAM_VOTE_ATTEMPTS
                             and frame_idx % TEAM_VOTE_STRIDE == 0)

                if need_team:
                    bh = y2 - y1
                    chest_crop = frame[y1 + int(bh * 0.20):y1 + int(bh * 0.65), x1:x2]
                    team_vote_attempts[pid] += 1
                    team_guess = classify_jersey_color(chest_crop)
                    if team_guess is not None:
                        team_votes[pid][team_guess] += 1
                        my_v  = team_votes[pid]["my_team"]
                        opp_v = team_votes[pid]["opponent"]
                        if my_v >= MIN_TEAM_VOTES and my_v - opp_v >= TEAM_VOTE_MARGIN:
                            id_to_team[pid] = "my_team"
                        elif opp_v >= MIN_TEAM_VOTES and opp_v - my_v >= TEAM_VOTE_MARGIN:
                            id_to_team[pid] = "opponent"

                # Save one thumbnail per bytetrack ID
                if pid not in seen_player_ids:
                    seen_player_ids.add(pid)
                    cv2.imwrite(os.path.join(THUMBS_DIR, f"id{pid}.jpg"), full_crop)

        active_player = None
        min_dist = None
        current_action = "none"
        action_conf = 0.0
        # --- Ball trajectory + landing detection ---
        ball_court_pos = None   # used for mini court overlay (only if calibrated)
        _ball_det_for_landing = None

        if ball_box is not None:
            _x1b, _y1b, _x2b, _y2b = ball_box
            bx_n = (_x1b + _x2b) / 2 / w
            by_n = (_y1b + _y2b) / 2 / h

            ball_traj.append((frame_idx, bx_n, by_n))
            if len(ball_traj) > BALL_TRAJ_WINDOW:
                ball_traj.pop(0)
            ball_detections_for_viz.append({
                "frame": frame_idx, "track_id": 0,
                "x1": int(_x1b), "y1": int(_y1b), "x2": int(_x2b), "y2": int(_y2b),
                "cx": (_x1b + _x2b) / 2, "cy": (_y1b + _y2b) / 2,
                "conf": round(best_ball_conf, 4),
            })
            last_nonball_frames = 0

            _ball_det_for_landing = {
                "x": _x1b, "y": _y1b,
                "w": _x2b - _x1b, "h": _y2b - _y1b,
                "confidence": best_ball_conf,
            }

            # court position for mini court (only when calibration loaded)
            if court_calibrator is not None:
                _bc = court_calibrator.transform((_x1b + _x2b) / 2.0, float(_y2b))
                ball_court_pos = (_bc["court_x"], _bc["court_y"])
        else:
            last_nonball_frames += 1
            if last_nonball_frames > 15:
                ball_traj = []

        # Always run landing detector — emits landed_side="unknown" when no calibration
        _event = landing_detector.update(frame_idx, _ball_det_for_landing)
        if _event:
            _event["last_attacker_id"] = last_active_id
            _event["last_action"] = last_recorded_action
            # Pixel-based fallback: when no calibration, guess side from ball Y position
            if _event.get("landed_side") == "unknown" and _event.get("video_position"):
                _by_px = _event["video_position"][1]
                _by_norm = _by_px / h
                if OUR_TEAM_SIDE == "bottom":
                    _event["landed_side"] = "my_team" if _by_norm > COURT_MID_Y else "opponent"
                else:
                    _event["landed_side"] = "opponent" if _by_norm > COURT_MID_Y else "my_team"
                _event["calibration_type"] = "pixel_fallback"
            landing_events.append(_event)

        # Proximity Link Logic
        # ball_pixel_* used for drawing overlays and distance calculations (pixel space)
        # ball_norm_*  used for RF features and tracking_data JSON (normalized 0-1)
        ball_pixel_x = ball_pixel_y = None
        ball_norm_x  = ball_norm_y  = None

        if ball_box is not None:
            ball_c = box_center(ball_box)
            ball_pixel_x, ball_pixel_y = ball_c
            ball_norm_x  = round(ball_pixel_x / w, 4)
            ball_norm_y  = round(ball_pixel_y / h, 4)
            if len(players) > 0:
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

        if current_action not in ("none", ""):
            last_recorded_action = current_action

        # Record Structural Analytics Data
        active_id     = active_player["id"] if active_player else None
        active_x_norm = active_y_norm = None
        if active_player is not None:
            bx1, by1, bx2, by2 = active_player["box"]
            active_x_norm = round(((bx1 + bx2) / 2) / w, 4)
            active_y_norm = round(((by1 + by2) / 2) / h, 4)
        tracking_data.append({
            "frame":               frame_idx,
            "ball":                {"x": ball_pixel_x, "y": ball_pixel_y} if ball_box else None,
            "active_player_id":    active_id,
            "active_player_team":  id_to_team.get(active_id, None) if active_id is not None else None,
            "active_player_jersey": pid_to_jersey.get(active_id) if active_id is not None else None,
            "active_player_x":     active_x_norm,
            "active_player_y":     active_y_norm,
            "distance_to_ball":    min_dist,
            "action":              current_action,
            "action_confidence":   action_conf,
        })

        # Save incrementally every 500 frames so data isn't lost if stopped
        if frame_idx % 500 == 0:
            with open(OUTPUT_JSON, "w") as f:
                json.dump({"frames": tracking_data, "ball_landings": landing_events}, f, indent=4)
            _reg = {}
            from collections import Counter as _Counter
            _counts = _Counter(
                d["active_player_id"] for d in tracking_data
                if d.get("active_player_id") is not None and d.get("action", "none") not in ("none", "", None)
            )
            for _bid, _count in _counts.most_common():
                _thumb = os.path.join(THUMBS_DIR, f"id{_bid}.jpg")
                _reg[str(_bid)] = {
                    "confirmed": False,
                    "thumbnail": _thumb if os.path.exists(_thumb) else None,
                    "event_count": _count,
                    "team": id_to_team.get(_bid, "unknown"),
                }
            with open(REGISTRY_JSON, "w") as f:
                json.dump(_reg, f, indent=4)

        # --- VISUALIZATION DRAWING ---
        # Ball box + trail are added by rally_detect visualizer (post-processing pass)

        # 1. Draw players — my_team vivid, opponent grey
        confirmed_our_ids = {pid for pid, t in id_to_team.items() if t == "my_team"}
        confirmed_opp_ids = {pid for pid, t in id_to_team.items() if t == "opponent"}

        if player_results and len(player_results) > 0 and player_results[0].boxes is not None:
            raw_boxes = player_results[0].boxes
            raw_xyxy  = raw_boxes.xyxy.cpu().numpy()
            raw_cls   = raw_boxes.cls.cpu().numpy()
            raw_ids   = raw_boxes.id.cpu().numpy() if raw_boxes.id is not None else None

            for i, raw_box in enumerate(raw_xyxy):
                if int(raw_cls[i]) != 0:
                    continue
                rx1, ry1, rx2, ry2 = map(int, raw_box[:4])
                rx1, ry1 = max(0, rx1), max(0, ry1)
                rx2, ry2 = min(w - 1, rx2), min(h - 1, ry2)
                if (rx2 - rx1) * (ry2 - ry1) < MIN_BOX_AREA:
                    continue

                pid    = int(raw_ids[i]) if raw_ids is not None else -1
                cx_raw = (rx1 + rx2) / 2 / w
                cy_raw = (ry1 + ry2) / 2 / h

                if pid in confirmed_our_ids:
                    is_our_team = True
                elif pid in confirmed_opp_ids:
                    is_our_team = False
                else:
                    is_our_team = (cy_raw > COURT_MID_Y) if OUR_TEAM_SIDE == "bottom" \
                                  else (cy_raw < COURT_MID_Y)

                if is_our_team:
                    is_act = (active_player is not None and pid == active_player["id"]
                              and current_action != "none")
                    base_color   = player_color(pid)
                    action_color = ACTION_COLORS.get(current_action, base_color)
                    color        = action_color if is_act else base_color
                    cv2.rectangle(frame, (rx1, ry1), (rx2, ry2), color, 2)
                    _by_color = id_to_team.get(pid) == "my_team"
                    if court_calibrator is not None and court_calibrator.is_ready():
                        _cpos = court_calibrator.transform((rx1 + rx2) / 2, ry2)
                        _should_match = _by_color and _cpos["court_y"] >= 0.5
                    else:
                        _should_match = _by_color
                    if _should_match:
                        matched = _match_jersey(frame_idx, rx1, ry1, rx2, ry2)
                        if matched is not None:
                            pid_jersey_votes[pid][matched] += 1
                            if pid not in pid_to_jersey:
                                pid_to_jersey[pid] = matched
                    # For video display: use confirmed jersey, or direct frame lookup (near side by pixel)
                    _display_jersey = pid_to_jersey.get(pid)
                    if _display_jersey is None and ry2 > h * 0.5:
                        _display_jersey = _match_jersey(frame_idx, rx1, ry1, rx2, ry2)
                    player_label = f"#{_display_jersey}" if _display_jersey is not None else "?"
                    cv2.putText(frame, player_label, (rx1, max(20, ry1 - 10)),
                                cv2.FONT_HERSHEY_SIMPLEX, 0.7, color, 2)
                    if is_act:
                        by1, by2 = max(0, ry1 - 45), max(20, ry1 - 10)
                        cv2.rectangle(frame, (rx1, by1), (rx1 + 190, by2), color, -1)
                        cv2.putText(frame, f"{current_action.upper()}!",
                                    (rx1 + 5, by2 - 5), cv2.FONT_HERSHEY_DUPLEX, 0.8, (0, 0, 0), 2)
                else:
                    cv2.rectangle(frame, (rx1, ry1), (rx2, ry2), (110, 110, 110), 1)

        # 3. Draw team labels
        mid_y_px = int(COURT_MID_Y * h)
        cv2.putText(frame, "US", (8, mid_y_px + 22),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 200, 255), 2)
        cv2.putText(frame, "OPP", (8, mid_y_px - 8),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, (120, 120, 120), 2)

        cv2.putText(frame, f"Frame {frame_idx}", (20, 32), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)

        # Mini court overlay — only when calibration is loaded
        if court_calibrator is not None:
            _recent = [e for e in landing_events if frame_idx - e["frame"] <= 90]
            _draw_mini_court(frame, ball_court_pos, _recent)

        writer.write(frame)

except KeyboardInterrupt:
    print("\nProcessing interrupted early. Saving tracking analytics data...")

# --- CLEANUP ---
cap.release()
writer.release()
inference_executor.shutdown(wait=False)

import subprocess as _sp

# --- DEAD SEGMENT DETECTION (RF Play/No-Play model) ---
DEAD_MIN_SEC    = 3.0
_DEAD_MIN_FRAMES = int(DEAD_MIN_SEC * fps)
dead_segments   = []

_RF_MODEL_PATH = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "rally", "models", "rally_prediction", "rally_predictor_rf_v4.pkl"))

print("\n" + "=" * 60)
print("[RF] Dead segment detection — Play/No-Play model")
print(f"[RF] Model path : {_RF_MODEL_PATH}")
print(f"[RF] Model found: {os.path.exists(_RF_MODEL_PATH)}")
print(f"[RF] Total frames in tracking_data: {len(tracking_data)}")

_ball_frames_count = sum(
    1 for _e in tracking_data
    if _e.get("ball") and _e["ball"].get("x") is not None
)
print(f"[RF] Frames with ball detected: {_ball_frames_count} "
      f"({100 * _ball_frames_count // max(1, len(tracking_data))}%)")

if not os.path.exists(_RF_MODEL_PATH):
    print("[RF] ERROR: model file not found — skipping RF detection")
else:
    try:
        import tempfile
        import traceback as _tb
        import sys as _sys
        import pandas as _pd

        _RALLY_DETECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "rally"))
        for _rp in [_RALLY_DETECT_ROOT, os.path.join(_RALLY_DETECT_ROOT, "src")]:
            if _rp not in _sys.path:
                _sys.path.insert(0, _rp)

        from src.ball_detector.track_ball_detections  import track_with_physics_predictive
        from src.ball_detector.clean_tracking_data    import clean_noise
        from src.rally_predictor                      import extract_features, predict_rallies, smooth_predictions
        from src.rally_predictor.predictions_handler  import analyze_rally_stats as _analyze_rally_stats

        # Temp files for each pipeline stage
        _tmp_raw   = tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False)
        _tmp_track = tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False)
        _tmp_clean = tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False)
        _tmp_feat  = tempfile.NamedTemporaryFile(mode='w', suffix='.csv', delete=False)
        _tmp_raw_path, _tmp_track_path = _tmp_raw.name, _tmp_track.name
        _tmp_clean_path, _tmp_feat_path = _tmp_clean.name, _tmp_feat.name
        for _tf in [_tmp_raw, _tmp_track, _tmp_clean, _tmp_feat]:
            _tf.close()

        # ── Stage: raw detections (from main loop — skips re-running YOLO) ──
        # track_with_physics_predictive expects: frame, x1, y1, x2, y2, conf
        _pd.DataFrame(ball_detections_for_viz)[
            ["frame", "x1", "y1", "x2", "y2", "conf"]
        ].to_csv(_tmp_raw_path, index=False)
        print(f"[RF] Stage raw   : {len(ball_detections_for_viz)} ball detections")

        # ── Stage: Tracking ──────────────────────────────────────────────────
        track_with_physics_predictive(input_csv=_tmp_raw_path, output_csv=_tmp_track_path)
        _n_tracked = len(_pd.read_csv(_tmp_track_path))
        print(f"[RF] Stage track : {_n_tracked} rows after physics tracking")

        # ── Stage: Cleaning ──────────────────────────────────────────────────
        clean_noise(tracking_csv=_tmp_track_path, output_csv=_tmp_clean_path)
        _n_clean = len(_pd.read_csv(_tmp_clean_path))
        print(f"[RF] Stage clean : {_n_clean} rows after noise removal")

        # ── Stage: Features ──────────────────────────────────────────────────
        extract_features(input_csv=_tmp_clean_path, output_csv=_tmp_feat_path)
        print(f"[RF] Stage feat  : features extracted")

        # ── Stage: Prediction ────────────────────────────────────────────────
        _raw_preds = predict_rallies(_RF_MODEL_PATH, _tmp_feat_path)
        _n_play  = sum(1 for p in _raw_preds if int(p) == 1)
        _n_nplay = sum(1 for p in _raw_preds if int(p) == 0)
        print(f"[RF] Stage pred  : {len(_raw_preds)} frames | PLAY={_n_play} | NO_PLAY={_n_nplay}")

        _smoothed = smooth_predictions(list(_raw_preds))
        _n_play_s  = sum(1 for p in _smoothed if int(p) == 1)
        _n_nplay_s = sum(1 for p in _smoothed if int(p) == 0)
        print(f"[RF] After smooth: PLAY={_n_play_s} | NO_PLAY={_n_nplay_s}")

        # Write play_state to every frame entry
        _smoothed_len = len(_smoothed)
        for _entry in tracking_data:
            _fi = _entry["frame"]
            _entry["play_state"] = "PLAY" if _fi < _smoothed_len and int(_smoothed[_fi]) == 1 else "NO_PLAY"

        # ── Stage: Analyze — builds rally_windows AND dead_segments ──────────
        _stats, _segments_df = _analyze_rally_stats(_smoothed, fps)
        print(f"[RF] Stats: { {k: v for k, v in _stats.items()} }")

        rally_windows = []
        _frame_cursor = 0
        for _, _seg in _segments_df.iterrows():
            _sf = _frame_cursor
            _ef = _frame_cursor + int(_seg["frame_count"]) - 1
            if int(_seg["label"]) == 1:
                rally_windows.append({
                    "start_frame": _sf, "end_frame": _ef,
                    "start_sec":   round(_sf / fps, 3),
                    "end_sec":     round(_ef / fps, 3),
                })
            elif int(_seg["label"]) == 0 and (_ef - _sf) >= _DEAD_MIN_FRAMES:
                dead_segments.append({
                    "start_frame": _sf, "end_frame": _ef,
                    "start_sec":   round(_sf / fps, 3),
                    "end_sec":     round(_ef / fps, 3),
                })
            _frame_cursor = _ef + 1

        for _p in [_tmp_raw_path, _tmp_track_path, _tmp_clean_path, _tmp_feat_path]:
            try: os.remove(_p)
            except OSError: pass

        _total_dead = sum(d["end_sec"] - d["start_sec"] for d in dead_segments)
        print(f"[RF] Rally windows  : {len(rally_windows)}")
        print(f"[RF] Dead segments  : {len(dead_segments)}  ({_total_dead:.1f}s  "
              f"{100 * _total_dead / max(1, frame_idx / fps):.1f}%)")

    except Exception as _rf_err:
        print(f"[RF] ERROR: {_rf_err}")
        print(_tb.format_exc())

print("=" * 60)
print(f"[DEAD SEGMENTS] Final count: {len(dead_segments)}")

def _trimmed_sec(orig_sec):
    offset = 0.0
    for ds in dead_segments:
        if orig_sec >= ds["end_sec"]:
            offset += ds["end_sec"] - ds["start_sec"]
        elif orig_sec > ds["start_sec"]:
            offset += orig_sec - ds["start_sec"]
    return round(max(0.0, orig_sec - offset), 3)

for _entry in tracking_data:
    _entry["time_sec"] = _trimmed_sec(_entry["frame"] / fps)
for _land in landing_events:
    _land["time_sec"] = _trimmed_sec(_land["frame"] / fps)

# --- CONVERT AVI → H264 MP4 (with silent audio so rally_detect visualizer can use [1:a]) ---
try:
    _r = _sp.run(
        ["ffmpeg", "-y",
         "-i", OUTPUT_VIDEO_RAW,
         "-f", "lavfi", "-i", f"anullsrc=r=44100:cl=stereo",
         "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
         "-c:a", "aac", "-b:a", "64k",
         "-shortest", "-threads", "0", "-movflags", "+faststart",
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

# Resolve jersey numbers by majority vote across all frames — but only trust
# the vote once it clears a minimum sample size. Without this floor, a track
# fragment that only exists for a couple of frames (e.g. right after an
# occlusion re-acquire) can have its own majority vote "won" by a single
# misread, getting confirmed as an entirely different jersey number than the
# same physical player's other, longer-lived fragments (observed in practice:
# jersey 42 also showing up registered as jersey 2).
MIN_JERSEY_VOTES = 5

for pid, votes in pid_jersey_votes.items():
    if not votes:
        continue
    best_jersey = max(votes, key=votes.get)
    best_count = votes[best_jersey]
    if best_count >= MIN_JERSEY_VOTES:
        pid_to_jersey[pid] = best_jersey
        print(f"[JERSEY] ID {pid} -> #{best_jersey} (votes: {dict(votes)})")
    else:
        print(f"[JERSEY] ID {pid} -> unconfirmed (best guess #{best_jersey} only had {best_count} vote(s), need {MIN_JERSEY_VOTES}): {dict(votes)}")

# Retroactively fill jersey numbers — only for my_team players
for entry in tracking_data:
    pid = entry.get("active_player_id")
    if pid is not None and entry.get("active_player_jersey") is None:
        if id_to_team.get(pid) == "my_team":
            j = pid_to_jersey.get(pid)
            if j is not None:
                entry["active_player_jersey"] = j

with open(OUTPUT_JSON, "w") as f:
    json.dump({
        "fps":           fps,
        "frames":        tracking_data,
        "ball_landings": landing_events,
        "dead_segments": dead_segments,
        "rally_windows": rally_windows if 'rally_windows' in dir() else [],
    }, f, indent=4)

# ── rally_detect visualizer — ball trail + box overlay ────────────────────────
import tempfile as _tmpfile
import pandas as _pd

_RALLY_DETECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", "rally"))
if _RALLY_DETECT_ROOT not in sys.path:
    sys.path.insert(0, _RALLY_DETECT_ROOT)

try:
    from src.visualizer.visualize_data import visualize as _rd_visualize

    _ball_csv = _tmpfile.NamedTemporaryFile(suffix=".csv", delete=False, mode="w")
    _pd.DataFrame(ball_detections_for_viz).to_csv(_ball_csv.name, index=False)
    _ball_csv.close()

    _pred_csv_path = None
    if dead_segments:
        _pred_rows = []
        _seg_set = {(d["start_frame"], d["end_frame"]) for d in dead_segments}
        for fi in range(frame_idx + 1):
            _in_dead = any(s <= fi <= e for s, e in _seg_set)
            _pred_rows.append({"label": 0 if _in_dead else 1})
        _pred_csv = _tmpfile.NamedTemporaryFile(suffix=".csv", delete=False, mode="w")
        _pd.DataFrame(_pred_rows).to_csv(_pred_csv.name, index=False)
        _pred_csv.close()
        _pred_csv_path = _pred_csv.name

    BALL_VIZ_OUTPUT = os.path.join(OUTPUT_DIR, "ball_tracking_viz")
    print("[VIZ] Running rally_detect visualizer on analyzed video...")
    _rd_visualize(
        video_path=OUTPUT_VIDEO,
        output_path=BALL_VIZ_OUTPUT + ".mp4",
        tracking_csv=_ball_csv.name,
        predictions_csv=_pred_csv_path,
        overlay_mode="both",
        log_callback=print,
    )
    print(f"[VIZ] Ball tracking video saved → {BALL_VIZ_OUTPUT}_both.mp4")

    for _f in [_ball_csv.name, _pred_csv_path]:
        if _f:
            try: os.remove(_f)
            except OSError: pass

except Exception as _viz_err:
    import traceback as _viz_tb
    print(f"[VIZ] rally_detect visualizer failed (non-fatal): {_viz_err}")
    print(_viz_tb.format_exc())

# Build registry keyed by jersey number (permanent ID), not bytetrack ID
from collections import Counter

# Count actions per jersey number (primary) or tracker ID (fallback for unidentified)
jersey_event_count  = Counter()
tracker_event_count = Counter()
for d in tracking_data:
    if d.get("action", "none") in ("none", "", None):
        continue
    j = d.get("active_player_jersey")
    if j is not None:
        jersey_event_count[j] += 1
    elif d.get("active_player_id") is not None:
        tracker_event_count[d["active_player_id"]] += 1

registry = {}

# Confirmed jersey players — keyed by "#<number>"
for jersey_num, count in jersey_event_count.most_common():
    # Collect all tracker IDs that mapped to this jersey
    all_tids = [pid for pid, j in pid_to_jersey.items() if j == jersey_num]
    thumb = next(
        (os.path.join(THUMBS_DIR, f"id{t}.jpg")
         for t in all_tids if os.path.exists(os.path.join(THUMBS_DIR, f"id{t}.jpg"))),
        None
    )
    registry[f"#{jersey_num}"] = {
        "confirmed":   True,
        "jersey":      jersey_num,
        "track_ids":   all_tids,
        "thumbnail":   thumb,
        "event_count": count,
        "team":        "my_team",
    }

# Digit-truncation heuristic: a lightly-tracked jersey number that's just the
# suffix of a much more heavily-tracked one (e.g. "2" vs "42") is very likely
# the same physical player misread with a clipped/blurred leading digit, not
# a distinct player — auto-fold the low-confidence one into the high-confidence
# one rather than leaving them as two separate registry entries. Conservative
# on purpose: only merges when the short number's support is low and the long
# number's support is clearly dominant, so two real jerseys like "2" and "42"
# both genuinely present on the roster are left alone. Anything this doesn't
# catch (or gets wrong) can still be fixed by hand in the coach-facing merge UI.
SUFFIX_MERGE_MAX_VOTES  = 3   # the short/truncated number must be rarely seen
SUFFIX_MERGE_MIN_TARGET = 10  # the real number must be well-established

jersey_keys = [k for k in registry if k.startswith("#")]
for short_key in jersey_keys:
    short = registry.get(short_key)
    if not short or short["event_count"] > SUFFIX_MERGE_MAX_VOTES:
        continue
    short_jersey = str(short["jersey"])
    for long_key in jersey_keys:
        if long_key == short_key or long_key not in registry:
            continue
        long_entry = registry[long_key]
        long_jersey = str(long_entry["jersey"])
        if (long_jersey.endswith(short_jersey) and long_jersey != short_jersey
                and long_entry["event_count"] >= SUFFIX_MERGE_MIN_TARGET
                and long_entry["team"] == short["team"]):
            print(f"[JERSEY] Folding #{short_jersey} ({short['event_count']} events) into "
                  f"#{long_jersey} ({long_entry['event_count']} events) — likely a truncated OCR read")
            long_entry["track_ids"] = list(set(long_entry["track_ids"] + short["track_ids"]))
            long_entry["event_count"] += short["event_count"]
            if not long_entry["thumbnail"] and short["thumbnail"]:
                long_entry["thumbnail"] = short["thumbnail"]
            del registry[short_key]
            break

# Unidentified players (no jersey confirmed) — keyed by tracker ID for debug only
for bid, count in tracker_event_count.most_common():
    thumb = os.path.join(THUMBS_DIR, f"id{bid}.jpg")
    if not os.path.exists(thumb):
        thumb = None
    registry[f"id_{bid}"] = {
        "confirmed":   False,
        "jersey":      None,
        "track_ids":   [bid],
        "thumbnail":   thumb,
        "event_count": count,
        "team":        id_to_team.get(bid, "unknown"),
    }

with open(REGISTRY_JSON, "w") as f:
    json.dump(registry, f, indent=4)

_my_count  = sum(1 for t in id_to_team.values() if t == "my_team")
_opp_count = sum(1 for t in id_to_team.values() if t == "opponent")
print("Execution complete!")
print("Video saved to:", OUTPUT_VIDEO)
print("Analytics JSON saved to:", OUTPUT_JSON)
print(f"Teams by jersey color: my_team={_my_count}, opponent={_opp_count}, unconfirmed={len(seen_player_ids) - _my_count - _opp_count}")
print(f"Player registry saved to: {REGISTRY_JSON}")
