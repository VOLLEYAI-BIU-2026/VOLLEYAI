import os
import cv2
import json
import numpy as np

# Court coordinate targets for the 4 calibration clicks (in order):
#   near_left  → (0.0, 1.0)  — bottom-left corner, near camera
#   near_right → (1.0, 1.0)  — bottom-right corner, near camera
#   net_left   → (0.0, 0.5)  — left end of net / centre line
#   net_right  → (1.0, 0.5)  — right end of net / centre line
#
# court_y:  1.0 = near end-line  |  0.5 = net  |  0.0 = far end-line (extrapolated)
# court_x:  0.0 = left sideline  |  1.0 = right sideline

COURT_TARGETS = np.float32([
    [0.0, 1.0],
    [1.0, 1.0],
    [0.0, 0.5],
    [1.0, 0.5],
])

POINT_LABELS = [
    "near_left  — bottom-left corner (near camera)",
    "near_right — bottom-right corner (near camera)",
    "net_left   — left end of net / centre line",
    "net_right  — right end of net / centre line",
]


class CourtCalibrator:
    """
    2-D homography calibrator for a single-side volleyball court view.
    Maps pixel coordinates → normalised court coordinates (court_x, court_y).
    No 3-D depth estimation is performed.
    """

    def __init__(self):
        self.H: np.ndarray | None = None
        self.image_points: np.ndarray | None = None
        self.court_points: np.ndarray = COURT_TARGETS.copy()

    # ------------------------------------------------------------------
    # Calibration
    # ------------------------------------------------------------------

    def calibrate_interactive(self, frame: np.ndarray) -> None:
        """Show frame in an OpenCV window; user clicks 4 points in order."""
        clicks: list[tuple[int, int]] = []
        display = frame.copy()

        # Draw instruction text on the frame
        for i, lbl in enumerate(POINT_LABELS, 1):
            cv2.putText(display, f"{i}. {lbl}",
                        (15, 30 + i * 30),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.65, (0, 200, 255), 2)
        cv2.putText(display, "Click 4 points, then press ENTER",
                    (15, 175), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)

        def _on_click(event, x, y, flags, param):
            if event == cv2.EVENT_LBUTTONDOWN and len(clicks) < 4:
                clicks.append((x, y))
                label = POINT_LABELS[len(clicks) - 1].split("—")[0].strip()
                cv2.circle(display, (x, y), 8, (0, 255, 0), -1)
                cv2.putText(display, f"{len(clicks)}: {label}",
                            (x + 10, y - 10),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 255, 0), 2)
                cv2.imshow("Court Calibration", display)
                print(f"  [{len(clicks)}] {POINT_LABELS[len(clicks) - 1]} -> pixel ({x}, {y})")

        print("\n=== Court Calibration ===")
        print("Click the following 4 points on the court (in order):")
        for i, lbl in enumerate(POINT_LABELS, 1):
            print(f"  {i}. {lbl}")
        print("Press ENTER when all 4 points are marked.\n")

        cv2.namedWindow("Court Calibration", cv2.WINDOW_NORMAL)
        cv2.setMouseCallback("Court Calibration", _on_click)
        cv2.imshow("Court Calibration", display)

        while True:
            key = cv2.waitKey(20) & 0xFF
            if key == 13 and len(clicks) == 4:   # ENTER
                break
            if key == 27:                          # ESC — abort
                cv2.destroyAllWindows()
                raise RuntimeError("Calibration aborted by user (ESC).")

        cv2.destroyAllWindows()

        self.image_points = np.float32(clicks)
        self._compute_homography()

    def _compute_homography(self) -> None:
        self.H, _ = cv2.findHomography(self.image_points, self.court_points)
        if self.H is None:
            raise ValueError(
                "cv2.findHomography failed — make sure the 4 points are not collinear."
            )

    # ------------------------------------------------------------------
    # Transformation
    # ------------------------------------------------------------------

    def transform(self, px: float, py: float) -> dict:
        """
        Map a single pixel (px, py) to court coordinates.

        Returns:
            {
                "video_x": float,
                "video_y": float,
                "court_x": float,   # 0 = left sideline, 1 = right sideline
                "court_y": float,   # 1 = near end-line, 0.5 = net, 0 = far end-line
                "side": "my_team" | "opponent" | "outside",
                "calibration_mode": "near_side_2d_homography"
            }
        """
        if self.H is None:
            raise RuntimeError(
                "No homography available. Call calibrate_interactive() or load() first."
            )

        src = np.array([[[float(px), float(py)]]], dtype=np.float32)
        dst = cv2.perspectiveTransform(src, self.H)[0][0]
        cx, cy = float(dst[0]), float(dst[1])

        if cx < 0.0 or cx > 1.0 or cy < 0.0 or cy > 1.0:
            side = "outside"
        elif cy >= 0.5:
            side = "my_team"
        else:
            side = "opponent"

        return {
            "video_x": round(float(px), 4),
            "video_y": round(float(py), 4),
            "court_x": round(cx, 4),
            "court_y": round(cy, 4),
            "side": side,
            "calibration_mode": "near_side_2d_homography",
        }

    def transform_normalized(self, x_norm: float, y_norm: float,
                              frame_w: int, frame_h: int) -> dict:
        """Convenience wrapper: accepts normalised pixel coords (0-1)."""
        return self.transform(x_norm * frame_w, y_norm * frame_h)

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def save(self, path: str) -> None:
        data = {
            "H": self.H.tolist(),
            "image_points": self.image_points.tolist(),
            "court_points": self.court_points.tolist(),
        }
        with open(path, "w") as f:
            json.dump(data, f, indent=2)
        print(f"Calibration saved -> {path}")

    def load(self, path: str) -> None:
        with open(path) as f:
            data = json.load(f)
        self.H = np.array(data["H"], dtype=np.float64)
        self.image_points = np.float32(data["image_points"])
        self.court_points = np.float32(data["court_points"])
        print(f"Calibration loaded <- {path}")

    def is_ready(self) -> bool:
        return self.H is not None

    def calibrate_from_points(self, image_points: list) -> None:
        """Compute homography from 4 [x, y] pixel points — no OpenCV window needed."""
        if len(image_points) != 4:
            raise ValueError("Exactly 4 image points are required.")
        self.image_points = np.float32(image_points)
        self._compute_homography()


# ------------------------------------------------------------------
# Helper: get-or-create calibration (used by triple_detection)
# ------------------------------------------------------------------

def get_calibrator(video_path: str, calib_json: str) -> CourtCalibrator:
    """
    Load existing calibration from calib_json, or run interactive
    calibration on the first frame of video_path and save the result.
    """
    cal = CourtCalibrator()

    if os.path.exists(calib_json):
        cal.load(calib_json)
        return cal

    cap = cv2.VideoCapture(video_path)
    ret, frame = cap.read()
    cap.release()
    if not ret:
        raise RuntimeError(f"Cannot read first frame from: {video_path}")

    cal.calibrate_interactive(frame)
    cal.save(calib_json)
    return cal


# ------------------------------------------------------------------
# CLI — standalone calibration / test
# ------------------------------------------------------------------

if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(
        description="Volleyball court calibration tool (2-D homography)"
    )
    ap.add_argument("--video",  default=None, help="Path to input video (required when not using --image-points)")
    ap.add_argument("--save",   default="court_calib.json", help="Where to save calibration JSON")
    ap.add_argument("--load",   default=None, help="Load existing calibration instead of clicking")
    ap.add_argument("--image-points", nargs=8, type=float,
                    metavar=("X1","Y1","X2","Y2","X3","Y3","X4","Y4"),
                    help="8 floats: near_left, near_right, net_left, net_right pixel coords")
    ap.add_argument("--test-pixel", nargs=2, type=float, metavar=("X", "Y"),
                    help="Test a pixel coordinate after calibration")
    args = ap.parse_args()

    cal = CourtCalibrator()

    if args.load and os.path.exists(args.load):
        cal.load(args.load)
    elif args.image_points:
        pts = [[args.image_points[i*2], args.image_points[i*2+1]] for i in range(4)]
        cal.calibrate_from_points(pts)
        cal.save(args.save)
    else:
        if not args.video:
            raise SystemExit("ERROR: --video is required when not using --image-points or --load")
        cap = cv2.VideoCapture(args.video)
        ok, frame = cap.read()
        cap.release()
        if not ok:
            raise SystemExit(f"ERROR: cannot open video: {args.video}")
        cal.calibrate_interactive(frame)
        cal.save(args.save)

    # Optional pixel test
    if args.test_pixel:
        px, py = args.test_pixel
        result = cal.transform(px, py)
        print("\nTransform result:")
        for k, v in result.items():
            print(f"  {k}: {v}")
    else:
        # Default: test the four calibration points themselves
        print("\nSanity check — transforming the 4 calibration pixels:")
        labels = ["near_left", "near_right", "net_left", "net_right"]
        for lbl, (px, py) in zip(labels, cal.image_points):
            r = cal.transform(px, py)
            print(f"  {lbl:12s} pixel({px:.0f},{py:.0f}) -> "
                  f"court({r['court_x']:.3f}, {r['court_y']:.3f})  side={r['side']}")
