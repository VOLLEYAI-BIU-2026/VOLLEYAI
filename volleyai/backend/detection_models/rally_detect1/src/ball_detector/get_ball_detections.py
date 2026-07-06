# src/ball_detector/get_ball_detections.py

import cv2
import csv
import time
from ultralytics import YOLO
from tqdm import tqdm

def get_ball_detections(model_path, video_path, output_csv, device='cpu', log_callback=None, progress_callback=None):
    """
    Runs YOLO inference on a video and saves detections to a CSV file.
    Supports throttled progress reporting for GUI and standard tqdm for CLI.

    Args:
        model_path (str): Path to YOLO model weights.
        video_path (str): Path to input video.
        output_csv (str): Path to save CSV results.
        device (str): Inference device ('cpu', 'cuda', etc.).
        progress_callback (func): Optional function(current, total, status_text) for GUI updates.
    """
    # Initialize YOLO model
    model = YOLO(model_path, task="detect")

    # Get total frames for progress tracking
    cap = cv2.VideoCapture(video_path)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.release()

    if total_frames <= 0:
        raise ValueError("Could not determine frame count or video is empty.")

    # Generator for inference
    results = model.predict(
        source=video_path,
        device=device,
        conf=0.1,
        iou=0,
        imgsz=640,
        stream=True, 
        verbose=False
    )

    # Throttling and Timing Variables
    last_percent = -1
    start_time = time.time()
    
    # Standard terminal progress bar (only enabled if no GUI callback is provided)
    pbar = tqdm(total=total_frames, desc="Processing Video", unit="frame", disable=(progress_callback is not None))

    log_callback(f"Starting inference on {total_frames} frames...")
    
    with open(output_csv, mode='w', newline='') as f:
        writer = csv.writer(f)
        writer.writerow(['frame', 'class', 'conf', 'x1', 'y1', 'x2', 'y2'])

        for frame_count, result in enumerate(results):
            current_frame = frame_count + 1
            
            # --- DATA EXTRACTION ---
            boxes = result.boxes
            if len(boxes) > 0:
                data = boxes.data.cpu().numpy() 
                rows = []
                for row in data:
                    rows.append([
                        frame_count, 
                        int(row[5]),          # class_id
                        f"{row[4]:.4f}",      # confidence
                        int(row[0]), int(row[1]), int(row[2]), int(row[3]) # x1, y1, x2, y2
                    ])
                writer.writerows(rows)

            # --- PROGRESS REPORTING ---
            # Calculate integer percentage (0-100)
            current_percent = int((current_frame / total_frames) * 100)
            
            # Only trigger GUI updates when the percentage integer changes
            if progress_callback and current_percent > last_percent:
                elapsed = time.time() - start_time
                fps = current_frame / elapsed
                
                # Send update to GUI
                status = f"Detecting Ball ({fps:.1f} FPS)"
                progress_callback(current_frame, total_frames, status)
                last_percent = current_percent
            
            # Standard CLI update (tqdm handles its own internal throttling for terminal)
            if not progress_callback:
                pbar.update(1)

    if not progress_callback:
        pbar.close()
    if progress_callback is not None:
        progress_callback(100, 100, "Detection Complete")
    log_callback(f"\nProcessing complete. Results saved to {output_csv}")