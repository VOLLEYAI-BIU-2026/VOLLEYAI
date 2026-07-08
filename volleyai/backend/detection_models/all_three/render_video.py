import os
import sys
import json
import argparse
import subprocess

import cv2

ACTION_COLORS = {
    "serve": (0, 165, 255),    # Orange
    "spike": (0, 0, 255),      # Red
    "block": (255, 0, 255),    # Magenta
    "bump": (255, 255, 0),     # Cyan
    "set": (0, 255, 255),      # Yellow
    "defence": (0, 128, 255),  # Light Orange
    "dig": (0, 128, 255),      # Legacy alias
    "none": (255, 0, 0),
}
MY_TEAM_COLOR = (60, 220, 100)
OPPONENT_COLOR = (110, 110, 110)


def parse_args():
    parser = argparse.ArgumentParser(
        description="Render the annotated analysis video (player boxes, jersey numbers, "
                    "action labels, dead-time trimmed out) from the decoupled pipeline's outputs."
    )
    parser.add_argument("--video", required=True, help="Path to input video")
    parser.add_argument("--output", required=True, help="Path to write the annotated mp4")
    parser.add_argument("--frame-jersey-map", default=None, help="frame_jersey_map.json from predict_pipeline.py")
    parser.add_argument("--jersey-registry", default=None, help="team registry from predict_pipeline.py --output-json")
    parser.add_argument("--volley-analytics", default=None, help="merged volley_analytics.json from merge_pipeline.py")
    parser.add_argument("--rally-windows", default=None, help="rally_windows.json from run_rally_stage.py (for dead-time trimming)")
    parser.add_argument("--no-trim", action="store_true", help="Keep dead-time segments in the output instead of cutting them")
    return parser.parse_args()


def load_json(path, default=None):
    if path and os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return default


def build_dead_frame_checker(dead_segments):
    sorted_segs = sorted(dead_segments, key=lambda s: s["start_frame"])

    def is_dead(frame_idx):
        for seg in sorted_segs:
            if seg["start_frame"] <= frame_idx <= seg["end_frame"]:
                return True
            if seg["start_frame"] > frame_idx:
                break
        return False

    return is_dead


def main():
    args = parse_args()

    frame_jersey_map = load_json(args.frame_jersey_map, {}) or {}

    registry = load_json(args.jersey_registry, {}) or {}
    jersey_to_team = {}
    for info in registry.values():
        jnum = info.get("jersey")
        if jnum is not None:
            jersey_to_team[str(jnum)] = info.get("team")

    analytics = load_json(args.volley_analytics, {}) or {}
    analytics_by_frame = {f["frame"]: f for f in analytics.get("frames", [])}

    rally_data = load_json(args.rally_windows, {}) or {}
    dead_segments = rally_data.get("dead_segments", [])
    is_dead_frame = build_dead_frame_checker(dead_segments) if (dead_segments and not args.no_trim) else (lambda f: False)

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {args.video}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0

    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    ffmpeg_cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "rawvideo", "-vcodec", "rawvideo", "-s", f"{w}x{h}",
        "-pix_fmt", "bgr24", "-r", str(fps),
        "-i", "-",
        "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        args.output,
    ]
    proc = subprocess.Popen(ffmpeg_cmd, stdin=subprocess.PIPE)

    frame_idx = 0
    frames_written = 0
    frames_skipped_dead = 0
    last_percent = -1

    print(f"[RENDER] Rendering {total_frames} frames ({'trimming dead time' if not args.no_trim else 'no trim'})...")

    while True:
        ret, frame = cap.read()
        if not ret:
            break
        frame_idx += 1

        if is_dead_frame(frame_idx):
            frames_skipped_dead += 1
            continue

        players = frame_jersey_map.get(str(frame_idx), [])
        entry = analytics_by_frame.get(frame_idx, {})
        active_jersey = entry.get("active_player_jersey")
        current_action = entry.get("action", "none")

        for p in players:
            jersey = p.get("jersey")
            team = jersey_to_team.get(str(jersey)) if jersey is not None else None
            rx1, ry1, rx2, ry2 = int(p["x1"]), int(p["y1"]), int(p["x2"]), int(p["y2"])

            if team == "my_team":
                is_active = (jersey is not None and jersey == active_jersey and current_action != "none")
                color = ACTION_COLORS.get(current_action, MY_TEAM_COLOR) if is_active else MY_TEAM_COLOR
                cv2.rectangle(frame, (rx1, ry1), (rx2, ry2), color, 2)

                # Single combined label (jersey + action, when active) so the action
                # banner never has to be drawn over the jersey number.
                jersey_str = f"#{jersey}" if jersey is not None else "?"
                label = f"{jersey_str} {current_action.upper()}!" if is_active else jersey_str
                font, scale, thick = cv2.FONT_HERSHEY_SIMPLEX, 0.7, 2
                (text_w, text_h), baseline = cv2.getTextSize(label, font, scale, thick)
                by2 = max(text_h + baseline + 4, ry1 - 6)
                by1 = by2 - text_h - baseline - 8
                if is_active:
                    cv2.rectangle(frame, (rx1, by1), (rx1 + text_w + 10, by2), color, -1)
                    text_color = (0, 0, 0)
                else:
                    text_color = color
                cv2.putText(frame, label, (rx1 + 5, by2 - baseline - 2),
                            font, scale, text_color, thick)
            else:
                cv2.rectangle(frame, (rx1, ry1), (rx2, ry2), OPPONENT_COLOR, 1)

        cv2.putText(frame, f"Frame {frame_idx}", (20, 32), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)

        proc.stdin.write(frame.tobytes())
        frames_written += 1

        if total_frames > 0:
            percent = int((frame_idx / total_frames) * 100)
            if percent != last_percent:
                print(f"[RENDER] {percent}%")
                last_percent = percent

    cap.release()
    proc.stdin.close()
    proc.wait()

    print(f"[RENDER] Done. {frames_written} frames written, {frames_skipped_dead} dead-time frames cut -> {args.output}")


if __name__ == "__main__":
    main()
