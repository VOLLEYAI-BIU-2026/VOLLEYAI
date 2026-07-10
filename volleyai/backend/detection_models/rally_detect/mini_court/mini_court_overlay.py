import cv2

# --- BALL TRAIL (drawn directly on the video, real pixel coordinates) ---
# Unlike rally_detect's own visualizer, we have no per-object track_id to color
# by — our ball_track.json is just frame -> position, one ball, no re-tracking
# identity to lose. So there's nothing to "reconnect": every point within the
# trailing time window gets drawn in the same fixed color, regardless of any
# gaps in between (a brief miss just leaves a gap in the line, not a color
# swap), which sidesteps the discontinuous-color problem entirely rather than
# trying to patch it with a same-color-if-gap-is-short heuristic.
def draw_ball_trail(frame, trail_points, color=(0, 255, 255)):
    """trail_points: chronological list of (frame_idx, cx, cy) within the trailing window."""
    n = len(trail_points)
    if n == 0:
        return
    if n == 1:
        _, cx, cy = trail_points[0]
        cv2.circle(frame, (int(cx), int(cy)), 6, color, -1)
        return

    overlay = frame.copy()
    for i in range(1, n):
        _, x0, y0 = trail_points[i - 1]
        _, x1, y1 = trail_points[i]
        thickness = max(1, int(2 + 4 * (i / n)))  # thicker toward the newest point
        cv2.line(overlay, (int(x0), int(y0)), (int(x1), int(y1)), color, thickness, cv2.LINE_AA)
    cv2.addWeighted(overlay, 0.8, frame, 0.2, 0, frame)

    _, cx, cy = trail_points[-1]
    cv2.circle(frame, (int(cx), int(cy)), 7, color, -1)
    cv2.circle(frame, (int(cx), int(cy)), 9, (255, 255, 255), 1)


# --- MINI COURT OVERLAY (top-right corner) ---
_MC_W, _MC_H = 240, 180
_MC_PAD      = 16
_MC_INNER    = 9
_MC_HDR      = 18
_MC_FTR      = 16


def draw_mini_court(frame, ball_cp, recent_land):
    """ball_cp: (court_x, court_y) in [0,1] or None. court_y=0 -> opponent (top),
    court_y=1 -> my_team (bottom). recent_land: list of ball_landings entries
    (from volley_analytics.json) still within their on-screen display window."""
    fh, fw = frame.shape[:2]
    panel_w = _MC_W + _MC_INNER * 2
    panel_h = _MC_H + _MC_INNER * 2 + _MC_HDR + _MC_FTR
    px0 = fw - panel_w - _MC_PAD
    py0 = _MC_PAD

    ov = frame.copy()
    cv2.rectangle(ov, (px0, py0), (px0 + panel_w, py0 + panel_h), (15, 15, 15), -1)
    cv2.addWeighted(ov, 0.65, frame, 0.35, 0, frame)

    cx0 = px0 + _MC_INNER
    cy0 = py0 + _MC_INNER + _MC_HDR

    my = frame.copy()
    cv2.rectangle(my, (cx0 + 1, cy0 + _MC_H // 2 + 1), (cx0 + _MC_W - 1, cy0 + _MC_H - 1), (20, 45, 20), -1)
    cv2.addWeighted(my, 0.40, frame, 0.60, 0, frame)

    cv2.rectangle(frame, (cx0, cy0), (cx0 + _MC_W, cy0 + _MC_H), (200, 200, 200), 1)
    net_py = cy0 + _MC_H // 2
    cv2.line(frame, (cx0, net_py), (cx0 + _MC_W, net_py), (160, 160, 200), 2)
    for dy in range(cy0, cy0 + _MC_H, 8):
        if dy + 3 < cy0 + _MC_H:
            cv2.line(frame, (cx0 + _MC_W // 2, dy), (cx0 + _MC_W // 2, dy + 3), (70, 70, 70), 1)

    cv2.putText(frame, "OPP", (cx0 + 6, cy0 + 18), cv2.FONT_HERSHEY_SIMPLEX, 0.50, (130, 130, 200), 1)
    cv2.putText(frame, "MY TEAM", (cx0 + 6, cy0 + _MC_H - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.50, (60, 220, 100), 1)
    cv2.putText(frame, "v CAM", (cx0, py0 + panel_h - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.40, (110, 110, 110), 1)

    def cp(cxx, cyy):
        mx = cx0 + int(max(0.0, min(1.0, cxx)) * _MC_W)
        my_ = cy0 + int(max(0.0, min(1.0, cyy)) * _MC_H)
        return (mx, my_)

    for ev in recent_land:
        ecp = ev.get("court_position")
        side = ev.get("landed_side", "outside")
        if ecp is None:
            continue
        lpx, lpy = cp(ecp[0], ecp[1])
        col = (50, 210, 80) if side == "my_team" else (60, 60, 240) if side == "opponent" else (0, 140, 255)
        cv2.circle(frame, (lpx, lpy), 9, col, -1)
        cv2.circle(frame, (lpx, lpy), 11, (255, 255, 255), 1)

    if ball_cp is not None:
        bpx, bpy = cp(ball_cp[0], ball_cp[1])
        cv2.circle(frame, (bpx, bpy), 6, (0, 255, 255), -1)
        cv2.circle(frame, (bpx, bpy), 8, (255, 255, 255), 1)
