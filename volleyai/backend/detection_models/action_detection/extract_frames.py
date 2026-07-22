import os
import argparse
import cv2


def parse_args():
    parser = argparse.ArgumentParser(description="Extract still frames from a video at a fixed rate, for building/labeling an action-model training set")
    parser.add_argument("--video", required=True, help="Path to input video")
    parser.add_argument("--output-dir", default=None, help="Directory to write frames into (default: extracted_frames/<video_basename>_<fps>fps next to this script)")
    parser.add_argument("--fps", type=float, default=3.0, help="Target frames per second to extract")
    return parser.parse_args()


def main():
    args = parse_args()

    cap = cv2.VideoCapture(args.video)
    if not cap.isOpened():
        raise RuntimeError(f"Cannot open video: {args.video}")

    native_fps = cap.get(cv2.CAP_PROP_FPS) or 30
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
    if args.fps <= 0 or args.fps > native_fps:
        raise ValueError(f"--fps must be > 0 and <= the video's native fps ({native_fps})")

    # Evenly spaced frame indices at the target rate, computed once up front
    # (not "every Nth frame") so the extracted set stays evenly spaced across
    # the whole video even when native_fps / target_fps isn't a whole number.
    step = native_fps / args.fps
    video_basename = os.path.splitext(os.path.basename(args.video))[0]
    output_dir = args.output_dir or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "extracted_frames", f"{video_basename}_{args.fps:g}fps"
    )
    os.makedirs(output_dir, exist_ok=True)

    print(f"[EXTRACT] {args.video}: native {native_fps:.2f}fps, {total_frames} frames -> {args.fps:g}fps into {output_dir}")

    frame_idx = 0
    next_target = 0.0
    saved = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if frame_idx >= next_target:
            time_sec = frame_idx / native_fps
            out_path = os.path.join(output_dir, f"{video_basename}_frame{frame_idx:06d}_t{time_sec:07.2f}.jpg")
            cv2.imwrite(out_path, frame)
            saved += 1
            next_target += step
        frame_idx += 1

    cap.release()
    print(f"[EXTRACT] Done. Saved {saved} frames -> {output_dir}")


if __name__ == "__main__":
    main()
