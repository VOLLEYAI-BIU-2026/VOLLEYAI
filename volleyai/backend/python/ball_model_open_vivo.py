from ultralytics import YOLO

BEST_MODEL = r"C:\Users\user\volleyball_project\volleyai\backend\runs\ball_yolo11s_cpu\weights\best.pt"

model = YOLO(BEST_MODEL)

model.export(
    format="openvino",
    imgsz=640,
    dynamic=False,
    half=False,
    int8=False
)

print("Done exporting ball model to OpenVINO")