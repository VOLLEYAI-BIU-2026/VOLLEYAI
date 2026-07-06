"""
predict_pipeline.py  —  VolleyAI jersey-OCR + Player Re-Identification pipeline.

Requirements implemented: 1-26 (26 = same-frame one-to-one assignment constraint)
Config: reid_config.json  (same directory as this file)
"""

import sys
import cv2
import os
import json
import argparse
import numpy as np
from collections import defaultdict, Counter, deque
from dataclasses import dataclass, field
from typing import Optional
import easyocr
import torch
import torchvision.models as tvm
import torchvision.transforms as T

# ─────────────────────────────────────────────────────────────────────────────
# 1. CONFIG  (req 25)
# ─────────────────────────────────────────────────────────────────────────────
SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
_CONFIG_PATH = os.path.join(SCRIPT_DIR, "reid_config.json")

def _load_config() -> dict:
    defaults = {
        "ocr":      {"conf_threshold": 0.80, "lock_votes": 3, "unlock_consecutive": 10,
                     "min_crop_px": 15, "min_blur_var": 60.0},
        "reid":     {"similarity_threshold": 0.70, "embed_max_avg": 30},
        "fusion":   {"reid_weight": 0.55, "ocr_weight": 0.25, "position_weight": 0.10,
                     "temporal_weight": 0.10, "merge_threshold": 0.55},
        "temporal": {"max_teleport_frames": 10, "max_court_fraction": 0.30, "max_gap_frames": 90},
        "rally":    {"defer_updates": True, "min_players": 4,
                     "movement_px_threshold": 6.0, "end_still_frames": 30},
        "confidence_history": {"window_size": 60},
        "impossible_change":  {"reid_certainty": 0.90},
        "debug":    {"enabled": True,
                     "locked_color": [0, 210, 0], "tentative_color": [0, 165, 255],
                     "merged_color": [200, 0, 220], "recently_merged_frames": 40},
        "team":     {"bootstrap_samples": 40, "vote_min": 3, "official_threshold": 80},
    }
    if os.path.exists(_CONFIG_PATH):
        with open(_CONFIG_PATH) as _f:
            user = json.load(_f)
        for section, vals in user.items():
            defaults.setdefault(section, {}).update(vals)
    return defaults

CFG = _load_config()
_O  = CFG["ocr"]
_R  = CFG["reid"]
_F  = CFG["fusion"]
_T  = CFG["temporal"]
_RL = CFG["rally"]
_CH = CFG["confidence_history"]
_IC = CFG["impossible_change"]
_D  = CFG["debug"]
_TM = CFG["team"]

# ─────────────────────────────────────────────────────────────────────────────
# 2. ARGS
# ─────────────────────────────────────────────────────────────────────────────
_parser = argparse.ArgumentParser()
_parser.add_argument("--video",            default=os.path.join(SCRIPT_DIR, "../videos/test_clip.mp4"))
_parser.add_argument("--output",           default=os.path.join(SCRIPT_DIR, "output_tracking.mp4"))
_parser.add_argument("--my-team-color",    default="blue_white")
_parser.add_argument("--libero-color",     default="")
_parser.add_argument("--opponent-color",   default="black_white")
_parser.add_argument("--output-json",      default="")
_parser.add_argument("--thumbs-dir",       default="")
_parser.add_argument("--frame-jersey-map", default="")
_parser.add_argument("--calib-json",       default="")
_args = _parser.parse_args()

VIDEO_PATH  = os.path.abspath(_args.video)
OUTPUT_PATH = os.path.abspath(_args.output)
OUTPUT_JSON = _args.output_json
THUMBS_DIR  = _args.thumbs_dir
CALIB_JSON  = _args.calib_json

if THUMBS_DIR:
    os.makedirs(THUMBS_DIR, exist_ok=True)

# ─────────────────────────────────────────────────────────────────────────────
# 3. MODELS
# ─────────────────────────────────────────────────────────────────────────────
from ultralytics import YOLO

PLAYER_MODEL = YOLO(os.path.join(SCRIPT_DIR, "yolo11s.pt"))
JERSEY_MODEL = YOLO(os.path.join(SCRIPT_DIR, "jersey_model.pt"))

print("[INIT] Loading EasyOCR...")
OCR_READER = easyocr.Reader(['en'], gpu=False, verbose=False)

print("[INIT] Loading ReID backbone (MobileNetV3-small)...")
_reid_backbone = tvm.mobilenet_v3_small(weights=tvm.MobileNet_V3_Small_Weights.DEFAULT)
_reid_backbone.classifier = torch.nn.Identity()
_reid_backbone.eval()
_reid_transform = T.Compose([
    T.ToPILImage(),
    T.Resize((128, 64)),
    T.ToTensor(),
    T.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
])

def extract_reid_embedding(crop: np.ndarray) -> Optional[np.ndarray]:
    if crop is None or crop.size == 0:
        return None
    h, w = crop.shape[:2]
    if h < 32 or w < 16:
        return None
    rgb    = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
    tensor = _reid_transform(rgb).unsqueeze(0)
    with torch.no_grad():
        feat = _reid_backbone(tensor).squeeze().numpy()
    norm = np.linalg.norm(feat)
    return feat / norm if norm > 1e-6 else None

def cosine_sim(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(a, b))

# ─────────────────────────────────────────────────────────────────────────────
# 4. COURT PROJECTOR  (req 20)
# ─────────────────────────────────────────────────────────────────────────────
class CourtProjector:
    def __init__(self, calib_path: str):
        self.H: Optional[np.ndarray] = None
        if calib_path and os.path.exists(calib_path):
            with open(calib_path) as f:
                data = json.load(f)
            self.H = np.array(data["H"], dtype=np.float64)
            print(f"[CourtProjector] Loaded homography from {calib_path}")
        else:
            print("[CourtProjector] No calibration — court positions unavailable")

    @property
    def ready(self) -> bool:
        return self.H is not None

    def project(self, px: float, py: float) -> Optional[tuple]:
        if not self.ready:
            return None
        src = np.array([[[px, py]]], dtype=np.float32)
        dst = cv2.perspectiveTransform(src, self.H)[0][0]
        return float(dst[0]), float(dst[1])

    def court_distance(self, p1: tuple, p2: tuple) -> float:
        return float(np.hypot(p1[0] - p2[0], p1[1] - p2[1]))

PROJECTOR = CourtProjector(CALIB_JSON)

# ─────────────────────────────────────────────────────────────────────────────
# 5. RALLY MANAGER  (req 17)
# ─────────────────────────────────────────────────────────────────────────────
class RallyManager:
    def __init__(self):
        self.active           = False
        self._still_count     = 0
        self._prev_positions  = {}
        self._pending_updates = []

    def update(self, current_positions: dict, n_players: int):
        if not _RL["defer_updates"]:
            return
        if not current_positions:
            self._end_rally_check()
            return
        movements = [
            float(np.hypot(cx - self._prev_positions[tid][0],
                           cy - self._prev_positions[tid][1]))
            for tid, (cx, cy) in current_positions.items()
            if tid in self._prev_positions
        ]
        self._prev_positions = dict(current_positions)
        if not movements:
            self._end_rally_check()
            return
        avg_move = float(np.mean(movements))
        if avg_move > _RL["movement_px_threshold"] and n_players >= _RL["min_players"]:
            if not self.active:
                self.active       = True
                self._still_count = 0
                print(f"[Rally] STARTED  (avg_move={avg_move:.1f}px  players={n_players})")
            else:
                self._still_count = 0
        else:
            self._end_rally_check()

    def _end_rally_check(self):
        if not self.active:
            return
        self._still_count += 1
        if self._still_count >= _RL["end_still_frames"]:
            self.active       = False
            self._still_count = 0
            print(f"[Rally] ENDED — flushing {len(self._pending_updates)} deferred updates")
            for fn, args, kwargs in self._pending_updates:
                fn(*args, **kwargs)
            self._pending_updates.clear()

    def defer_or_run(self, fn, *args, **kwargs):
        if self.active and _RL["defer_updates"]:
            self._pending_updates.append((fn, args, kwargs))
        else:
            fn(*args, **kwargs)

RALLY = RallyManager()

# ─────────────────────────────────────────────────────────────────────────────
# 6. CONFIDENCE HISTORY  (req 22)
# ─────────────────────────────────────────────────────────────────────────────
class ConfidenceHistory:
    W = _CH["window_size"]

    def __init__(self):
        self._ocr_confs   = deque(maxlen=self.W)
        self._reid_sims   = deque(maxlen=self.W)
        self._merge_confs = deque(maxlen=self.W)
        self._lock_flags  = deque(maxlen=self.W)

    def record(self, ocr_conf=None, reid_sim=None, merge_conf=None, locked=None):
        if ocr_conf   is not None: self._ocr_confs.append(float(ocr_conf))
        if reid_sim   is not None: self._reid_sims.append(float(reid_sim))
        if merge_conf is not None: self._merge_confs.append(float(merge_conf))
        if locked     is not None: self._lock_flags.append(1 if locked else 0)

    @property
    def avg_ocr(self)        -> float: return float(np.mean(self._ocr_confs))   if self._ocr_confs   else 0.0
    @property
    def avg_reid(self)       -> float: return float(np.mean(self._reid_sims))   if self._reid_sims   else 0.0
    @property
    def avg_merge(self)      -> float: return float(np.mean(self._merge_confs)) if self._merge_confs else 0.0
    @property
    def lock_stability(self) -> float: return float(np.mean(self._lock_flags))  if self._lock_flags  else 0.0

# ─────────────────────────────────────────────────────────────────────────────
# 7. PLAYER IDENTITY  (req 1-13, 17, 19, 22, 23, 24)
# ─────────────────────────────────────────────────────────────────────────────
_next_player_id = 1

@dataclass
class PlayerIdentity:
    player_id:       int
    locked_jersey:   Optional[int]        = None
    lock_confidence: float                = 0.0
    vote_history:    list                 = field(default_factory=list)
    last_seen_frame: int                  = 0
    reid_embedding:  Optional[np.ndarray] = None
    embedding_count: int                  = 0
    track_ids:       set                  = field(default_factory=set)
    history:         ConfidenceHistory    = field(default_factory=ConfidenceHistory)
    last_court_pos:  Optional[tuple]      = None
    last_image_pos:  Optional[tuple]      = None
    recently_merged: int                  = 0
    _consec_jersey:  Optional[int]        = field(default=None, repr=False)
    _consec_count:   int                  = field(default=0,    repr=False)
    _display_jersey: Optional[int]        = field(default=None, repr=False)

    def add_ocr_read(self, jersey_num: int, conf: float, frame: int,
                     last_reid_sim: float = 0.0):
        self.vote_history.append((jersey_num, conf, frame))
        self.last_seen_frame = frame
        self.history.record(ocr_conf=conf)

        # req 23: suppress if ReID is very certain identity is correct
        if (self.locked_jersey is not None
                and jersey_num != self.locked_jersey
                and last_reid_sim >= _IC["reid_certainty"]):
            print(f"[OCR SUPPRESSED] player_id={self.player_id} "
                  f"OCR=#{jersey_num} reid_sim={last_reid_sim:.2f}>={_IC['reid_certainty']}"
                  f" — keeping #{self.locked_jersey}")
            return

        if self.locked_jersey is None:
            counts = Counter(j for j, c, _ in self.vote_history if c >= _O["conf_threshold"])
            if not counts:
                return
            best_j, best_count = counts.most_common(1)[0]
            if best_count >= _O["lock_votes"]:
                avg_conf = float(np.mean(
                    [c for j, c, _ in self.vote_history
                     if j == best_j and c >= _O["conf_threshold"]]
                ))
                _bj, _ac = best_j, avg_conf

                def _apply_lock():
                    self.locked_jersey   = _bj
                    self.lock_confidence = _ac
                    self._display_jersey = _bj
                    print(f"[Jersey LOCKED] player_id={self.player_id} "
                          f"jersey=#{_bj} conf={_ac:.2f} votes={best_count}")
                RALLY.defer_or_run(_apply_lock)
        else:
            if jersey_num != self.locked_jersey and conf >= _O["conf_threshold"]:
                if self._consec_jersey == jersey_num:
                    self._consec_count += 1
                else:
                    self._consec_jersey = jersey_num
                    self._consec_count  = 1
                if self._consec_count >= _O["unlock_consecutive"]:
                    _nj, _nc, _cc = jersey_num, conf, self._consec_count

                    def _apply_update():
                        print(f"[Jersey UPDATED] player_id={self.player_id} "
                              f"#{self.locked_jersey}->#{_nj} ({_cc} consecutive frames)")
                        self.locked_jersey   = _nj
                        self.lock_confidence = _nc
                        self._display_jersey = _nj
                        self._consec_count   = 0
                        self._consec_jersey  = None
                    RALLY.defer_or_run(_apply_update)
            else:
                self._consec_count  = 0
                self._consec_jersey = None

    @property
    def display_jersey(self) -> Optional[int]:
        """Stable display label — frozen during rally. Req 17."""
        return self._display_jersey

    def update_embedding(self, emb: np.ndarray):
        max_n = _R["embed_max_avg"]
        if self.reid_embedding is None:
            self.reid_embedding  = emb.copy()
            self.embedding_count = 1
        elif self.embedding_count < max_n:
            n = self.embedding_count
            self.reid_embedding  = (self.reid_embedding * n + emb) / (n + 1)
            self.embedding_count  = n + 1
            norm = np.linalg.norm(self.reid_embedding)
            if norm > 1e-6:
                self.reid_embedding /= norm

    def update_position(self, cx: float, cy: float, court_pos: Optional[tuple]):
        self.last_image_pos = (cx, cy)
        if court_pos is not None:
            self.last_court_pos = court_pos

    def tick_merged(self):
        if self.recently_merged > 0:
            self.recently_merged -= 1

# ─────────────────────────────────────────────────────────────────────────────
# 8. JERSEY REGISTRY  (req 18)
# ─────────────────────────────────────────────────────────────────────────────
class JerseyRegistry:
    def __init__(self):
        self._map: dict = {}

    def register(self, jersey: int, player: PlayerIdentity):
        if jersey not in self._map:
            self._map[jersey] = player

    def lookup(self, jersey: int) -> Optional[PlayerIdentity]:
        return self._map.get(jersey)

JERSEY_REG = JerseyRegistry()

# ─────────────────────────────────────────────────────────────────────────────
# 9. GLOBAL REGISTRIES & TEMPORAL TRACKING
# ─────────────────────────────────────────────────────────────────────────────
all_players:          list  = []
track_to_player:      dict  = {}
jersey_to_track_ids         = defaultdict(set)
track_positions             = defaultdict(list)
track_thumbnails:     dict  = {}

# req 26 — track_id -> set of frame numbers where it was seen
# Used to detect temporal overlap: if A and B ever appeared in the same frame,
# they cannot belong to the same PlayerIdentity.
track_active_frames: dict   = defaultdict(set)

# ─────────────────────────────────────────────────────────────────────────────
# 10. CONFIDENCE FUSION  (req 19, 21)
# ─────────────────────────────────────────────────────────────────────────────
def position_consistency_score(player: PlayerIdentity,
                                new_cx: float, new_cy: float,
                                new_court: Optional[tuple],
                                frame_gap: int) -> float:
    if player.last_image_pos is None:
        return 0.5
    if PROJECTOR.ready and player.last_court_pos is not None and new_court is not None:
        dist = PROJECTOR.court_distance(player.last_court_pos, new_court)
        if frame_gap <= _T["max_teleport_frames"] and dist > _T["max_court_fraction"]:
            penalty = 1.0 - min(1.0, (dist - _T["max_court_fraction"]) / _T["max_court_fraction"])
            return float(np.clip(penalty, 0.0, 1.0))
        return float(np.clip(1.0 - dist, 0.0, 1.0))
    px, py  = player.last_image_pos
    dist_px = float(np.hypot(new_cx - px, new_cy - py))
    return float(np.clip(1.0 - dist_px / 500.0, 0.0, 1.0))

def temporal_consistency_score(player: PlayerIdentity, current_frame: int) -> float:
    gap = current_frame - player.last_seen_frame
    return float(np.clip(1.0 - gap / _T["max_gap_frames"], 0.0, 1.0))

def fusion_score(reid_sim: float, ocr_conf: float,
                 pos_score: float, temp_score: float) -> float:
    return (
        _F["reid_weight"]     * reid_sim  +
        _F["ocr_weight"]      * ocr_conf  +
        _F["position_weight"] * pos_score +
        _F["temporal_weight"] * temp_score
    )

# ─────────────────────────────────────────────────────────────────────────────
# 11. TEMPORAL OVERLAP GUARD  (req 26)
# ─────────────────────────────────────────────────────────────────────────────
def _check_temporal_overlap(new_tid: int, candidate: PlayerIdentity) -> bool:
    """
    Returns True if a merge is SAFE (no temporal overlap).
    Returns False if new_tid and any existing track_id in candidate were ever
    visible in the same frame — they cannot be the same person.
    """
    new_frames = track_active_frames[new_tid]
    if not new_frames:
        return True  # brand-new track has no history, no overlap possible
    for existing_tid in candidate.track_ids:
        overlap = new_frames & track_active_frames[existing_tid]
        if overlap:
            print(f"[Track MERGE REJECTED] new_tid={new_tid} "
                  f"candidate_tid={existing_tid} player_id={candidate.player_id} "
                  f"reason=temporal_overlap_same_frame frames={len(overlap)}")
            return False
    return True

# ─────────────────────────────────────────────────────────────────────────────
# 12. ONE-TO-ONE GREEDY ASSIGNMENT  (req 26)
#
# Given a list of unassigned detections and available PlayerIdentity candidates,
# compute all pairwise fusion scores, sort descending, and greedily assign
# highest-score pairs — ensuring each detection gets at most one player and
# each player gets at most one detection per frame.
# ─────────────────────────────────────────────────────────────────────────────
def greedy_assign(new_dets: list, available_players: list,
                  frame_idx: int) -> dict:
    """
    Returns {track_id: (PlayerIdentity, reid_sim, score)}.
    Only includes pairs where score >= merge_threshold.
    Enforces: one-to-one, temporal-overlap-free assignment.
    """
    pairs = []   # (score, sim, det_idx, player_idx)

    for i, det in enumerate(new_dets):
        emb = det["emb"]
        if emb is None:
            continue
        for j, player in enumerate(available_players):
            if player.reid_embedding is None:
                continue
            # Temporal overlap guard (req 26)
            if not _check_temporal_overlap(det["tid"], player):
                continue
            sim       = cosine_sim(emb, player.reid_embedding)
            pos_score = position_consistency_score(
                player, det["cx"], det["cy"], det["court_pos"],
                frame_idx - player.last_seen_frame)
            tmp_score = temporal_consistency_score(player, frame_idx)
            ocr_sig   = player.history.avg_ocr if player.history.avg_ocr > 0 else 0.5
            score     = fusion_score(sim, ocr_sig, pos_score, tmp_score)
            if score >= _F["merge_threshold"]:
                pairs.append((score, sim, i, j))

    pairs.sort(reverse=True)   # highest score first

    assigned_dets    = set()
    assigned_players = set()
    result           = {}

    for score, sim, di, pi in pairs:
        if di in assigned_dets or pi in assigned_players:
            continue
        det    = new_dets[di]
        player = available_players[pi]
        result[det["tid"]] = (player, sim, score)
        assigned_dets.add(di)
        assigned_players.add(pi)

    return result

# ─────────────────────────────────────────────────────────────────────────────
# 13. PLAYER CREATION HELPER
# ─────────────────────────────────────────────────────────────────────────────
def _make_player(det: dict, frame_idx: int) -> PlayerIdentity:
    global _next_player_id
    p = PlayerIdentity(
        player_id       = _next_player_id,
        last_seen_frame = frame_idx,
        reid_embedding  = det["emb"],
        embedding_count = 1 if det["emb"] is not None else 0,
    )
    p.track_ids.add(det["tid"])
    p.update_position(det["cx"], det["cy"], det["court_pos"])
    _next_player_id += 1
    all_players.append(p)
    track_to_player[det["tid"]] = p
    print(f"[New player] player_id={p.player_id} track_id={det['tid']} role={det['role']}")
    return p

# ─────────────────────────────────────────────────────────────────────────────
# 14. OCR HELPERS
# ─────────────────────────────────────────────────────────────────────────────
def preprocess_for_ocr(crop: np.ndarray) -> np.ndarray:
    h, w = crop.shape[:2]
    if h < 40 or w < 30:
        scale = max(40 / max(h, 1), 30 / max(w, 1))
        crop  = cv2.resize(crop, (int(w*scale), int(h*scale)), interpolation=cv2.INTER_CUBIC)
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return binary

def _try_read(img) -> tuple:
    results = OCR_READER.readtext(img, allowlist='0123456789', detail=1)
    if not results:
        return None, 0.0
    if len(results) == 1:
        text = results[0][1].strip()
        if text.isdigit() and 1 <= int(text) <= 99:
            return int(text), float(results[0][2])
        return None, 0.0
    results_sorted = sorted(results, key=lambda r: r[0][0][0])
    if len(results_sorted) == 2:
        crop_w         = img.shape[1]
        right_of_first = max(p[0] for p in results_sorted[0][0])
        left_of_second = min(p[0] for p in results_sorted[1][0])
        if left_of_second - right_of_first < crop_w * 0.3:
            combined = results_sorted[0][1].strip() + results_sorted[1][1].strip()
            if combined.isdigit() and 1 <= int(combined) <= 99:
                return int(combined), min(float(results_sorted[0][2]),
                                          float(results_sorted[1][2]))
    candidates = [(int(r[1].strip()), float(r[2])) for r in results
                  if r[1].strip().isdigit() and 1 <= int(r[1].strip()) <= 99]
    if candidates:
        return max(candidates, key=lambda x: x[1])
    return None, 0.0

def read_jersey_number_with_conf(crop: np.ndarray) -> tuple:
    if crop is None or crop.size == 0:
        return None, 0.0
    h, w = crop.shape[:2]
    if h < _O["min_crop_px"] or w < _O["min_crop_px"]:
        print(f"[OCR ignored] crop too small ({w}x{h})")
        return None, 0.0
    gray     = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    blur_var = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    if blur_var < _O["min_blur_var"]:
        print(f"[OCR ignored] too blurry (var={blur_var:.1f})")
        return None, 0.0
    processed = preprocess_for_ocr(crop)
    n1, c1    = _try_read(processed)
    n2, c2    = _try_read(cv2.bitwise_not(processed))
    if n1 is None and n2 is None: return None, 0.0
    if n1 is None: return n2, c2
    if n2 is None: return n1, c1
    return (n1, c1) if c1 >= c2 else (n2, c2)

def detect_jersey_region(player_crop: np.ndarray):
    if player_crop is None or player_crop.size == 0:
        return None, None
    results   = JERSEY_MODEL(player_crop, conf=0.4, verbose=False)
    best_box  = None
    best_conf = 0.0
    for r in results:
        for j_box in r.boxes:
            conf = float(j_box.conf[0])
            if conf > best_conf:
                best_conf = conf
                best_box  = j_box.xyxy[0]
    if best_box is not None:
        jx1, jy1, jx2, jy2 = map(int, best_box)
        jcrop = player_crop[max(0, jy1):jy2, max(0, jx1):jx2]
        return jcrop, (jx1, jy1, jx2, jy2)
    return None, None

# ─────────────────────────────────────────────────────────────────────────────
# 15. TEAM CLASSIFICATION
# ─────────────────────────────────────────────────────────────────────────────
_PRESET_DOMINANT_BGR = {
    "white":  (255, 255, 255), "blue":   (255,   0,   0),
    "navy":   (128,   0,   0), "red":    (  0,   0, 255),
    "maroon": (  0,   0, 100), "black":  (  0,   0,   0),
    "yellow": (  0, 255, 255), "green":  (  0, 200,   0),
    "orange": (  0, 165, 255), "purple": (128,   0, 128),
    "gray":   (128, 128, 128), "gold":   (  0, 215, 255),
}

def _preset_to_bgr(key: str):
    first = (key or "").split("_")[0]
    return np.array(_PRESET_DOMINANT_BGR.get(first, (128, 128, 128)), dtype=np.uint8)

team_color_samples   = []
cluster_centroids    = None
cluster_roles        = {}
team_votes           = defaultdict(Counter)
team_labels_by_track = {}

_main_bgr     = _preset_to_bgr(_args.my_team_color)
_libero_bgr   = _preset_to_bgr(_args.libero_color)   if _args.libero_color   else None
_opponent_bgr = _preset_to_bgr(_args.opponent_color) if _args.opponent_color else None
K_CLUSTERS    = 3 if _libero_bgr is not None else 2
TEAM_FILTER   = _main_bgr is not None

def bgr_to_hsv(bgr):
    return cv2.cvtColor(np.uint8([[bgr]]), cv2.COLOR_BGR2HSV)[0, 0].astype(np.float32)

_main_hsv     = bgr_to_hsv(_main_bgr)
_libero_hsv   = bgr_to_hsv(_libero_bgr)   if _libero_bgr   is not None else None
_opponent_hsv = bgr_to_hsv(_opponent_bgr) if _opponent_bgr is not None else None

def extract_torso_color(crop):
    if crop is None or crop.size == 0: return None
    h, w = crop.shape[:2]
    if h < 10 or w < 10: return None
    torso = crop[int(0.15*h):int(0.55*h), int(0.25*w):int(0.75*w)]
    if torso.size == 0: return None
    hsv = cv2.cvtColor(torso, cv2.COLOR_BGR2HSV)
    return np.median(hsv.reshape(-1, 3).astype(np.float32), axis=0)

def hsv_distance(c1, c2):
    h1, s1, v1 = c1; h2, s2, v2 = c2
    if s1 < 40 or s2 < 40:
        return float(((v1-v2)**2 + ((s1-s2)*0.5)**2) ** 0.5)
    dh = min(abs(h1-h2), 180-abs(h1-h2)) * 2.0
    return float((dh**2 + (s1-s2)**2 + ((v1-v2)*0.5)**2) ** 0.5)

def bootstrap_kmeans():
    global cluster_centroids, cluster_roles
    data     = np.array(team_color_samples, dtype=np.float32)
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
    for i in range(K_CLUSTERS):
        if i not in cluster_roles:
            cluster_roles[i] = 'OPPONENT'
    cluster_centroids = centers
    print(f"[INFO] k-means done (k={K_CLUSTERS}):")
    for i in range(K_CLUSTERS):
        print(f"  Centroid {i} ({cluster_roles[i]}): HSV={np.round(centers[i],1).tolist()}")

def classify_color(color):
    if cluster_centroids is None or color is None: return None
    dists   = [hsv_distance(color, cluster_centroids[i]) for i in range(K_CLUSTERS)]
    nearest = int(np.argmin(dists))
    return 'OTHER' if dists[nearest] > _TM["official_threshold"] else cluster_roles[nearest]

def update_team_label(track_id, player_crop):
    color = extract_torso_color(player_crop)
    if color is None: return
    if cluster_centroids is None:
        if len(team_color_samples) < _TM["bootstrap_samples"]:
            team_color_samples.append(color)
        if len(team_color_samples) >= _TM["bootstrap_samples"]:
            bootstrap_kmeans()
        return
    role = classify_color(color)
    if role is None: return
    team_votes[track_id][role] += 1
    if sum(team_votes[track_id].values()) >= _TM["vote_min"]:
        team_labels_by_track[track_id] = team_votes[track_id].most_common(1)[0][0]

# ─────────────────────────────────────────────────────────────────────────────
# 16. DEBUG RENDERER  (req 24)
# ─────────────────────────────────────────────────────────────────────────────
def _player_box_color(player: Optional[PlayerIdentity], role: str) -> tuple:
    if player is None:
        return {"LIBERO": (0,215,255), "OPPONENT": (255,100,0)}.get(role, (160,160,160))
    if player.recently_merged > 0:
        r, g, b = _D["merged_color"];   return (b, g, r)
    if player.locked_jersey is not None:
        r, g, b = _D["locked_color"];   return (b, g, r)
    r, g, b = _D["tentative_color"];    return (b, g, r)

def draw_player(frame: np.ndarray, x1: int, y1: int, x2: int, y2: int,
                player: Optional[PlayerIdentity], role: str,
                track_id: int, reid_sim: float, merge_score: float):
    color = _player_box_color(player, role)
    cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)

    if not _D["enabled"] or player is None:
        if role == 'OTHER':
            lbl = "Other"
        elif role == 'OPPONENT':
            lbl = "Opp"
        else:
            pfx = "L" if role == 'LIBERO' else ""
            j   = player.display_jersey if player else None
            lbl = f"{pfx}#{j}" if j else f"{pfx}?"
        cv2.putText(frame, lbl, (x1, max(20, y1 - 6)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.65, color, 2)
        return

    lock_str = "LOCKED" if player.locked_jersey is not None else "tentative"
    lines = [
        f"T{track_id} | P{player.player_id}",
        f"J=#{player.display_jersey or '?'} [{lock_str}]",
        f"OCR={player.history.avg_ocr:.2f} ReID={reid_sim:.2f}",
        f"Fuse={merge_score:.2f} Stab={player.history.lock_stability:.2f}",
    ]
    font   = cv2.FONT_HERSHEY_SIMPLEX
    scale  = 0.40
    thick  = 1
    line_h = 14
    pad    = 3
    box_w  = max(len(l) for l in lines) * 7 + pad * 2
    box_h  = len(lines) * line_h + pad * 2
    bx1, by1 = x1, max(0, y1 - box_h - 2)
    bx2, by2 = bx1 + box_w, by1 + box_h
    overlay = frame.copy()
    cv2.rectangle(overlay, (bx1, by1), (bx2, by2), (20, 20, 20), -1)
    cv2.addWeighted(overlay, 0.55, frame, 0.45, 0, frame)
    for i, line in enumerate(lines):
        cv2.putText(frame, line, (bx1 + pad, by1 + pad + (i+1) * line_h),
                    font, scale, color, thick)

# ─────────────────────────────────────────────────────────────────────────────
# 17. MAIN LOOP  — three-pass: collect → assign → apply
# ─────────────────────────────────────────────────────────────────────────────
cap = cv2.VideoCapture(VIDEO_PATH)
if not cap.isOpened():
    raise RuntimeError(f"Cannot open video: {VIDEO_PATH}")

frame_width  = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
frame_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
fps          = int(cap.get(cv2.CAP_PROP_FPS)) or 30
out = cv2.VideoWriter(OUTPUT_PATH, cv2.VideoWriter_fourcc(*'mp4v'),
                      fps, (frame_width, frame_height))

total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 1
print(f"[START] {total_frames} frames | team_filter={'ON' if TEAM_FILTER else 'OFF'} "
      f"| court={'YES' if PROJECTOR.ready else 'NO'} | debug={_D['enabled']}")

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
    raw_tids  = player_results[0].boxes.id.cpu().numpy().astype(int)

    # ─────────────────────────────────────────────────────────────────────────
    # PASS 1 — collect per-detection data (no assignment yet)
    # ─────────────────────────────────────────────────────────────────────────
    dets = []
    for box, tid in zip(boxes, raw_tids):
        x1, y1, x2, y2 = map(int, box)
        cx, cy = (x1 + x2) / 2.0, (y1 + y2) / 2.0
        crop   = frame[max(0, y1):y2, max(0, x1):x2]

        if TEAM_FILTER and tid not in team_labels_by_track:
            update_team_label(tid, crop)
        role    = team_labels_by_track.get(tid) if TEAM_FILTER else 'MAIN'
        is_ours = role in ('MAIN', 'LIBERO')

        if TEAM_FILTER and role == 'OPPONENT':
            continue  # skip opponents entirely — no tracking, no draw

        dets.append({
            "tid":       int(tid),
            "box":       (x1, y1, x2, y2),
            "cx":        cx,  "cy":       cy,
            "court_pos": PROJECTOR.project(cx, cy),
            "crop":      crop,
            "emb":       extract_reid_embedding(crop) if is_ours else None,
            "role":      role,
            "is_ours":   is_ours,
        })
        track_positions[int(tid)].append((frame_idx, x1, y1, x2, y2))

    frame_centres = {d["tid"]: (d["cx"], d["cy"]) for d in dets}

    # ─────────────────────────────────────────────────────────────────────────
    # PASS 2 — one-to-one assignment (req 26)
    #
    # Rule: each PlayerIdentity can appear at most once per frame.
    #       each detection box maps to at most one PlayerIdentity.
    # ─────────────────────────────────────────────────────────────────────────
    frame_active_pids: set = set()   # player_ids already assigned THIS frame
    assignment: dict       = {}      # tid -> PlayerIdentity
    assignment_sim: dict   = {}      # tid -> reid_sim
    assignment_score: dict = {}      # tid -> fusion score

    our_dets = [d for d in dets if d["is_ours"]]

    # 2a. Tracks already known to a PlayerIdentity — claim first
    known_dets = [d for d in our_dets if d["tid"] in track_to_player]
    new_dets   = [d for d in our_dets if d["tid"] not in track_to_player]

    for det in known_dets:
        tid = det["tid"]
        p   = track_to_player[tid]
        if p.player_id in frame_active_pids:
            # Same-frame conflict: two known track_ids mapped to the same player.
            # This means an earlier (incorrect) merge produced this.
            # Treat the lower-priority detection as a new/unknown track.
            print(f"[ReID rejected] reason=same_frame_conflict "
                  f"track_id={tid} player_id={p.player_id} "
                  f"(player already assigned to another box this frame)")
            new_dets.append(det)
        else:
            assignment[tid]       = p
            assignment_sim[tid]   = 1.0
            assignment_score[tid] = 1.0
            frame_active_pids.add(p.player_id)

    # 2b. New track_ids — greedy one-to-one matching against unassigned players
    available = [p for p in all_players if p.player_id not in frame_active_pids]
    matched   = greedy_assign(new_dets, available, frame_idx)

    for tid, (player, sim, score) in matched.items():
        # Double-check same-frame guard (should be guaranteed by greedy_assign,
        # but be defensive)
        if player.player_id in frame_active_pids:
            print(f"[ReID rejected] reason=same_frame_conflict "
                  f"track_id={tid} player_id={player.player_id} (greedy post-check)")
            continue
        assignment[tid]       = player
        assignment_sim[tid]   = sim
        assignment_score[tid] = score
        frame_active_pids.add(player.player_id)
        # Register the new track_id with the existing player
        track_to_player[tid] = player
        player.track_ids.add(tid)
        player.recently_merged = _D["recently_merged_frames"]
        print(f"[Track MERGED] track_id={tid} -> player_id={player.player_id} "
              f"(jersey=#{player.locked_jersey} fusion={score:.2f} reid={sim:.2f})")

    # 2c. Remaining unmatched new track_ids → create new PlayerIdentity
    for det in new_dets:
        tid = det["tid"]
        if tid in assignment:
            continue
        p = _make_player(det, frame_idx)
        assignment[tid]       = p
        assignment_sim[tid]   = 0.0
        assignment_score[tid] = 0.0
        frame_active_pids.add(p.player_id)

    # Record current-frame presence AFTER assignment (so temporal overlap
    # checks in this same frame see only prior-frame history)
    for det in dets:
        track_active_frames[det["tid"]].add(frame_idx)

    # ─────────────────────────────────────────────────────────────────────────
    # PASS 3 — update state, run OCR, draw
    # ─────────────────────────────────────────────────────────────────────────
    for det in dets:
        tid            = det["tid"]
        x1, y1, x2, y2 = det["box"]
        role           = det["role"]
        crop           = det["crop"]
        player         = assignment.get(tid) if det["is_ours"] else None
        reid_sim       = assignment_sim.get(tid, 0.0)
        merge_score    = assignment_score.get(tid, 0.0)
        jersey_abs_box = None

        if player is not None:
            if det["emb"] is not None:
                player.update_embedding(det["emb"])
            player.update_position(det["cx"], det["cy"], det["court_pos"])
            player.last_seen_frame = frame_idx
            player.history.record(reid_sim=reid_sim,
                                  merge_conf=merge_score,
                                  locked=(player.locked_jersey is not None))
            merge_score = player.history.avg_merge
            player.tick_merged()

            if THUMBS_DIR and player.player_id not in track_thumbnails and crop.size > 0:
                thumb = os.path.join(THUMBS_DIR, f"jersey_id{player.player_id}.jpg")
                cv2.imwrite(thumb, crop)
                track_thumbnails[player.player_id] = thumb

            # OCR
            jersey_crop, j_rel_box = detect_jersey_region(crop)
            if jersey_crop is not None:
                jersey_num, conf = read_jersey_number_with_conf(jersey_crop)
                if jersey_num is not None:
                    if conf >= _O["conf_threshold"]:
                        print(f"[OCR detected] player_id={player.player_id} "
                              f"jersey=#{jersey_num} conf={conf:.2f} frame={frame_idx}")
                        player.add_ocr_read(jersey_num, conf, frame_idx, reid_sim)

                        # req 18: jersey already in registry → attempt merge
                        # only if the registry player is NOT active in this frame
                        existing = JERSEY_REG.lookup(jersey_num)
                        if (existing is not None
                                and existing is not player
                                and player.locked_jersey is None
                                and existing.player_id not in frame_active_pids):
                            emb = player.reid_embedding
                            if emb is not None and existing.reid_embedding is not None:
                                # Temporal overlap check before any merge
                                if _check_temporal_overlap(tid, existing):
                                    sim       = cosine_sim(emb, existing.reid_embedding)
                                    ps        = position_consistency_score(
                                        existing, det["cx"], det["cy"], det["court_pos"],
                                        frame_idx - existing.last_seen_frame)
                                    ts        = temporal_consistency_score(existing, frame_idx)
                                    score     = fusion_score(sim, conf, ps, ts)
                                    if score >= _F["merge_threshold"]:
                                        track_to_player[tid] = existing
                                        existing.track_ids.add(tid)
                                        existing.recently_merged = _D["recently_merged_frames"]
                                        if player in all_players and not player.locked_jersey:
                                            all_players.remove(player)
                                        player = existing
                                        assignment[tid] = existing
                                        print(f"[Jersey MERGE] track_id={tid} -> "
                                              f"player_id={existing.player_id} "
                                              f"jersey=#{jersey_num} fusion={score:.2f}")
                                else:
                                    print(f"[Jersey MERGE REJECTED] track_id={tid} "
                                          f"jersey=#{jersey_num} reason=temporal_overlap")

                        if player.locked_jersey is not None:
                            JERSEY_REG.register(player.locked_jersey, player)
                            jersey_to_track_ids[player.locked_jersey].update(player.track_ids)

                        if j_rel_box is not None:
                            jx1, jy1_, jx2, jy2_ = j_rel_box
                            jersey_abs_box = (x1+jx1, y1+jy1_, x1+jx2, y1+jy2_)
                    else:
                        print(f"[OCR ignored] player_id={player.player_id} "
                              f"jersey=#{jersey_num} conf={conf:.2f}<{_O['conf_threshold']}")
        else:
            if THUMBS_DIR and tid not in track_thumbnails and crop.size > 0:
                thumb = os.path.join(THUMBS_DIR, f"jersey_idopp{tid}.jpg")
                cv2.imwrite(thumb, crop)
                track_thumbnails[tid] = thumb

        draw_player(frame, x1, y1, x2, y2,
                    player, role, tid, reid_sim, merge_score)
        if jersey_abs_box is not None:
            jax1, jay1, jax2, jay2 = jersey_abs_box
            cv2.rectangle(frame, (jax1, jay1), (jax2, jay2), (0, 255, 0), 2)

    # Rally state update (req 17)
    RALLY.update(frame_centres, len(frame_centres))
    rally_label = "RALLY" if RALLY.active else "break"
    cv2.putText(frame, f"F{frame_idx} | {rally_label}",
                (20, 32), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)

    out.write(frame)

    if frame_idx % 100 == 0:
        locked = sum(1 for p in all_players if p.locked_jersey is not None)
        print(f"  Frame {frame_idx}/{total_frames} | players={len(all_players)} "
              f"locked={locked} | rally={'ON' if RALLY.active else 'off'}")
        pct = int(frame_idx / total_frames * 100)
        print(f"{pct}%", file=sys.stderr, flush=True)

cap.release()
out.release()
print(f"[SUCCESS] Done. Output: {OUTPUT_PATH}")

# ─────────────────────────────────────────────────────────────────────────────
# 18. OUTPUT JSON
# ─────────────────────────────────────────────────────────────────────────────
if OUTPUT_JSON:
    registry = {}
    for player in all_players:
        tid   = max(player.track_ids, default=0)
        role  = team_labels_by_track.get(tid, "MAIN")
        thumb = track_thumbnails.get(player.player_id)
        key   = str(player.locked_jersey) if player.locked_jersey else f"id_{player.player_id}"
        registry[key] = {
            "jersey":           player.locked_jersey,
            "player_id":        player.player_id,
            "track_ids":        sorted(player.track_ids),
            "current_track_id": tid,
            "role":             role,
            "team":             "opponent" if role == "OPPONENT" else "my_team",
            "confirmed":        player.locked_jersey is not None,
            "lock_confidence":  round(player.lock_confidence, 3),
            "thumbnail":        thumb,
            "confidence_stats": {
                "avg_ocr":        round(player.history.avg_ocr,        3),
                "avg_reid":       round(player.history.avg_reid,       3),
                "avg_merge":      round(player.history.avg_merge,      3),
                "lock_stability": round(player.history.lock_stability, 3),
            },
        }
    with open(OUTPUT_JSON, "w") as _f:
        json.dump(registry, _f, indent=2)
    print(f"[INFO] Jersey registry saved -> {OUTPUT_JSON}")

# ─────────────────────────────────────────────────────────────────────────────
# 19. FRAME-JERSEY MAP
# ─────────────────────────────────────────────────────────────────────────────
if _args.frame_jersey_map:
    frame_map = defaultdict(list)
    for player in all_players:
        if player.locked_jersey is None:
            continue
        for tid in player.track_ids:
            for (fidx, x1, y1, x2, y2) in track_positions.get(tid, []):
                frame_map[str(fidx)].append({
                    "x1": x1, "y1": y1, "x2": x2, "y2": y2,
                    "jersey":    player.locked_jersey,
                    "track_id":  int(tid),
                    "player_id": player.player_id,
                })
    with open(_args.frame_jersey_map, "w") as _f:
        json.dump(frame_map, _f)
    print(f"[INFO] Frame-jersey map saved -> {_args.frame_jersey_map} ({len(frame_map)} frames)")
