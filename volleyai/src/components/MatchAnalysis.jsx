import { API_BASE } from "../config.js";
import React, { useEffect, useRef, useState, useCallback } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import "./MatchAnalysis.css";

const API = API_BASE;

const ACTION_COLOR = {
    // Real action strings the model/pipeline actually produces:
    service:        "#f97316",  // orange
    attack:         "#ef4444",  // red
    setting:        "#06b6d4",  // cyan
    "defense-move": "#fb923c",  // light orange
    block:          "#a855f7",  // purple
    // Aliases kept for any older/alternate naming still floating around.
    serve:  "#f97316",
    spike:  "#ef4444",
    set:    "#06b6d4",
    defence:"#fb923c",
    dig:    "#22c55e",
    bump:   "#22c55e",
    receive:"#3b82f6",
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

function toTimeStr(sec) {
    const s = Math.floor(sec ?? 0);
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export default function MatchAnalysis() {
    const { videoId } = useParams();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const seekParam = searchParams.get("seek");
    const videoRef = useRef(null);
    const actionRefs = useRef({});
    const rallyRefs  = useRef({});
    const pollRef = useRef(null);

    const [status, setStatus]       = useState("checking");
    const [progress, setProgress]   = useState(0);
    const [rallies, setRallies]     = useState([]);
    const [rallyMeta, setRallyMeta] = useState(null);
    const [videoUrl, setVideoUrl]   = useState(null);
    const [activeFrame, setActiveFrame]     = useState(null);
    const [activeRallyId, setActiveRallyId] = useState(null);
    const [activeTab, setActiveTab]         = useState("actions");
    const [currentScore, setCurrentScore] = useState({ us: 0, opp: 0 });
    const [scoreEvents, setScoreEvents]   = useState([]);
    const [teamNames, setTeamNames]       = useState({ us: "Us", opp: "Opp" });
    const [allActions, setAllActions]     = useState([]);
    const [duration, setDuration]         = useState(0);
    const [playheadSec, setPlayheadSec]   = useState(0);

    // ── Load team names ───────────────────────────────────────
    useEffect(() => {
        if (!videoId) return;
        fetch(`${API}/videos/${videoId}`, { credentials: "include" })
            .then(r => r.ok ? r.json() : null)
            .then(d => {
                if (!d?.video) return;
                setTeamNames({
                    us:  d.video.teamA || "Us",
                    opp: d.video.teamB || "Opp",
                });
            })
            .catch(() => {});
    }, [videoId]);

    // ── Load rally data ──────────────────────────────────────
    const loadRallies = useCallback(() => {
        if (!videoId) return;
        fetch(`${API}/videos/${videoId}/rally-analysis`, { credentials: "include" })
            .then(r => r.ok ? r.json() : null)
            .then(d => {
                if (d) {
                    setRallies(d.rallies || []);
                    setAllActions(d.all_actions || d.rallies?.flatMap(r => r.actions) || []);
                    setScoreEvents(d.score_events || []);
                    setRallyMeta({
                        total: d.total_rallies ?? 0,
                        won:   d.total_won     ?? 0,
                        lost:  d.total_lost    ?? 0,
                    });
                }
            })
            .catch(() => {});
    }, [videoId]);

    // Resolve the video src: prefer the per-video persisted copy (survives
    // refresh/relogin); fall back to the shared in-progress scratch mount,
    // which only ever holds whichever video most recently finished processing.
    const resolveVideoUrl = (video) =>
        video?.analyzedVideoPath
            ? `${API}${video.analyzedVideoPath}?t=${Date.now()}`
            : `${API}/analysis-video/active_player.mp4?t=${Date.now()}`;

    const finishAnalysis = useCallback(async () => {
        setProgress(100);
        try {
            const r = await fetch(`${API}/videos/${videoId}`, { credentials: "include" });
            const d = r.ok ? await r.json() : null;
            setVideoUrl(resolveVideoUrl(d?.video));
        } catch {
            setVideoUrl(`${API}/analysis-video/active_player.mp4?t=${Date.now()}`);
        }
        setStatus("done");
        loadRallies();
    }, [videoId, loadRallies]);

    // ── On mount: check analytics status, poll while processing ──
    useEffect(() => {
        let cancelled = false;

        const checkStatus = async () => {
            try {
                const r = await fetch(`${API}/videos/${videoId}`, { credentials: "include" });
                const d = r.ok ? await r.json() : null;
                if (cancelled) return;
                if (!d?.video) { setStatus("failed"); return; }

                const st = d.video.analytics?.status;
                if (st === "done") {
                    setVideoUrl(resolveVideoUrl(d.video));
                    setStatus("done");
                    setProgress(100);
                    loadRallies();
                    return;
                }
                if (st === "failed") { setStatus("failed"); return; }
                if (st === "processing") {
                    setStatus("processing");
                    // Poll in-memory progress
                    const poll = setInterval(async () => {
                        if (cancelled) { clearInterval(poll); return; }
                        try {
                            const pr = await fetch(`${API}/videos/${videoId}/analysis-status`, { credentials: "include" });
                            const pd = pr.ok ? await pr.json() : null;
                            if (cancelled) { clearInterval(poll); return; }
                            if (pd?.progress != null) setProgress(pd.progress);
                            if (pd?.status === "done") {
                                clearInterval(poll);
                                if (!cancelled) await finishAnalysis();
                            } else if (pd?.status === "failed") {
                                clearInterval(poll);
                                setStatus("failed");
                            }
                        } catch {}
                    }, 3000);
                    pollRef.current = poll;
                    return;
                }
                setStatus("not_started");
            } catch {
                if (!cancelled) setStatus("failed");
            }
        };

        checkStatus();
        return () => { cancelled = true; clearInterval(pollRef.current); };
    }, [videoId, loadRallies, finishAnalysis]);

    // ── Video time sync ───────────────────────────────────────
    useEffect(() => {
        const video = videoRef.current;
        if (!video || !allActions.length) return;
        const onTime = () => {
            const t = video.currentTime;
            setPlayheadSec(t);

            // Active action highlight
            let best = null;
            for (const act of allActions) {
                if (act.time_sec <= t + 0.5) best = act;
                else break;
            }
            if (best) setActiveFrame(best.frame);

            // Active rally highlight
            const activeRally = rallies.find(r => t >= r.start_sec && t <= r.end_sec + 0.5);
            setActiveRallyId(activeRally?.rally_id ?? null);

            // Score dashboard
            let score = { us: 0, opp: 0 };
            for (const ev of scoreEvents) {
                if (ev.time_sec <= t) score = { us: ev.us, opp: ev.opp };
            }
            setCurrentScore(score);
        };
        video.addEventListener("timeupdate", onTime);
        return () => video.removeEventListener("timeupdate", onTime);
    }, [allActions, scoreEvents]);

    // ── Auto-scroll active action ─────────────────────────────
    useEffect(() => {
        if (activeFrame !== null && actionRefs.current[activeFrame]) {
            actionRefs.current[activeFrame].scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
    }, [activeFrame]);

    useEffect(() => {
        if (activeRallyId !== null && rallyRefs.current[activeRallyId]) {
            rallyRefs.current[activeRallyId].scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
    }, [activeRallyId]);

    const seekTo = useCallback((action) => {
        if (videoRef.current) {
            videoRef.current.currentTime = action.time_sec;
            videoRef.current.play();
        }
        setActiveFrame(action.frame);
    }, []);

    const seekToRally = useCallback((rally) => {
        if (videoRef.current) {
            videoRef.current.currentTime = rally.start_sec;
            videoRef.current.play();
        }
        setActiveRallyId(rally.rally_id);
    }, []);

    const displayActions = allActions;

    // ── Loading / Processing / Error screens ─────────────────
    if (status === "checking") {
        return (
            <div className="ma-page ma-center">
                <div className="ma-processing-box">
                    <button className="ma-back" style={{ alignSelf: "flex-start" }} onClick={() => navigate(-1)}>←</button>
                    <div className="ma-spinner" />
                </div>
            </div>
        );
    }

    if (status === "processing") {
        return (
            <div className="ma-page ma-center">
                <div className="ma-processing-box">
                    <button className="ma-back" style={{ alignSelf: "flex-start" }} onClick={() => navigate(-1)}>←</button>
                    <div className="ma-spinner" />
                    <div className="ma-proc-title">Processing Video...</div>
                    <div className="ma-proc-sub">Detecting players, ball &amp; actions</div>
                    <div className="ma-prog-bar-wrap">
                        <div className="ma-prog-bar" style={{ width: `${progress}%` }} />
                    </div>
                    <div className="ma-prog-pct">{progress}%</div>
                    <button className="ma-back-link" onClick={handleStopAnalysis}>■ Stop</button>
                </div>
            </div>
        );
    }

    async function handleStartAnalysis() {
        try {
            setStatus("processing");
            setProgress(0);
            await fetch(`${API}/videos/${videoId}/start-analysis`, {
                method: "POST",
                credentials: "include",
            });
            // Poll for progress
            const poll = setInterval(async () => {
                try {
                    const pr = await fetch(`${API}/videos/${videoId}/analysis-status`, { credentials: "include" });
                    const pd = pr.ok ? await pr.json() : null;
                    if (pd?.progress != null) setProgress(pd.progress);
                    if (pd?.status === "done") {
                        clearInterval(poll);
                        await finishAnalysis();
                    } else if (pd?.status === "failed") {
                        clearInterval(poll);
                        setStatus("failed");
                    }
                } catch {}
            }, 3000);
            pollRef.current = poll;
        } catch {
            setStatus("failed");
        }
    }

    async function handleStopAnalysis() {
        if (!window.confirm("Stop analysis? Whatever's already been processed will be saved.")) return;
        clearInterval(pollRef.current);
        setStatus("checking");
        try {
            await fetch(`${API}/videos/${videoId}/stop-analysis`, {
                method: "POST",
                credentials: "include",
            });
        } catch {}
        // stop-analysis responds immediately but kills the process and
        // persists partial results asynchronously afterward (up to ~15s) —
        // poll analysis-status until that's actually done before loading
        // results, instead of racing it.
        for (let i = 0; i < 20; i++) {
            await new Promise(r => setTimeout(r, 1000));
            try {
                const pr = await fetch(`${API}/videos/${videoId}/analysis-status`, { credentials: "include" });
                const pd = pr.ok ? await pr.json() : null;
                if (pd?.status === "done") break;
            } catch {}
        }
        await finishAnalysis();
    }

    if (status === "not_started") {
        return (
            <div className="ma-page ma-center">
                <div className="ma-processing-box">
                    <div className="ma-proc-icon">🏐</div>
                    <div className="ma-proc-title">Ready to Analyze</div>
                    <div className="ma-proc-sub">Run all 3 models: player detection, ball tracking &amp; action recognition.</div>
                    <button className="ma-start-btn ma-start-run" onClick={handleStartAnalysis}>
                        ▶ Start Analysis
                    </button>
                    <button className="ma-back-link" onClick={() => navigate(-1)}>← Go Back</button>
                </div>
            </div>
        );
    }

    if (status === "failed") {
        return (
            <div className="ma-page ma-center">
                <div className="ma-processing-box">
                    <button className="ma-back" style={{ alignSelf: "flex-start" }} onClick={() => navigate(-1)}>←</button>
                    <div className="ma-proc-title" style={{ color: "#f87171" }}>Analysis Failed</div>
                    <div className="ma-proc-sub">The main detection finished but a secondary step failed.</div>
                    <button className="ma-start-btn" style={{ marginTop: 12 }} onClick={async () => {
                        try {
                            const r = await fetch(`${API}/videos/${videoId}/recover-analysis`, {
                                method: "POST", credentials: "include",
                            });
                            if (r.ok) window.location.reload();
                        } catch {}
                    }}>
                        View Existing Results
                    </button>
                    <button className="ma-back-link" onClick={() => navigate(-1)}>← Go Back</button>
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
                <button className="ma-start-btn" onClick={() => navigate(`/match-statistics/${videoId}`)}>
                    Start Statistics →
                </button>
                <button className="ma-rerun-btn" onClick={() => navigate(`/player-merge/${videoId}`)}>
                    🔀 Merge Players
                </button>
                <button
                    className="ma-rerun-btn"
                    onClick={() => {
                        if (window.confirm("Re-run analysis for this video? This takes several minutes and replaces the current results.")) {
                            handleStartAnalysis();
                        }
                    }}
                >
                    ↻ Re-analyze
                </button>
            </div>

            <div className="ma-body">
                {/* Processed video with boxes + trail, plus timeline below it */}
                <div className="ma-video-column">
                <div className="ma-video-wrap">
                    <video
                        ref={videoRef}
                        className="ma-video"
                        src={videoUrl || `${API}/analysis-video/active_player.mp4`}
                        controls
                        playsInline
                        onLoadedMetadata={(e) => {
                            setDuration(e.currentTarget.duration || 0);
                            const seekSec = parseFloat(seekParam);
                            if (!isNaN(seekSec)) {
                                e.currentTarget.currentTime = seekSec;
                                e.currentTarget.play().catch(() => {});
                            }
                        }}
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

                {duration > 0 && (
                    <div className="ma-timeline">
                        <div
                            className="ma-timeline-track"
                            onClick={(e) => {
                                const rect = e.currentTarget.getBoundingClientRect();
                                const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
                                if (videoRef.current) videoRef.current.currentTime = frac * duration;
                            }}
                        >
                            {rallies.map(rally => (
                                <div
                                    key={rally.rally_id}
                                    className={`ma-timeline-rally ${activeRallyId === rally.rally_id ? "ma-timeline-rally-active" : ""}`}
                                    style={{
                                        left:  `${(rally.start_sec / duration) * 100}%`,
                                        width: `${Math.max(0, (rally.end_sec - rally.start_sec) / duration) * 100}%`,
                                    }}
                                    title={`Rally ${rally.rally_id} (${toTimeStr(rally.start_sec)}–${toTimeStr(rally.end_sec)})`}
                                    onClick={(e) => { e.stopPropagation(); seekToRally(rally); }}
                                />
                            ))}
                            {allActions.map((act, i) => (
                                <button
                                    key={i}
                                    type="button"
                                    className={`ma-timeline-dot ${activeFrame === act.frame ? "ma-timeline-dot-active" : ""}`}
                                    style={{ left: `${(act.time_sec / duration) * 100}%`, background: ACTION_COLOR[act.action] ?? "#888" }}
                                    title={`${act.time_str} — ${act.action_label} by ${act.player_label}`}
                                    onClick={(e) => { e.stopPropagation(); seekTo(act); }}
                                />
                            ))}
                            <div className="ma-timeline-playhead" style={{ left: `${Math.min(100, (playheadSec / duration) * 100)}%` }} />
                        </div>
                        <div className="ma-timeline-legend">
                            {[...new Set(allActions.map(a => a.action))].map(action => (
                                <span key={action} className="ma-timeline-legend-item">
                                    <span className="ma-timeline-legend-dot" style={{ background: ACTION_COLOR[action] ?? "#888" }} />
                                    {action}
                                </span>
                            ))}
                        </div>
                    </div>
                )}
                </div>

                {/* Right panel */}
                <div className="ma-panel">
                    <div className="ma-tabs">
                        <button
                            className={`ma-tab ${activeTab === "actions" ? "active" : ""}`}
                            onClick={() => setActiveTab("actions")}
                        >
                            Actions {displayActions.length ? `(${displayActions.length})` : ""}
                        </button>
                        <button
                            className={`ma-tab ${activeTab === "rallies" ? "active" : ""}`}
                            onClick={() => setActiveTab("rallies")}
                        >
                            Rallies {rallies.length ? `(${rallies.length})` : ""}
                        </button>
                    </div>

                    <div className="ma-list">
                        {activeTab === "actions" && (
                            <>
                                {!displayActions.length && (
                                    <div className="ma-state">No action data.<br />Click "Start Statistics" to generate.</div>
                                )}
                                {displayActions.map((act, i) => (
                                    <ActionRow
                                        key={i}
                                        act={act}
                                        active={activeFrame === act.frame}
                                        onClick={() => seekTo(act)}
                                        ref={el => { actionRefs.current[act.frame] = el; }}
                                    />
                                ))}
                            </>
                        )}

                        {activeTab === "rallies" && (
                            <>
                                {!rallies.length && (
                                    <div className="ma-state">No rally data detected.</div>
                                )}
                                {rallies.map(rally => (
                                    <RallyRow
                                        key={rally.rally_id}
                                        rally={rally}
                                        active={activeRallyId === rally.rally_id}
                                        onClick={() => seekToRally(rally)}
                                        ref={el => { rallyRefs.current[rally.rally_id] = el; }}
                                    />
                                ))}
                            </>
                        )}
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
            {typeof act.confidence === "number" && (
                <span className="ma-action-conf" title="Model confidence for this action">
                    {Math.round(act.confidence * 100)}%
                </span>
            )}
            {res.text && <span className={`ma-res-badge ${res.cls}`}>{res.text}</span>}
        </div>
    );
});
ActionRow.displayName = "ActionRow";

const RallyRow = React.forwardRef(({ rally, active, onClick }, ref) => {
    const durationSec = Math.max(0, Math.round((rally.end_sec ?? 0) - (rally.start_sec ?? 0)));
    const startStr    = toTimeStr(rally.start_sec);
    const endStr      = toTimeStr(rally.end_sec);

    let resultCls  = "";
    let resultText = "";
    if      (rally.result === "point_my_team")  { resultCls = "won";  resultText = "Won";  }
    else if (rally.result === "point_opponent") { resultCls = "lost"; resultText = "Lost"; }

    const actionCount = rally.actions?.length ?? 0;

    return (
        <div
            ref={ref}
            className={`ma-rally-pill ${active ? "active" : ""}`}
            onClick={onClick}
        >
            <span className="ma-rally-num">#{rally.rally_id}</span>
            <span className="ma-rally-info">
                <span className="ma-rally-timerange">{startStr} – {endStr}</span>
                {actionCount > 0 && (
                    <span className="ma-rally-actcount">{actionCount} action{actionCount !== 1 ? "s" : ""}</span>
                )}
                {rally.defensive_player && (
                    <span className="ma-rally-defense" title={
                        rally.defensive_player.source === "action"
                            ? "Last classified action by our team before the point was lost"
                            : "No action classified — nearest player to the ball when the point was lost"
                    }>
                        Defense: #{rally.defensive_player.jersey}
                        {rally.defensive_player.action ? ` (${rally.defensive_player.action})` : " (no action detected)"}
                    </span>
                )}
            </span>
            <span className="ma-rally-dur">{durationSec}s</span>
            {resultText && <span className={`ma-rally-result ${resultCls}`}>{resultText}</span>}
        </div>
    );
});
RallyRow.displayName = "RallyRow";
