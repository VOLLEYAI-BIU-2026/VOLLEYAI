from ultralytics import YOLO

# 1. Load the model
model = YOLO("yolo11s_not sure to erase.pt") 

# 2. Use the exact path that worked in your 'ls' command
VIDEO_PATH = "../videos/test_clip.mp4"

# 3. Run the detection
# We use save=True because WSL usually can't open a video window.
# We use stream=True so your laptop doesn't run out of memory.
print("Starting analysis... this may take a while for a full match.")
results = model.predict(source=VIDEO_PATH, classes=[0], conf=0.5, save=True, stream=True)

# This loop tells the computer to keep processing until the video ends
for result in results:
    pass

print("Finished! Your processed video is saved in the 'runs' folder.")