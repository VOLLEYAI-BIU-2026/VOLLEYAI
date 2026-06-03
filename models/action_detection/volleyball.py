import cv2
import supervision as sv
from inference_sdk import InferenceHTTPClient
from tqdm import tqdm

# 1. Setup
VIDEO_PATH = "../videos/test_clip.mp4"
OUTPUT_PATH = "volley_debug_results.mp4"
MODEL_ID = "volleyball-actions/4" 

# Use 'detect.roboflow.com' as it's more stable for video frames
CLIENT = InferenceHTTPClient(
    api_url="https://detect.roboflow.com",
    api_key="zhaNQA68oDKv3Jx4jaT2"
)

# 2. Tools
box_annotator = sv.BoxAnnotator(thickness=4)
label_annotator = sv.LabelAnnotator(text_scale=1.0, text_thickness=2)
video_info = sv.VideoInfo.from_video_path(VIDEO_PATH)
frames_generator = sv.get_video_frames_generator(VIDEO_PATH)

print(f"Testing Model: {MODEL_ID}...")

with sv.VideoSink(target_path=OUTPUT_PATH, video_info=video_info) as sink:
    for index, frame in enumerate(tqdm(frames_generator, total=500)): # Just test 200 frames
        if index >= 500: break
            
        # Raw Inference
        results = CLIENT.infer(frame, model_id=MODEL_ID)
        
        # --- THE X-RAY PRINT ---
        # This will show us EXACTLY what the API is sending back
        if results['predictions']:
            print(f"\nFrame {index} RAW DATA: {results['predictions']}")
        # -----------------------

        # Convert to Supervision
        detections = sv.Detections.from_inference(results)
        
        # Lower confidence to 0.15 just to see if ANYTHING appears
        detections = detections[detections.confidence > 0.15]
        
        # If we have detections, draw them
        if len(detections) > 0:
            annotated_frame = box_annotator.annotate(scene=frame.copy(), detections=detections)
            annotated_frame = label_annotator.annotate(scene=annotated_frame, detections=detections)
            sink.write_frame(annotated_frame)
        else:
            sink.write_frame(frame)

print(f"\nDone! Check the terminal above. Did you see 'RAW DATA' scroll by?")