import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import "./VideoAnalysis.css";

const API = "https://volleyai.onrender.com";

function formatTime(sec) {
  const total = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function VideoAnalysis() {
  const { videoId } = useParams();
  const navigate = useNavigate();
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const pollRef = useRef(null);

  const [videoSrc, setVideoSrc] = useState("");
  const [status, setStatus] = useState("none");
  const [error, setError] = useState("");
  const [rallies, setRallies] = useState([]);
  const [points, setPoints] = useState([]);
  const [selectedRallyId, setSelectedRallyId] = useState(null);
  const [optimizedMode, setOptimizedMode] = useState(false);

  useEffect(() => {
    init();

    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [videoId]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    function onTimeUpdate() {
      drawBallOverlay();

      if (!optimizedMode || !rallies.length) return;

      const t = video.currentTime;
      const currentRally = rallies.find((r) => t >= r.start && t <= r.end);

      if (!currentRally) {
        const nextRally = rallies.find((r) => r.start > t);
        if (nextRally) {
          video.currentTime = nextRally.start;
        }
      }
    }

    function onSeeked() {
      drawBallOverlay();
    }

    function onLoadedMetadata() {
      resizeCanvas();
      drawBallOverlay();
    }

    window.addEventListener("resize", resizeCanvas);
    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("seeked", onSeeked);
    video.addEventListener("loadedmetadata", onLoadedMetadata);

    return () => {
      window.removeEventListener("resize", resizeCanvas);
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
    };
  }, [optimizedMode, rallies, points]);

  async function init() {
    try {
      const videoRes = await fetch(`${API}/videos/${videoId}`, {
        credentials: "include",
      });
      const videoData = await videoRes.json();

      if (videoRes.ok && videoData?.video?.filePath) {
        const src = `${API}${videoData.video.filePath}`;
        setVideoSrc(src);
      }

      const analysis = await fetchBallAnalysis();

      if (analysis.status === "none") {
        await startBallAnalysis();
        schedulePoll();
      } else if (analysis.status === "processing") {
        applyAnalysis(analysis);
        schedulePoll();
      } else {
        applyAnalysis(analysis);
      }
    } catch (e) {
      setError("Failed to initialize video analysis.");
    }
  }

  async function fetchBallAnalysis() {
    const res = await fetch(`${API}/videos/${videoId}/ball-analysis`, {
      credentials: "include",
      cache: "no-store",
    });
    const data = await res.json();
    return data;
  }

  async function startBallAnalysis() {
    const res = await fetch(`${API}/videos/${videoId}/analyze-ball`, {
      method: "POST",
      credentials: "include",
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok && res.status !== 202) {
      throw new Error(data.message || "Failed to start ball analysis");
    }
  }

  function schedulePoll() {
    if (pollRef.current) clearTimeout(pollRef.current);

    pollRef.current = setTimeout(async () => {
      try {
        const data = await fetchBallAnalysis();
        applyAnalysis(data);

        if (data.status === "processing") {
          schedulePoll();
        }
      } catch (e) {
        setError("Polling failed.");
      }
    }, 2500);
  }

  function applyAnalysis(data) {
    setStatus(data.status || "none");
    setError(data.error || "");
    setRallies(data.rallies || []);
    setPoints(data.points || []);
  }

  function jumpToRally(rally) {
    if (!videoRef.current) return;
    setSelectedRallyId(rally.rallyId);
    videoRef.current.currentTime = rally.start;
    videoRef.current.play();
    drawBallOverlay();
  }

  function resizeCanvas() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    const rect = video.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
  }

  function drawBallOverlay() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !points.length) return;

    resizeCanvas();

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const currentTime = video.currentTime;

    const recentPoints = points.filter(
      (p) => Math.abs((p.time || 0) - currentTime) <= 1.2
    );

    if (!recentPoints.length) return;

    const videoW = video.videoWidth || 1;
    const videoH = video.videoHeight || 1;

    const sx = canvas.width / videoW;
    const sy = canvas.height / videoH;

    ctx.lineWidth = 3;
    ctx.strokeStyle = "#ff4d4f";
    ctx.fillStyle = "#ff4d4f";

    for (let i = 0; i < recentPoints.length; i++) {
      const p = recentPoints[i];
      const x = p.x * sx;
      const y = p.y * sy;

      ctx.beginPath();
      ctx.arc(x, y, Math.max(4, (p.radius || 4) * ((sx + sy) / 2) * 0.5), 0, Math.PI * 2);
      ctx.fill();

      if (i > 0) {
        const prev = recentPoints[i - 1];
        const px = prev.x * sx;
        const py = prev.y * sy;

        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(x, y);
        ctx.stroke();
      }
    }
  }

  return (
    <div className="va-page">
      <div className="va-topbar">
        <div className="va-topbarLeft">
          <button className="va-backBtn" type="button" onClick={() => navigate(-1)}>
            ←
          </button>

          <div className="va-titleWrap">
            <div className="va-breadcrumb">Video / Analysis</div>
            <h1 className="va-title">Video Analysis</h1>
          </div>
        </div>

        <div className="va-actions">
          <button
            className={`va-actionBtn ${optimizedMode ? "primary" : ""}`}
            type="button"
            onClick={() => setOptimizedMode((v) => !v)}
          >
            {optimizedMode ? "Optimized Mode On" : "Optimized Mode Off"}
          </button>

          <button
            className="va-actionBtn"
            type="button"
            onClick={() => navigate(`/teams-roster/${videoId}`)}
          >
            Continue
          </button>
        </div>
      </div>

      <div className="va-layout">
        <div className="va-main">
          <div className="va-toolbar">
            <div className="va-toolbarLeft">
              <button className="va-chipBtn active" type="button">
                Rallies
              </button>
              <button className="va-chipBtn" type="button">
                Ball Track
              </button>
            </div>

            <div className="va-status">
              {status === "processing"
                ? "Analyzing ball movement and building rallies..."
                : status === "done"
                ? `${rallies.length} rallies found`
                : status === "failed"
                ? "Analysis failed"
                : "Waiting to start"}
            </div>
          </div>

          <div className="va-videoCard">
            <div className="va-videoWrap" style={{ position: "relative" }}>
              {videoSrc ? (
                <>
                  <video
                    ref={videoRef}
                    src={videoSrc}
                    controls
                    className="va-video"
                    onLoadedMetadata={drawBallOverlay}
                    onPlay={drawBallOverlay}
                    onPause={drawBallOverlay}
                  />
                  <canvas
                    ref={canvasRef}
                    style={{
                      position: "absolute",
                      inset: 0,
                      width: "100%",
                      height: "100%",
                      pointerEvents: "none",
                    }}
                  />
                </>
              ) : (
                <div className="va-empty">Loading video...</div>
              )}
            </div>

            <div className="va-overlayHint">
              Red points and lines show the detected ball trajectory around the current playback time.
            </div>
          </div>

          {status === "processing" && (
            <div className="va-message">
              Analyzing ball movement and removing dead time...
            </div>
          )}

          {status === "failed" && (
            <div className="va-message error">{error || "Ball analysis failed."}</div>
          )}
        </div>

        <aside className="va-side">
          <div className="va-sideHeader">
            <div>
              <div className="va-sideTitle">Rallies</div>
              <div className="va-sideSub">
                {status === "done" ? `${rallies.length} detected` : "Building rally list..."}
              </div>
            </div>
          </div>

          <div className="va-rallyList">
            {!rallies.length ? (
              <div className="va-empty">
                {status === "processing" ? "Building rally list..." : "No rallies yet"}
              </div>
            ) : (
              rallies.map((rally) => (
                <button
                  key={rally.rallyId}
                  className={`va-rallyCard ${selectedRallyId === rally.rallyId ? "active" : ""}`}
                  onClick={() => jumpToRally(rally)}
                  type="button"
                >
                  <div className="va-rallyTime">
                    {formatTime(rally.start)} - {formatTime(rally.end)}
                  </div>
                  <div className="va-rallyLabel">{rally.label}</div>
                </button>
              ))
            )}
          </div>

          <div className="va-footerNote">
            Optimized mode skips inactive gaps between rallies during playback.
          </div>
        </aside>
      </div>
    </div>
  );
}