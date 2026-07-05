# Project: Automated Volleyball Match Analysis Pipeline

### **Stage 1: Detect Volleyball in Video**

* **Sub-stage 1: Train YOLOv11 Detection Model**
The model was trained using an iterative active learning pipeline:
1. Utilized **SAM3** (Segment Anything Model) on select video clips via **Kaggle** to generate initial ground-truth data.
2. Trained **YOLOv11** on the initial dataset.
3. Ran the model on longer video sequences (one full set from multiple matches).
4. Extracted "hard frames" where the ball was in view but the model failed to detect it.
5. Applied **SAM3** to these specific images (faster but less accurate than the video version) to generate new labels.
6. Retrained the model using the augmented dataset.
7. Repeated steps 2–6 three times until the model reached a high level of accuracy.


* **Sub-stage 2: Build Framework for Video Inference**
* The framework runs detection on every frame of the video.
* Results (bounding box coordinates) are saved to a **CSV** for post-processing.
* **Optimization:** To speed up inference on a local PC, the model was converted to **OpenVINO**.



### **Stage 2: Convert Detections into Tracks**

**Goal:** Distinguish active volleyball play from noise or background objects.

* Implemented logic to assign a unique **Track ID** to each detection.
* If a detection in a future frame matches specific criteria (physics-based location prediction), it is assigned to that existing track.
* To prevent a moving track from incorrectly merging with a static object (like a ball on the sideline), an `is_static` flag was implemented.

### **Stage 3: Clean Tracks**

**Goal:** Filter out non-ball tracks.

* Utilized track data to easily remove static objects (those showing low movement over time).
* Filtered out "flickering" detections caused by arms or legs (short-lived tracks with low confidence and minimal movement).
* Maintained detections of the actual ball even during high-velocity/blurry frames by prioritizing track continuity over raw confidence scores.

### **Stage 4: Feature Extraction**

**Goal:** Prepare data for Rally vs. Downtime classification.

* Interpolated small gaps in detection tracks to ensure continuity.
* Calculated movement features: **velocity**, **acceleration**, and **y-axis dominance**.
* Computed the **mean** and **max** of these features within a sliding window around each frame.

### **Stage 5: Predict Rally or Downtime**

* **Sub-stage 1: Train a Random Forest Model**
1. Developed a labeling tool to efficiently categorize frames as **Rally** or **Downtime**.
2. Labeled rallies from three different matches to ensure data diversity.
3. Processed these rallies through Stages 1–4 to generate features.
4. Split data into **Train/Validation** sets using a group-based split (rather than random) to prevent data leakage.
5. Trained the model using the `RandomForestClassifier` from **Scikit-learn**.


* **Sub-stage 2: Inference**
* Predicted states across full matches.
* Ensured consistent interpolation and window sizes between the training and inference phases.



### **Stage 6: Clean Predictions**

**Goal:** Remove temporal jitter in the Random Forest output.

* Applied a **rolling window** to smooth predictions, acknowledging that rallies and downtime periods have a logical minimum duration.
* Implemented a bias toward "Rally" states during smoothing to ensure full play coverage.
* Extracted final analytics, such as the **total number of rallies** and **average rally duration**.

### **Stage 7: Visualization**

**Goal:** Deliver a polished final output.

* **Option 1 (Automated Highlights):** Automatically trimmed the video based on rally predictions. A 1-second buffer was added before and after each rally to ensure a smooth viewing experience.
* **Option 2 (Data Overlay):** Visualized the ball tracking with bounding boxes, a "trail" of the ball’s path, and real-time velocity (pixels per frame) displayed on screen.