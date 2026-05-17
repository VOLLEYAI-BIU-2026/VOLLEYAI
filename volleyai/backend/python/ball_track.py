import os
import cv2
import numpy as np
from collections import deque
from ultralytics import YOLO

# =========================================
# PATHS (מעודכן לפי הנתונים שלך)
# =========================================
MODEL_PATH = r"C:\Users\user\volleyball_project\volleyai\backend\runs\ball_yolo11s_cpu\weights\best.pt"
VIDEO_PATH = r"C:\Users\user\volleyball_project\volleyai\backend\python\runs\detect\predict\match8.avi"
OUTPUT_PATH = r"C:\Users\user\volleyball_project\volleyai\backend\python\runs\detect\match8_trajectory_on_model.mp4"

# =========================================
# הגדרות ויזואליות למסלול חלק
# =========================================
TRAIL_LEN = 25       # אורך השובל בפריימים
SMOOTHING = True     # החלקת קצוות LINE_AA

def main():
    # בדיקה שהתיקיות קיימות
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)

    # טעינת המודל
    model = YOLO(MODEL_PATH)

    # פתיחת הוידאו המעובד (ה-AVI)
    cap = cv2.VideoCapture(VIDEO_PATH)
    if not cap.isOpened():
        print(f"Error: Could not open video {VIDEO_PATH}")
        return

    # נתוני וידאו
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS)
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    # הגדרת כותב הוידאו (MP4)
    fourcc = cv2.VideoWriter_fourcc(*'mp4v')
    out = cv2.VideoWriter(OUTPUT_PATH, fourcc, fps, (width, height))

    # תור לשמירת הנקודות (הזנב)
    trail = deque(maxlen=TRAIL_LEN)

    print(f"Starting process: {total_frames} frames to process...")

    while cap.isOpened():
        ret, frame = cap.read()
        if not ret:
            break

        # הרצת המודל על הפריים כדי למצוא את מיקום הכדור הנוכחי
        results = model.predict(frame, conf=0.25, verbose=False)
        
        if len(results[0].boxes) > 0:
            # לקיחת הכדור (התיבה הראשונה)
            box = results[0].boxes[0].xyxy[0].cpu().numpy()
            x1, y1, x2, y2 = box
            
            # חישוב מרכז התיבה
            cx = int((x1 + x2) / 2)
            cy = int((y1 + y2) / 2)
            trail.append((cx, cy))

        # --- ציור המסלול בצורה חלקה ---
        points = list(trail)
        for i in range(1, len(points)):
            # חישוב עובי דועך (התחלה דקה, סוף עבה ליד הכדור)
            thickness = int(np.sqrt(i + 1) * 2)
            
            # צבע כחול-בהיר זוהר (ניתן לשינוי)
            color = (255, 200, 0) # ציאן/טורקיז
            
            # ציור הקו עם LINE_AA להחלקה מקסימלית
            cv2.line(frame, points[i-1], points[i], color, thickness, lineType=cv2.LINE_AA)

        # כתיבת הפריים לוידאו החדש
        out.write(frame)

        if len(trail) % 50 == 0:
            curr_frame = int(cap.get(cv2.CAP_PROP_POS_FRAMES))
            print(f"Processed {curr_frame}/{total_frames} frames...")

    # שחרור משאבים
    cap.release()
    out.write(frame) # פריים אחרון
    out.release()
    print(f"\nSuccess! Video saved at: {OUTPUT_PATH}")

if __name__ == "__main__":
    main()