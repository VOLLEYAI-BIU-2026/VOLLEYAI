import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import "./CourtSetup.css";

const API = "http://localhost:5000";

function clamp01(x) {
    return Math.max(0, Math.min(1, x));
}

function defaultPoints() {
    return {
        netTopLeft: { x: 0.15, y: 0.25 },
        netTopRight: { x: 0.85, y: 0.25 },
        farLineLeft: { x: 0.28, y: 0.68 },
        farLineRight: { x: 0.72, y: 0.68 },
        middleLineLeft: { x: 0.12, y: 0.78 },
        middleLineRight: { x: 0.88, y: 0.78 },
    };
}

export default function CourtSetup() {
    const navigate = useNavigate();
    const { videoId } = useParams();

    const stageRef = useRef(null);
    const videoRef = useRef(null);
    const startedRef = useRef(false);

    const [step, setStep] = useState(1);
    const [videoMeta, setVideoMeta] = useState(null);
    const [loading, setLoading] = useState(true);

    const [points, setPoints] = useState(defaultPoints());
    const [dragKey, setDragKey] = useState(null);

    const [saving, setSaving] = useState(false);
    const [err, setErr] = useState("");

    const [frameLoading, setFrameLoading] = useState(false);
    const [frameWarn, setFrameWarn] = useState("");

    async function fetchVideo() {
        const res = await fetch(`${API}/videos/${videoId}`, {
            credentials: "include",
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.message || "Failed to load video.");
        return data.video;
    }

    useEffect(() => {
        if (!videoId) {
            navigate("/upload-video");
            return;
        }

        (async () => {
            try {
                setLoading(true);
                const v = await fetchVideo();
                setVideoMeta(v);

                const saved1 = v?.courtSetup?.step1;
                const saved2 = v?.courtSetup?.step2;

                if (saved1) {
                    setPoints(saved1);
                    setStep(1);
                } else if (saved2) {
                    setPoints(saved2);
                    setStep(2);
                }

                setLoading(false);
            } catch (e) {
                setErr(e.message || "Failed to load video.");
                setLoading(false);
            }
        })();
    }, [videoId, navigate]);

    useEffect(() => {
        if (!videoMeta) return;
        if (videoMeta.sourceType !== "file") return;

        const ready = videoMeta.cleanFrameStatus === "done" && videoMeta.cleanFramePath;
        if (ready) return;

        if (!startedRef.current) {
            startedRef.current = true;
            setFrameLoading(true);
            setFrameWarn("");

            fetch(`${API}/videos/${videoId}/clean-frame`, {
                method: "POST",
                credentials: "include",
            }).catch(() => {
                setFrameLoading(false);
                setFrameWarn("Could not prepare clean frame. Showing video.");
            });
        }

        const id = setInterval(async () => {
            try {
                const v = await fetchVideo();
                setVideoMeta(v);

                const ok = v.cleanFrameStatus === "done" && v.cleanFramePath;
                const failed = v.cleanFrameStatus === "failed";

                if (ok) {
                    setFrameLoading(false);
                    clearInterval(id);
                } else if (failed) {
                    setFrameLoading(false);
                    setFrameWarn(v.cleanFrameError || "Clean frame failed. Showing video.");
                    clearInterval(id);
                } else {
                    setFrameLoading(true);
                }
            } catch {
                setFrameLoading(false);
                setFrameWarn("Could not check clean frame status. Showing video.");
                clearInterval(id);
            }
        }, 1200);

        return () => clearInterval(id);
    }, [videoMeta, videoId]);

    useEffect(() => {
        function onMove(e) {
            if (!dragKey || !stageRef.current) return;

            const rect = stageRef.current.getBoundingClientRect();
            const clientX = e.touches?.[0]?.clientX ?? e.clientX;
            const clientY = e.touches?.[0]?.clientY ?? e.clientY;

            const x = clamp01((clientX - rect.left) / rect.width);
            const y = clamp01((clientY - rect.top) / rect.height);

            setPoints((prev) => ({
                ...prev,
                [dragKey]: { x, y },
            }));
        }

        function onUp() {
            setDragKey(null);
        }

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

    const videoSrc = useMemo(() => {
        if (!videoMeta) return "";
        if (videoMeta.sourceType === "file") return `${API}${videoMeta.filePath}`;
        return "";
    }, [videoMeta]);

    const ytEmbed = useMemo(() => {
        if (!videoMeta?.youtubeUrl) return "";
        const u = videoMeta.youtubeUrl.trim();
        const m =
            u.match(/[?&]v=([^&]+)/) ||
            u.match(/youtu\.be\/([^?&]+)/) ||
            u.match(/youtube\.com\/shorts\/([^?&]+)/) ||
            u.match(/youtube\.com\/embed\/([^?&]+)/);
        const id = m?.[1];
        return id ? `https://www.youtube.com/embed/${id}` : "";
    }, [videoMeta]);

    async function handleSave() {
        if (!videoId) return;
        setErr("");
        setSaving(true);

        try {
            const res = await fetch(`${API}/videos/${videoId}/court-setup`, {
                method: "POST",
                credentials: "include",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ step, points }),
            });

            const data = await res.json();

            if (!res.ok) {
                setErr(data.message || "Save failed.");
                return;
            }

            if (step === 1) {
                setStep(2);
            } else {
                const detectRes = await fetch(`${API}/videos/${videoId}/detect-players`, {
                    method: "POST",
                    credentials: "include",
                });

                const detectData = await detectRes.json().catch(() => ({}));

                if (!detectRes.ok && detectRes.status !== 202) {
                    setErr(detectData.message || "Player detection could not start.");
                    return;
                }

                navigate(`/video-analysis/${videoId}`);
            }
        } catch {
            setErr("Save failed.");
        } finally {
            setSaving(false);
        }
    }

    function handleSkip() {
        setErr("");
        if (videoRef.current) {
            videoRef.current.currentTime = Math.min(
                (videoRef.current.currentTime || 0) + 1,
                videoRef.current.duration || 999999
            );
        }
    }

    const labelText = step === 1 ? "Video Court Corners Setup 1/2" : "Video Court Corners Setup 2/2";

    return (
        <div className="cs-page">
            <header className="cs-top">
                <div className="cs-title">{labelText}</div>
                <button className="cs-close" type="button" onClick={() => navigate("/home")}>
                    ✕
                </button>
            </header>

            <div className="cs-sub">
                Help our AI by adjusting the far side court corners and the top of the net.
            </div>

            <div className="cs-actionsTop">
                <button className="cs-ghost" type="button" onClick={handleSkip} disabled={saving || loading}>
                    Skip Frame
                </button>
                <button className="cs-primary" type="button" onClick={handleSave} disabled={saving || loading}>
                    {saving ? "Saving..." : "Save"}
                </button>
            </div>

            {err ? <div className="cs-error">{err}</div> : null}

            <div className="cs-stageWrap">
                <div className="cs-stage" ref={stageRef}>
                    {loading ? (
                        <div className="cs-loading">Loading...</div>
                    ) : videoMeta?.sourceType === "youtube" ? (
                        <div className="cs-loading">Clean frame is not supported for YouTube yet.</div>
                    ) : videoMeta?.cleanFrameStatus === "done" && videoMeta?.cleanFramePath ? (
                        <img
                            className="cs-media"
                            src={`${API}${videoMeta.cleanFramePath}`}
                            alt="Clean court frame"
                        />
                    ) : (
                        <div className="cs-loading">Preparing clean court frame...</div>
                    )}

                    {frameLoading ? <div className="cs-loading">Preparing clean court frame...</div> : null}
                    {frameWarn ? <div className="cs-cleanWarn">{frameWarn}</div> : null}

                    <svg className="cs-overlay" viewBox="0 0 1000 560" preserveAspectRatio="none">
                        <line
                            x1={points.netTopLeft.x * 1000}
                            y1={points.netTopLeft.y * 560}
                            x2={points.netTopRight.x * 1000}
                            y2={points.netTopRight.y * 560}
                            className="cs-line cs-line-blue"
                        />
                        <line
                            x1={points.farLineLeft.x * 1000}
                            y1={points.farLineLeft.y * 560}
                            x2={points.farLineRight.x * 1000}
                            y2={points.farLineRight.y * 560}
                            className="cs-line cs-line-green"
                        />
                        <line
                            x1={points.middleLineLeft.x * 1000}
                            y1={points.middleLineLeft.y * 560}
                            x2={points.middleLineRight.x * 1000}
                            y2={points.middleLineRight.y * 560}
                            className="cs-line cs-line-green"
                        />
                        <line
                            x1={points.farLineLeft.x * 1000}
                            y1={points.farLineLeft.y * 560}
                            x2={points.middleLineLeft.x * 1000}
                            y2={points.middleLineLeft.y * 560}
                            className="cs-line cs-line-green"
                        />
                        <line
                            x1={points.farLineRight.x * 1000}
                            y1={points.farLineRight.y * 560}
                            x2={points.middleLineRight.x * 1000}
                            y2={points.middleLineRight.y * 560}
                            className="cs-line cs-line-green"
                        />
                    </svg>

                    <Point name="netTopLeft" label="Net Top Left (Antenna line)" p={points.netTopLeft} onDown={setDragKey} />
                    <Point name="netTopRight" label="Net Top Right (Antenna line)" p={points.netTopRight} onDown={setDragKey} />
                    <Point name="farLineLeft" label="Far Line Left" p={points.farLineLeft} onDown={setDragKey} />
                    <Point name="farLineRight" label="Far Line Right" p={points.farLineRight} onDown={setDragKey} />
                    <Point name="middleLineLeft" label="Middle Line Left" p={points.middleLineLeft} onDown={setDragKey} />
                    <Point name="middleLineRight" label="Middle Line Right" p={points.middleLineRight} onDown={setDragKey} />
                </div>

                <div className="cs-hint">Drag the corners to identify the far side court corners and net top points.</div>
            </div>
        </div>
    );
}

function Point({ name, label, p, onDown }) {
    return (
        <div
            className="cs-pointWrap"
            style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
            onMouseDown={(e) => {
                e.preventDefault();
                onDown(name);
            }}
            onTouchStart={(e) => {
                e.preventDefault();
                onDown(name);
            }}
        >
            <div className="cs-point" />
            <div className="cs-label">{label}</div>
        </div>
    );
}