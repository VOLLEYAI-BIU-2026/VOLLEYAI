import argparse
import sys
import os
import traceback

# Utility for relative-to-absolute path resolution
from src.utils.utils import get_resource_path
# The new centralized pipeline manager
from src.pipeline.manager import run_volleyball_pipeline

def main():
    """
    Main entry point for the Volleyball Rally Analytics CLI.
    This script parses user arguments and delegates the execution to the 
    centralized Pipeline Manager.
    """
    STAGES = ["detection", "tracking", "cleaning", "features", "prediction", "visualization"]

    parser = argparse.ArgumentParser(description="Volleyball Rally Analytics CLI")

    # --- INPUT ARGUMENTS ---
    parser.add_argument("--video_path", type=str, help="Path to input video.")
    parser.add_argument("--input_csv", type=str, help="Path to a CSV file to resume from (detections, tracks, or cleaned).")
    parser.add_argument("--start_at", type=str, choices=STAGES, default="detection", 
                        help="Stage to start from. Use with --input_csv if not starting at detection.")

    # --- CONFIGURATION ARGUMENTS ---
    parser.add_argument("--rf_model", type=str, default="v3", help="Version of the RF model (v1-v4).")
    parser.add_argument("--device", type=str, default="cpu", help="Hardware device (cpu, cuda, intel:gpu).")
    parser.add_argument("--stop_at", type=str, choices=STAGES, default="visualization", 
                        help="Stage after which to terminate execution.")
    
    # --- TRIMMING ARGUMENTS ---
    parser.add_argument("--start_time", type=str, default="", help="Start time for trim (HH:MM:SS).")
    parser.add_argument("--end_time", type=str, default="", help="End time for trim (HH:MM:SS).")

    # --- VISUALIZATION & OUTPUT ---
    parser.add_argument("--viz_early", action="store_true", help="Render video even if stopping early.")
    parser.add_argument("--viz_type", type=str, default="both", 
                        help="Visual overlay style: 'cut', 'both', 'tracking', 'predictions', or 'all'.")
    parser.add_argument("--keep_all", action="store_true", help="Move intermediate CSVs to output directory.")
    parser.add_argument("--output_dir", type=str, default="./output", help="Root directory for outputs.")

    args = parser.parse_args()

    # 1. Validate Inputs
    if not args.video_path and not args.input_csv:
        print("Error: You must provide either a --video_path or an --input_csv.")
        sys.exit(1)

    # 2. Map CLI arguments to the Pipeline Config dictionary
    # This structure matches what run_volleyball_pipeline expects
    pipeline_config = {
        'video_path': args.video_path,
        'input_csv_path': args.input_csv,
        'start_at': args.start_at,
        'stop_at': args.stop_at,
        'rf_model_ver': args.rf_model,
        'device': args.device,
        'start_time': args.start_time,
        'end_time': args.end_time,
        'viz_early': args.viz_early,
        'viz_type': args.viz_type,
        'keep_all': args.keep_all,
        'output_dir': args.output_dir
    }

    # 3. Simple logger for CLI output
    def cli_logger(message):
        print(f"[PIPELINE] {message}")

    # 4. Execute the Pipeline
    try:
        print("\n--- Initializing Volleyball Analytics Pipeline ---")
        success, output_file = run_volleyball_pipeline(pipeline_config, cli_logger)
        
        if success:
            print(f"\nPipeline completed successfully!")
            print(f"Final Output: {output_file}")
            
    except Exception as e:
        print(f"\n[CRITICAL ERROR] Pipeline failed: {str(e)}")
        traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    main()