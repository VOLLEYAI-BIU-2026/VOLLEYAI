import cv2
import os
import json
import argparse
import numpy as np
from ultralytics import YOLO
from collections import defaultdict, Counter
import easyocr

# Fixed seed for cv2.kmeans (team-color bootstrap uses KMEANS_PP_CENTERS, which is
# randomized by default) — without this, identical input samples can produce
# different cluster centroids on separate runs, changing who gets classified as
# "our team" (and therefore who gets OCR'd at all) from the very first frame.
cv2.setRNGSeed(42)

# --- 1. SETUP PATHS ---
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

_parser = argparse.ArgumentParser()
_parser.add_argument("--video",            default=os.path.join(SCRIPT_DIR, "../videos/test_clip-36s.mp4"))
_parser.add_argument("--output",           default=os.path.join(SCRIPT_DIR, "output_tracking.mp4"))
_parser.add_argument("--frame-jersey-map", default="")
_parser.add_argument("--output-json",      default="")
_parser.add_argument("--known-jerseys",    default="",
                      help="Optional comma-separated list of valid jersey numbers "
                           "(from a pre-entered roster). If provided, any OCR read "
                           "outside this set is rejected as noise instead of accepted.")
_parser.add_argument("--my-team-color",    default="blue_white")
_parser.add_argument("--libero-color",     default="")
_parser.add_argument("--opponent-color",   default="black")  # accepted for CLI compatibility, unused
_parser.add_argument("--calib-json",       default="")  # accepted for CLI compatibility, unused
_args = _parser.parse_args()

PLAYER_MODEL = YOLO(os.path.join(SCRIPT_DIR, "yolo11s.pt"))
JERSEY_MODEL = YOLO(os.path.join(SCRIPT_DIR, "jersey_model.pt"))
VIDEO_PATH = os.path.abspath(_args.video)
OUTPUT_PATH = os.path.abspath(_args.output)

# Empty set = no constraint (identical to prior behavior — accept any 1-99 reading).
KNOWN_JERSEYS = {
    int(n.strip()) for n in _args.known_jerseys.split(",") if n.strip().isdigit()
}
if KNOWN_JERSEYS:
    print(f"[INFO] Roster constraint active — only accepting: {sorted(KNOWN_JERSEYS)}")

# --- 2. OCR SETUP ---
print("[INIT] Loading EasyOCR...")
OCR_READER = easyocr.Reader(['en'], gpu=True, verbose=False)

# --- 3. JERSEY ID MAPPING STATE ---
VOTE_THRESHOLD = 5

jersey_votes = defaultdict(Counter)
tracker_to_jersey = {}   # track_id  -> confirmed jersey number (int), CURRENT holder only
jersey_to_tracker = {}   # jersey_num -> current track_id
# Every track_id that ever earned a jersey lock, kept even after a later track_id
# reclaims that jersey number (tracker_to_jersey only remembers the current holder,
# so without this, an earlier fragment's frames become permanently unexportable —
# even though OCR genuinely read that jersey on that fragment).
all_time_track_jersey = {}   # track_id -> jersey number (int), never removed

# --- 3a. POSITION-BASED TRACK BRIDGING ---
# The underlying tracker frequently drops and re-creates track_ids for the same
# physical player (occlusion, crossing paths near the net, briefly leaving frame)
# — very common in busy team-sport footage. Without bridging, that player's
# jersey lock is lost for the rest of the video once their original track_id
# disappears, since a brand-new track_id has no memory of it.
#
# This is geometry-only (last position + timing), NOT appearance-based re-id —
# it never has to distinguish between multiple *simultaneously visible* players
# (the case that failed before, since teammates wear identical jerseys). It only
# ever compares one track that just vanished against one track that just
# appeared, sequentially — a much easier, safer problem.
BRIDGE_MAX_GAP_SEC = 3.0    # max time since a jersey's track vanished to still bridge it
BRIDGE_MAX_DIST_PX = 250    # max distance between vanish position and reappear position
BRIDGE_RECLAIM_THRESHOLD = 1  # confident votes needed to reclaim via a bridge match
BRIDGE_COMPETING_PENALTY = 2  # multiplier on a competing number's threshold while a
                              # bridge candidate is still outstanding on that track

vanished_jerseys = {}   # jersey_num -> {"frame": F, "cx": x, "cy": y}
bridge_candidate = {}   # track_id -> jersey_num (spatially/temporally plausible reclaim)
seen_track_ids   = set()      # every track_id ever encountered (first-appearance detector)
last_position    = {}         # track_id -> (frame, cx, cy), updated every frame it appears
_active_tids_prev_frame = set()

# --- 3b. TEAM CLASSIFICATION VIA K-MEANS ON ACTUAL VIDEO COLOURS ---
# Real jersey colours under stadium lighting are far less saturated/bright than
# named presets (e.g. "blue" preset = HSV(120,255,255) but actual blue jerseys =
# HSV(120,~150,~90)). Instead of comparing directly against user-typed colours,
# k-means discovers the actual cluster centroids from the first N detections.
# The user's colour hints are used only to decide WHICH cluster is which role.

BOOTSTRAP_SAMPLE_TARGET = 40  # torso samples collected before running k-means
TEAM_VOTE_MIN = 3             # votes per track before locking in a role
OFFICIAL_THRESHOLD = 80       # dist to nearest centroid above this -> 'OTHER' (refs/crowd)

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

# Named colour presets, keyed by the primary colour name in the app's UI preset
# keys (e.g. "blue_white" -> "blue"). Same palette the app's colour picker offers.
_PRESET_DOMINANT_BGR = {
    "white":  (255, 255, 255), "blue":   (255,   0,   0),
    "navy":   (128,   0,   0), "red":    (  0,   0, 255),
    "maroon": (  0,   0, 100), "black":  (  0,   0,   0),
    "yellow": (  0, 255, 255), "green":  (  0, 200,   0),
    "orange": (  0, 165, 255), "purple": (128,   0, 128),
    "gray":   (128, 128, 128), "gold":   (  0, 215, 255),
}

def _preset_to_bgr(key: str):
    """'blue_white' -> the BGR for 'blue' (the primary/dominant jersey colour)."""
    first = (key or "").split("_")[0]
    return np.array(_PRESET_DOMINANT_BGR.get(first, (128, 128, 128)), dtype=np.uint8)


def bgr_to_hsv(bgr: np.ndarray) -> np.ndarray:
    patch = np.uint8([[bgr]])
    return cv2.cvtColor(patch, cv2.COLOR_BGR2HSV)[0, 0].astype(np.float32)


# --- Team colour hints: main team (required) + optional libero. No opponent
# hint — any k-means cluster left without a hint falls back to OPPONENT
# automatically (see bootstrap_kmeans below).
_main_bgr   = _preset_to_bgr(_args.my_team_color)
_libero_bgr = _preset_to_bgr(_args.libero_color) if _args.libero_color else None

_main_hsv   = bgr_to_hsv(_main_bgr)
_libero_hsv = bgr_to_hsv(_libero_bgr) if _libero_bgr is not None else None
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
    if _libero_hsv is not None: hints.append(('LIBERO', _libero_hsv))

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

    candidate = bridge_candidate.get(track_id)
    if candidate == jersey_num:
        threshold = BRIDGE_RECLAIM_THRESHOLD
    else:
        # No plausible position/timing relationship between this track and this
        # number (that's what bridge_candidate is for, handled above) — always
        # require the full vote bar, even if the number happens to already be
        # (or have previously been) assigned to some other track_id. Lowering
        # the bar just because "someone already has this number" has no real
        # justification: it doesn't verify this track is that same player, so
        # it only makes it easier for a couple of stray OCR misreads to hijack
        # an unrelated player's identity with no plausibility check at all.
        threshold = VOTE_THRESHOLD
        if candidate is not None:
            # A bridge candidate is still outstanding for this track — a *different*
            # number needs to clearly out-earn it, not just win its own separate
            # race. Otherwise a wrong-but-frequent misread can lock before the
            # spatially-plausible correct number is ever even read once.
            threshold *= BRIDGE_COMPETING_PENALTY

    if jersey_votes[track_id][jersey_num] >= threshold:
        old_tid = jersey_to_tracker.get(jersey_num)
        if old_tid is not None and old_tid != track_id:
            tracker_to_jersey.pop(old_tid, None)
        tracker_to_jersey[track_id] = jersey_num
        jersey_to_tracker[jersey_num] = track_id
        all_time_track_jersey[track_id] = jersey_num


# Boxes overlapping this much or more are treated as "crowded" — a player's OCR
# crop can bleed into a neighboring player standing this close, producing a
# confident-but-wrong reading that then locks in permanently. Skip OCR entirely
# for overlapping boxes rather than risk that.
OVERLAP_IOU_SKIP = 0.15

def box_iou(box_a, box_b) -> float:
    ax1, ay1, ax2, ay2 = box_a
    bx1, by1, bx2, by2 = box_b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih   = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter    = iw * ih
    if inter <= 0:
        return 0.0
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union  = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


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
track_positions = defaultdict(list)  # track_id -> [(frame, x1, y1, x2, y2), ...] for --frame-jersey-map

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

    # Track_ids whose box significantly overlaps another player's box this frame —
    # OCR is skipped for these (see OVERLAP_IOU_SKIP above).
    _overlapping_tids = set()
    for _i in range(len(boxes)):
        for _j in range(_i + 1, len(boxes)):
            if box_iou(boxes[_i], boxes[_j]) >= OVERLAP_IOU_SKIP:
                _overlapping_tids.add(int(track_ids[_i]))
                _overlapping_tids.add(int(track_ids[_j]))

    _current_active_tids = set()

    for box, track_id in zip(boxes, track_ids):
        track_id = int(track_id)
        x1, y1, x2, y2 = map(int, box)
        player_crop   = frame[y1:y2, x1:x2]
        jersey_abs_box = None

        # --- Team classification ---
        if TEAM_FILTER_ENABLED and track_id not in team_labels_by_track:
            update_team_label(track_id, player_crop)

        role = team_labels_by_track.get(track_id) if TEAM_FILTER_ENABLED else 'MAIN'

        # Only run jersey OCR for our own players (MAIN or LIBERO), not opponent/refs
        is_our_player = role in ('MAIN', 'LIBERO')
        if is_our_player:
            track_positions[track_id].append((frame_idx, x1, y1, x2, y2))
            _current_active_tids.add(track_id)
            cx, cy = (x1 + x2) / 2.0, (y1 + y2) / 2.0
            last_position[track_id] = (frame_idx, cx, cy)

            # First-ever appearance of this track_id: check if it plausibly
            # continues a jersey whose previous track recently vanished nearby.
            if track_id not in seen_track_ids:
                seen_track_ids.add(track_id)
                best_jersey, best_dist = None, BRIDGE_MAX_DIST_PX
                for jnum, v in vanished_jerseys.items():
                    if (frame_idx - v["frame"]) > BRIDGE_MAX_GAP_SEC * fps:
                        continue
                    d = ((cx - v["cx"]) ** 2 + (cy - v["cy"]) ** 2) ** 0.5
                    if d < best_dist:
                        best_dist, best_jersey = d, jnum
                if best_jersey is not None:
                    bridge_candidate[track_id] = best_jersey
                    vanished_jerseys.pop(best_jersey, None)
                    print(f"[Jersey BRIDGE] track_id={track_id} candidate=#{best_jersey} "
                          f"(dist={best_dist:.0f}px)")

        if is_our_player and track_id not in tracker_to_jersey and track_id not in _overlapping_tids:
            jersey_crop, j_rel_box = detect_jersey_region(player_crop)
            if jersey_crop is not None:
                jersey_num = read_jersey_number(jersey_crop)
                if KNOWN_JERSEYS and jersey_num not in KNOWN_JERSEYS:
                    jersey_num = None  # not on the roster — treat as OCR noise
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

    # Tracks that were locked + active last frame but are missing this frame —
    # their jersey just "vanished"; remember where, so a new track appearing
    # nearby soon can bridge back to it (see BRIDGE_* above).
    for _tid in (_active_tids_prev_frame - _current_active_tids):
        _jersey = tracker_to_jersey.get(_tid)
        if _jersey is not None and _tid in last_position:
            _lf, _lcx, _lcy = last_position[_tid]
            vanished_jerseys[_jersey] = {"frame": _lf, "cx": _lcx, "cy": _lcy}
    _active_tids_prev_frame = _current_active_tids

    # Garbage-collect vanished entries past the bridging window
    for _jnum in [j for j, v in vanished_jerseys.items()
                  if (frame_idx - v["frame"]) > BRIDGE_MAX_GAP_SEC * fps]:
        vanished_jerseys.pop(_jnum, None)

    cv2.putText(frame, f"Frame {frame_idx}", (20, 32),
                cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
    out.write(frame)

    if frame_idx % 100 == 0:
        print(f"  Frame {frame_idx} | {len(tracker_to_jersey)} players ID'd by jersey")
        pct = int(frame_idx / total_frames * 100)
        print(f"{pct}%")

cap.release()
out.release()
print(f"[SUCCESS] Done. Output: {OUTPUT_PATH}")
print(f"[INFO] Jersey map: {jersey_to_tracker}")
print(f"[INFO] Team labels: {team_labels_by_track}")

# --- 5. FRAME-JERSEY MAP (consumed by triple_detection.py) ---
if _args.frame_jersey_map:
    frame_map = defaultdict(list)
    for track_id, positions in track_positions.items():
        jersey = all_time_track_jersey.get(track_id)
        if jersey is None:
            continue
        for (fidx, x1, y1, x2, y2) in positions:
            frame_map[str(fidx)].append({
                "x1": x1, "y1": y1, "x2": x2, "y2": y2,
                "jersey": jersey, "track_id": track_id,
            })
    with open(_args.frame_jersey_map, "w") as _f:
        json.dump(frame_map, _f)
    print(f"[INFO] Frame-jersey map saved -> {_args.frame_jersey_map} ({len(frame_map)} frames)")

# --- 6. REGISTRY JSON (jersey -> team, consumed by merge_pipeline.py) ---
if _args.output_json:
    registry = {}
    for track_id, jersey in tracker_to_jersey.items():
        role = team_labels_by_track.get(track_id, "MAIN")
        registry[str(jersey)] = {
            "jersey": jersey,
            "track_id": track_id,
            "role": role,
            "team": "opponent" if role == "OPPONENT" else "my_team",
        }
    with open(_args.output_json, "w") as _f:
        json.dump(registry, _f, indent=2)
    print(f"[INFO] Registry saved -> {_args.output_json} ({len(registry)} players)")
