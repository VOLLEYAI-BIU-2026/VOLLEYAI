import json
import os
import argparse
from collections import defaultdict

# ── Action mapping ─────────────────────────────────────────────────────────────
# Handles both canonical names (from triple_detection.py) and raw model names
ACTION_MAP = {
    # Canonical names (already normalized by triple_detection.py)
    "spike":        "spike",
    "serve":        "serve",
    "block":        "block",
    "set":          "set",
    "dig":          "dig",
    # Raw model class names (fallback for older JSON files)
    "attack":       "spike",
    "attacker":     "spike",
    "defense-move": "dig",
    "service":      "serve",
    "setting":      "set",
    "a_surve":      "serve",
    "blocking":     "block",
    "digging":      "dig",
    "bump":         "dig",
    "receive":      "dig",
    "over":         "set",
    "none":         "none",
}

MIN_EVENT_GAP  = 15   # min frames between two same-action events for same player
OUTCOME_WINDOW = 150  # max frames to look ahead for outcome (~5 sec at 30 fps)


# ── Geometry helpers ───────────────────────────────────────────────────────────

def _point_in_poly(px, py, poly):
    n, inside, j = len(poly), False, len(poly) - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if ((yi > py) != (yj > py)) and (px < (xj - xi) * (py - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside

def _build_court(court_str: str):
    if not court_str:
        return None
    try:
        vals = [float(v) for v in court_str.split(",")]
        if len(vals) == 8:
            return [(vals[i], vals[i + 1]) for i in range(0, 8, 2)]
    except ValueError:
        pass
    return None

def _is_out(ball_x, ball_y, court_poly=None):
    if court_poly:
        return not _point_in_poly(ball_x, ball_y, court_poly)
    return ball_x < 0.05 or ball_x > 0.95 or ball_y < 0.03 or ball_y > 0.97

def _on_opp_side(ball_y, net_y, our_side):
    return ball_y < net_y if our_side == "bottom" else ball_y > net_y

def _resolve_player(bid, ocr_jersey, registry):
    reg_jersey = registry.get(str(bid), {}).get("jersey") if bid is not None else None
    return ocr_jersey or reg_jersey or bid


# ── Team classification ────────────────────────────────────────────────────────

def _build_player_teams(frames, registry, net_y, our_side):
    """
    Classify each player as 'ours' or 'opp' by their average y-position
    relative to net_y across all frames.
    """
    y_sum = defaultdict(float)
    y_cnt = defaultdict(int)
    for entry in frames:
        pid = _resolve_player(entry.get("active_player_id"),
                              entry.get("active_player_jersey"), registry)
        py = entry.get("active_player_y")
        if pid is not None and py is not None:
            y_sum[pid] += py
            y_cnt[pid] += 1
    team_map = {}
    for pid in y_sum:
        avg_y = y_sum[pid] / y_cnt[pid]
        if our_side == "bottom":
            team_map[pid] = "ours" if avg_y > net_y else "opp"
        else:
            team_map[pid] = "ours" if avg_y < net_y else "opp"
    return team_map


# ── Outcome detection ──────────────────────────────────────────────────────────

def _ball_after(frames, from_frame, to_frame):
    """Last ball (x, y) in frames where from_frame < frame < to_frame."""
    last = None
    for entry in frames:
        f = entry.get("frame", 0)
        if f <= from_frame:
            continue
        if f >= to_frame:
            break
        ball = entry.get("ball")
        if ball and ball.get("x") is not None and ball.get("y") is not None:
            last = (ball["x"], ball["y"])
    return last


def _classify_outcome(event_frame, action_timeline, landings_sorted, frames,
                      net_y, our_side, court_poly, team_filter=None):
    """
    Determine what happened after the action at event_frame.

    team_filter – 'ours' or 'opp': restrict next_action_frame to that team.
                  None = any player.

    For terminal actions (spike/serve/block): pass team_filter='opp'
      → no_play = True when ball lands before opponent touches it  → Kill/Ace/Block Kill
    For continuation actions (dig/set): pass team_filter='ours'
      → no_play = True when ball lands before same team continues  → Error/0-rating

    Returns dict: no_play, ball_x, ball_y, on_opp_side, is_out,
                  next_action, next_frame
    """
    next_action = None
    next_frame  = None
    for ev_f, ev_team, _, ev_action in action_timeline:
        if ev_f <= event_frame or ev_f > event_frame + OUTCOME_WINDOW:
            continue
        if team_filter is not None and ev_team != team_filter:
            continue
        next_action = ev_action
        next_frame  = ev_f
        break

    next_landing = None
    for landing in landings_sorted:
        if landing["frame"] > event_frame:
            next_landing = landing
            break

    if next_landing is None:
        pos = _ball_after(frames, event_frame, event_frame + OUTCOME_WINDOW)
        if pos:
            bx, by = pos
            return {"no_play": False, "ball_x": bx, "ball_y": by,
                    "on_opp_side": _on_opp_side(by, net_y, our_side),
                    "is_out": False,
                    "next_action": next_action, "next_frame": next_frame}
        return None

    land_frame = next_landing["frame"]

    if next_frame is None or land_frame <= next_frame:
        no_play = True
        bx = next_landing.get("ball_x_norm", 0.5)
        by = next_landing.get("ball_y_norm", 0.5)
    else:
        no_play = False
        pos = _ball_after(frames, event_frame, next_frame)
        bx, by = pos if pos else (0.5, 0.5)

    on_opp = _on_opp_side(by, net_y, our_side)
    is_out  = _is_out(bx, by, court_poly) if no_play else False

    return {"no_play": no_play, "ball_x": bx, "ball_y": by,
            "on_opp_side": on_opp, "is_out": is_out,
            "next_action": next_action, "next_frame": next_frame}


# ── Main statistics ────────────────────────────────────────────────────────────

def aggregate_stats(json_path: str, registry: dict = None,
                    net_y: float = 0.50, our_side: str = "bottom",
                    court_poly=None) -> dict:
    if registry is None:
        registry = {}
    with open(json_path) as f:
        raw = json.load(f)

    frames        = raw.get("frames", raw) if isinstance(raw, dict) else raw
    ball_landings = raw.get("ball_landings", []) if isinstance(raw, dict) else []

    # Classify each player as 'ours' or 'opp' by average y-position
    team_map = _build_player_teams(frames, registry, net_y, our_side)

    # ── Build action event timeline: (frame, team, player_id, action) ─────────
    last_event_frame = defaultdict(lambda: defaultdict(lambda: -MIN_EVENT_GAP))
    action_timeline  = []

    for entry in frames:
        bid        = entry.get("active_player_id")
        ocr_jersey = entry.get("active_player_jersey")
        player_id  = _resolve_player(bid, ocr_jersey, registry)
        raw_action = entry.get("action", "none")
        frame_no   = entry.get("frame", 0)

        if player_id is None:
            continue
        action = ACTION_MAP.get(raw_action, "none")
        if action == "none":
            continue
        if frame_no - last_event_frame[player_id][action] < MIN_EVENT_GAP:
            continue

        last_event_frame[player_id][action] = frame_no
        team = team_map.get(player_id, "ours")
        action_timeline.append((frame_no, team, player_id, action))

    action_timeline.sort(key=lambda x: x[0])
    landings_sorted = sorted(ball_landings, key=lambda x: x["frame"])

    # ── Per-player counters ────────────────────────────────────────────────────
    att_K, att_E, att_TA = defaultdict(int), defaultdict(int), defaultdict(int)
    srv_SA, srv_SE, srv_TA = defaultdict(int), defaultdict(int), defaultdict(int)
    rcv_r3, rcv_r2, rcv_r1, rcv_r0, rcv_TA = (defaultdict(int), defaultdict(int),
                                                defaultdict(int), defaultdict(int),
                                                defaultdict(int))
    set_AST, set_r3, set_r2, set_r1, set_r0, set_TA = (defaultdict(int), defaultdict(int),
                                                         defaultdict(int), defaultdict(int),
                                                         defaultdict(int), defaultdict(int))
    dig_DS, dig_DE, dig_TA = defaultdict(int), defaultdict(int), defaultdict(int)
    blk_BK, blk_BE, blk_TA = defaultdict(int), defaultdict(int), defaultdict(int)

    # ── Process each event ─────────────────────────────────────────────────────
    for i, (ev_frame, ev_team, player_id, action) in enumerate(action_timeline):
        tl_after = action_timeline[i + 1:]
        opp_team = "opp" if ev_team == "ours" else "ours"

        # Terminal actions → look for opponent's next touch
        # Continuation actions → look for same-team's next touch
        if action in ("spike", "serve", "block"):
            oc = _classify_outcome(ev_frame, tl_after, landings_sorted, frames,
                                   net_y, our_side, court_poly, team_filter=opp_team)
        else:
            oc = _classify_outcome(ev_frame, tl_after, landings_sorted, frames,
                                   net_y, our_side, court_poly, team_filter=ev_team)

        # ── Attack ────────────────────────────────────────────────────────
        if action == "spike":
            att_TA[player_id] += 1
            if oc and oc["no_play"]:
                if oc["on_opp_side"] and not oc["is_out"]:
                    att_K[player_id] += 1   # Kill
                else:
                    att_E[player_id] += 1   # Error

        # ── Serve ─────────────────────────────────────────────────────────
        elif action == "serve":
            srv_TA[player_id] += 1
            if oc and oc["no_play"]:
                if oc["on_opp_side"] and not oc["is_out"]:
                    srv_SA[player_id] += 1  # Ace
                else:
                    srv_SE[player_id] += 1  # Error

        # ── Receive / Dig ──────────────────────────────────────────────────
        elif action == "dig":
            rcv_TA[player_id] += 1
            dig_TA[player_id] += 1
            if oc:
                if oc["no_play"] and not oc["on_opp_side"]:
                    rcv_r0[player_id] += 1   # Ball landed on own side → 0
                    dig_DE[player_id] += 1
                elif oc["no_play"] and oc["on_opp_side"]:
                    rcv_r1[player_id] += 1   # Ball crossed without continuation → 1
                    dig_DS[player_id] += 1
                else:
                    # Same team continued before landing
                    dig_DS[player_id] += 1
                    if oc["next_action"] == "set":
                        rcv_r3[player_id] += 1   # Perfect: reached setter
                    elif oc["next_action"] in ("spike", "dig", "block"):
                        rcv_r2[player_id] += 1   # Good: team continued
                    else:
                        rcv_r1[player_id] += 1   # Weak

        # ── Set ────────────────────────────────────────────────────────────
        elif action == "set":
            set_TA[player_id] += 1
            if oc:
                if oc["no_play"] and not oc["on_opp_side"]:
                    set_r0[player_id] += 1   # Set error
                elif not oc["no_play"] and oc["next_action"] == "spike":
                    # Check if that spike ended as a kill
                    spike_frame = oc["next_frame"]
                    spike_tl    = [t for t in action_timeline if t[0] > spike_frame]
                    spike_oc    = _classify_outcome(spike_frame, spike_tl,
                                                    landings_sorted, frames,
                                                    net_y, our_side, court_poly,
                                                    team_filter=opp_team)
                    if (spike_oc and spike_oc["no_play"]
                            and spike_oc["on_opp_side"] and not spike_oc["is_out"]):
                        set_r3[player_id]  += 1  # Led to kill
                        set_AST[player_id] += 1
                    else:
                        set_r2[player_id]  += 1  # Spike but not kill
                elif not oc["no_play"]:
                    set_r2[player_id] += 1       # Team continued
                else:
                    set_r1[player_id] += 1       # Ball went over without kill

        # ── Block ──────────────────────────────────────────────────────────
        elif action == "block":
            blk_TA[player_id] += 1
            if oc and oc["no_play"]:
                if oc["on_opp_side"] and not oc["is_out"]:
                    blk_BK[player_id] += 1  # Block kill
                else:
                    blk_BE[player_id] += 1  # Block error

    # ── Build final stats dict ─────────────────────────────────────────────────
    stats = {}
    all_players = (set(att_TA) | set(srv_TA) | set(rcv_TA) |
                   set(set_TA) | set(dig_TA) | set(blk_TA))

    for pid in all_players:
        ta_att = att_TA.get(pid, 0)
        k      = att_K.get(pid, 0)
        e      = att_E.get(pid, 0)
        atk_pct = round((k - e) / ta_att, 3) if ta_att > 0 else 0.0

        ta_srv  = srv_TA.get(pid, 0)
        sa      = srv_SA.get(pid, 0)
        se      = srv_SE.get(pid, 0)
        srv_pct = round((ta_srv - se) / ta_srv, 3) if ta_srv > 0 else 1.0
        srv_eff = round((sa - se) / ta_srv, 3)     if ta_srv > 0 else 0.0

        ta_rcv  = rcv_TA.get(pid, 0)
        r3, r2, r1, r0 = (rcv_r3.get(pid, 0), rcv_r2.get(pid, 0),
                           rcv_r1.get(pid, 0), rcv_r0.get(pid, 0))
        pass_rtg = round((3 * r3 + 2 * r2 + r1) / ta_rcv, 2) if ta_rcv > 0 else 0.0

        ta_set  = set_TA.get(pid, 0)
        ast     = set_AST.get(pid, 0)
        sr3, sr2, sr1, sr0 = (set_r3.get(pid, 0), set_r2.get(pid, 0),
                               set_r1.get(pid, 0), set_r0.get(pid, 0))
        tot_rated = sr3 + sr2 + sr1 + sr0
        set_rtg = round((3 * sr3 + 2 * sr2 + sr1) / tot_rated, 2) if tot_rated > 0 else 0.0

        ta_dig = dig_TA.get(pid, 0)
        ds     = dig_DS.get(pid, 0)
        de     = dig_DE.get(pid, 0)

        ta_blk = blk_TA.get(pid, 0)
        bk     = blk_BK.get(pid, 0)
        be     = blk_BE.get(pid, 0)

        pts = k + sa + bk

        stats[str(pid)] = {
            "attack":  {"K": k,   "E": e,   "TA": ta_att, "ATK%": atk_pct},
            "serve":   {"SA": sa, "SE": se,  "TA": ta_srv, "PCT": srv_pct, "EFF": srv_eff},
            "receive": {"TA": ta_rcv, "3": r3, "2": r2, "1": r1, "0": r0, "PASS_RTG": pass_rtg},
            "set":     {"AST": ast, "TA": ta_set, "SE": sr0,
                        "3": sr3, "2": sr2, "1": sr1, "0": sr0, "RTG": set_rtg},
            "dig":     {"DS": ds, "DE": de, "TA": ta_dig},
            "block":   {"BK": bk, "BE": be, "TA": ta_blk, "BA": 0},
            "pts":     pts,
            "total_events": ta_att + ta_srv + ta_rcv + ta_set + ta_dig + ta_blk,
        }

    return stats


# ── Rally detection ────────────────────────────────────────────────────────────

def _format_time(sec):
    m, s = int(sec // 60), int(sec % 60)
    return f"{m}:{s:02d}"


def detect_rallies(frames, ball_landings, registry=None, fps=30.0,
                   net_y=0.50, our_side="bottom", court_poly=None):
    if registry is None:
        registry = {}

    ACTION_LABELS = {
        "serve": "Serve", "spike": "Attack",
        "set":   "Set",   "dig":   "Dig",   "block": "Block",
    }
    events = []
    last_ev = {}

    for entry in frames:
        action = ACTION_MAP.get(entry.get("action", "none"), "none")
        if action == "none":
            continue
        frame_no  = entry.get("frame", 0)
        bid       = entry.get("active_player_id")
        ocr       = entry.get("active_player_jersey")
        player_id = _resolve_player(bid, ocr, registry)
        key = (player_id, action)
        if frame_no - last_ev.get(key, -MIN_EVENT_GAP) < MIN_EVENT_GAP:
            continue
        last_ev[key] = frame_no
        t_sec = entry.get("time_sec", round(frame_no / fps, 2))
        events.append({
            "frame":        frame_no,
            "time_sec":     t_sec,
            "time_str":     _format_time(t_sec),
            "action":       action,
            "action_label": ACTION_LABELS.get(action, action.capitalize()),
            "player_id":    str(player_id) if player_id is not None else "?",
            "player_label": player_label(str(player_id), registry)
                            if player_id is not None else "?",
            "result": "in_play",
        })

    events.sort(key=lambda e: e["frame"])
    landings_sorted = sorted(ball_landings, key=lambda x: x["frame"])

    our_score = opp_score = 0
    score_events, rallies = [], []
    prev_frame, prev_time = 0, 0.0

    for rally_num, landing in enumerate(landings_sorted, start=1):
        land_frame = landing["frame"]
        land_time  = landing.get("time_sec", round(land_frame / fps, 2))

        rally_actions = [e.copy() for e in events
                         if prev_frame < e["frame"] <= land_frame]

        bx = landing.get("ball_x_norm", 0.5)
        by = landing.get("ball_y_norm", 0.5)
        out = _is_out(bx, by, court_poly)
        won = _on_opp_side(by, net_y, our_side) and not out

        if won:
            our_score += 1
        else:
            opp_score += 1

        score_events.append({"time_sec": round(land_time, 2),
                              "us": our_score, "opp": opp_score})
        rallies.append({
            "rally_number": rally_num,
            "start_frame":  prev_frame,
            "end_frame":    land_frame,
            "start_sec":    round(prev_time, 2),
            "end_sec":      round(land_time, 2),
            "start_time":   _format_time(prev_time),
            "end_time":     _format_time(land_time),
            "duration_sec": round(land_time - prev_time, 1),
            "actions":      rally_actions,
        })
        prev_frame, prev_time = land_frame, land_time

    return rallies, score_events


# ── Helpers ───────────────────────────────────────────────────────────────────

def load_registry(registry_path: str) -> dict:
    if not os.path.exists(registry_path):
        return {}
    with open(registry_path) as f:
        return json.load(f)

def player_label(player_id: str, registry: dict) -> str:
    entry  = registry.get(str(player_id), {})
    jersey = entry.get("jersey") or entry.get("jersey_number")
    name   = entry.get("name", "")
    if jersey is not None:
        return f"#{jersey}" + (f" {name}" if name else "")
    return f"ID {player_id}"


# ── CLI entry point ────────────────────────────────────────────────────────────

if __name__ == "__main__":
    _parser = argparse.ArgumentParser()
    _parser.add_argument("--court",  default="")
    _parser.add_argument("--net_y",  default="")
    _parser.add_argument("--near_y", default="")
    _parser.add_argument("--far_y",  default="")
    _parser.add_argument("--side",   default="bottom")
    _args = _parser.parse_args()

    court_poly = _build_court(_args.court)
    net_y      = float(_args.net_y)  if _args.net_y.strip()  else 0.50
    our_side   = _args.side

    SCRIPT_DIR_   = os.path.dirname(os.path.abspath(__file__))
    JSON_PATH     = os.path.join(SCRIPT_DIR_, "runs", "volley_analytics.json")
    REGISTRY_PATH = os.path.join(SCRIPT_DIR_, "runs", "player_registry.json")
    STATS_PATH    = os.path.join(SCRIPT_DIR_, "runs", "player_stats.json")
    RALLY_PATH    = os.path.join(SCRIPT_DIR_, "runs", "rally_analysis.json")

    registry = load_registry(REGISTRY_PATH)

    with open(JSON_PATH) as f:
        raw = json.load(f)
    frames        = raw.get("frames", raw) if isinstance(raw, dict) else raw
    ball_landings = raw.get("ball_landings", []) if isinstance(raw, dict) else []

    stats = aggregate_stats(JSON_PATH, registry,
                            net_y=net_y, our_side=our_side, court_poly=court_poly)
    with open(STATS_PATH, "w") as f:
        json.dump(stats, f, indent=4)

    rallies, score_events = detect_rallies(
        frames, ball_landings, registry,
        net_y=net_y, our_side=our_side, court_poly=court_poly)
    with open(RALLY_PATH, "w") as f:
        json.dump({"total_rallies": len(rallies),
                   "score_events":  score_events,
                   "rallies":       rallies}, f, indent=4)

    print(f"Stats computed for {len(stats)} players")
    print(f"Rallies detected:  {len(rallies)}")
    print(f"Court poly used:   {court_poly is not None}")
    print(f"Net Y:             {net_y}")
