# src/visualizer/visualize_data.py

import os
import json
import shutil
import cv2
import subprocess
import sys
import pandas as pd
import numpy as np
import time 
from tqdm import tqdm
from pathlib import Path
from src.utils.manipulate_video import get_video_properties
from src.utils.utils import get_bin_path, CREATE_NO_WINDOW

def get_color(track_id):
    """Generates a consistent BGR color for a given track_id."""
    np.random.seed(int(track_id))
    return tuple(np.random.randint(0, 255, 3).tolist())

def run_processing(segments, video_path, output_path, lookup, mode, fps, width, height, log_callback=None, progress_callback=None):
    if(len(segments)==0):
        return
    ffmpeg_bin = get_bin_path("ffmpeg")
    
    # Calculate total frames/duration for progress tracking
    total_frames_to_proc = sum(f1 - f0 + 1 for f0, f1 in segments)
    total_duration_secs = total_frames_to_proc / fps

    # --- PATH A: PURE FFMPEG (With Progress Bar) ---
    if mode == "cut":
        filter_script = ""
        for i, (f0, f1) in enumerate(segments):
            t0, dur = f0 / fps, (f1 - f0 + 1) / fps
            filter_script += f"[0:v]trim=start={t0}:duration={dur},setpts=PTS-STARTPTS[v{i}]; "
            filter_script += f"[0:a]atrim=start={t0}:duration={dur},asetpts=PTS-STARTPTS,aresample=async=1[a{i}]; "

        concat_inputs = "".join([f"[v{i}][a{i}]" for i in range(len(segments))])
        filter_script += f"{concat_inputs}concat=n={len(segments)}:v=1:a=1[outv][outa]"
        
        # Add '-progress pipe:1' to output progress info to stdout
        cmd = [
            ffmpeg_bin, "-y", "-progress", "pipe:1", "-i", video_path,
            "-filter_complex", filter_script,
            "-map", "[outv]", "-map", "[outa]",
            "-c:v", "libx264", "-preset", "fast", "-crf", "23",
            "-c:a", "aac", "-b:a", "192k", output_path
        ]

        # Setup Progress Bars
        pbar = tqdm(total=100, desc="Cutting Video", disable=(progress_callback is not None))
        last_percent = -1

        # Launch FFmpeg
        process = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, universal_newlines=True,creationflags=CREATE_NO_WINDOW)

        try:
            for line in process.stdout:
                # FFmpeg outputs out_time_us (microseconds)
                if "out_time_us=" in line:
                    try:
                        time_us = int(line.split('=')[1])
                        current_secs = time_us / 1_000_000.0
                        
                        # Calculate percentage
                        percent = int((current_secs / total_duration_secs) * 100)
                        percent = min(100, max(0, percent)) # Clamp 0-100

                        if percent > last_percent:
                            if progress_callback:
                                # Update GUI
                                progress_callback(percent, 100, f"Cutting Video")
                            else:
                                # Update CLI TQDM
                                pbar.update(percent - last_percent)
                            last_percent = percent
                    except (ValueError, IndexError):
                        continue
            
            process.wait()
            
        finally:
            pbar.close()
            if process.returncode != 0:
                raise subprocess.CalledProcessError(process.returncode, cmd)
        if progress_callback is not None:
            progress_callback(100, 100, "Cutting Complete")  # <--- SAFE
        return

    # --- PATH B: VISUALIZATION (OpenCV + FFmpeg Pipe) ---
    # Progress Setup
    frames_done = 0
    last_percent = -1
    start_time = time.time()
    
    # Terminal progress bar (disabled if GUI callback is present)
    pbar = tqdm(total=total_frames_to_proc, desc=f"Visualizing: {mode}", disable=(progress_callback is not None))

    filter_parts = []
    for i, (f0, f1) in enumerate(segments):
        t0 = f0 / fps
        dur = (f1 - f0 + 1) / fps 
        filter_parts.append(f"[1:a]atrim=start={t0}:duration={dur},asetpts=PTS-STARTPTS,aresample=async=1[a{i}];")

    audio_concat = "".join([f"[a{i}]" for i in range(len(segments))])
    filter_script = "".join(filter_parts) + f"{audio_concat}concat=n={len(segments)}:v=0:a=1[outa]"

    ffmpeg_cmd = [
        ffmpeg_bin, '-y', '-loglevel', 'error',
        '-f', 'rawvideo', '-vcodec', 'rawvideo', '-s', f'{width}x{height}', 
        '-pix_fmt', 'bgr24', '-r', str(fps),
        '-i', '-',  
        '-i', video_path, 
        '-filter_complex', filter_script,
        '-map', '0:v', '-map', '[outa]',
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23', 
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k',
        '-shortest', output_path
    ]
    
    cap = cv2.VideoCapture(video_path)
    process = subprocess.Popen(ffmpeg_cmd, stdin=subprocess.PIPE, creationflags=CREATE_NO_WINDOW)

    try:
        for f0, f1 in segments:
            if int(cap.get(cv2.CAP_PROP_POS_FRAMES)) != f0:
                cap.set(cv2.CAP_PROP_POS_FRAMES, f0)
            
            trails = {} 

            for current_frame_idx in range(f0, f1 + 1):
                ret, frame = cap.read()
                if not ret: break

                detections = lookup.get(current_frame_idx, [])
                active_ids_this_frame = set()

                for d in detections:
                    track_id = d.get('track_id', 0)
                    active_ids_this_frame.add(track_id)
                    color = get_color(track_id)

                    if mode in ("data", "both"):
                        x1, y1, x2, y2 = map(int, (d["x1"], d["y1"], d["x2"], d["y2"]))
                        cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
                        label = f"ID:{track_id} Co:{d.get('conf', 0):.1f}"
                        cv2.putText(frame, label, (x1, y1 - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)

                    if track_id not in trails:
                        trails[track_id] = []
                    trails[track_id].append((int(d["cx"]), int(d["cy"])))

                if mode in ("trajectory", "both"):
                    for tid, pts_list in trails.items():
                        if tid not in active_ids_this_frame:
                            pts_list.append(None)
                        if len(pts_list) > 30: pts_list.pop(0)
                        valid_pts = np.array([p for p in pts_list if p is not None], np.int32).reshape((-1, 1, 2))
                        if len(valid_pts) > 1:
                            cv2.polylines(frame, [valid_pts], False, get_color(tid), 2, cv2.LINE_AA)

                process.stdin.write(frame.tobytes())
                
                # --- PROGRESS UPDATES ---
                frames_done += 1
                curr_percent = int((frames_done / total_frames_to_proc) * 100)
                
                if progress_callback and curr_percent > last_percent:
                    elapsed = time.time() - start_time
                    curr_fps = frames_done / elapsed if elapsed > 0 else 0
                    status = f"Visualizing: {mode} ({curr_fps:.1f} FPS)"
                    progress_callback(frames_done, total_frames_to_proc, status)
                    last_percent = curr_percent
                
                if not progress_callback:
                    pbar.update(1)
    finally:
        cap.release()
        process.stdin.close()
        process.wait()
        if not progress_callback:
            pbar.close()
        if progress_callback is not None:
            progress_callback(100, 100, "Visualization Complete")

def visualize(video_path, output_path, tracking_csv, predictions_csv=None, overlay_mode="both", buffer_sec=1.5, log_callback=None, progress_callback=None):
    fps, total_frames, width, height = get_video_properties(video_path)

    df = pd.read_csv(tracking_csv)
    if "cx" not in df:
        df["cx"] = (df["x1"] + df["x2"]) / 2
        df["cy"] = (df["y1"] + df["y2"]) / 2
    
    lookup = df.groupby("frame").apply(
        lambda x: x.to_dict("records"), 
        include_groups=False
    ).to_dict()

    segments = []
    if predictions_csv and os.path.exists(predictions_csv):
        p = pd.read_csv(predictions_csv)
        p["frame"] = p.index.astype(int)
        p["grp"] = (p["label"] != p["label"].shift()).cumsum()
        rallies = p[p["label"] == 1].groupby("grp")["frame"].agg(["min", "max"])
        
        buf_frames = int(buffer_sec * fps)
        edge_buf_frames = int(3.0 * fps)
        
        rally_list = list(rallies.itertuples())
        for idx, r in enumerate(rally_list):
            start_b = edge_buf_frames if idx == 0 else buf_frames
            end_b = edge_buf_frames if idx == len(rally_list) - 1 else buf_frames
            segments.append((max(0, int(r.min - start_b)), min(total_frames - 1, int(r.max + end_b))))
    else:
        segments = [(0, total_frames - 1)]

    # 3. Execution
    if overlay_mode == "all":
        viz_out = output_path.replace(".mp4", "_visualized.mp4")
        run_processing(segments, video_path, viz_out, lookup, "both", fps, width, height, log_callback, progress_callback)
        cut_out = output_path.replace(".mp4", "_cuts.mp4")
        run_processing(segments, video_path, cut_out, lookup, "cut", fps, width, height, log_callback, progress_callback)
    else:
        viz_out = output_path.replace(".mp4", f"_{overlay_mode}.mp4")
        run_processing(segments, video_path, viz_out, lookup, overlay_mode, fps, width, height, log_callback, progress_callback)

    if os.path.exists("tmp"): shutil.rmtree("tmp")