import React, { useEffect, useRef, useState, useCallback } from "react";
import { useNavigate, useParams } from "react-router-dom";
import "./MatchAnalysis.css";

const API = "http://localhost:5000";

const ACTION_COLOR = {
    serve: "#f97316",
    spike: "#ef4444",
    set:   "#06b6d4",
    dig:   "#fb923c",
    block: "#a855f7",
};

const RESULT_LABEL = {
    kill:    { text: "Kill",    cls: "ma-res-kill"   },
    error:   { text: "Error",   cls: "ma-res-error"  },
    assist:  { text: "Assist",  cls: "ma-res-assist" },
    won:     { text: "Won",     cls: "ma-res-kill"   },
    lost:    { text: "Lost",    cls: "ma-res-error"  },
    in_play: { text: "In play", cls: "ma-res-inplay" },
    unknown: { text: "",        cls: ""              },
};

export default function MatchAnalysis() {
    const { videoId } = useParams();
    const navigate = useNavigate();
    const videoRef = useRef(null);
    const actionRefs = useRef({});
    const pollRef = useRef(null);

    const [status, setStatus]       = useState("checking");
    const [progress, setProgress]   = useState(0);
    const [rallies, setRallies]     = useState([]);
    const [rallyMeta, setRallyMeta] = useState(null);
    const [videoUrl, setVideoUrl]   = useState(null);
    const [activeFrame, setActiveFrame] = useState(null);
    const [tab, setTab]             = useState("rallies");
    const [activeRally, setActiveRally] = useState(null);
    const [currentScore, setCurrentScore] = useState({ us: 0, opp: 0 });
    const [scoreEvents, setScoreEvents]   = useState([]);
    const [teamNames, setTeamNames]       = useState({ us: "Us", opp: "Opp" });

    // ── Load video URL + team names ───────────────────────────
    useEffect(() => {
        if (!videoId) return;
        fetch(`${API}/videos/${videoId}`, { credentials: "include" })
            .then(r => r.ok ? r.json() : null)
            .then(d => {
                if (!d?.video) return;
                if (d.video.filePath) setVideoUrl(`${API}${d.video.filePath}`);
                setTeamNames({
                    us:  d.video.teamA || "Us",
                    opp: d.video.teamB || "Opp",
                });
            })
            .catch(() => {});
    }, [videoId]);

    // ── Load rally data ──────────────────────────────────────
    const loadRallies = useCallback(() => {
        fetch(`${API}/videos/rally-analysis`, { credentials: "include" })
            .then(r => r.ok ? r.json() : null)
            .then(d => {
                if (d?.rallies) {
                    setRallies(d.rallies);
                    setScoreEvents(d.score_events || []);
                    setRallyMeta({ total: d.total_rallies });
                    const init = {};
                    if (d.rallies.length > 0) setActiveRally(d.rallies[0].rally_number);
                }
            })
            .catch(() => {});
    }, []);

    // ── Poll analysis status ──────────────────────────────────
    const pollStatus = useCallback(() => {
        fetch(`${API}/videos/${videoId}/analysis-status`, { credentials: "include" })
            .then(r => r.ok ? r.json() : null)
            .then(d => {
                if (!d) return;
                setProgress(d.progress ?? 0);
                if (d.status === "done") {
                    setStatus("done");
                    clearInterval(pollRef.current);
                    loadRallies();
                } else if (d.status === "failed") {
                    setStatus("failed");
                    clearInterval(pollRef.current);
                } else {
                    setStatus("processing");
                }
            })
            .catch(() => {});
    }, [videoId, loadRallies]);

    // ── On mount: check status, auto-start if needed ──────────
    useEffect(() => {
        fetch(`${API}/videos/${videoId}/analysis-status`, { credentials: "include" })
            .then(r => r.ok ? r.json() : null)
            .then(d => {
                if (!d) return;
                if (d.status === "done") {
                    setStatus("done");
                    setProgress(100);
                    loadRallies();
                } else if (d.status === "processing") {
                    setStatus("processing");
                    setProgress(d.progress ?? 0);
                    pollRef.current = setInterval(pollStatus, 3000);
                } else {
                    // Auto-start analysis
                    fetch(`${API}/videos/${videoId}/start-analysis`, {
                        method: "POST",
                        credentials: "include",
                    })
                        .then(r => r.ok ? r.json() : null)
                        .then(() => {
                            setStatus("processing");
                            pollRef.current = setInterval(pollStatus, 3000);
                        })
                        .catch(() => setStatus("failed"));
                }
            })
            .catch(() => setStatus("failed"));

        return () => clearInterval(pollRef.current);
    }, [videoId, pollStatus, loadRallies]);

    // ── Video time sync ───────────────────────────────────────
    useEffect(() => {
        const video = videoRef.current;
        if (!video || !rallies.length) return;
        const onTime = () => {
            const t = video.currentTime;

            // Active action highlight
            let best = null;
            for (const rally of rallies) {
                for (const act of rally.actions) {
                    if (act.time_sec <= t + 0.5) best = act;
                }
            }
            if (best) setActiveFrame(best.frame);

            // Score dashboard: find latest score_event before current time
            let score = { us: 0, opp: 0 };
            for (const ev of scoreEvents) {
                if (ev.time_sec <= t) score = { us: ev.us, opp: ev.opp };
            }
            setCurrentScore(score);
        };
        video.addEventListener("timeupdate", onTime);
        return () => video.removeEventListener("timeupdate", onTime);
    }, [rallies, scoreEvents]);

    // ── Auto-scroll active action ─────────────────────────────
    useEffect(() => {
        if (activeFrame !== null && actionRefs.current[activeFrame]) {
            actionRefs.current[activeFrame].scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
    }, [activeFrame]);

    const seekTo = useCallback((action) => {
        if (videoRef.current) {
            videoRef.current.currentTime = action.time_sec;
            videoRef.current.play();
        }
        setActiveFrame(action.frame);
    }, []);

    const seekToRally = (rally) => {
        if (videoRef.current) {
            videoRef.current.currentTime = rally.start_sec ?? 0;
            videoRef.current.play();
        }
        setActiveRally(rally.rally_number);
    };

    const allActions = rallies.flatMap(r => r.actions);

    // ── Processing screen ─────────────────────────────────────
    if (status === "checking" || status === "processing") {
        return (
            <div className="ma-page ma-center">
                <div className="ma-processing-box">
                    <div className="ma-spinner" />
                    <div className="ma-proc-title">Processing Video...</div>
                    <div className="ma-proc-sub">Detecting players, ball & actions</div>
                    <div className="ma-prog-bar-wrap">
                        <div className="ma-prog-bar" style={{ width: `${progress}%` }} />
                    </div>
                    <div className="ma-prog-pct">{progress}%</div>
                </div>
            </div>
        );
    }

    if (status === "failed") {
        return (
            <div className="ma-page ma-center">
                <div className="ma-processing-box">
                    <div className="ma-proc-title" style={{ color: "#f87171" }}>Analysis Failed</div>
                    <button className="ma-start-btn" onClick={() => navigate(-1)}>← Go Back</button>
                </div>
            </div>
        );
    }

    // ── Main screen (done) ────────────────────────────────────
    return (
        <div className="ma-page">
            <div className="ma-topbar">
                <button className="ma-back" onClick={() => navigate(-1)}>←</button>
                <span className="ma-title">Processed Video</span>
                {rallyMeta && (
                    <span className="ma-summary">
                        {rallyMeta.won}W – {rallyMeta.lost}L · {rallyMeta.total} rallies
                    </span>
                )}
                <button className="ma-start-btn" onClick={() => navigate("/match-statistics")}>
                    Start Statistics →
                </button>
            </div>

            <div className="ma-body">
                {/* Processed video with boxes + trail */}
                <div className="ma-video-wrap">
                    <video
                        ref={videoRef}
                        className="ma-video"
                        src={`${API}/analysis-video/active_player.mp4`}
                        controls
                        playsInline
                    />
                    <div className="ma-score-overlay">
                        <span className="ma-score-team">{teamNames.us}</span>
                        <span className="ma-score-num">
                            {currentScore.us}
                            <span className="ma-score-sep"> – </span>
                            {currentScore.opp}
                        </span>
                        <span className="ma-score-team">{teamNames.opp}</span>
                    </div>
                </div>

                {/* Rally panel */}
                <div className="ma-panel">
                    <div className="ma-tabs">
                        <button className={`ma-tab ${tab === "rallies" ? "active" : ""}`} onClick={() => setTab("rallies")}>
                            Rallies {rallies.length ? `(${rallies.length})` : ""}
                        </button>
                        <button className={`ma-tab ${tab === "actions" ? "active" : ""}`} onClick={() => setTab("actions")}>
                            Actions {allActions.length ? `(${allActions.length})` : ""}
                        </button>
                    </div>

                    <div className="ma-list">
                        {!rallies.length && (
                            <div className="ma-state">No rally data.<br />Click "Start Statistics" to generate.</div>
                        )}

                        {tab === "rallies" && rallies.map(rally => (
                            <button
                                key={rally.rally_number}
                                className={`ma-rally-pill ${activeRally === rally.rally_number ? "active" : ""}`}
                                onClick={() => seekToRally(rally)}
                            >
                                <span className="ma-rally-num">#{rally.rally_number}</span>
                                <span className="ma-rally-dur">{rally.duration_sec != null ? `${rally.duration_sec}s` : ""}</span>
                            </button>
                        ))}


                        {tab === "actions" && allActions.map((act, i) => (
                            <ActionRow
                                key={i}
                                act={act}
                                active={activeFrame === act.frame}
                                onClick={() => seekTo(act)}
                                ref={el => { actionRefs.current[act.frame] = el; }}
                            />
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
}

const ActionRow = React.forwardRef(({ act, active, onClick }, ref) => {
    const res = RESULT_LABEL[act.result] ?? RESULT_LABEL.unknown;
    return (
        <div
            ref={ref}
            className={`ma-action-row ${active ? "ma-action-active" : ""}`}
            onClick={onClick}
        >
            <span className="ma-action-time">{act.time_str}</span>
            <span className="ma-action-dot" style={{ background: ACTION_COLOR[act.action] ?? "#888" }} />
            <span className="ma-action-label">
                {act.action_label}
                <span className="ma-action-player"> by {act.player_label}</span>
            </span>
            {res.text && <span className={`ma-res-badge ${res.cls}`}>{res.text}</span>}
        </div>
    );
});
ActionRow.displayName = "ActionRow";
