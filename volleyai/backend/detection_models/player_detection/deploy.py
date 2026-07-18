from roboflow import Roboflow

# MAKE ABSOLUTELY SURE YOU REPLACE THIS WITH YOUR NEW, VALID PRIVATE KEY FROM YOUR DASHBOARD
PRIVATE_API_KEY = "TFHu7Hly4DV7oQsB1ekq"

rf = Roboflow(api_key=PRIVATE_API_KEY)
print("Connecting to Roboflow workspace...")
project = rf.workspace("s-workspace-ell9d").project("person_detection-kwszk")

# 2. Target the clean Version 2 slot you created
version = project.version(4) 

print("Uploading custom YOLO11s weights...")

# 3. Deploy by targeting the explicit model size identifier
version.deploy(
    model_type="yolov11s", 
    model_path="/home/jesicemal/project/VOLLEYAI/volleyai/backend/detection_models/player_detection", 
    filename="yolo11s.pt"
)

print("Upload complete! Check your Version 2 tab in the dashboard.")