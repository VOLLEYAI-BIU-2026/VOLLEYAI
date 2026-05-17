from ultralytics import YOLO

MODEL_PATH = "yolo11s.pt"
DATA_YAML = r"C:\Users\user\volleyball_project\volleyai\backend\dataset\volley.v3i.yolov8\data.yaml"

model = YOLO(MODEL_PATH)

model.train(
    data=DATA_YAML,
    epochs=80,
    imgsz=640,
    batch=4,
    device="cpu",
    workers=0,
    project=r"C:\Users\user\volleyball_project\volleyai\backend\runs",
    name="ball_yolo11s_cpu"
)