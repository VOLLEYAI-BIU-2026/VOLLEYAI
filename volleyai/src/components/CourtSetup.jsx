import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import "./CourtSetup.css";

const API = "http://localhost:5000";

const POINT_LABELS = [
    "1 — פינה שמאלית קרובה (near left)",
    "2 — פינה ימנית קרובה (near right)",
    "3 — קו רשת שמאל (net left)",
    "4 — קו רשת ימין (net right)",
];

export default function CourtSetup() {
    const { videoId } = useParams();
    const navigate    = useNavigate();
    const imgRef      = useRef(null);
    const canvasRef   = useRef(null);

    const [frameUrl, setFrameUrl]       = useState(null);
    const [points, setPoints]           = useState([]);
    const [saving, setSaving]           = useState(false);
    const [error, setError]             = useState("");
    const [done, setDone]               = useState(false);
    const [frameStatus, setFrameStatus] = useState("loading"); // "loading"|"generating"|"ready"|"error"

    // Load the clean frame — trigger generation if missing
    useEffect(() => {
        if (!videoId) return;
        let pollTimer = null;

        async function load() {
            const r = await fetch(`${API}/videos/${videoId}`, { credentials: "include" });
            const d = r.ok ? await r.json() : null;
            if (!d?.video) { setFrameStatus("error"); return; }

            if (d.video.calibrationJsonPath && !d.video.cleanFramePath) {
                setDone(true);
                return;
            }

            if (d.video.cleanFramePath) {
                setFrameUrl(`${API}${d.video.cleanFramePath}?t=${Date.now()}`);
                setFrameStatus("ready");
                return;
            }

            // Clean frame missing — trigger generation
            if (d.video.cleanFrameStatus === "processing") {
                setFrameStatus("generating");
                pollTimer = setInterval(load, 3000);
                return;
            }

            if (d.video.cleanFrameStatus === "failed") {
                setFrameStatus("error");
                setError("יצירת הפריים נכשלה. נסה שנית.");
                return;
            }

            // Not started yet — kick it off
            setFrameStatus("generating");
            await fetch(`${API}/videos/${videoId}/clean-frame`, {
                method: "POST", credentials: "include",
            });
            pollTimer = setInterval(load, 3000);
        }

        load();
        return () => clearInterval(pollTimer);
    }, [videoId]);

    // Draw points on canvas when they change
    useEffect(() => {
        const canvas = canvasRef.current;
        const img    = imgRef.current;
        if (!canvas || !img || !img.complete) return;

        canvas.width  = img.clientWidth;
        canvas.height = img.clientHeight;
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const colors = ["#22c55e", "#22c55e", "#f59e0b", "#f59e0b"];
        points.forEach(({ x, y }, i) => {
            ctx.beginPath();
            ctx.arc(x, y, 8, 0, Math.PI * 2);
            ctx.fillStyle = colors[i] || "#fff";
            ctx.fill();
            ctx.strokeStyle = "#fff";
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.fillStyle = "#fff";
            ctx.font = "bold 13px sans-serif";
            ctx.fillText(String(i + 1), x + 12, y + 5);
        });

        // Draw lines between corners and net
        if (points.length === 4) {
            ctx.strokeStyle = "rgba(255,255,255,0.5)";
            ctx.lineWidth = 1.5;
            // near side
            ctx.beginPath();
            ctx.moveTo(points[0].x, points[0].y);
            ctx.lineTo(points[1].x, points[1].y);
            ctx.stroke();
            // net
            ctx.beginPath();
            ctx.moveTo(points[2].x, points[2].y);
            ctx.lineTo(points[3].x, points[3].y);
            ctx.stroke();
            // sides
            ctx.beginPath();
            ctx.moveTo(points[0].x, points[0].y);
            ctx.lineTo(points[2].x, points[2].y);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(points[1].x, points[1].y);
            ctx.lineTo(points[3].x, points[3].y);
            ctx.stroke();
        }
    }, [points]);

    function handleCanvasClick(e) {
        if (points.length >= 4) return;
        const rect = canvasRef.current.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        setPoints(prev => [...prev, { x, y }]);
    }

    async function handleSave() {
        if (points.length < 4) return;
        setSaving(true);
        setError("");

        const img = imgRef.current;
        const scaleX = img.naturalWidth  / img.clientWidth;
        const scaleY = img.naturalHeight / img.clientHeight;

        // Convert display pixels → actual image pixels
        const imagePoints = points.map(({ x, y }) => [
            Math.round(x * scaleX),
            Math.round(y * scaleY),
        ]);

        try {
            const r = await fetch(`${API}/videos/${videoId}/calibrate`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ imagePoints }),
            });
            if (!r.ok) {
                const d = await r.json();
                throw new Error(d.message || "Calibration failed");
            }
            setDone(true);
        } catch (e) {
            setError(e.message);
        } finally {
            setSaving(false);
        }
    }

    function handleReset() {
        setPoints([]);
    }

    if (done) {
        return (
            <div className="cs-page cs-center">
                <div className="cs-card">
                    <div className="cs-check">✓</div>
                    <div className="cs-title">כיול נשמר בהצלחה</div>
                    <div className="cs-sub">הכיול ישמש לזיהוי נפילות כדור וניקוד אוטומטי</div>
                    <button className="cs-btn" onClick={async () => {
                        try {
                            await fetch(`${API}/videos/${videoId}/start-analysis`, {
                                method: "POST", credentials: "include",
                            });
                        } catch { /* starts in background */ }
                        navigate(`/match-analysis/${videoId}`);
                    }}>המשך לניתוח →</button>
                </div>
            </div>
        );
    }

    return (
        <div className="cs-page">
            <div className="cs-topbar">
                <button className="cs-back" onClick={() => navigate(-1)}>←</button>
                <span className="cs-title">כיול מגרש</span>
            </div>

            <div className="cs-body">
                <div className="cs-instructions">
                    <div className="cs-inst-title">לחץ על 4 נקודות בתמונה לפי הסדר:</div>
                    {POINT_LABELS.map((lbl, i) => (
                        <div key={i} className={`cs-inst-row ${points.length > i ? "cs-inst-done" : points.length === i ? "cs-inst-active" : ""}`}>
                            <span className={`cs-dot ${i < 2 ? "cs-dot-green" : "cs-dot-yellow"}`} />
                            {lbl}
                            {points.length > i && <span className="cs-inst-check">✓</span>}
                        </div>
                    ))}
                </div>

                <div className="cs-canvas-wrap">
                    {frameUrl ? (
                        <>
                            <img
                                ref={imgRef}
                                src={frameUrl}
                                className="cs-frame"
                                alt="court frame"
                                onLoad={() => {
                                    const canvas = canvasRef.current;
                                    const img    = imgRef.current;
                                    if (canvas && img) {
                                        canvas.width  = img.clientWidth;
                                        canvas.height = img.clientHeight;
                                    }
                                }}
                            />
                            <canvas
                                ref={canvasRef}
                                className="cs-canvas"
                                onClick={handleCanvasClick}
                            />
                        </>
                    ) : frameStatus === "generating" ? (
                        <div className="cs-loading">
                            <div className="cs-spinner" />
                            מייצר פריים נקי מהוידאו...
                        </div>
                    ) : frameStatus === "error" ? (
                        <div className="cs-loading" style={{ color: "#f87171" }}>
                            {error || "שגיאה בטעינת הפריים"}
                        </div>
                    ) : (
                        <div className="cs-loading">
                            <div className="cs-spinner" />
                            טוען...
                        </div>
                    )}
                </div>

                <div className="cs-actions">
                    {error && <div className="cs-error">{error}</div>}
                    <button className="cs-btn cs-btn-secondary" onClick={handleReset} disabled={!points.length}>
                        נקה נקודות
                    </button>
                    <button
                        className="cs-btn cs-btn-primary"
                        onClick={handleSave}
                        disabled={points.length < 4 || saving}
                    >
                        {saving ? "שומר..." : "שמור כיול"}
                    </button>
                </div>
            </div>
        </div>
    );
}
