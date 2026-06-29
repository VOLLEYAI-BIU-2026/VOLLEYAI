import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import "./CourtSetup.css";

const API = "http://localhost:5000";

function clamp01(x) {
    return Math.max(0, Math.min(1, x));
}

function defaultPoints() {
    return {
        farLeft:     { x: 0.18, y: 0.28 },
        farRight:    { x: 0.82, y: 0.28 },
        netTopLeft:  { x: 0.14, y: 0.36 },
        netTopRight: { x: 0.86, y: 0.36 },
        netLeft:     { x: 0.12, y: 0.48 },
        netRight:    { x: 0.88, y: 0.48 },
        nearLeft:    { x: 0.04, y: 0.80 },
        nearRight:   { x: 0.96, y: 0.80 },
    };
}

const POINT_META = {
    farLeft:     { label: "Far Baseline Left",  color: "#16a34a" },
    farRight:    { label: "Far Baseline Right", color: "#16a34a" },
    netTopLeft:  { label: "Net Top Left",       color: "#2563eb" },
    netTopRight: { label: "Net Top Right",      color: "#2563eb" },
    netLeft:     { label: "Net Floor Left",     color: "#2563eb" },
    netRight:    { label: "Net Floor Right",    color: "#2563eb" },
    nearLeft:    { label: "Near Baseline Left", color: "#dc2626" },
    nearRight:   { label: "Near Baseline Right",color: "#dc2626" },
};

export default function CourtSetup() {
    const navigate = useNavigate();
    const { videoId } = useParams();

    const stageRef = useRef(null);
    const startedRef = useRef(false);

    const [videoMeta, setVideoMeta] = useState(null);
    const [loading, setLoading] = useState(true);
    const [points, setPoints] = useState(defaultPoints());
    const [dragKey, setDragKey] = useState(null);
    const [saving, setSaving] = useState(false);
    const [err, setErr] = useState("");
    const [frameLoading, setFrameLoading] = useState(false);
    const [frameWarn, setFrameWarn] = useState("");

    async function fetchVideo() {
        const res = await fetch(`${API}/videos/${videoId}`, { credentials: "include" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || "Failed to load video.");
        return data.video;
    }

    useEffect(() => {
        if (!videoId) { navigate("/upload-video"); return; }
        (async () => {
            try {
                setLoading(true);
                const v = await fetchVideo();
                setVideoMeta(v);
                const saved = v?.courtSetup?.step1;
                if (saved?.nearLeft) setPoints(saved);
                setLoading(false);
            } catch (e) {
                setErr(e.message || "Failed to load video.");
                setLoading(false);
            }
        })();
    }, [videoId]);

    useEffect(() => {
        if (!videoMeta || videoMeta.sourceType !== "file") return;
        if (videoMeta.cleanFrameStatus === "done" && videoMeta.cleanFramePath) return;

        if (!startedRef.current) {
            startedRef.current = true;
            setFrameLoading(true);
            fetch(`${API}/videos/${videoId}/clean-frame`, { method: "POST", credentials: "include" })
                .catch(() => { setFrameLoading(false); setFrameWarn("Could not prepare clean frame."); });
        }

        const id = setInterval(async () => {
            try {
                const v = await fetchVideo();
                setVideoMeta(v);
                if (v.cleanFrameStatus === "done" && v.cleanFramePath) {
                    setFrameLoading(false); clearInterval(id);
                } else if (v.cleanFrameStatus === "failed") {
                    setFrameLoading(false);
                    setFrameWarn(v.cleanFrameError || "Clean frame failed.");
                    clearInterval(id);
                }
            } catch { setFrameLoading(false); clearInterval(id); }
        }, 1200);

        return () => clearInterval(id);
    }, [videoMeta, videoId]);

    useEffect(() => {
        function onMove(e) {
            if (!dragKey || !stageRef.current) return;
            const rect = stageRef.current.getBoundingClientRect();
            const cx = e.touches?.[0]?.clientX ?? e.clientX;
            const cy = e.touches?.[0]?.clientY ?? e.clientY;
            setPoints(prev => ({
                ...prev,
                [dragKey]: {
                    x: clamp01((cx - rect.left) / rect.width),
                    y: clamp01((cy - rect.top) / rect.height),
                },
            }));
        }
        function onUp() { setDragKey(null); }
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        window.addEventListener("touchmove", onMove, { passive: false });
        window.addEventListener("touchend", onUp);
        return () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            window.removeEventListener("touchmove", onMove);
            window.removeEventListener("touchend", onUp);
        };
    }, [dragKey]);

    async function handleSave() {
        if (!videoId) return;
        setErr("");
        setSaving(true);
        try {
            const res = await fetch(`${API}/videos/${videoId}/court-setup`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ step: 1, points }),
            });
            const data = await res.json();
            if (!res.ok) { setErr(data.message || "Save failed."); return; }

            navigate(`/jersey-setup/${videoId}`);
        } catch {
            setErr("Save failed.");
        } finally {
            setSaving(false);
        }
    }

    const p = points;
    const W = 1000, H = 560;

    const courtPolygon = [
        `${p.farLeft.x * W},${p.farLeft.y * H}`,
        `${p.farRight.x * W},${p.farRight.y * H}`,
        `${p.nearRight.x * W},${p.nearRight.y * H}`,
        `${p.nearLeft.x * W},${p.nearLeft.y * H}`,
    ].join(" ");

    const teamAX = ((p.farLeft.x + p.farRight.x) / 2) * W;
    const teamAY = ((p.farLeft.y + p.netLeft.y) / 2) * H;
    const teamBX = ((p.nearLeft.x + p.nearRight.x) / 2) * W;
    const teamBY = ((p.netLeft.y + p.nearLeft.y) / 2) * H;

    const frameReady = videoMeta?.cleanFrameStatus === "done" && videoMeta?.cleanFramePath;

    return (
        <div className="cs-page">
            <header className="cs-top">
                <div className="cs-topLeft">
                    <div className="cs-title">Court Setup</div>
                    <div className="cs-sub">
                        Drag the 8 points to match your court.&nbsp;
                        <span style={{ color: "#60a5fa", fontWeight: 700 }}>Above net = Team A</span>,&nbsp;
                        <span style={{ color: "#f87171", fontWeight: 700 }}>below = Team B</span>.
                    </div>
                </div>
                <div className="cs-topRight">
                    <button className="cs-primary" type="button" onClick={handleSave} disabled={saving || loading}>
                        {saving ? "Saving..." : "Save & Continue"}
                    </button>
                    <button className="cs-close" type="button" onClick={() => navigate("/home")}>✕</button>
                </div>
            </header>

            {err && <div className="cs-error">{err}</div>}

            <div className="cs-stageWrap">
                <div className="cs-stage" ref={stageRef}>
                    {loading ? (
                        <div className="cs-loading">Loading...</div>
                    ) : videoMeta?.sourceType === "youtube" ? (
                        <div className="cs-loading">Clean frame not supported for YouTube.</div>
                    ) : frameLoading && !frameReady ? (
                        <div className="cs-loading">Preparing court frame...</div>
                    ) : frameReady ? (
                        <img className="cs-media" src={`${API}${videoMeta.cleanFramePath}`} alt="Court frame" />
                    ) : (
                        <div className="cs-loading">{frameWarn || "Preparing court frame..."}</div>
                    )}

                    <svg className="cs-overlay" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
                        {/* Full court outline */}
                        <polygon points={courtPolygon} fill="rgba(22,163,74,0.06)" stroke="#16a34a" strokeWidth="2.5" />

                        {/* Net top (dashed) */}
                        <line x1={p.netTopLeft.x*W} y1={p.netTopLeft.y*H} x2={p.netTopRight.x*W} y2={p.netTopRight.y*H}
                            stroke="#2563eb" strokeWidth="2" strokeDasharray="7 3" />
                        {/* Net posts */}
                        <line x1={p.netTopLeft.x*W} y1={p.netTopLeft.y*H} x2={p.netLeft.x*W} y2={p.netLeft.y*H}
                            stroke="#2563eb" strokeWidth="1.5" strokeDasharray="4 3" />
                        <line x1={p.netTopRight.x*W} y1={p.netTopRight.y*H} x2={p.netRight.x*W} y2={p.netRight.y*H}
                            stroke="#2563eb" strokeWidth="1.5" strokeDasharray="4 3" />
                        {/* Net floor — team divider */}
                        <line x1={p.netLeft.x*W} y1={p.netLeft.y*H} x2={p.netRight.x*W} y2={p.netRight.y*H}
                            stroke="#2563eb" strokeWidth="3.5" />

                        {/* Team labels */}
                        <text x={teamAX} y={teamAY} fill="#2563eb" fontSize="24" fontWeight="bold"
                            textAnchor="middle" dominantBaseline="middle"
                            stroke="white" strokeWidth="5" paintOrder="stroke">TEAM A</text>
                        <text x={teamBX} y={teamBY} fill="#dc2626" fontSize="24" fontWeight="bold"
                            textAnchor="middle" dominantBaseline="middle"
                            stroke="white" strokeWidth="5" paintOrder="stroke">TEAM B</text>
                    </svg>

                    {Object.entries(points).map(([name, pos]) => (
                        <Point key={name} name={name} meta={POINT_META[name]} p={pos} onDown={setDragKey} />
                    ))}
                </div>

                <div className="cs-hint">
                    <strong style={{ color: "#16a34a" }}>Green</strong> = court boundary (4 corners).&nbsp;
                    <strong style={{ color: "#2563eb" }}>Blue solid</strong> = net at floor (team divider).&nbsp;
                    <strong style={{ color: "#2563eb" }}>Blue dashed</strong> = net top.&nbsp;
                    <strong style={{ color: "#dc2626" }}>Red</strong> = near baseline.
                </div>
            </div>
        </div>
    );
}

function Point({ name, meta, p, onDown }) {
    return (
        <div
            className="cs-pointWrap"
            style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
            onMouseDown={(e) => { e.preventDefault(); onDown(name); }}
            onTouchStart={(e) => { e.preventDefault(); onDown(name); }}
        >
            <div className="cs-point" style={{ borderColor: meta.color, boxShadow: `0 0 0 3px ${meta.color}33` }} />
            <div className="cs-label">{meta.label}</div>
        </div>
    );
}
