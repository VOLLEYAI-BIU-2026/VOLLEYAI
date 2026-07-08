
"""
extract_scoreboard_frames.py
===================================================================
Sample frames from match video(s) and crop to the scoreboard ROI
(assumed fixed, far-left corner). Output = images ready to upload
to Roboflow for annotation.

Usage:
    # 1) First, PREVIEW the crop on one frame and tune the ROI:
    python extract_scoreboard_frames.py match.mp4 --preview

    # 2) When the box looks right, extract the dataset:
    python extract_scoreboard_frames.py match.mp4 -o frames/ --every 1.5

    # Multiple videos into the same output folder:
    python extract_scoreboard_frames.py game1.mp4 game2.mp4 -o frames/

Requires: opencv-python   (pip install opencv-python)
"""

import cv2
import os
import argparse

# ------------------------------------------------------------------
# ROI as FRACTIONS of frame size, so it works at any resolution.
# Default = far-left corner, loose box (not tight on the digits).
# Tune with --preview until the box comfortably contains the board
# with a little margin for camera shake.
# ------------------------------------------------------------------
ROI_X = 0.15   # left edge   (fraction of width)
ROI_Y = 0.05   # top edge     (fraction of height)
ROI_W = 0.10   # width        (fraction of width)
ROI_H = 0.10   # height       (fraction of height)


def roi_pixels(frame):
    h, w = frame.shape[:2]
    x1 = int(ROI_X * w)
    y1 = int(ROI_Y * h)
    x2 = int((ROI_X + ROI_W) * w)
    y2 = int((ROI_Y + ROI_H) * h)
    return x1, y1, x2, y2


def preview(video_path):
    """Save one full frame with the ROI drawn, plus the crop, to check the box."""
    cap = cv2.VideoCapture(video_path)
    cap.set(cv2.CAP_PROP_POS_FRAMES, int(cap.get(cv2.CAP_PROP_FRAME_COUNT) * 0.3))
    ok, frame = cap.read()
    cap.release()
    if not ok:
        print("Could not read a frame."); return
    x1, y1, x2, y2 = roi_pixels(frame)
    marked = frame.copy()
    cv2.rectangle(marked, (x1, y1), (x2, y2), (0, 0, 255), 3)
    cv2.imwrite("preview_full.jpg", marked)
    cv2.imwrite("preview_crop.jpg", frame[y1:y2, x1:x2])
    print("Wrote preview_full.jpg (ROI drawn) and preview_crop.jpg (the crop).")
    print(f"ROI pixels: ({x1},{y1}) -> ({x2},{y2}).  Adjust ROI_* at top if needed.")


def crop_changed(prev_small, cur_small, thresh):
    """True if the scoreboard crop differs enough from the last saved one."""
    if prev_small is None:
        return True
    diff = cv2.absdiff(prev_small, cur_small).mean()
    return diff > thresh


def extract(video_paths, out_dir, every_seconds, upscale, dedup_thresh):
    """
    Sample every `every_seconds`, but only SAVE a crop when it differs from
    the last saved crop by more than `dedup_thresh` (mean pixel difference on
    a small grayscale version). This keeps ~one frame per score change and
    skips the long identical stretches -> mostly-unique numbers to annotate.
    Set dedup_thresh=0 to disable and save every time-sample.
    """
    os.makedirs(out_dir, exist_ok=True)
    total = 0
    for vp in video_paths:
        cap = cv2.VideoCapture(vp)
        fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        step = max(1, int(round(fps * every_seconds)))
        name = os.path.splitext(os.path.basename(vp))[0]
        idx, saved, seen = 0, 0, 0
        prev_small = None
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if idx % step == 0:
                x1, y1, x2, y2 = roi_pixels(frame)
                crop = frame[y1:y2, x1:x2]
                # small grayscale signature for change detection
                small = cv2.cvtColor(cv2.resize(crop, (64, 48)), cv2.COLOR_BGR2GRAY)
                seen += 1
                if crop_changed(prev_small, small, dedup_thresh):
                    prev_small = small
                    out = crop
                    if upscale > 1:
                        out = cv2.resize(crop, None, fx=upscale, fy=upscale,
                                         interpolation=cv2.INTER_CUBIC)
                    cv2.imwrite(f"{out_dir}/{name}_f{idx:07d}.jpg", out)
                    saved += 1
            idx += 1
        cap.release()
        print(f"{vp}: checked {seen} samples, saved {saved} unique-ish crops.")
        total += saved
    print(f"Total: {total} crops in {out_dir}/  (tune --dedup if too many/few)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("videos", nargs="+", help="video file(s)")
    ap.add_argument("-o", "--out", default="frames", help="output folder")
    ap.add_argument("--every", type=float, default=1.5,
                    help="seconds between sampled frames (default 1.5)")
    ap.add_argument("--upscale", type=float, default=2.0,
                    help="upscale crop factor to enlarge digits (default 2x)")
    ap.add_argument("--dedup", type=float, default=3.0,
                    help="skip crops that barely changed from the last saved one "
                         "(mean pixel diff; higher = fewer, more-different frames; "
                         "0 disables). Default 3.0")
    ap.add_argument("--preview", action="store_true",
                    help="just write a preview of the ROI and exit")
    args = ap.parse_args()

    if args.preview:
        preview(args.videos[0])
    else:
        extract(args.videos, args.out, args.every, args.upscale, args.dedup)