# src/utils/manipulate_video.py

import json
import subprocess
import cv2

from .utils import get_bin_path
from src.utils.utils import CREATE_NO_WINDOW

def get_video_properties(video_path):
    """
    Extracts core metadata from a video file using ffprobe.

    Args:
        video_path (str): Path to the source video.

    Returns:
        tuple: (fps, total_frames, width, height)
    """
    ffprobe_bin = get_bin_path("ffprobe")

    cmd = [
        ffprobe_bin, "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=r_frame_rate,nb_frames,width,height,duration",
        "-of", "json",
        video_path
    ]
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, universal_newlines=True,creationflags=CREATE_NO_WINDOW)
    s = json.loads(p.stdout)["streams"][0]

    # Handle frame rate fractions (e.g., '30000/1001')
    num, den = map(int, s["r_frame_rate"].split("/"))
    fps = num / den
    width = int(s["width"])
    height = int(s["height"])

    # Fallback for total frames if nb_frames is missing from metadata
    if "nb_frames" in s:
        total_frames = int(s["nb_frames"])
    else:
        total_frames = int(float(s["duration"]) * fps)

    return fps, total_frames, width, height


def ensure_30fps(input_path, output_path, log_func):
    """
    Checks FPS and converts to exactly 30 if higher.
    """
    cap = cv2.VideoCapture(input_path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    cap.release()

    # We allow a small margin around 30.0
    if fps > 30.5:
        log_func(f"Video FPS is {fps:.2f}. Downsampling to 30 FPS...")
        
        ffmpeg_bin = get_bin_path("ffmpeg")
        
        # Mirroring your successful manual command
        cmd = [
            ffmpeg_bin, "-y",
            "-i", input_path,
            "-vf", "fps=fps=30",     # Fixed frame rate filter
            "-c:v", "libx264",       # Re-encode video
            "-crf", "20",            # Your preferred quality setting
            "-c:a", "copy",          # Keep original audio stream
            output_path
        ]
        
        try:
            subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, universal_newlines=True,creationflags=CREATE_NO_WINDOW)
            return output_path
        except subprocess.CalledProcessError as e:
            log_func(f"Error during FPS conversion: {e.stderr}")
            raise e
    
    elif fps < 29.5:
        log_func(f"WARNING: Video FPS is low ({fps:.2f}). Tracking accuracy may decrease.")
    
    # If already ~30fps, just return the original path to skip processing
    return input_path

def trim_video(input_path, output_path, start_time, end_time, log_func):
    """
    Blazing fast cut using stream copying.
    """
    if end_time == "00:00:00" or end_time == "" and start_time == "":
        return input_path
    
    log_func(f"Fast-Trimming: {start_time or '00:00:00'} to {end_time or 'End'}")
    
    ffmpeg_bin = get_bin_path("ffmpeg")
    
    # We put -ss BEFORE -i for the 'Fast Seek' behavior you used
    cmd = [ffmpeg_bin, '-y']
    
    if start_time:
        cmd.extend(['-ss', start_time])
        
    if end_time:
        cmd.extend(['-to', end_time])
        
    cmd.extend([
        '-i', input_path,
        '-c', 'copy',                # No re-encoding
        output_path
    ])
    
    subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, universal_newlines=True,creationflags=CREATE_NO_WINDOW)
    return output_path