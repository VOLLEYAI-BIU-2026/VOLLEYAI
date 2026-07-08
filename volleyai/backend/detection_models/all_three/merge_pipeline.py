import os
import sys
import json
import argparse
from collections import defaultdict, Counter

import cv2

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

from ball_landing_detector import BallLandingDetector

OUR_TEAM_SIDE = "bottom"
COURT_MID_Y = 0.5

# Minimum box overlap required to attribute an action to a player — not just
# "greater than zero". Without a real floor, whichever player happens to be
# tracked in the most frames (e.g. a libero who's visible almost constantly)
# can pick up every stray, incidental sliver of overlap by default, simply
# because no better candidate is ever present to compete with. Observed in
# practice: one such player absorbed 98.7% of all attributed actions in a
# real match, including attacks/blocks a back-row player would never perform.
MIN_ACTION_IOU = 0.10


def parse_args():
    parser = argparse.ArgumentParser(
        description="Merge rally + jersey + action stage outputs into a single volley_analytics.json"
    )
    parser.add_argument("--video", required=True, help="Path to input video (used for frame height)")
    parser.add_argument("--rally-windows", default=None, help="rally_windows.json from run_rally_stage.py (optional — rally stage may be disabled)")
    parser.add_argument("--ball-track", default=None, help="ball_track.json from run_rally_stage.py (optional — rally stage may be disabled)")
    parser.add_argument("--frame-jersey-map", default=None, help="frame_jersey_map.json from predict_pipeline.py (optional — jersey stage may fail non-fatally)")
    parser.add_argument("--jersey-registry", default=None, help="team registry from predict_pipeline.py --output-json")
    parser.add_argument("--action-detections", default=None, help="action_detections.json from action.py (optional — action stage may fail non-fatally)")
    parser.add_argument("--calib-json", default=None, help="Optional court calibration JSON")
    parser.add_argument("--output", required=True, help="Path to write merged volley_analytics.json")
    parser.add_argument("--registry-output", default=None, help="Path to write enriched player_registry.json (adds event_count to --jersey-registry)")
    return parser.parse_args()


def load_json(path, default=None):
    if path and os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return default


def box_center(box):
    x1, y1, x2, y2 = box
    return ((x1 + x2) / 2.0, (y1 + y2) / 2.0)


def distance(a, b):
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5


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


def build_window_lookup(windows):
    """Returns a function frame_idx -> bool (inside any window)."""
    sorted_windows = sorted(windows, key=lambda w: w["start_frame"])

    def in_windows(frame_idx):
        for w in sorted_windows:
            if w["start_frame"] <= frame_idx <= w["end_frame"]:
                return True
            if w["start_frame"] > frame_idx:
                break
        return False

    return in_windows


def main():
    args = parse_args()

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {args.video}")
    frame_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 1
    frame_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or 1
    video_fps = cap.get(cv2.CAP_PROP_FPS)
    cap.release()

    rally_data = load_json(args.rally_windows, {}) or {}
    # Read fps from the actual video file, not the (often-absent, since the rally
    # stage is currently disabled) rally_windows.json — falling back to its value
    # only if the video file itself doesn't report one.
    fps = video_fps if video_fps and video_fps > 0 else rally_data.get("fps", 30)
    total_frames = rally_data.get("total_frames", 0)
    rally_windows = rally_data.get("rally_windows", [])
    dead_segments = rally_data.get("dead_segments", [])
    in_rally_window = build_window_lookup(rally_windows)

    ball_data = load_json(args.ball_track, {}) or {}
    ball_by_frame = {b["frame"]: b for b in ball_data.get("ball_track", [])}

    frame_jersey_map = load_json(args.frame_jersey_map, {}) or {}

    registry = load_json(args.jersey_registry, {}) or {}
    jersey_to_team = {}
    for info in registry.values():
        jnum = info.get("jersey")
        if jnum is not None:
            jersey_to_team[str(jnum)] = info.get("team")

    action_data = load_json(args.action_detections, {}) or {}
    actions_by_frame = defaultdict(list)
    for det in action_data.get("detections", []):
        actions_by_frame[det["frame"]].append(det)

    court_calibrator = None
    if args.calib_json and os.path.exists(args.calib_json):
        from court_calibration import CourtCalibrator
        court_calibrator = CourtCalibrator()
        court_calibrator.load(args.calib_json)

    landing_detector = BallLandingDetector(court_calibrator)

    if total_frames <= 0:
        candidate_frames = set(ball_by_frame.keys())
        candidate_frames |= {int(k) for k in frame_jersey_map.keys()}
        candidate_frames |= set(actions_by_frame.keys())
        total_frames = max(candidate_frames) if candidate_frames else 0

    tracking_data = []
    landing_events = []
    last_active_jersey = None
    last_recorded_action = "none"
    jersey_event_count = Counter()

    for frame_idx in range(1, total_frames + 1):
        play_state = "PLAY" if in_rally_window(frame_idx) else "NO_PLAY"

        # --- Ball ---
        ball_entry = ball_by_frame.get(frame_idx)
        ball_pixel_x = ball_pixel_y = None
        ball_det_for_landing = None
        if ball_entry:
            ball_pixel_x, ball_pixel_y = ball_entry["cx"], ball_entry["cy"]
            ball_det_for_landing = {
                "x": ball_entry["x1"], "y": ball_entry["y1"],
                "w": ball_entry["x2"] - ball_entry["x1"],
                "h": ball_entry["y2"] - ball_entry["y1"],
                "confidence": ball_entry["conf"],
            }

        event = landing_detector.update(frame_idx, ball_det_for_landing)
        if event:
            event["last_attacker_id"] = last_active_jersey
            event["last_action"] = last_recorded_action
            if event.get("landed_side") == "unknown" and event.get("video_position"):
                by_px = event["video_position"][1]
                by_norm = by_px / frame_h
                if OUR_TEAM_SIDE == "bottom":
                    event["landed_side"] = "my_team" if by_norm > COURT_MID_Y else "opponent"
                else:
                    event["landed_side"] = "opponent" if by_norm > COURT_MID_Y else "my_team"
                event["calibration_type"] = "pixel_fallback"
            landing_events.append(event)

        # --- Players (from jersey stage; no re-detection needed) ---
        players = []
        for p in frame_jersey_map.get(str(frame_idx), []):
            players.append({"jersey": p.get("jersey"), "box": [p["x1"], p["y1"], p["x2"], p["y2"]]})

        # --- Active player: nearest to ball, else last known jersey ---
        active_player = None
        min_dist = None
        if ball_pixel_x is not None and players:
            for p in players:
                d = distance((ball_pixel_x, ball_pixel_y), box_center(p["box"]))
                if min_dist is None or d < min_dist:
                    min_dist = d
                    active_player = p
            if active_player is not None:
                last_active_jersey = active_player["jersey"]
        elif ball_pixel_x is None and players and last_active_jersey is not None:
            for p in players:
                if p["jersey"] == last_active_jersey:
                    active_player = p
                    break

        # --- Action: match by box overlap (IoU), not center-distance — a player
        # actually performing the action should meaningfully overlap the action
        # box, whereas a nearby bystander usually won't. This also means an
        # action with no overlapping "our team" player (e.g. an opponent's
        # action, since opponents aren't tracked at all) correctly gets no
        # attribution instead of being forced onto the nearest teammate.
        current_action, action_conf = "none", 0.0
        detected_actions = [
            (d["action"], [d["x1"], d["y1"], d["x2"], d["y2"]], d["conf"])
            for d in actions_by_frame.get(frame_idx, [])
        ]
        if active_player is not None and detected_actions:
            active_box = active_player["box"]
            best_iou = MIN_ACTION_IOU
            for cls_name, act_box, conf in detected_actions:
                iou = box_iou(active_box, act_box)
                if iou > best_iou:
                    best_iou = iou
                    current_action, action_conf = cls_name, conf
        elif active_player is None and detected_actions and players:
            best_player, best_action, best_conf, best_iou = None, "none", 0.0, MIN_ACTION_IOU
            for cls_name, act_box, conf in detected_actions:
                for p in players:
                    iou = box_iou(p["box"], act_box)
                    if iou > best_iou:
                        best_iou, best_player, best_action, best_conf = iou, p, cls_name, conf
            if best_player is not None:
                active_player = best_player
                current_action, action_conf = best_action, best_conf

        if current_action != "none":
            last_recorded_action = current_action

        active_jersey = active_player["jersey"] if active_player else None
        if current_action != "none" and active_jersey is not None:
            jersey_event_count[active_jersey] += 1
        active_team = jersey_to_team.get(str(active_jersey)) if active_jersey is not None else None
        active_x_norm = active_y_norm = None
        if active_player is not None:
            cx, cy = box_center(active_player["box"])
            active_x_norm = round(cx / frame_w, 4)
            active_y_norm = round(cy / frame_h, 4)

        tracking_data.append({
            "frame": frame_idx,
            "play_state": play_state,
            "ball": {"x": ball_pixel_x, "y": ball_pixel_y} if ball_pixel_x is not None else None,
            "active_player_jersey": active_jersey,
            "active_player_team": active_team,
            "active_player_x": active_x_norm,
            "active_player_y": active_y_norm,
            "distance_to_ball": min_dist,
            "action": current_action,
            "action_confidence": action_conf,
        })

    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    with open(args.output, "w") as f:
        json.dump({
            "fps": fps,
            "rally_windows": rally_windows,
            "dead_segments": dead_segments,
            "frames": tracking_data,
            "ball_landings": landing_events,
        }, f, indent=2)

    print(f"[MERGE] {len(tracking_data)} frames, {len(landing_events)} landing events -> {args.output}")

    if args.registry_output and registry:
        enriched = {}
        for key, info in registry.items():
            jnum = info.get("jersey")
            enriched[key] = {**info, "event_count": jersey_event_count.get(jnum, 0)}
        os.makedirs(os.path.dirname(os.path.abspath(args.registry_output)), exist_ok=True)
        with open(args.registry_output, "w") as f:
            json.dump(enriched, f, indent=4)
        print(f"[MERGE] Enriched registry ({len(enriched)} players) -> {args.registry_output}")


if __name__ == "__main__":
    main()
