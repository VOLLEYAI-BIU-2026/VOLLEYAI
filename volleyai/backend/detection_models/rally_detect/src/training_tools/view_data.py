import cv2
import os
import glob

# --- CONFIGURATION ---
# Paths to your YOLO formatted dataset
IMAGE_FOLDER = r'yolo_dataset_hard_data_v3\images'
LABEL_FOLDER = r'yolo_dataset_hard_data_v3\labels'
CLASSES = ['volleyball'] 
# ---------------------

# Global state for mouse interaction and persistent editing
drawing = False
ix, iy = -1, -1
current_rect = None
last_rect = None  # Remembers the last drawn block for batch processing

def get_data():
    """Retrieves and sorts all image paths from the dataset folder."""
    image_paths = []
    for ext in ['*.jpg', '*.jpeg', '*.png']:
        image_paths.extend(glob.glob(os.path.join(IMAGE_FOLDER, ext)))
    return sorted(image_paths)

def draw_boxes(image, label_path):
    """
    Parses a YOLO .txt file and draws green bounding boxes on the image.
    
    Args:
        image (ndarray): The source image.
        label_path (str): Path to the YOLO label file.
    """
    h, w, _ = image.shape
    if not os.path.exists(label_path):
        return image
    
    with open(label_path, 'r', encoding='utf-8') as f:
        for line in f.readlines():
            parts = line.split()
            if len(parts) < 5: continue
            # Convert normalized YOLO [center_x, center_y, width, height] to pixel coordinates
            cls, x, y, nw, nh = map(float, parts)
            x1 = int((x - nw/2) * w)
            y1 = int((y - nh/2) * h)
            x2 = int((x + nw/2) * w)
            y2 = int((y + nh/2) * h)
            cv2.rectangle(image, (x1, y1), (x2, y2), (0, 255, 0), 2)
    return image

def handle_click(event, x, y, flags, param):
    """OpenCV Mouse Callback for drawing removal rectangles."""
    global ix, iy, drawing, current_rect
    if event == cv2.EVENT_LBUTTONDOWN:
        drawing = True
        ix, iy = x, y
    elif event == cv2.EVENT_MOUSEMOVE:
        if drawing:
            current_rect = (ix, iy, x, y)
    elif event == cv2.EVENT_LBUTTONUP:
        drawing = False
        current_rect = (ix, iy, x, y)
        param['action_pending'] = True # Triggers process_removal in main loop

def process_removal(img_path, label_path, rect):
    """
    Physically blacks out a region of the image and deletes labels within that region.
    
    This is useful for 'Negative Mining'—removing false positives that confuse the model.
    """
    global last_rect
    x1, y1, x2, y2 = rect
    # Ensure coordinates are sorted regardless of drag direction
    rx1, rx2 = sorted([x1, x2])
    ry1, ry2 = sorted([y1, y2])

    # Cache this rect so it can be 're-applied' to the next frame with 'R'
    last_rect = (rx1, ry1, rx2, ry2)

    # 1. Modify the Image: Paint a solid black rectangle over the noise
    img = cv2.imread(img_path)
    if img is None: return
    cv2.rectangle(img, (rx1, ry1), (rx2, ry2), (0, 0, 0), -1)
    cv2.imwrite(img_path, img)

    # 2. Modify the Label: Filter out any YOLO boxes whose center is inside the black block
    if os.path.exists(label_path):
        h, w, _ = img.shape
        remaining_labels = []
        with open(label_path, 'r') as f:
            lines = f.readlines()
        for line in lines:
            parts = line.split()
            if len(parts) < 5: continue
            cls, x, y, nw, nh = map(float, parts)
            px, py = x * w, y * h
            # Keep labels only if their center point is OUTSIDE the blocked area
            if not (rx1 <= px <= rx2 and ry1 <= py <= ry2):
                remaining_labels.append(line)
        with open(label_path, 'w') as f:
            f.writelines(remaining_labels)
    print(f"Applied block at {last_rect}")

def main():
    """
    The main review loop. Allows navigation through the dataset and 
    provides tools for cleaning up detection noise.
    """
    global current_rect, last_rect, drawing
    images = get_data()
    idx = 0
    
    cv2.namedWindow("Dataset Reviewer")
    state = {'action_pending': False}
    cv2.setMouseCallback("Dataset Reviewer", handle_click, state)

    print("\nCONTROLS:")
    print("  'D' / 'A'          : Next/Prev Image")
    print("  'Click & Drag'     : Draw Black Block (Removes data)")
    print("  'R'                : Re-apply last block (Fix same spot in next frame)")
    print("  'X'                : Delete Image & Label completely")
    print("  'Q'                : Quit\n")

    while idx < len(images):
        img_path = images[idx]
        label_path = os.path.join(LABEL_FOLDER, os.path.splitext(os.path.basename(img_path))[0] + '.txt')
        
        # Handle edits triggered by mouse release
        if state['action_pending'] and current_rect:
            process_removal(img_path, label_path, current_rect)
            state['action_pending'] = False
            current_rect = None

        img = cv2.imread(img_path)
        if img is None: 
            idx += 1
            continue

        display_img = img.copy()
        display_img = draw_boxes(display_img, label_path)
        
        # Draw a preview of the rectangle while the user is still dragging
        if drawing and current_rect:
            cv2.rectangle(display_img, (current_rect[0], current_rect[1]), 
                          (current_rect[2], current_rect[3]), (255, 255, 255), 1)

        # UI Overlay: Progress and Tips
        info = f"[{idx + 1}/{len(images)}] {os.path.basename(img_path)}"
        cv2.putText(display_img, info, (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2)
        if last_rect:
            cv2.putText(display_img, "Press 'R' to re-apply last block", (10, 60), 
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 0), 2)

        cv2.imshow("Dataset Reviewer", display_img)
        key = cv2.waitKeyEx(1)

        # KEYBOARD LOGIC
        if key == ord('r'):
            if last_rect: process_removal(img_path, label_path, last_rect)
        elif key == ord('d') or key == 2555904: # Right Arrow
            idx = min(len(images) - 1, idx + 1)
        elif key == ord('a') or key == 2424832: # Left Arrow
            idx = max(0, idx - 1)
        elif key == ord('x'): # Delete bad image-label pair
            if os.path.exists(img_path): os.remove(img_path)
            if os.path.exists(label_path): os.remove(label_path)
            images.pop(idx)
            if idx >= len(images): idx = len(images) - 1
        elif key == ord('q') or key == 27:
            break

    cv2.destroyAllWindows()

if __name__ == "__main__":
    main()