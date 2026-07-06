"""
Quick visual test — Players + Ball (rally_detect) + PLAY/NO_PLAY, NO OCR.
Usage:
    py test_visual.py --video path/to/clip.mp4 --frames 400
Output:  runs/test_visual_final.mp4
"""
import os, sys, argparse, tempfile, subprocess, cv2, numpy as np
import pandas as pd
from concurrent.futures import ThreadPoolExecutor
from ultralytics import YOLO
from tqdm import tqdm

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

PLAYERS_MODEL = os.path.join(SCRIPT_DIR, "../player_detection/yolo11s.pt")
BALL_MODEL    = os.path.join(SCRIPT_DIR, "../ball_tracking/ball_model.pt")
RALLY_ROOT    = os.path.abspath(os.path.join(SCRIPT_DIR, "../rally_detect"))
RF_MODEL      = os.path.join(RALLY_ROOT, "models/rally_prediction/rally_predictor_rf_v4.pkl")
TRACKER_CFG   = os.path.join(SCRIPT_DIR, "botsort_volleyball.yaml")

for _p in [RALLY_ROOT, os.path.join(RALLY_ROOT, "src")]:
    if _p not in sys.path:
        sys.path.insert(0, _p)

parser = argparse.ArgumentParser()
parser.add_argument("--video",  default=r"C:\Users\user\Desktop\VOLLEYAI\volleyai\backend\uploads\1783341654771_test_clip_-_Trim_-_Trim.mp4")
parser.add_argument("--frames", type=int, default=400)
args = parser.parse_args()

OUT_DIR  = os.path.join(SCRIPT_DIR, "runs")
OUT_RAW  = os.path.join(OUT_DIR, "test_visual_raw.avi")
OUT_MP4  = os.path.join(OUT_DIR, "test_visual.mp4")
OUT_BALL = os.path.join(OUT_DIR, "test_visual_ball")   # visualizer adds suffix
OUT_FINAL= os.path.join(OUT_DIR, "test_visual_final.mp4")
os.makedirs(OUT_DIR, exist_ok=True)

print("Loading models...")
players_model = YOLO(PLAYERS_MODEL)
ball_model    = YOLO(BALL_MODEL)
print("Done.\n")

cap = cv2.VideoCapture(args.video)
fps   = cap.get(cv2.CAP_PROP_FPS) or 30.0
w     = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
h     = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
n_frames = min(args.frames, total)

writer = cv2.VideoWriter(OUT_RAW, cv2.VideoWriter_fourcc(*"XVID"), fps, (w, h))

COURT_MID_Y  = 0.5
TRAJ_WINDOW  = 12
CONF_PLAYERS = 0.35
CONF_BALL    = 0.35
IMG_SIZE     = 640

ball_traj       = []
ball_detections = []   # for RF pipeline

def player_color(pid):
    import colorsys
    hue = (int(pid) * 0.618033988749895) % 1.0
    r, g, b = colorsys.hsv_to_rgb(hue, 0.95, 1.0)
    return (int(b*255), int(g*255), int(r*255))

# ── PASS 1: detect players + collect ball detections ─────────────────────────
print(f"Pass 1 — detecting {n_frames} frames...")
with ThreadPoolExecutor(max_workers=2) as ex:
    for fi in tqdm(range(n_frames), desc="Detecting"):
        ret, frame = cap.read()
        if not ret:
            break

        f_ball    = ex.submit(ball_model.predict,  frame, conf=CONF_BALL,    imgsz=IMG_SIZE, verbose=False)
        f_players = ex.submit(players_model.track, frame, classes=[0], conf=CONF_PLAYERS,
                              imgsz=IMG_SIZE, persist=True, verbose=False, tracker=TRACKER_CFG)

        res_ball    = f_ball.result()
        res_players = f_players.result()

        # Collect ball detection for RF pipeline
        if res_ball and res_ball[0].boxes is not None and len(res_ball[0].boxes):
            b = res_ball[0].boxes.xyxy[0].cpu().numpy()
            x1,y1,x2,y2 = map(int, b[:4])
            conf = float(res_ball[0].boxes.conf[0].cpu())
            ball_detections.append({"frame": fi, "x1": x1, "y1": y1,
                                    "x2": x2, "y2": y2, "conf": round(conf,4)})

        # Draw players
        if res_players and res_players[0].boxes is not None:
            boxes = res_players[0].boxes
            xyxy  = boxes.xyxy.cpu().numpy()
            ids   = boxes.id.cpu().numpy() if boxes.id is not None else None
            for i, box in enumerate(xyxy):
                rx1,ry1,rx2,ry2 = map(int, box[:4])
                pid = int(ids[i]) if ids is not None else i
                cy_norm = (ry1+ry2)/(2*h)
                is_our  = cy_norm > COURT_MID_Y
                color   = player_color(pid) if is_our else (110,110,110)
                thick   = 2 if is_our else 1
                cv2.rectangle(frame, (rx1,ry1), (rx2,ry2), color, thick)
                cv2.putText(frame, f"#{pid}", (rx1, max(20, ry1-8)),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.55, color, 2)

        cv2.putText(frame, f"F{fi}", (8, h-10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (200,200,200), 1)
        writer.write(frame)

cap.release()
writer.release()
print(f"Pass 1 done. Ball detections: {len(ball_detections)}\n")

# ── AVI → MP4 with silent audio (so rally_detect visualizer can use [1:a]) ───
print("Converting AVI → MP4...")
subprocess.run([
    "ffmpeg", "-y",
    "-i", OUT_RAW,
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
    "-c:v", "libx264", "-preset", "fast", "-crf", "23",
    "-c:a", "aac", "-b:a", "64k",
    "-shortest", "-movflags", "+faststart",
    OUT_MP4
], capture_output=True)
print(f"MP4 ready: {OUT_MP4}\n")

# ── RF Rally Detect pipeline ──────────────────────────────────────────────────
smoothed    = []
dead_segs   = []

if os.path.exists(RF_MODEL) and ball_detections:
    print("Running Rally Detect RF pipeline...")
    try:
        from src.ball_detector.track_ball_detections import track_with_physics_predictive
        from src.ball_detector.clean_tracking_data   import clean_noise
        from src.rally_predictor                     import extract_features, predict_rallies, smooth_predictions
        from src.rally_predictor.predictions_handler import analyze_rally_stats

        t1 = tempfile.NamedTemporaryFile(suffix=".csv", delete=False, mode="w")
        t2 = tempfile.NamedTemporaryFile(suffix=".csv", delete=False, mode="w")
        t3 = tempfile.NamedTemporaryFile(suffix=".csv", delete=False, mode="w")
        t4 = tempfile.NamedTemporaryFile(suffix=".csv", delete=False, mode="w")
        for t in [t1,t2,t3,t4]: t.close()

        pd.DataFrame(ball_detections)[["frame","x1","y1","x2","y2","conf"]].to_csv(t1.name, index=False)
        track_with_physics_predictive(input_csv=t1.name, output_csv=t2.name)
        n_tracked = len(pd.read_csv(t2.name))
        print(f"  Tracking : {n_tracked} rows")
        clean_noise(tracking_csv=t2.name, output_csv=t3.name)
        n_clean = len(pd.read_csv(t3.name))
        print(f"  Cleaning : {n_clean} rows")
        extract_features(input_csv=t3.name, output_csv=t4.name)
        raw_preds = predict_rallies(RF_MODEL, t4.name)
        smoothed  = smooth_predictions(list(raw_preds))
        n_play    = sum(1 for p in smoothed if int(p)==1)
        print(f"  PLAY={n_play} / NO_PLAY={len(smoothed)-n_play}")

        _stats, _segs_df = analyze_rally_stats(smoothed, fps)
        print(f"  Stats: {_stats}")

        _cursor = 0
        for _, seg in _segs_df.iterrows():
            sf = _cursor
            ef = _cursor + int(seg["frame_count"]) - 1
            if int(seg["label"]) == 0:
                dead_segs.append({"start_frame": sf, "end_frame": ef})
            _cursor = ef + 1

        for f in [t1.name, t2.name, t3.name, t4.name]:
            try: os.remove(f)
            except: pass

        print("RF done.\n")
    except Exception as e:
        import traceback
        print(f"RF ERROR: {e}")
        traceback.print_exc()
else:
    print("Skipping RF (no model or no ball detections)\n")

# ── rally_detect visualizer — ball box + trail on top of players video ────────
print("Running rally_detect visualizer (ball trail + box)...")
try:
    from src.visualizer.visualize_data import visualize as _rd_visualize

    _ball_csv = tempfile.NamedTemporaryFile(suffix=".csv", delete=False, mode="w")
    pd.DataFrame(ball_detections).to_csv(_ball_csv.name, index=False)
    _ball_csv.close()

    _pred_csv_path = None
    if dead_segs:
        rows = []
        dead_set = {(d["start_frame"], d["end_frame"]) for d in dead_segs}
        for fi in range(n_frames):
            in_dead = any(s <= fi <= e for s, e in dead_set)
            rows.append({"label": 0 if in_dead else 1})
        _pred_csv = tempfile.NamedTemporaryFile(suffix=".csv", delete=False, mode="w")
        pd.DataFrame(rows).to_csv(_pred_csv.name, index=False)
        _pred_csv.close()
        _pred_csv_path = _pred_csv.name

    _rd_visualize(
        video_path=OUT_MP4,
        output_path=OUT_BALL + ".mp4",
        tracking_csv=_ball_csv.name,
        predictions_csv=_pred_csv_path,
        overlay_mode="both",
        log_callback=print,
    )

    viz_result = OUT_BALL + "_both.mp4"
    if os.path.exists(viz_result):
        import shutil
        shutil.copy(viz_result, OUT_FINAL)
        print(f"\n✓ Final video → {OUT_FINAL}")
    else:
        import shutil
        shutil.copy(OUT_MP4, OUT_FINAL)
        print(f"\n⚠ Visualizer didn't produce output, using players-only → {OUT_FINAL}")

    for f in [_ball_csv.name, _pred_csv_path]:
        if f:
            try: os.remove(f)
            except: pass

except Exception as e:
    import traceback, shutil
    print(f"Visualizer ERROR: {e}")
    traceback.print_exc()
    shutil.copy(OUT_MP4, OUT_FINAL)
    print(f"Fallback → {OUT_FINAL}")
