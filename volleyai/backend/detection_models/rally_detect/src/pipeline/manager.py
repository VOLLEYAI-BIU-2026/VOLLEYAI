# src/pipeline/manager.py

import os
import shutil
import yaml
import pandas as pd
from src.utils import get_resource_path, ensure_30fps, trim_video 
from src.ball_detector import get_ball_detections, track_with_physics_predictive, clean_noise
from src.rally_predictor import extract_features,predict_rallies,analyze_rally_stats,smooth_predictions
from src.visualizer import visualize

def run_volleyball_pipeline(config, log_callback, progress_callback=None):
    """
    Executes the volleyball analytics pipeline with support for 
    modular entry/exit points and visualization control.
    """
    STAGES = ["detection", "tracking", "cleaning", "features", "prediction", "visualization"]
    
    # Map start/stop names to indices for logical comparison
    start_idx = STAGES.index(config.get('start_at', 'detection'))
    stop_idx = STAGES.index(config.get('stop_at', 'visualization'))

    # 1. SETUP WORKSPACE
    out_dir = config['output_dir']
    temp_dir = os.path.join(out_dir, "temp")
    table_data_dir = os.path.join(out_dir, "table_data")
    video_out_dir = os.path.join(out_dir, "videos")
    
    for d in [temp_dir, table_data_dir, video_out_dir]: 
        os.makedirs(d, exist_ok=True)

    # Resolve input source and base name
    input_source = config['input_csv_path'] if start_idx > 0 else config['video_path']
    if not input_source:
        raise ValueError("Missing input source. Provide a video or a starting CSV.")
        
    base_name = os.path.basename(input_source).rsplit('.', 1)[0]
    working_video = config['video_path']

    # 2. DEFINE DATA FLOW PATHS
    # If we skip a stage, we use the custom input CSV for that stage's requirement
    fn_detections = config['input_csv_path'] if config['start_at'] == "tracking" else os.path.join(temp_dir, f"{base_name}_detections.csv")
    fn_tracks = config['input_csv_path'] if config['start_at'] == "cleaning" else os.path.join(temp_dir, f"{base_name}_tracks.csv")
    fn_clean = config['input_csv_path'] if config['start_at'] == "features" else os.path.join(temp_dir, f"{base_name}_cleaned.csv")
    
    fn_features = os.path.join(temp_dir, f"{base_name}_features.csv")
    fn_predictions = os.path.join(temp_dir, f"{base_name}_predictions.csv")
    final_video_output = os.path.join(video_out_dir, f"{base_name}_{config['stop_at']}.mp4")

    # 3. LOAD MODEL CONFIGS
    rf_model_config_path = get_resource_path(os.path.join("models", "rally_prediction", "config.yaml"))
    with open(rf_model_config_path, 'r') as f:
        rf_configs = yaml.safe_load(f)["models"]
    
    rf_info = rf_configs.get(config['rf_model_ver'], {})
    rf_path = get_resource_path(rf_info.get("path", f"models/rally_prediction/rally_predictor_rf_{config['rf_model_ver']}.pkl"))
    feature_params = rf_info.get("feature_extraction", {})

    # Helper function to check if a stage should be executed
    def should_run(stage):
        idx = STAGES.index(stage)
        return start_idx <= idx <= stop_idx

    # --- PIPELINE EXECUTION ---

    # Stage: Detection
    if should_run("detection"):
        log_callback("--- Running Stage: Detection ---")
        proc_path = os.path.join(temp_dir, f"proc_{base_name}.mp4")
        working_video = trim_video(working_video, proc_path, config['start_time'], config['end_time'], log_callback)
        
        proc_fps_path = os.path.join(temp_dir, f"proc_30fps_{base_name}.mp4")
        working_video = ensure_30fps(working_video, proc_fps_path, log_callback)

        get_ball_detections(
            model_path = ("/home/jesicemal/project/VOLLEYAI/volleyai/backend/detection_models/ball_tracking/ball_model.pt"), 
            video_path=working_video, 
            output_csv=fn_detections, 
            device=config['device'],
            log_callback=log_callback,
            progress_callback=progress_callback
        )

    # Stage: Tracking
    if should_run("tracking"):
        log_callback("--- Running Stage: Tracking ---")
        track_with_physics_predictive(input_csv=fn_detections, output_csv=fn_tracks)

    # Stage: Cleaning
    if should_run("cleaning"):
        log_callback("--- Running Stage: Cleaning ---")
        clean_noise(tracking_csv=fn_tracks, output_csv=fn_clean)

    # Stage: Features
    if should_run("features"):
        log_callback("--- Running Stage: Features ---")
        extract_features(
            input_csv=fn_clean, 
            output_csv=fn_features, 
            window_size=feature_params.get("window_size", 60),
            interpolation_size=feature_params.get("interpolation_size", 60)
        )

    # Stage: Prediction
    if should_run("prediction"):
        log_callback("--- Running Stage: Prediction ---")
        preds = predict_rallies(rf_path=rf_path, df_path=fn_features)
        preds = smooth_predictions(preds)
        pd.DataFrame({'label': preds}).to_csv(fn_predictions, index=False)
        
        stats, _ = analyze_rally_stats(preds)

        # Format the stats for a clean output
        log_callback("\n--- Rally Analysis Results ---")
        for key, value in stats.items():
            log_callback(f" • {key}: {value}")
        log_callback("------------------------------\n")

    # Stage: Visualization (Runs if it's the final stage OR if Visualize Early is checked)
    if should_run("visualization") or (config.get('viz_early') and working_video):
        log_callback(f"--- Running Stage: Visualization (Mode: {config['viz_type']}) ---")
        
        # Decide which data to overlay based on what is available
        track_file = fn_clean if os.path.exists(fn_clean) else (fn_tracks if os.path.exists(fn_tracks) else fn_detections)
        pred_file = fn_predictions if os.path.exists(fn_predictions) else None

        visualize(
            video_path=working_video, 
            output_path=final_video_output,
            tracking_csv=track_file, 
            predictions_csv=pred_file, 
            overlay_mode=config['viz_type'],
            log_callback=log_callback,
            progress_callback=progress_callback
        )

    # 4. FINALIZE
    if config['keep_all']:
        for f in [fn_detections, fn_tracks, fn_clean, fn_features, fn_predictions]:
            if os.path.exists(f) and f.startswith(temp_dir):
                shutil.move(f, os.path.join(table_data_dir, os.path.basename(f)))
    
    if os.path.exists(temp_dir):
        shutil.rmtree(temp_dir)

    return True, final_video_output