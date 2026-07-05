import sys
import cv2
import os
import argparse
import numpy as np
from ultralytics import YOLO
from collections import defaultdict, Counter
import easyocr

# --- 1. SETUP PATHS ---
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# --- ARGS (replaces interactive input) ---
_parser = argparse.ArgumentParser()
_parser.add_argument("--video",            default=os.path.abspath(os.path.join(SCRIPT_DIR, "../videos/test_clip.mp4")))
_parser.add_argument("--output",           default=os.path.abspath(os.path.join(SCRIPT_DIR, "output_tracking.mp4")))
_parser.add_argument("--my-team-color",    default="blue_white",  help="e.g. blue_white, red_white")
_parser.add_argument("--libero-color",     default="",            help="Libero preset, blank if none")
_parser.add_argument("--opponent-color",   default="black_white", help="e.g. black_white, red_white")
_parser.add_argument("--output-json",      default="",            help="Path to save jersey registry JSON")
_parser.add_argument("--thumbs-dir",       default="",            help="Directory to save player thumbnails")
_parser.add_argument("--frame-jersey-map", default="",            help="Path to save frame→bbox→jersey JSON for triple_detection")
_args = _parser.parse_args()

VIDEO_PATH   = _args.video
OUTPUT_PATH  = _args.output
OUTPUT_JSON  = _args.output_json
THUMBS_DIR   = _args.thumbs_dir

if THUMBS_DIR:
    os.makedirs(THUMBS_DIR, exist_ok=True)

PLAYER_MODEL = YOLO(os.path.join(SCRIPT_DIR, "yolo11s.pt"))
JERSEY_MODEL = YOLO(os.path.join(SCRIPT_DIR, "jersey_model.pt"))

# --- 2. OCR SETUP ---
print("[INIT] Loading EasyOCR...")
OCR_READER = easyocr.Reader(['en'], gpu=False, verbose=False)

# --- 3. JERSEY ID MAPPING STATE ---
VOTE_THRESHOLD = 5
RE_ID_THRESHOLD = 2

jersey_votes = defaultdict(Counter)
tracker_to_jersey   = {}              # track_id  -> confirmed jersey number (int)
jersey_to_track_ids = defaultdict(set)  # jersey_num -> all track_ids ever assigned (persistent)

# --- 3b. TEAM CLASSIFICATION VIA K-MEANS ON ACTUAL VIDEO COLOURS ---
# Real jersey colours under stadium lighting are far less saturated/bright than
# named presets (e.g. "blue" preset = HSV(120,255,255) but actual blue jerseys =
# HSV(120,~150,~90)). Instead of comparing directly against user-typed colours,
# k-means discovers the actual cluster centroids from the first N detections.
# The user's colour hints are used only to decide WHICH cluster is which role.

BOOTSTRAP_SAMPLE_TARGET = 40  # torso samples collected before running k-means
TEAM_VOTE_MIN = 3             # votes per track before locking in a role
OFFICIAL_THRESHOLD = 80       # dist to nearest centroid above this -> 'OTHER' (refs/crowd)

# Map the first component of a preset key to a dominant BGR colour (k-means hint)
_PRESET_DOMINANT_BGR = {
    "white":  (255, 255, 255),
    "blue":   (255,   0,   0),   # BGR
    "navy":   (128,   0,   0),
    "red":    (  0,   0, 255),
    "maroon": (  0,   0, 100),
    "black":  (  0,   0,   0),
    "yellow": (  0, 255, 255),
    "green":  (  0, 200,   0),
    "orange": (  0, 165, 255),
    "purple": (128,   0, 128),
    "gray":   (128, 128, 128),
    "gold":   (  0, 215, 255),
}

def _preset_to_bgr(preset_key: str):
    """Return the dominant BGR colour for a preset key (e.g. 'blue_white' → blue)."""
    first = (preset_key or "").split("_")[0]
    rgb = _PRESET_DOMINANT_BGR.get(first, (128, 128, 128))
    return np.array(rgb, dtype=np.uint8)

ROLE_BOX_COLORS = {
    'MAIN':     (0, 200, 0),      # green  - our team main jersey
    'LIBERO':   (0, 215, 255),    # yellow - our libero
    'OPPONENT': (255, 100, 0),    # orange - opponent (no OCR)
    'OTHER':    (160, 160, 160),  # gray   - referee / crowd
}

team_color_samples = []          # bootstrap buffer of HSV colours
cluster_centroids = None         # np.ndarray (k, 3) once bootstrapped
cluster_roles = {}               # centroid index -> role string
team_votes = defaultdict(Counter)
team_labels_by_track = {}
track_thumbnails = {}            # track_id -> saved thumbnail path
track_positions = defaultdict(list)  # track_id -> [(frame_idx, x1, y1, x2, y2)]


def bgr_to_hsv(bgr: np.ndarray) -> np.ndarray:
    patch = np.uint8([[bgr]])
    return cv2.cvtColor(patch, cv2.COLOR_BGR2HSV)[0, 0].astype(np.float32)


_main_bgr     = _preset_to_bgr(_args.my_team_color)
_libero_bgr   = _preset_to_bgr(_args.libero_color)   if _args.libero_color   else None
_opponent_bgr = _preset_to_bgr(_args.opponent_color) if _args.opponent_color else None
print(f"[TEAM COLORS] my_team={_args.my_team_color}  libero={_args.libero_color or 'none'}  opponent={_args.opponent_color or 'none'}")

_main_hsv     = bgr_to_hsv(_main_bgr)     if _main_bgr     is not None else None
_libero_hsv   = bgr_to_hsv(_libero_bgr)   if _libero_bgr   is not None else None
_opponent_hsv = bgr_to_hsv(_opponent_bgr) if _opponent_bgr is not None else None
TEAM_FILTER_ENABLED = _main_hsv is not None
K_CLUSTERS = 3 if (_libero_bgr is not None) else 2


def extract_torso_color(crop: np.ndarray):
    """Median HSV of the torso strip (upper-middle of bounding box = jersey area)."""
    if crop is None or crop.size == 0:
        return None
    h, w = crop.shape[:2]
    if h < 10 or w < 10:
        return None
    torso = crop[int(0.15*h):int(0.55*h), int(0.25*w):int(0.75*w)]
    if torso.size == 0:
        return None
    hsv = cv2.cvtColor(torso, cv2.COLOR_BGR2HSV)
    return np.median(hsv.reshape(-1, 3).astype(np.float32), axis=0)


def hsv_distance(c1: np.ndarray, c2: np.ndarray) -> float:
    """Perceptual HSV distance. Hue is circular; grayscale colours compare on V/S only."""
    h1, s1, v1 = c1
    h2, s2, v2 = c2
    if s1 < 40 or s2 < 40:   # black / white / gray - hue meaningless
        return float(((v1-v2)**2 + ((s1-s2)*0.5)**2) ** 0.5)
    dh = min(abs(h1-h2), 180-abs(h1-h2)) * 2.0
    return float((dh**2 + (s1-s2)**2 + ((v1-v2)*0.5)**2) ** 0.5)


def bootstrap_kmeans():
    """
    Run k-means on collected samples and assign cluster roles.
    The user-provided colour hints determine which centroid is which role;
    all hints compete against every centroid so no hint can "steal" a centroid
    that belongs to another role (e.g. whitish opponent stealing LIBERO).
    Prints centroid HSV so the user can verify the assignment.
    """
    global cluster_centroids, cluster_roles
    data = np.array(team_color_samples, dtype=np.float32)
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 50, 0.5)
    _, _, centers = cv2.kmeans(data, K_CLUSTERS, None, criteria, 5, cv2.KMEANS_PP_CENTERS)

    assigned = set()
    cluster_roles = {}

    hints = [('MAIN', _main_hsv)]
    if _libero_hsv   is not None: hints.append(('LIBERO',   _libero_hsv))
    if _opponent_hsv is not None: hints.append(('OPPONENT', _opponent_hsv))

    for role, ref in hints:
        dists = [hsv_distance(centers[i], ref) if i not in assigned else float('inf')
                 for i in range(K_CLUSTERS)]
        best = int(np.argmin(dists))
        cluster_roles[best] = role
        assigned.add(best)

    # Any remaining centroid (no hint given for it) falls back to OPPONENT
    for i in range(K_CLUSTERS):
        if i not in cluster_roles:
            cluster_roles[i] = 'OPPONENT'

    cluster_centroids = centers
    print(f"[INFO] k-means done (k={K_CLUSTERS}) from {len(data)} samples:")
    for i in range(K_CLUSTERS):
        print(f"  Centroid {i} ({cluster_roles[i]}): HSV={np.round(centers[i], 1).tolist()}")


def classify_color(color: np.ndarray):
    """Classify a torso colour against k-means centroids. Returns role string or None."""
    if cluster_centroids is None or color is None:
        return None
    dists = [hsv_distance(color, cluster_centroids[i]) for i in range(K_CLUSTERS)]
    nearest = int(np.argmin(dists))
    if dists[nearest] > OFFICIAL_THRESHOLD:
        return 'OTHER'
    return cluster_roles[nearest]


def update_team_label(track_id: int, player_crop: np.ndarray):
    """
    During bootstrap: collect torso colour samples.
    After bootstrap: classify and vote-stabilise the track's role.
    """
    color = extract_torso_color(player_crop)
    if color is None:
        return

    if cluster_centroids is None:
        if len(team_color_samples) < BOOTSTRAP_SAMPLE_TARGET:
            team_color_samples.append(color)
        if len(team_color_samples) >= BOOTSTRAP_SAMPLE_TARGET:
            bootstrap_kmeans()
        return

    role = classify_color(color)
    if role is None:
        return
    team_votes[track_id][role] += 1
    if sum(team_votes[track_id].values()) >= TEAM_VOTE_MIN:
        team_labels_by_track[track_id] = team_votes[track_id].most_common(1)[0][0]


# --- JERSEY DETECTION + OCR HELPERS ---

def preprocess_for_ocr(crop: np.ndarray) -> np.ndarray:
    h, w = crop.shape[:2]
    if h < 40 or w < 30:
        scale = max(40 / max(h, 1), 30 / max(w, 1))
        crop = cv2.resize(crop, (int(w*scale), int(h*scale)), interpolation=cv2.INTER_CUBIC)
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return binary


def read_jersey_number(crop: np.ndarray):
    if crop is None or crop.size == 0:
        return None
    results = OCR_READER.readtext(preprocess_for_ocr(crop), allowlist='0123456789', detail=0)
    for text in results:
        text = text.strip()
        if text.isdigit() and 1 <= int(text) <= 99:
            return int(text)
    return None


def detect_jersey_region(player_crop: np.ndarray):
    if player_crop is None or player_crop.size == 0:
        return None, None
    results = JERSEY_MODEL(player_crop, conf=0.4, verbose=False)
    best_box, best_conf = None, 0.0
    for r in results:
        for j_box in r.boxes:
            conf = float(j_box.conf[0])
            if conf > best_conf:
                best_conf = conf
                best_box = j_box.xyxy[0]
    if best_box is not None:
        jx1, jy1, jx2, jy2 = map(int, best_box)
        jersey_crop = player_crop[max(0, jy1):jy2, max(0, jx1):jx2]
        return jersey_crop, (jx1, jy1, jx2, jy2)
    return None, None


def update_jersey_mapping(track_id: int, jersey_num: int):
    jersey_votes[track_id][jersey_num] += 1
    # Fewer votes needed to re-link a track_id to an already-known jersey
    already_known = len(jersey_to_track_ids[jersey_num]) > 0
    threshold = RE_ID_THRESHOLD if already_known else VOTE_THRESHOLD
    if jersey_votes[track_id][jersey_num] >= threshold:
        tracker_to_jersey[track_id] = jersey_num
        jersey_to_track_ids[jersey_num].add(track_id)


# --- 4. INITIALIZE VIDEO ---
cap = cv2.VideoCapture(VIDEO_PATH)
if not cap.isOpened():
    raise RuntimeError(f"Cannot open video: {VIDEO_PATH}")

frame_width  = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
frame_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
fps = int(cap.get(cv2.CAP_PROP_FPS)) or 30
out = cv2.VideoWriter(OUTPUT_PATH, cv2.VideoWriter_fourcc(*'mp4v'),
                      fps, (frame_width, frame_height))

total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 1
print(f"[START] Processing video (team filter: {'ON' if TEAM_FILTER_ENABLED else 'OFF'})...")

frame_idx = 0
while cap.isOpened():
    success, frame = cap.read()
    if not success:
        break
    frame_idx += 1

    player_results = PLAYER_MODEL.track(
        frame, persist=True, conf=0.5, classes=[0], verbose=False
    )

    if player_results[0].boxes.id is None:
        out.write(frame)
        continue

    boxes     = player_results[0].boxes.xyxy.cpu().numpy()
    track_ids = player_results[0].boxes.id.cpu().numpy().astype(int)

    for box, track_id in zip(boxes, track_ids):
        x1, y1, x2, y2 = map(int, box)
        player_crop   = frame[y1:y2, x1:x2]
        jersey_abs_box = None

        # Record position for frame-jersey map
        track_positions[int(track_id)].append((frame_idx, x1, y1, x2, y2))

        # Save one thumbnail per track_id
        if THUMBS_DIR and track_id not in track_thumbnails and player_crop.size > 0:
            thumb_path = os.path.join(THUMBS_DIR, f"jersey_id{track_id}.jpg")
            cv2.imwrite(thumb_path, player_crop)
            track_thumbnails[track_id] = thumb_path

        # --- Team classification ---
        if TEAM_FILTER_ENABLED and track_id not in team_labels_by_track:
            update_team_label(track_id, player_crop)

        role = team_labels_by_track.get(track_id) if TEAM_FILTER_ENABLED else 'MAIN'

        # Only run jersey OCR for our own players (MAIN or LIBERO), not opponent/refs
        is_our_player = role in ('MAIN', 'LIBERO')
        if is_our_player and track_id not in tracker_to_jersey:
            jersey_crop, j_rel_box = detect_jersey_region(player_crop)
            if jersey_crop is not None:
                jersey_num = read_jersey_number(jersey_crop)
                if jersey_num is not None:
                    update_jersey_mapping(track_id, jersey_num)
                    if j_rel_box is not None:
                        jx1, jy1, jx2, jy2 = j_rel_box
                        jersey_abs_box = (x1+jx1, y1+jy1, x1+jx2, y1+jy2)

        # --- Choose label and box colour ---
        if role == 'OTHER':
            label = "Other"
        elif role == 'OPPONENT':
            label = "Opp"
        else:
            prefix = "L" if role == 'LIBERO' else ""
            if track_id in tracker_to_jersey:
                label = f"{prefix}#{tracker_to_jersey[track_id]}"
            else:
                label = f"{prefix}?"

        color = ROLE_BOX_COLORS.get(role, (255, 255, 255))

        cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
        cv2.putText(frame, label, (x1, max(20, y1-10)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, color, 2)

        if jersey_abs_box is not None:
            jax1, jay1, jax2, jay2 = jersey_abs_box
            cv2.rectangle(frame, (jax1, jay1), (jax2, jay2), (0, 255, 0), 2)

    cv2.putText(frame, f"Frame {frame_idx}", (20, 32),
                cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
    out.write(frame)

    if frame_idx % 100 == 0:
        pct = int(frame_idx / total_frames * 100)
        print(f"  Frame {frame_idx} | {len(tracker_to_jersey)} players ID'd by jersey")
        print(f"{pct}%", file=sys.stderr, flush=True)

cap.release()
out.release()
print(f"[SUCCESS] Done. Output: {OUTPUT_PATH}")
print(f"[INFO] Jersey map: { {j: list(tids) for j, tids in jersey_to_track_ids.items()} }")
print(f"[INFO] Team labels: {team_labels_by_track}")

# --- Save jersey registry JSON ---
if OUTPUT_JSON:
    import json
    registry = {}

    # Confirmed players: key by jersey number, store ALL track_ids
    for jersey_num, track_ids_set in jersey_to_track_ids.items():
        track_ids_list = sorted(track_ids_set)
        current_tid = track_ids_list[-1]  # most recently assigned
        role  = team_labels_by_track.get(current_tid, "MAIN")
        # Pick thumbnail from the first track_id that has one
        thumb = next((track_thumbnails[t] for t in track_ids_list if t in track_thumbnails), None)
        registry[str(jersey_num)] = {
            "jersey":          jersey_num,
            "track_ids":       track_ids_list,
            "current_track_id": current_tid,
            "role":            role,
            "team":            "opponent" if role == "OPPONENT" else "my_team",
            "confirmed":       True,
            "thumbnail":       thumb,
        }

    # Our-team players without a confirmed jersey number yet
    confirmed_tids = {t for tids in jersey_to_track_ids.values() for t in tids}
    for track_id, role in team_labels_by_track.items():
        if role not in ("MAIN", "LIBERO"):
            continue
        if track_id in confirmed_tids:
            continue   # already saved above
        thumb = track_thumbnails.get(track_id)
        registry[f"id_{track_id}"] = {
            "jersey":          None,
            "track_ids":       [track_id],
            "current_track_id": track_id,
            "role":            role,
            "team":            "my_team",
            "confirmed":       False,
            "thumbnail":       thumb,
        }

    with open(OUTPUT_JSON, "w") as _f:
        json.dump(registry, _f, indent=2)
    print(f"[INFO] Jersey registry saved -> {OUTPUT_JSON}")

# --- Save frame-jersey map for triple_detection ---
if _args.frame_jersey_map:
    import json as _json
    frame_map = defaultdict(list)
    for jersey_num, track_ids_set in jersey_to_track_ids.items():
        for track_id in track_ids_set:
            for (fidx, x1, y1, x2, y2) in track_positions.get(track_id, []):
                frame_map[str(fidx)].append({
                    "x1": x1, "y1": y1, "x2": x2, "y2": y2,
                    "jersey": jersey_num,
                    "track_id": int(track_id),
                })
    with open(_args.frame_jersey_map, "w") as _f:
        _json.dump(frame_map, _f)
    print(f"[INFO] Frame-jersey map saved -> {_args.frame_jersey_map} ({len(frame_map)} frames)")
