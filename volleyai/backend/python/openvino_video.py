from ultralytics import YOLO

model = YOLO("yolo11s.pt")
model.export(format="openvino", imgsz=640, dynamic=False, half=False)