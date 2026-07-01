import cv2
import os
import numpy as np
from ultralytics import YOLO
from collections import defaultdict, Counter
import easyocr

# --- 1. SETUP PATHS ---
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PLAYER_MODEL = YOLO(os.path.join(SCRIPT_DIR, "yolo11s.pt"))
JERSEY_MODEL = YOLO(os.path.join(SCRIPT_DIR, "weights.pt"))
VIDEO_PATH = os.path.abspath(os.path.join(SCRIPT_DIR, "../videos/test_clip.mp4"))
OUTPUT_PATH = os.path.abspath(os.path.join(SCRIPT_DIR, "output_tracking.mp4"))

# --- 2. OCR SETUP ---
print("[INIT] Loading EasyOCR...")
OCR_READER = easyocr.Reader(['en'], gpu=False, verbose=False)

# --- 3. JERSEY ID MAPPING STATE ---
VOTE_THRESHOLD = 5
RE_ID_THRESHOLD = 2

jersey_votes = defaultdict(Counter)
tracker_to_jersey = {}   # track_id  -> confirmed jersey number (int)
jersey_to_tracker = {}   # jersey_num -> current track_id

# --- 3b. TEAM CLASSIFICATION VIA K-MEANS ON ACTUAL VIDEO COLOURS ---
# Real jersey colours under stadium lighting are far less saturated/bright than
# named presets (e.g. "blue" preset = HSV(120,255,255) but actual blue jerseys =
# HSV(120,~150,~90)). Instead of comparing directly against user-typed colours,
# k-means discovers the actual cluster centroids from the first N detections.
# The user's colour hints are used only to decide WHICH cluster is which role.

BOOTSTRAP_SAMPLE_TARGET = 40  # torso samples collected before running k-means
TEAM_VOTE_MIN = 3             # votes per track before locking in a role
OFFICIAL_THRESHOLD = 80       # dist to nearest centroid above this -> 'OTHER' (refs/crowd)

# Named colour presets the user can type (used only as a hint to label k-means clusters)
PRESET_COLORS_RGB = {
    'black':  (0,   0,   0),
    'white':  (255, 255, 255),
    'red':    (255, 0,   0),
    'green':  (0,   255, 0),
    'yellow': (255, 255, 0),
    'blue':   (0,   0,   255),
}

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


def get_color_input(prompt_text: str):
    """Accept a preset name (black/white/red/green/yellow/blue) or R,G,B. None if blank."""
    raw = input(prompt_text).strip()
    if not raw:
        return None
    key = raw.lower()
    if key in PRESET_COLORS_RGB:
        r, g, b = PRESET_COLORS_RGB[key]
        return np.array([b, g, r], dtype=np.uint8)
    try:
        r, g, b = [int(x.strip()) for x in raw.split(',')]
        if all(0 <= v <= 255 for v in (r, g, b)):
            return np.array([b, g, r], dtype=np.uint8)
    except ValueError:
        pass
    names = ', '.join(PRESET_COLORS_RGB)
    print(f"  '{raw}' not recognised. Use a name ({names}) or R,G,B e.g. 255,0,0. Skipping.")
    return None


def bgr_to_hsv(bgr: np.ndarray) -> np.ndarray:
    patch = np.uint8([[bgr]])
    return cv2.cvtColor(patch, cv2.COLOR_BGR2HSV)[0, 0].astype(np.float32)


print("Enter jersey colours (name or R,G,B). Leave main blank to skip team filtering.")
_main_bgr     = get_color_input("  Your team main jersey colour (e.g. blue):  ")
_libero_bgr   = get_color_input("  Libero jersey colour        (e.g. white, blank if none): ")
_opponent_bgr = get_color_input("  Opponent jersey colour      (e.g. red,   blank if none): ")

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
    threshold = RE_ID_THRESHOLD if jersey_num in jersey_to_tracker else VOTE_THRESHOLD
    if jersey_votes[track_id][jersey_num] >= threshold:
        old_tid = jersey_to_tracker.get(jersey_num)
        if old_tid is not None and old_tid != track_id:
            tracker_to_jersey.pop(old_tid, None)
        tracker_to_jersey[track_id] = jersey_num
        jersey_to_tracker[jersey_num] = track_id


# --- 4. INITIALIZE VIDEO ---
cap = cv2.VideoCapture(VIDEO_PATH)
if not cap.isOpened():
    raise RuntimeError(f"Cannot open video: {VIDEO_PATH}")

frame_width  = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
frame_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
fps = int(cap.get(cv2.CAP_PROP_FPS)) or 30
out = cv2.VideoWriter(OUTPUT_PATH, cv2.VideoWriter_fourcc(*'mp4v'),
                      fps, (frame_width, frame_height))

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
                # Still bootstrapping or role pending - show tracker ID
                label = f"{prefix}?{track_id}"

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
        print(f"  Frame {frame_idx} | {len(tracker_to_jersey)} players ID'd by jersey")

cap.release()
out.release()
print(f"[SUCCESS] Done. Output: {OUTPUT_PATH}")
print(f"[INFO] Jersey map: {jersey_to_tracker}")
print(f"[INFO] Team labels: {team_labels_by_track}")
