import os
from ultralytics import YOLO

def export_to_openvino(model_path, imgsz=640):
    """
    Exports a YOLO model to optimized OpenVINO format with FP16 precision.

    This function takes a standard PyTorch weights file (.pt) and converts it 
    into an OpenVINO Intermediate Representation (.xml and .bin files). This 
    is a critical step for deploying models on Intel-based edge devices or 
    embedded systems to achieve real-time performance.

    Args:
        model_path (str): Path to the input PyTorch (.pt) weights file.
        imgsz (int): Target input image size. Should match the size used 
            during model training (default is 640).

    Returns:
        str: The path to the directory containing the exported OpenVINO model.
    """
    # 1. Load the model
    # Note: Using your custom 'vbn11' (Volleyball Ball Nano 11?) model
    model = YOLO(model_path)

    # 2. Export the model
    # format: "openvino" creates an IR directory containing .xml and .bin
    # half=True: Enables FP16 (16-bit) precision. This roughly doubles 
    #   inference speed on Intel GPUs and VPUs with negligible accuracy loss.
    # imgsz=640: Locks the input layer size. 
    # augment=False: Ensures we aren't using TTA (Test Time Augmentation) 
    #   which is too slow for real-time tracking.
    export_path = model.export(
        format="openvino", 
        half=True, 
        imgsz=imgsz, 
        augment=False
    )
    
    return export_path

if __name__ == "__main__":
    # Your specific model path
    MODEL_FILE = "./models/ball_detection/vbn11.pt"
    
    if os.path.exists(MODEL_FILE):
        print(f"Starting OpenVINO export for {MODEL_FILE}...")
        path = export_to_openvino(MODEL_FILE)
        print(f"Export complete. Model saved at: {path}")
    else:
        print(f"Error: Model file not found at {MODEL_FILE}")