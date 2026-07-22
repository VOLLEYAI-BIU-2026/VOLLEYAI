from roboflow import Roboflow

# MAKE ABSOLUTELY SURE YOU REPLACE THIS WITH YOUR NEW, VALID PRIVATE KEY FROM YOUR DASHBOARD
PRIVATE_API_KEY = "1FkdEzikAONwnsuA40lT"

rf = Roboflow(api_key=PRIVATE_API_KEY)
print("Connecting to Roboflow workspace...")
project = rf.workspace("s-workspace-ell9d").project("volleyball_action_detection")

# 2. Target the clean Version 2 slot you created
version = project.version(6) 

print("Uploading custom YOLO11s weights...")

# 3. Deploy by targeting the explicit model size identifier
version.deploy(
    model_type="yolov8", 
    model_path="/home/jesicemal/project/VOLLEYAI/volleyai/backend/detection_models/action_detection", 
    filename="best_renamed.pt"
)

print("Upload complete! Check your Version 2 tab in the dashboard.")