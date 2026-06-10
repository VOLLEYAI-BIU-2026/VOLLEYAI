from ultralytics import YOLO

# ==========================================
# 1. LOAD YOUR CUSTOM BRAIN
# ==========================================
# Make sure "yolo11n_action.pt" is in the same folder as this script
model = YOLO("yolo11n_action.pt")

# ==========================================
# 2. DEFINE YOUR TEST VIDEO
# ==========================================
# Replace this string with the actual path to a volleyball video on your computer
video_path = "../videos/test_clip.mp4"

print(f"Loading custom action model and analyzing: {video_path}")

# ==========================================
# 3. RUN INFERENCE & DISPLAY
# ==========================================
# The predict() method handles all the video reading, box drawing, and displaying automatically.
# - show=True: Opens a window to play the video live
# - conf=0.5: Only shows predictions if the AI is at least 50% confident
# - save=True: Saves a copy of the video with boxes drawn into a "runs/detect/predict" folder
results = model.predict(
    source=video_path, 
    show=True, 
    conf=0.5,  
    save=True  
)

print("Inference complete! Press 'q' in the video window to close it if it's still open.")