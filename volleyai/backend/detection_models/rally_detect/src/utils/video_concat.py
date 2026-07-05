# src/utils/video_concat.py

import os
import subprocess
import re

def natural_sort_key(s):
    """Sorts strings containing numbers in human order (1, 2, 10 instead of 1, 10, 2)."""
    return [int(text) if text.isdigit() else text.lower() for text in re.split('([0-9]+)', s)]

def concat_videos_in_folder(folder_path, output_filename="final_output.mp4", extension=".mp4"):
    # 1. Gather and sort the video files
    video_files = [f for f in os.listdir(folder_path) if f.endswith(extension)]
    video_files.sort(key=natural_sort_key)

    if not video_files:
        print(f"No files with extension {extension} found in {folder_path}")
        return

    # 2. Create the temporary 'inputs.txt' file FFmpeg needs
    # Using absolute paths to avoid issues with working directories
    list_file_path = os.path.join(folder_path, "ffmpeg_list.txt")
    
    with open(list_file_path, "w", encoding="utf-8") as f:
        for file_name in video_files:
            # Escape single quotes for FFmpeg's format
            escaped_name = file_name.replace("'", "'\\''")
            f.write(f"file '{escaped_name}'\n")

    # 3. Build the FFmpeg command
    # -f concat: use the concat demuxer
    # -safe 0: allows the use of absolute paths
    # -c copy: stream copy (no re-encoding)
    output_path = os.path.join(folder_path, output_filename)
    
    cmd = [
        "ffmpeg", "-y",             # Overwrite output if it exists
        "-f", "concat",             # Format: concat demuxer
        "-safe", "0",                # Required for absolute/unusual paths
        "-i", list_file_path,       # Input list
        "-c", "copy",               # Copy codecs (lossless and fast)
        output_path
    ]

    # 4. Execute
    try:
        print(f"Concatenating {len(video_files)} files...")
        subprocess.run(cmd, check=True, capture_output=True)
        print(f"Success! Video saved as: {output_path}")
    except subprocess.CalledProcessError as e:
        print(f"Error during FFmpeg execution: {e.stderr.decode()}")
    finally:
        # Clean up the temporary text file
        if os.path.exists(list_file_path):
            os.remove(list_file_path)

if __name__ == "__main__":
    # Change this to your video folder path
    target_folder = r"C:\Users\morde\Desktop\projects\volleyball cv\data\input_videos\vs_south_out\videos\cuts"
    concat_videos_in_folder(target_folder)