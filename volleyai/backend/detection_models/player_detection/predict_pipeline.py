import cv2
import os
import json
import argparse
import numpy as np
from ultralytics import YOLO
from ultralytics.trackers.bot_sort import BOTSORT
from ultralytics.utils import IterableSimpleNamespace, yaml_load
from ultralytics.utils.checks import check_yaml
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
_parser.add_argument("--opponent-libero-color", default="")
_parser.add_argument("--calib-json",       default="",
                      help="Homography from court_setup, used to filter out clearly-off-court "
                           "detections (bleacher spectators) before tracking. Optional — falls "
                           "back to color-only filtering when not provided.")
_parser.add_argument("--thumbs-dir",       default="",
                      help="Optional: save one representative full-body crop per track_id "
                           "here (id<track_id>.jpg), for the player-merge UI's thumbnails.")
_parser.add_argument("--start-frame", type=int, default=0,
                      help="First frame (in the source video's own numbering) to process. "
                           "Used by the chunked-processing orchestrator to run this script "
                           "once per rally-boundary-aligned chunk of a long video instead of "
                           "the whole thing in one continuous pass -- ByteTrack's own tracking "
                           "quality was verified directly to degrade over a long continuous "
                           "run, tracking noticeably better when the identical footage is "
                           "reprocessed as a short, fresh segment. All frame numbers written to "
                           "--frame-jersey-map/--output-json use this same source-video "
                           "numbering, never a chunk-local one, so multiple chunks' outputs can "
                           "be merged directly with no offset math needed downstream.")
_parser.add_argument("--end-frame", type=int, default=-1,
                      help="Last frame (inclusive, source-video numbering) to process. -1 = "
                           "process to the end of the video.")
_parser.add_argument("--import-bootstrap", default="",
                      help="Path to a JSON file (from a prior run's --export-bootstrap) with "
                           "already-decided k-means centroids/role labels, an initial "
                           "main-team court footprint, and the previous chunk's resolved "
                           "tracklet endpoints. When given, this chunk skips its own color "
                           "bootstrap entirely and starts from this shared state instead.")
_parser.add_argument("--export-bootstrap", default="",
                      help="Path to write this run's own k-means centroids/role labels, "
                           "main-team court footprint, and resolved tracklet endpoints as "
                           "JSON, for a later chunk to import via --import-bootstrap.")
_parser.add_argument("--skip-team-classification", action="store_true",
                      help="Skip color k-means and calibration-based team separation "
                           "entirely, treating every detection PLAYER_MODEL finds as our "
                           "own team directly. Verified directly this is the correct mode "
                           "once player_model.pt itself was retrained to only ever detect "
                           "our own team (never opponents) -- at that point, color/"
                           "calibration have nothing left to separate (there's no second "
                           "team in the detections to tell apart from), and color k-means "
                           "specifically risks splitting our own single jersey color into "
                           "two arbitrary groups on lighting noise, wrongly excluding some "
                           "of our own players. Does not remove any of the color/"
                           "calibration code -- just bypasses it, so a future detector that "
                           "isn't team-restricted can still use it by omitting this flag.")
_args = _parser.parse_args()

# Homography (image px -> normalized court coords) from the optional court-setup
# step, used only to widen the pre-tracking clutter filter below — never a hard
# boundary on its own (see should_track), since real play regularly goes past
# the calibrated reference lines (digs out of bounds, etc.).
COURT_H = None
if _args.calib_json and os.path.exists(_args.calib_json):
    with open(_args.calib_json) as _f:
        _calib = json.load(_f)
    COURT_H = np.array(_calib["H"], dtype=np.float64)

# Fine-tuned on real match footage (14rallies.mov), then again on a second
# round of annotations restricted to genuine on-court players only (bench,
# referees, and spectators deliberately left unboxed as negative examples).
# Verified directly: cuts raw "person" detections from ~25/frame to ~9/frame
# on this footage, all on real players, none on bench/crowd.
PLAYER_MODEL = YOLO(os.path.join(SCRIPT_DIR, "player_model.pt"))
# Must match this model's own training resolution (embedded in the checkpoint
# as imgsz=1024) — running inference at a different size than it was trained
# at throws away most of the fine-tune's benefit.
PLAYER_MODEL_IMGSZ = 1024
JERSEY_MODEL = YOLO(os.path.join(SCRIPT_DIR, "jersey_model.pt"))
# Dedicated per-digit classifier (0,1,2,3,4,7,8,9 -- no 5/6 examples existed
# in this team's own roster to train on, see jersey_digit_crops annotation
# notes) trained the same way led_read.pt was for the scoreboard: real match
# crops, imgsz=512. Optional -- falls back to EasyOCR in read_jersey_number
# below when this file isn't present, so an older deployment without it
# still works exactly as before.
_jersey_digit_path = os.path.join(SCRIPT_DIR, "jersey_digit.pt")
JERSEY_DIGIT_MODEL = YOLO(_jersey_digit_path) if os.path.exists(_jersey_digit_path) else None
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

# --- 3. JERSEY IDENTITY RESOLUTION: TWO-PASS, OFFLINE ---
# Real-time locking (confirm a track's jersey the moment it clears a vote
# threshold, live, frame by frame) was the previous design and needed a large
# pile of exception-handling to stay correct: steal-protection, a first-
# appearance-only-then-every-frame bridge check, a competing-candidate
# penalty, a stationary-bench filter, vanish-confirmation streaks. Each was a
# real, verified fix for a real bug -- but the fundamental problem is that
# real-time locking has to decide a track's identity before it's seen that
# track's whole life, so an early run of bad reads can lock in wrong, and a
# good read arriving later can't undo it without yet another exception layer.
#
# This is also the approach validated by the field's own state of the art
# (SoccerNet's jersey-number-recognition and game-state-reconstruction work):
# track first (accept that tracklets will fragment), resolve each tracklet's
# identity from its WHOLE recorded history in one offline pass afterward,
# then stitch same-identity tracklets together as a separate global step --
# not live, forward-only bridging.
#
# Pass 1 (the frame loop below): track + classify team color as before, but
# jersey OCR results are only ever collected, never locked in real time.
# Pass 2 (resolve_track_jerseys / stitch_unresolved_tracks, after the loop):
# resolve each track's final number by majority vote across its full
# lifetime, resolve any same-number collisions between tracks that were
# provably different physical players, then stitch tracks that never got a
# confident reading onto the nearest resolved tracklet by position/timing --
# looking in BOTH directions (this track could precede OR follow a resolved
# one), which a live, forward-only bridge can never do.
# Pass 3 (render_output_video, after that): re-reads the raw frames (cheap,
# no model inference) and draws final boxes/labels using the fully-resolved
# identities, so the debug video reflects the same answer as the exported
# JSON instead of an in-progress, still-uncertain one.

track_ocr_readings = defaultdict(list)   # track_id -> [(jersey_num, confidence), ...] every successful read
# Tracks whose jersey number has ever matched the roster -- overrides color
# classification for team membership, since it's checked directly against
# court position (see the main loop), not gated by color at all.
roster_confirmed_main = set()
# A track needs at least this many successful OCR reads before its majority
# vote is trusted at all. Verified directly against a real dead-zone rally:
# a track can be short-lived purely from tracker fragmentation (BOTSORT's own
# run-to-run non-determinism) while still reading its jersey number correctly
# on essentially every single attempt -- requiring 2 matching reads costs
# real, individually-accurate short tracks their only chance to resolve,
# since they may never get a second attempt before fragmenting again.
MIN_READINGS_TO_RESOLVE = 1

# Same geometry-only matching used by the old live bridging path (last
# position + timing, never appearance) -- reused here for the offline
# stitching pass, just no longer restricted to a forward-only, "currently
# vanished" search. Values carried over unchanged from the live version,
# already verified directly against this video's real gaps (1.3-70.8s,
# 142-666px measured; 55s/500px covers all but a few genuine-break outliers).
STITCH_MAX_GAP_SEC = 55.0
STITCH_MAX_DIST_PX = 500

# One representative thumbnail per track_id, for the player-merge UI — keeps
# whichever crop has the largest box area seen so far (bigger box = closer to
# camera = clearer, more identifiable picture), overwriting only when a better
# one comes along, so this never grows past one image per track_id in memory.
best_thumb_crop = {}   # track_id -> crop (np.ndarray)
best_thumb_area = {}   # track_id -> int

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
    'MAIN':       (0, 200, 0),      # green  - our team main jersey
    'LIBERO':     (0, 215, 255),    # yellow - our libero
    'OPPONENT':   (255, 100, 0),    # orange - opponent (no OCR)
    'OPP_LIBERO': (0, 100, 255),    # red-orange - opponent's libero (no OCR)
    'OTHER':      (160, 160, 160),  # gray   - referee / crowd
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


# --- Team colour hint: only the main team's own jersey colour is used to
# seed classification. A separate libero/opponent-libero color hint was
# tried and dropped -- verified directly on real match footage that it
# doesn't isolate the libero at all. See matches_main_footprint() below for
# how a differently-colored teammate like the libero is now recognized
# instead (by court position, not color). --libero-color and
# --opponent-libero-color are still accepted on the CLI for compatibility
# but no longer affect classification.
_main_bgr = _preset_to_bgr(_args.my_team_color)
_main_hsv = bgr_to_hsv(_main_bgr)
TEAM_FILTER_ENABLED = _main_hsv is not None
K_CLUSTERS = 2   # the main team's own color cluster + one auto-assigned OPPONENT bucket


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
    Run k-means (k=2) on collected samples: the real centroid closest to the
    main-team color hint becomes MAIN, the other becomes OPPONENT. Prints
    centroid HSV so the user can verify the split.
    """
    global cluster_centroids, cluster_roles
    data = np.array(team_color_samples, dtype=np.float32)
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 50, 0.5)
    _, _, centers = cv2.kmeans(data, K_CLUSTERS, None, criteria, 5, cv2.KMEANS_PP_CENTERS)

    dists = [hsv_distance(centers[i], _main_hsv) for i in range(K_CLUSTERS)]
    main_idx = int(np.argmin(dists))
    cluster_roles = {i: ('MAIN' if i == main_idx else 'OPPONENT') for i in range(K_CLUSTERS)}

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


# How far outside the calibrated court reference region (normalized [0,1]) a
# detection's foot-point can land and still count as "on/near the court".
# Asymmetric on purpose: X directly tracks how far to the side something is,
# which is exactly what separates real play (bench, sideline digs) from
# bleacher spectators, so it's kept tight. Y is depth, where legitimate play
# regularly goes well behind the baseline (deep serves, defense), so it's
# kept loose.
COURT_MARGIN_X = 0.15
COURT_MARGIN_Y = 0.5


def court_coords(x1, y1, x2, y2):
    """Maps a detection's foot-point (bottom-center of its box) into
    normalized court space via the calibration homography. Returns None when
    no calibration was provided or the projection is degenerate."""
    if COURT_H is None:
        return None
    foot = np.array([(x1 + x2) / 2.0, y2, 1.0])
    mapped = COURT_H @ foot
    if abs(mapped[2]) < 1e-9:
        return None  # degenerate projection - don't trust it either way
    return mapped[0] / mapped[2], mapped[1] / mapped[2]


def foot_point_in_court(x1, y1, x2, y2) -> bool:
    """No calibration -> nothing gets excluded on spatial grounds alone (color
    is then the only signal, see should_track)."""
    coords = court_coords(x1, y1, x2, y2)
    if coords is None:
        return True
    cx, cy = coords
    return (-COURT_MARGIN_X <= cx <= 1 + COURT_MARGIN_X) and (-COURT_MARGIN_Y <= cy <= 1 + COURT_MARGIN_Y)


def should_track(x1, y1, x2, y2, crop: np.ndarray) -> bool:
    """Pre-tracking clutter filter: keep a detection if it's plausibly a real
    player by EITHER signal — on/near the court, OR wearing a color that
    matches one of the known team clusters."""
    if foot_point_in_court(x1, y1, x2, y2):
        return True
    color = extract_torso_color(crop)
    if color is None:
        return True
    role = classify_color(color)
    if role is None:
        return True
    return role != 'OTHER'


# --- Position-based fallback for a teammate color can't catch (e.g. a
# libero in a different-colored kit) -- every one of a team's own players,
# regardless of jersey color, occupies the same court-side footprint.
# Requires calibration -- with no COURT_H this is a no-op and classification
# stays color-only, same as before.
MAIN_FOOTPRINT_MIN_SAMPLES = 20   # confirmed MAIN samples needed before trusting the footprint
MAIN_FOOTPRINT_MIN_TRACK_SAMPLES = 5  # this track's own samples needed before checking it
MAIN_FOOTPRINT_MARGIN = 0.05      # slack around the observed [min,max] main-team court-y range

main_court_cys = []                    # cy of every confirmed-MAIN detection (the footprint)
# Mirror of main_court_cys for the away side -- built from tracks confidently
# classified OPPONENT by color (never footprint-rescued, since the rescue
# only ever runs OPPONENT/OTHER -> MAIN). Used to veto a roster-matching
# jersey read for a track that's confidently standing on the opponent's side
# of the court -- jersey numbers aren't unique across both teams, so a
# roster match alone can't tell "our #7" from "their #7" wearing the same
# number by coincidence; court side can.
opponent_court_cys = []
_opponent_footprint_contributed = set()  # track_ids already counted into opponent_court_cys
track_court_cys = defaultdict(list)    # track_id -> cy list, collected regardless of role

# Imported bootstrap state (chunked processing) -- skips this run's own color
# bootstrap entirely and starts from a prior chunk's already-decided
# centroids/roles/footprint instead. Setting cluster_centroids here directly
# makes update_team_label's own "if cluster_centroids is None" bootstrap-
# collection check see it as already-bootstrapped, no separate flag needed.
#
# imported_endpoints seeds the offline stitching pass (see stitch_unresolved_
# tracks) with the previous chunk's own resolved tracklets' last-known
# position, so this chunk's early, still-unresolved tracks can stitch onto
# them immediately instead of every chunk boundary forcing a cold restart.
imported_endpoints = defaultdict(list)   # jersey_num -> [(frame, cx, cy), ...]
if _args.import_bootstrap:
    with open(_args.import_bootstrap) as _f:
        _imported = json.load(_f)
    cluster_centroids = np.array(_imported["centroids"], dtype=np.float32)
    cluster_roles = {int(k): v for k, v in _imported["roles"].items()}
    main_court_cys = list(_imported.get("main_court_cys", []))
    opponent_court_cys = list(_imported.get("opponent_court_cys", []))
    for _jersey_str, _v in _imported.get("last_positions", {}).items():
        imported_endpoints[int(_jersey_str)].append((_v["frame"], _v["cx"], _v["cy"]))
    print(f"[INFO] Imported bootstrap from {_args.import_bootstrap} "
          f"(k={len(cluster_centroids)}, {len(main_court_cys)} footprint samples, "
          f"{len(imported_endpoints)} carried-over tracklet endpoints)")


def matches_main_footprint(track_id: int) -> bool:
    if len(main_court_cys) < MAIN_FOOTPRINT_MIN_SAMPLES:
        return False
    cys = track_court_cys.get(track_id, [])
    if len(cys) < MAIN_FOOTPRINT_MIN_TRACK_SAMPLES:
        return False
    lo = min(main_court_cys) - MAIN_FOOTPRINT_MARGIN
    hi = max(main_court_cys) + MAIN_FOOTPRINT_MARGIN
    return lo <= float(np.median(cys)) <= hi


def matches_opponent_footprint(track_id: int) -> bool:
    """True if this track's own court position confidently matches the
    established AWAY-side footprint -- used only to veto a roster-matching
    jersey read (see main loop), never to assign team labels on its own."""
    if len(opponent_court_cys) < MAIN_FOOTPRINT_MIN_SAMPLES:
        return False
    cys = track_court_cys.get(track_id, [])
    if len(cys) < MAIN_FOOTPRINT_MIN_TRACK_SAMPLES:
        return False
    lo = min(opponent_court_cys) - MAIN_FOOTPRINT_MARGIN
    hi = max(opponent_court_cys) + MAIN_FOOTPRINT_MARGIN
    return lo <= float(np.median(cys)) <= hi


def update_team_label(track_id: int, player_crop: np.ndarray, x1, y1, x2, y2):
    """
    During bootstrap: collect torso colour samples.
    After bootstrap: classify and vote-stabilise the track's role.
    """
    coords = court_coords(x1, y1, x2, y2)
    if coords is not None:
        track_court_cys[track_id].append(coords[1])

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
    # A color-based OPPONENT/OTHER read doesn't necessarily mean an opponent
    # -- a teammate in a different-colored kit (the libero) reads as "not
    # main-team color" on every single frame, so no amount of vote
    # accumulation would ever fix it through color alone. Check whether this
    # track's own court position matches the established main-team
    # footprint before letting color lock it out as an opponent.
    if role in ('OPPONENT', 'OTHER') and matches_main_footprint(track_id):
        role = 'MAIN'
    team_votes[track_id][role] += 1
    if sum(team_votes[track_id].values()) >= TEAM_VOTE_MIN:
        team_labels_by_track[track_id] = team_votes[track_id].most_common(1)[0][0]
        if team_labels_by_track[track_id] == 'MAIN':
            main_court_cys.extend(track_court_cys.get(track_id, []))
        elif (team_labels_by_track[track_id] == 'OPPONENT'
                and track_id not in _opponent_footprint_contributed):
            _opponent_footprint_contributed.add(track_id)
            opponent_court_cys.extend(track_court_cys.get(track_id, []))


# --- JERSEY DETECTION + OCR HELPERS ---

def preprocess_for_ocr(crop: np.ndarray) -> np.ndarray:
    h, w = crop.shape[:2]
    if h < 40 or w < 30:
        scale = max(40 / max(h, 1), 30 / max(w, 1))
        crop = cv2.resize(crop, (int(w*scale), int(h*scale)), interpolation=cv2.INTER_CUBIC)
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return binary


def _box_iou(a, b):
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = max(0.0, ix2 - ix1), max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


# Same fix read_scoreboard.py needed for the scoreboard's own digit model:
# YOLO's NMS is class-aware, so two different digit classes proposed at
# roughly the same position (e.g. "1" and "2" both guessed for one
# ambiguous shape) never get merged on their own -- composing both
# left-to-right by x-position turns one real digit into two (a real "10"
# reads as "210"). Any box overlapping an already-kept one above this
# threshold is a second guess for the same position, not a second digit;
# only the higher-confidence guess survives.
DIGIT_DEDUP_IOU = 0.3
# jersey_digit.pt was trained on Roboflow-preprocessed crops resized to
# 512x512 (matching led_read.pt's own training scale) -- a raw detected
# jersey region can be much smaller than that (as small as ~30x40px), and
# read_scoreboard.py already hit this exact train/inference scale mismatch
# for the scoreboard's own digit model: feeding a tiny crop at native size
# produced an unstable reading that changed frame to frame for what should
# be one fixed number. Upscaling first keeps inference at roughly the same
# scale the model was trained on.
JERSEY_DIGIT_UPSCALE = 4


def read_jersey_number_via_digit_model(crop: np.ndarray, conf: float = 0.4):
    """Dedicated per-digit detector, same approach as read_scoreboard.py's
    led_model path: detect each digit character, sort left-to-right by
    x-position, and compose them into the full number. Returns
    (number, confidence) or (None, 0.0) -- confidence is the WEAKEST digit's
    own confidence, since a two-digit number is only as trustworthy as its
    least-certain character (verified directly: the 3/8/9 confusion this
    model has shows up as a low-confidence guess on the wrong digit far more
    often than a high-confidence one, making this a real, useful signal for
    weighting votes later, not just a formality)."""
    if crop is None or crop.size == 0:
        return None, 0.0
    big = cv2.resize(crop, None, fx=JERSEY_DIGIT_UPSCALE, fy=JERSEY_DIGIT_UPSCALE,
                      interpolation=cv2.INTER_CUBIC)
    results = JERSEY_DIGIT_MODEL(big, conf=conf, verbose=False)[0]
    if len(results.boxes) == 0:
        return None, 0.0

    candidates = sorted(
        ((float(b.conf[0]), tuple(b.xyxy[0].tolist()), JERSEY_DIGIT_MODEL.names[int(b.cls[0])])
         for b in results.boxes),
        key=lambda c: c[0], reverse=True,
    )
    kept = []  # (conf, box, cls_name), highest-confidence guess per position
    for conf_val, box, cls_name in candidates:
        if any(_box_iou(box, kb) >= DIGIT_DEDUP_IOU for _, kb, _ in kept):
            continue  # a higher-confidence guess already claimed this position
        kept.append((conf_val, box, cls_name))

    digits = sorted((box[0], conf_val, cls_name) for conf_val, box, cls_name in kept)
    composed = "".join(d[2] for d in digits)
    if composed.isdigit() and 1 <= int(composed) <= 99:
        weakest_conf = min(d[1] for d in digits)
        return int(composed), weakest_conf
    return None, 0.0


# EasyOCR is the fallback path only (no 5/6 classes in the digit model), and
# already documented as less reliable overall -- capped below the digit
# model's own typical confidence range so a digit-model read always
# outweighs an EasyOCR read of a different number for the same track, while
# still letting EasyOCR readings vote among themselves normally.
EASYOCR_CONF_CAP = 0.5


def read_jersey_number(crop: np.ndarray):
    """Returns (jersey_num, confidence) or (None, 0.0)."""
    if crop is None or crop.size == 0:
        return None, 0.0
    if JERSEY_DIGIT_MODEL is not None:
        digit_result, digit_conf = read_jersey_number_via_digit_model(crop)
        if digit_result is not None:
            return digit_result, digit_conf
        # Falls through to EasyOCR below rather than returning None outright
        # -- jersey_digit.pt has no "5"/"6" classes at all (never had real
        # examples to train on), so it can never read a number containing
        # either digit no matter how clear the crop is. EasyOCR, though less
        # reliable overall, at least has a chance at those two.
    results = OCR_READER.readtext(preprocess_for_ocr(crop), allowlist='0123456789', detail=1)
    for (_, text, ocr_conf) in results:
        text = text.strip()
        if text.isdigit() and 1 <= int(text) <= 99:
            return int(text), min(float(ocr_conf), EASYOCR_CONF_CAP)
    return None, 0.0


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


def _tracks_overlapped_in_time(tid_a: int, tid_b: int) -> bool:
    """True if these two tracks were ever simultaneously on screen at any
    point in their recorded histories -- if so they are, with certainty, two
    different physical players, no matter what their OCR votes say."""
    pa, pb = track_positions.get(tid_a), track_positions.get(tid_b)
    if not pa or not pb:
        return False
    a_start, a_end = pa[0][0], pa[-1][0]
    b_start, b_end = pb[0][0], pb[-1][0]
    return max(a_start, b_start) <= min(a_end, b_end)


# Boxes overlapping this much or more are treated as "crowded" — a player's OCR
# crop can bleed into a neighboring player standing this close, producing a
# confident-but-wrong reading that would otherwise outvote the real one.
# Skip OCR entirely for overlapping boxes rather than risk that.
#
# 0.15 was too aggressive: verified directly on real footage that two clearly
# different, cleanly-numbered players standing near each other during normal
# play measured 0.26 IoU from their legs/lower-body overlapping, while their
# jersey numbers were fully separated and legible. Raised to only catch
# genuine near-total occlusion.
OVERLAP_IOU_SKIP = 0.4

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

_video_total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 1
_chunk_start = max(0, _args.start_frame)
_chunk_end = _args.end_frame if _args.end_frame >= 0 else _video_total_frames - 1
total_frames = max(1, _chunk_end - _chunk_start + 1)  # for the progress %% print below
if _chunk_start > 0:
    cap.set(cv2.CAP_PROP_POS_FRAMES, _chunk_start)
track_positions = defaultdict(list)  # track_id -> [(frame, x1, y1, x2, y2), ...]
track_role = {}  # track_id -> role string, fixed once team_labels_by_track resolves it

print(f"[START] Pass 1/3: detect + track + collect (team filter: {'ON' if TEAM_FILTER_ENABLED else 'OFF'})"
      f"{f' [chunk frames {_chunk_start}-{_chunk_end}]' if (_chunk_start or _args.end_frame >= 0) else ''}...")

# Tracker instantiated manually (rather than PLAYER_MODEL.track(persist=True))
# so should_track can run BEFORE detections reach it, filtering out clearly
# off-court clutter before the tracker ever sees it.
_tracker_cfg = IterableSimpleNamespace(**yaml_load(check_yaml("botsort.yaml")))
player_tracker = BOTSORT(args=_tracker_cfg, frame_rate=fps)

frame_idx = _chunk_start - 1  # incremented to _chunk_start before the first frame is processed
while cap.isOpened():
    success, frame = cap.read()
    if not success:
        break
    frame_idx += 1
    if frame_idx > _chunk_end:
        break

    raw_results = PLAYER_MODEL.predict(
        frame, conf=0.5, classes=[0], imgsz=PLAYER_MODEL_IMGSZ, verbose=False
    )[0]

    # should_track's whole job is dropping off-court clutter using color/
    # calibration -- with --skip-team-classification, PLAYER_MODEL itself
    # already guarantees clean input (retrained to never detect anything but
    # our own team), so this pre-filter has nothing left to catch and only
    # carries downside risk (a real detection wrongly dropped on a color/
    # calibration edge case). Keep everything the detector found instead.
    keep_mask = (np.ones(len(raw_results.boxes), dtype=bool) if _args.skip_team_classification else
                 np.array([
                     should_track(*map(int, b), frame[int(b[1]):int(b[3]), int(b[0]):int(b[2])])
                     for b in raw_results.boxes.xyxy.cpu().numpy()
                 ], dtype=bool)) if len(raw_results.boxes) else np.array([], dtype=bool)

    filtered_boxes = raw_results.boxes[keep_mask]
    if len(filtered_boxes) == 0:
        continue

    tracks = player_tracker.update(filtered_boxes.cpu().numpy(), frame)
    if len(tracks) == 0:
        continue

    boxes     = tracks[:, :4]
    track_ids = tracks[:, 4].astype(int)

    # Track_ids whose box significantly overlaps another player's box this frame —
    # OCR is skipped for these (see OVERLAP_IOU_SKIP above).
    _overlapping_tids = set()
    for _i in range(len(boxes)):
        for _j in range(_i + 1, len(boxes)):
            if box_iou(boxes[_i], boxes[_j]) >= OVERLAP_IOU_SKIP:
                _overlapping_tids.add(int(track_ids[_i]))
                _overlapping_tids.add(int(track_ids[_j]))

    for box, track_id in zip(boxes, track_ids):
        track_id = int(track_id)
        x1, y1, x2, y2 = map(int, box)
        player_crop = frame[y1:y2, x1:x2]

        # --- Team classification (color, still real-time/lockable) ---
        # Skipped entirely when --skip-team-classification is set: every
        # track just IS our team, since the detector itself now guarantees
        # that. See the CLI arg's own help text for why this is correct
        # once player_model.pt is retrained to be team-restricted.
        if _args.skip_team_classification:
            color_role = 'MAIN'
        else:
            if TEAM_FILTER_ENABLED and track_id not in team_labels_by_track:
                update_team_label(track_id, player_crop, x1, y1, x2, y2)
            color_role = team_labels_by_track.get(track_id) if TEAM_FILTER_ENABLED else 'MAIN'

        if _args.thumbs_dir and player_crop.size > 0:
            _area = (x2 - x1) * (y2 - y1)
            if _area > best_thumb_area.get(track_id, 0):
                best_thumb_area[track_id] = _area
                best_thumb_crop[track_id] = player_crop.copy()

        # Attempt the jersey read for anyone on/near the court, regardless of
        # what color classification currently believes -- color's real-time
        # lock-in can be permanently wrong from a few bad early frames (see
        # update_team_label), and a roster-matching jersey number is strictly
        # stronger evidence of team identity than an early color guess. Using
        # court position (already computed for should_track's own clutter
        # filter) as the gate instead of color means a wrongly-colored real
        # teammate still gets read and can self-correct via their own jersey
        # number, instead of never being checked at all.
        on_court = True if _args.skip_team_classification else foot_point_in_court(x1, y1, x2, y2)
        if on_court and track_id not in _overlapping_tids:
            jersey_crop, _ = detect_jersey_region(player_crop)
            if jersey_crop is not None:
                jersey_num, jersey_conf = read_jersey_number(jersey_crop)
                if KNOWN_JERSEYS:
                    # Jersey numbers aren't unique across both teams -- a
                    # roster match alone can't tell "our #7" from "their #7"
                    # worn by coincidence. Tried combining in color_role ==
                    # 'OPPONENT' as a second veto signal alongside position;
                    # verified directly this REGRESSED the roster-override
                    # fix (rally 4/5 avg confirmed/frame dropped from
                    # 5.69/6.20 to 3.67/2.75) -- color's real-time lock-in is
                    # exactly what the roster override exists to rescue a
                    # wrongly-locked real teammate FROM, so using color_role
                    # == 'OPPONENT' as a veto condition blocks the very
                    # rescue the whole mechanism is for. Position-only veto,
                    # reverted back to this after confirming the combined
                    # version was worse, not better.
                    if jersey_num in KNOWN_JERSEYS and matches_opponent_footprint(track_id):
                        # Discarded, not just left unconfirmed -- letting it
                        # fall through to the color-only branch below would
                        # just re-confirm it via whatever color already
                        # (correctly, in this case) called it anyway.
                        pass
                    elif jersey_num in KNOWN_JERSEYS:
                        # Roster-confirmed: definitely our team, regardless of
                        # what color classification currently says about them.
                        roster_confirmed_main.add(track_id)
                        track_ocr_readings[track_id].append((jersey_num, jersey_conf))
                    # else: not on the roster (an opponent's real number, or
                    # OCR noise either way) -- discard.
                elif jersey_num is not None and color_role in ('MAIN', 'LIBERO'):
                    # No roster to check against -- fall back to color's own
                    # team call, same as before.
                    track_ocr_readings[track_id].append((jersey_num, jersey_conf))

        # Roster confirmation overrides color's guess for every purpose
        # below (position history, thumbnails, final role/team labeling) --
        # it's the whole point of checking the jersey number regardless of
        # color in the first place.
        role = 'MAIN' if track_id in roster_confirmed_main else color_role
        if track_id in roster_confirmed_main or track_id in team_labels_by_track or not TEAM_FILTER_ENABLED:
            track_role[track_id] = role

        is_our_player = role in ('MAIN', 'LIBERO')
        if is_our_player:
            track_positions[track_id].append((frame_idx, x1, y1, x2, y2))

    if frame_idx % 100 == 0:
        pct = int((frame_idx - _chunk_start) / total_frames * 100)
        print(f"  Frame {frame_idx} | {len(track_ocr_readings)} tracks with at least one reading so far")
        print(f"{pct}%")

cap.release()
print(f"[INFO] Pass 1 done: {len(track_positions)} tracks recorded as our-team players, "
      f"{len(track_ocr_readings)} of them have at least one OCR reading.")


# --- PASS 2: RESOLVE EACH TRACK'S IDENTITY FROM ITS WHOLE HISTORY ---

def _confidence_weighted_tally(readings):
    """Sums confidence per candidate number instead of counting readings
    equally -- verified directly against real footage that jersey_digit.pt's
    known 3/8/9 confusion produces close, sometimes near-even RAW vote counts
    for the same physical player (one real track: 46 reads of #3 vs 42 of #9,
    a 36% 'majority' that's barely better than a coin flip). A wrong guess on
    an ambiguous crop is typically a lower-confidence guess than a correct
    read on a clean one, so weighting by confidence lets a smaller number of
    high-confidence correct reads outweigh a larger number of low-confidence
    wrong ones, rather than every reading counting the same regardless of
    how sure the model actually was."""
    tally = Counter()
    for jersey_num, conf in readings:
        tally[jersey_num] += conf
    return tally


def resolve_track_jerseys():
    """Confidence-weighted vote across each track's ENTIRE collected reading
    history, not the first reading to clear a live threshold -- a track that
    reads wrong a couple of times early but right for the rest of its life
    now resolves correctly, which real-time locking could never recover
    from."""
    resolved = {}
    for track_id, readings in track_ocr_readings.items():
        if len(readings) < MIN_READINGS_TO_RESOLVE:
            continue
        tally = _confidence_weighted_tally(readings)
        best_jersey, _ = tally.most_common(1)[0]
        resolved[track_id] = best_jersey
    return resolved


def resolve_collisions(resolved):
    """Two tracks resolving to the same jersey number are either the same
    physical player fragmented by a tracker drop (fine, stitching below will
    treat them as one), or two different real players who both got read as
    the same number by mistake -- provably true whenever they were ever
    simultaneously on screen. In that case, keep whichever track has stronger
    (confidence-weighted, not just count) support for the number and demote
    the other back to unresolved, so it goes through the stitching pass
    instead and (hopefully) finds its actual number from a nearby resolved
    tracklet."""
    by_jersey = defaultdict(list)
    for tid, j in resolved.items():
        by_jersey[j].append(tid)

    final = dict(resolved)
    for jersey, tids in by_jersey.items():
        if len(tids) < 2:
            continue
        def _support(t):
            return sum(conf for num, conf in track_ocr_readings[t] if num == jersey)
        tids_sorted = sorted(tids, key=lambda t: -_support(t))
        keeper = tids_sorted[0]
        for tid in tids_sorted[1:]:
            if _tracks_overlapped_in_time(tid, keeper):
                print(f"[Jersey COLLISION] track_id={tid} and track_id={keeper} both read as "
                      f"#{jersey} but were simultaneously on screen -- demoting {tid} back to unresolved")
                final.pop(tid, None)
    return final


def stitch_unresolved_tracks(final):
    """Global, offline tracklet stitching: for every track that never got a
    confident jersey reading of its own, find the nearest resolved tracklet
    by position + timing and adopt its number -- checking BOTH directions
    (this track could precede a resolved one, or continue after it ends),
    which a live, forward-only bridge can never do since it doesn't yet know
    about tracks that haven't appeared yet."""
    jersey_endpoints = defaultdict(list)  # jersey -> [(start_f, start_pos, end_f, end_pos), ...]
    by_jersey = defaultdict(list)
    for tid, j in final.items():
        by_jersey[j].append(tid)
    for j, tids in by_jersey.items():
        for tid in tids:
            positions = track_positions[tid]
            sf, sx1, sy1, sx2, sy2 = positions[0]
            ef, ex1, ey1, ex2, ey2 = positions[-1]
            jersey_endpoints[j].append(
                (sf, ((sx1+sx2)/2.0, (sy1+sy2)/2.0), ef, ((ex1+ex2)/2.0, (ey1+ey2)/2.0)))
    # Previous chunk's carried-over endpoints -- treated as zero-length
    # segments (start==end at the last known point) so this chunk's own
    # early unresolved tracks can stitch onto them immediately.
    for j, pts in imported_endpoints.items():
        for (f, cx, cy) in pts:
            jersey_endpoints[j].append((f, (cx, cy), f, (cx, cy)))

    max_gap_frames = STITCH_MAX_GAP_SEC * fps

    def dist(a, b):
        return ((a[0]-b[0])**2 + (a[1]-b[1])**2) ** 0.5

    stitched_count = 0
    for tid, positions in track_positions.items():
        if tid in final:
            continue
        t_sf, t_sx1, t_sy1, t_sx2, t_sy2 = positions[0]
        t_ef, t_ex1, t_ey1, t_ex2, t_ey2 = positions[-1]
        t_start_pos = ((t_sx1+t_sx2)/2.0, (t_sy1+t_sy2)/2.0)
        t_end_pos = ((t_ex1+t_ex2)/2.0, (t_ey1+t_ey2)/2.0)

        best_jersey, best_cost = None, STITCH_MAX_DIST_PX
        for j, endpoints in jersey_endpoints.items():
            for (sf, spos, ef, epos) in endpoints:
                # this track could continue right after an existing segment ends
                if 0 < (t_sf - ef) <= max_gap_frames:
                    d = dist(t_start_pos, epos)
                    if d < best_cost:
                        best_cost, best_jersey = d, j
                # or this track could precede an existing segment's start
                if 0 < (sf - t_ef) <= max_gap_frames:
                    d = dist(t_end_pos, spos)
                    if d < best_cost:
                        best_cost, best_jersey = d, j
        if best_jersey is not None:
            final[tid] = best_jersey
            stitched_count += 1
    print(f"[INFO] Pass 2 stitching: {stitched_count} otherwise-unresolved tracks "
          f"matched to a nearby resolved tracklet.")
    return final


print("[START] Pass 2/3: resolve identities + stitch tracklets...")
_resolved = resolve_track_jerseys()
_resolved = resolve_collisions(_resolved)
track_to_jersey = stitch_unresolved_tracks(_resolved)
print(f"[INFO] Pass 2 done: {len(track_to_jersey)} tracks resolved to a jersey number "
      f"across {len(set(track_to_jersey.values()))} distinct players.")
print(f"[INFO] Jersey map (jersey -> most-recent track_id): "
      f"{ {j: max((t for t, jj in track_to_jersey.items() if jj == j), key=lambda t: track_positions[t][-1][0]) for j in set(track_to_jersey.values())} }")
print(f"[INFO] Team labels: {team_labels_by_track}")


# --- PASS 3: RENDER THE DEBUG VIDEO USING FINAL, RESOLVED IDENTITIES ---
# Re-reads raw frames (cheap -- no model inference this time) so the debug
# video shows the same final answer as the exported JSON, instead of the
# in-progress, still-uncertain labels Pass 1 would have had to show live.
print("[START] Pass 3/3: rendering annotated video...")
_frame_to_boxes = defaultdict(list)  # frame_idx -> [(x1,y1,x2,y2,role,jersey_or_none), ...]
for track_id, positions in track_positions.items():
    role = track_role.get(track_id, 'MAIN')
    jersey = track_to_jersey.get(track_id)
    for (fidx, x1, y1, x2, y2) in positions:
        _frame_to_boxes[fidx].append((x1, y1, x2, y2, role, jersey, track_id))

cap = cv2.VideoCapture(VIDEO_PATH)
if _chunk_start > 0:
    cap.set(cv2.CAP_PROP_POS_FRAMES, _chunk_start)
out = cv2.VideoWriter(OUTPUT_PATH, cv2.VideoWriter_fourcc(*'mp4v'),
                       fps, (frame_width, frame_height))
frame_idx = _chunk_start - 1
while cap.isOpened():
    success, frame = cap.read()
    if not success:
        break
    frame_idx += 1
    if frame_idx > _chunk_end:
        break

    for (x1, y1, x2, y2, role, jersey, track_id) in _frame_to_boxes.get(frame_idx, []):
        if role == 'OTHER':
            label = "Other"
        elif role == 'OPPONENT':
            label = "Opp"
        elif role == 'OPP_LIBERO':
            label = "LOpp"
        else:
            prefix = "L" if role == 'LIBERO' else "T"
            label = f"{prefix}#{jersey}" if jersey is not None else f"{prefix}?{track_id}"
        color = ROLE_BOX_COLORS.get(role, (255, 255, 255))
        cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
        cv2.putText(frame, label, (x1, max(20, y1-10)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, color, 2)

    cv2.putText(frame, f"Frame {frame_idx}", (20, 32),
                cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
    out.write(frame)

cap.release()
out.release()
print(f"[SUCCESS] Done. Output: {OUTPUT_PATH}")

# Export this run's bootstrap state (chunked processing) -- a later chunk
# importing this via --import-bootstrap skips its own color bootstrap and
# starts from these same centroids/roles/footprint instead, and seeds its
# own stitching pass with every resolved jersey's last known position here.
if _args.export_bootstrap and cluster_centroids is not None:
    os.makedirs(os.path.dirname(os.path.abspath(_args.export_bootstrap)), exist_ok=True)
    last_positions = {}
    for jersey in set(track_to_jersey.values()):
        member_tids = [t for t, j in track_to_jersey.items() if j == jersey]
        last_tid = max(member_tids, key=lambda t: track_positions[t][-1][0])
        lf, lx1, ly1, lx2, ly2 = track_positions[last_tid][-1]
        last_positions[str(jersey)] = {"frame": lf, "cx": (lx1+lx2)/2.0, "cy": (ly1+ly2)/2.0}
    with open(_args.export_bootstrap, "w") as _f:
        json.dump({
            "centroids": cluster_centroids.tolist(),
            "roles": {str(k): v for k, v in cluster_roles.items()},
            "main_court_cys": main_court_cys,
            "opponent_court_cys": opponent_court_cys,
            "last_positions": last_positions,
        }, _f)
    print(f"[INFO] Exported bootstrap state ({len(last_positions)} last known positions) -> {_args.export_bootstrap}")

# --- 5. FRAME-JERSEY MAP (consumed by triple_detection.py) ---
if _args.frame_jersey_map:
    frame_map = defaultdict(list)
    for track_id, positions in track_positions.items():
        jersey = track_to_jersey.get(track_id)
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
    for jersey in set(track_to_jersey.values()):
        member_tids = [t for t, j in track_to_jersey.items() if j == jersey]
        # Most-recent track_id as the "representative" one for role/thumbnail --
        # role is fixed per-track already, and all member tracks of one resolved
        # jersey should agree on role (they were all classified as is_our_player).
        rep_tid = max(member_tids, key=lambda t: track_positions[t][-1][0])
        role = track_role.get(rep_tid, "MAIN")
        thumbnail = None
        if _args.thumbs_dir:
            thumb_tid = max((t for t in member_tids if t in best_thumb_crop),
                             key=lambda t: best_thumb_area.get(t, 0), default=None)
            if thumb_tid is not None:
                os.makedirs(_args.thumbs_dir, exist_ok=True)
                thumbnail = os.path.join(_args.thumbs_dir, f"id{rep_tid}.jpg")
                cv2.imwrite(thumbnail, best_thumb_crop[thumb_tid])
        registry[str(jersey)] = {
            "jersey": jersey,
            "track_id": rep_tid,
            "role": role,
            "team": "opponent" if role == "OPPONENT" else "my_team",
            "thumbnail": thumbnail,
        }
    with open(_args.output_json, "w") as _f:
        json.dump(registry, _f, indent=2)
    print(f"[INFO] Registry saved -> {_args.output_json} ({len(registry)} players)")
