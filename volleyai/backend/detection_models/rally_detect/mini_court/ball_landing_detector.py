"""
ball_landing_detector.py — 2D ball landing detection for volleyball.

No 3D. No depth estimation. No y-pixel thresholds.
Landing detection is based solely on ball trajectory over multiple frames.
Court side is determined via CourtCalibrator (2D homography).
"""

from __future__ import annotations

_IDLE       = 0
_DESCENDING = 1
_CONFIRMING = 2   # descent confirmed, waiting for bounce / disappearance


class BallLandingDetector:
    """
    Feed one ball detection (or None) per frame via update().
    Returns a landing event dict when a landing is confirmed, else None.

    Detection input format:
        {"x": float, "y": float, "w": float, "h": float, "confidence": float}

    The landing point used is ball_bottom:
        bx = x + w / 2
        by = y + h          ← bottom of the bounding box

    Landing logic (state machine):
      IDLE → (min_drop_frames consecutive frames with by increasing,
               total rise >= min_drop_pixels) → DESCENDING
      DESCENDING → (ball starts going up for confirm_up_frames)  → emit + reset
      DESCENDING → (ball disappears for confirm_miss_frames)     → emit + reset
      Any state → (ball missing for > 20 frames)                 → reset to IDLE

    The emitted event contains court coordinates from CourtCalibrator.transform(),
    which does the 2D homography projection — never raw pixel y.
    """

    def __init__(
        self,
        calibrator=None,
        min_drop_frames: int    = 4,
        min_drop_pixels: float  = 18.0,
        confirm_up_frames: int  = 2,
        confirm_miss_frames: int = 5,
        cooldown_frames: int    = 45,
    ):
        """
        calibrator       — CourtCalibrator instance, or None (landing still detected,
                           but court_position=null and landed_side="unknown")
        min_drop_frames  — consecutive descending frames required to start a descent
        min_drop_pixels  — minimum total pixel drop (ball_bottom_y) for a valid descent
        confirm_up_frames — upward frames needed to confirm a bounce landing
        confirm_miss_frames — missing frames after descent that confirm a landing
        cooldown_frames  — minimum gap between two events (prevents double-fire)
        """
        self.cal                 = calibrator
        self.min_drop_frames     = min_drop_frames
        self.min_drop_pixels     = min_drop_pixels
        self.confirm_up_frames   = confirm_up_frames
        self.confirm_miss_frames = confirm_miss_frames
        self.cooldown_frames     = cooldown_frames

        self._last_event_frame = -(cooldown_frames + 1)
        self._reset()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def update(self, frame_idx: int, detection: dict | None) -> dict | None:
        """
        Call once per frame in order.

        detection = {"x", "y", "w", "h", "confidence"} or None.
        Returns a landing event dict when a landing is confirmed, else None.
        """
        if detection is not None:
            self._miss_streak = 0
            self._ingest(frame_idx, detection)
            if not self._in_cooldown(frame_idx):
                return self._check_bounce()
        else:
            self._miss_streak += 1
            if not self._in_cooldown(frame_idx):
                event = self._check_disappear(frame_idx)
                if event:
                    return event
            # Long absence — full reset
            if self._miss_streak > 20:
                self._reset()

        return None

    # ------------------------------------------------------------------
    # State machine
    # ------------------------------------------------------------------

    def _reset(self):
        self._state      = _IDLE
        self._start_by   = None    # by at the first frame of the current descent
        self._valley     = None    # {"frame","bx","by","conf"} — deepest point so far
        self._desc_count = 0       # consecutive downward frames seen
        self._up_count   = 0       # consecutive upward frames (CONFIRMING only)
        self._miss_streak = 0
        self._last_by    = None    # last seen ball_bottom_y

    def _in_cooldown(self, frame_idx: int) -> bool:
        return (frame_idx - self._last_event_frame) < self.cooldown_frames

    def _ingest(self, frame_idx: int, detection: dict):
        bx   = float(detection["x"]) + float(detection["w"]) / 2.0
        by   = float(detection["y"]) + float(detection["h"])   # ball bottom
        conf = float(detection.get("confidence", 1.0))
        pos  = {"frame": frame_idx, "bx": bx, "by": by, "conf": conf}

        if self._state == _IDLE:
            self._start_by   = by
            self._valley     = pos
            self._desc_count = 1
            self._up_count   = 0
            self._last_by    = by
            self._state      = _DESCENDING

        elif self._state == _DESCENDING:
            if by > self._last_by:           # going further down ↓
                self._desc_count += 1
                if by > self._valley["by"]:
                    self._valley = pos
                self._last_by = by
            elif by < self._last_by:         # going up ↑ — start CONFIRMING
                self._up_count = 1
                self._last_by  = by
                self._state    = _CONFIRMING
            # by == last_by: flat — ignore, stay in state

        elif self._state == _CONFIRMING:
            if by < self._last_by:           # still going up ↑
                self._up_count += 1
                self._last_by   = by
            elif by > self._last_by:         # going down again ↓
                if by > self._valley["by"]:
                    self._valley = pos
                self._desc_count += 1
                self._up_count   = 0
                self._last_by    = by
                self._state      = _DESCENDING
            # flat: stay in CONFIRMING

    # ------------------------------------------------------------------
    # Confirmation checks
    # ------------------------------------------------------------------

    def _check_bounce(self) -> dict | None:
        """Emit landing if bounce is confirmed (enough upward frames)."""
        if self._state != _CONFIRMING:
            return None
        if self._up_count < self.confirm_up_frames:
            return None
        if not self._valid_descent():
            self._reset()
            return None
        event = self._emit()
        self._reset()
        return event

    def _check_disappear(self, frame_idx: int) -> dict | None:
        """Emit landing if ball disappeared after a valid descent."""
        if self._state not in (_DESCENDING, _CONFIRMING):
            return None
        if self._miss_streak < self.confirm_miss_frames:
            return None
        if not self._valid_descent():
            self._reset()
            return None
        event = self._emit()
        self._reset()
        return event

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _valid_descent(self) -> bool:
        if self._valley is None or self._start_by is None:
            return False
        if self._desc_count < self.min_drop_frames:
            return False
        if (self._valley["by"] - self._start_by) < self.min_drop_pixels:
            return False
        return True

    def _emit(self) -> dict | None:
        """Build and return the structured landing event."""
        if self._valley is None:
            return None

        bx, by = self._valley["bx"], self._valley["by"]
        self._last_event_frame = self._valley["frame"]

        # Without calibration: save raw landing with unknown side (no scoring)
        if self.cal is None or not self.cal.is_ready():
            return {
                "event":            "ball_landing",
                "frame":            self._valley["frame"],
                "video_position":   [round(bx, 2), round(by, 2)],
                "court_position":   None,
                "landed_side":      "unknown",
                "confidence":       round(self._valley["conf"], 3),
                "calibration_type": None,
            }

        court = self.cal.transform(bx, by)
        return {
            "event":            "ball_landing",
            "frame":            self._valley["frame"],
            "video_position":   [round(bx, 2), round(by, 2)],
            "court_position":   [round(court["court_x"], 4), round(court["court_y"], 4)],
            "landed_side":      court["side"],   # "my_team" / "opponent" / "outside"
            "confidence":       round(self._valley["conf"], 3),
            "calibration_type": "2d_near_side_homography",
        }
