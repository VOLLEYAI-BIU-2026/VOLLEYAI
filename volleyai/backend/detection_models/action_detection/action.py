from ultralytics import YOLO

model = YOLO("best_robo_with_git.pt")
video_path = "../videos/test_clip.mp4"

print(f"Analyzing {video_path} in memory-safe stream mode...")

# Add stream=True to prevent RAM exhaustion
results = model.predict(
    source=video_path, 
    show=False,        
    conf=0.5,  
    save=True,
    stream=True      # <-- THE FIX
)

# You must loop through the generator to actually process the video
for frame in results:
    pass # We do nothing here; YOLO handles the saving automatically in the background!

print("\nInference complete! Check your runs/detect/predict folder.")