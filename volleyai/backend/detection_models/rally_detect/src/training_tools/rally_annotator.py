import cv2
import pandas as pd
import os

# --- CONFIGURATION ---
# Paths for the specific raw video and where to save the resulting label CSV
VIDEO_PATH = r"C:\Users\morde\Desktop\projects\volleyball cv\data\input_videos\game5_set1.mp4"
PER_FRAME_OUTPUT_FILE = './output/training_data/game5_rally_labels_per_frame.csv'
PLAYBACK_SPEED = 2  # Increases labeling efficiency

def label_video(video_path):
    """
    An interactive tool to manually label video frames as 'Rally' or 'Downtime'.

    The user watches the video and uses keyboard shortcuts to mark event transitions.
    The tool records these timestamps and expands them into a frame-by-frame 
    CSV file used for training the rally prediction model.

    Args:
        video_path (str): Path to the volleyball video file to be labeled.

    Keyboard Controls:
        [2]: Set state to 'Rally'
        [1]: Set state to 'Downtime'
        [Space]: Pause/Resume playback
        [Z]: Undo the last marker
        [Left Arrow]: Rewind 5 seconds
        [Q]: Save labels and exit
    """
    if not os.path.exists(video_path):
        print(f"Error: Video file {video_path} not found.")
        return

    cap = cv2.VideoCapture(video_path)
    actual_fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    if actual_fps == 0: actual_fps = 30.0
    
    # --- INTERNAL TRACKING ---
    # Stores tuples of (frame_index, label_name)
    event_markers = [] 
    current_state = "Downtime"
    
    # Calculate wait delay based on desired playback speed
    delay = max(1, int((1000 / actual_fps) / PLAYBACK_SPEED))
    paused = False
    
    print(f"Controls:")
    print(" [2] Rally | [1] Downtime | [Space] Pause")
    print(" [Z] Undo Last | [Left Arrow] Rewind 5s | [Q] Save & Quit")

    curr_frame = 0

    while cap.isOpened():
        if not paused:
            # Skip frames to achieve the requested playback speed
            for _ in range(PLAYBACK_SPEED):
                ret, frame = cap.read()
                if not ret: break
            if not ret: break
            curr_frame = int(cap.get(cv2.CAP_PROP_POS_FRAMES))
        
        # UI Overlay Logic
        display_frame = frame.copy()
        state_color = (0, 255, 0) if current_state == "Rally" else (0, 0, 255)
        
        cv2.putText(display_frame, f"State: {current_state}", (50, 50), 2, 1, state_color, 2)
        cv2.putText(display_frame, f"Frame: {curr_frame} / {total_frames}", (50, 100), 2, 1, (255, 255, 255), 2)
        
        cv2.imshow('Volleyball Labeler', display_frame)
        
        # waitKeyEx is used to capture special keys like Arrow Keys
        key = cv2.waitKeyEx(delay)

        # 1. Update State & Record Markers
        if key == ord('2'):
            current_state = "Rally"
            event_markers.append((curr_frame, "Rally"))
        elif key == ord('1'):
            current_state = "Downtime"
            event_markers.append((curr_frame, "Downtime"))
            
        # 2. Correction Logic (Undo)
        elif key == ord('z') or key == ord('Z'):
            if event_markers:
                event_markers.pop()
                current_state = event_markers[-1][1] if event_markers else "Downtime"
                
        # 3. Navigation
        elif key == 2424832: # Windows Left Arrow Code
            curr_frame = max(0, curr_frame - int(actual_fps * 5))
            cap.set(cv2.CAP_PROP_POS_FRAMES, curr_frame)
            ret, frame = cap.read() 
        elif key == ord(' '):
            paused = not paused
        elif key == ord('q'):
            break

    cap.release()
    cv2.destroyAllWindows()
    
    if not event_markers and current_state == "Downtime":
        print("No labels to save.")
        return

    # --- GENERATE PER-FRAME LABELS ---
    # This section expands the sparse markers into a full-length list
    print("Processing per-frame labels...")
    full_labels = ["Downtime"] * total_frames
    event_markers.sort()

    for i in range(len(event_markers)):
        start_f, label = event_markers[i]
        # Propagate the label from the marker until the end of the video
        # (Subsequent markers in the loop will overwrite the later parts)
        full_labels[start_f:] = [label] * (total_frames - start_f)

    # --- SAVE TO CSV ---
    os.makedirs(os.path.dirname(PER_FRAME_OUTPUT_FILE), exist_ok=True)
    df = pd.DataFrame({'label': full_labels})
    df.to_csv(PER_FRAME_OUTPUT_FILE, index_label='frame')
    
    print(f"Successfully saved {total_frames} frame labels to {PER_FRAME_OUTPUT_FILE}")

if __name__ == "__main__":
    label_video(VIDEO_PATH)