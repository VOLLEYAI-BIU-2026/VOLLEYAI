import { API_BASE } from "../config.js";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import "./PlayerProfile.css";

const API = API_BASE;

const POSITION_LABEL = { libero: "Libero", setter: "Setter", hitter: "Hitter", blocker: "Blocker", "": "" };

const ACTION_COLOR = {
    service: "#f97316", attack: "#ef4444", setting: "#06b6d4",
    "defense-move": "#fb923c", block: "#a855f7",
};

// 6 axes at 60° apart, matching the existing .pp-radarAxis rotations
// (0/60/120/180/240/300 = top/rightTop/rightBottom/bottom/leftBottom/leftTop).
// Our schema has no separate "pass/reception" stat -- passing and digging
// are the same tracked skill here, so Pass reuses the Defense number rather
// than showing a fabricated metric.
const RADAR_AXES = [
    { label: "Attack",  angle: 0,   cat: "attack",  field: "TA" },
    { label: "Block",   angle: 60,  cat: "block",   field: "TA" },
    { label: "Serve",   angle: 120, cat: "serve",   field: "TA" },
    { label: "Defense", angle: 180, cat: "defence", field: "TA" },
    { label: "Pass",    angle: 240, cat: "defence", field: "TA" },
    { label: "Set",     angle: 300, cat: "set",     field: "TA" },
];
const RADAR_MAX_RADIUS_PCT = 46;

const CHART_TABS = [
    { label: "Attack",  action: "attack" },
    { label: "Block",   action: "block" },
    { label: "Serve",   action: "service" },
    { label: "Defense", action: "defense-move" },
    { label: "Set",     action: "setting" },
];

function pct(val) {
    if (val === null || val === undefined) return "-";
    return (Number(val) * 100).toFixed(1) + "%";
}
function num(val) {
    return val === null || val === undefined ? "-" : val;
}

export default function PlayerProfile() {
    const { videoId, jersey } = useParams();
    const navigate = useNavigate();

    const [video, setVideo] = useState(null);
    const [allStats, setAllStats] = useState({});
    const [rosterPlayer, setRosterPlayer] = useState(null);
    const [rallies, setRallies] = useState([]);
    const [allActions, setAllActions] = useState([]);
    const [thumbnailUrl, setThumbnailUrl] = useState(null);
    const [loading, setLoading] = useState(true);
    const [chartAction, setChartAction] = useState("attack");

    useEffect(() => {
        (async () => {
            try {
                const [videoRes, statsRes, rosterRes, rallyRes, registryRes] = await Promise.all([
                    fetch(`${API}/videos/${videoId}`, { credentials: "include" }),
                    fetch(`${API}/videos/${videoId}/player-stats`, { credentials: "include" }),
                    fetch(`${API}/videos/${videoId}/team-roster`, { credentials: "include" }),
                    fetch(`${API}/videos/${videoId}/rally-analysis`, { credentials: "include" }),
                    fetch(`${API}/videos/${videoId}/player-registry`, { credentials: "include" }),
                ]);
                if (videoRes.ok) setVideo((await videoRes.json()).video);
                if (statsRes.ok) {
                    const d = await statsRes.json();
                    if (d.status === "done") setAllStats(d.stats || {});
                }
                if (rosterRes.ok) {
                    const d = await rosterRes.json();
                    const match = (d.players || []).find(p => String(p.jerseyNumber) === String(jersey));
                    setRosterPlayer(match || null);
                }
                if (rallyRes.ok) {
                    const d = await rallyRes.json();
                    setRallies(d.rallies || []);
                    setAllActions(d.all_actions || []);
                }
                if (registryRes.ok) {
                    const d = await registryRes.json();
                    if (d.status === "ok") {
                        const entry = Object.values(d.registry).find(e => String(e.jersey) === String(jersey));
                        if (entry?.thumbnailUrl) setThumbnailUrl(entry.thumbnailUrl);
                    }
                }
            } catch {}
            setLoading(false);
        })();
    }, [videoId, jersey]);

    // Upserts this jersey's position on the per-video roster -- if it was
    // already imported from "My Team" (importMyTeam already carries position
    // over automatically), the dropdown below just reflects that; this only
    // needs to actually write something when setting/changing it here.
    async function handlePositionChange(newPosition) {
        try {
            const res = await fetch(`${API}/videos/${videoId}/team-roster/position`, {
                method: "PATCH",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    jerseyNumber: jersey,
                    teamSide: rosterPlayer?.teamSide || "my_team",
                    position: newPosition,
                }),
            });
            if (res.ok) {
                const data = await res.json();
                const updated = (data.players || []).find(p => String(p.jerseyNumber) === String(jersey));
                setRosterPlayer(updated || null);
            }
        } catch {}
    }

    const stats = allStats[jersey] || {};

    // Same headline-stat + tiebreak logic as the Statistics page's crown —
    // whichever player leads a category's primary stat, breaking a raw-count
    // tie by efficiency, wins that category's crown. Recomputed here per
    // player so the profile can show which crowns (if any) THIS player holds.
    const crowns = useMemo(() => {
        const rankFns = {
            Attack:  (p) => [p.attack?.K ?? 0, p.attack?.["ATK%"] ?? -Infinity],
            Serve:   (p) => [p.serve?.SA ?? 0, p.serve?.EFF ?? -Infinity],
            Set:     (p) => [p.set?.AST ?? 0, p.set?.TA ?? 0],
            Defence: (p) => [p.defence?.DS ?? 0, p.defence?.["DS%"] ?? -Infinity],
            Block:   (p) => [p.block?.BK ?? 0, p.block?.["WIN%"] ?? -Infinity],
        };
        const compareRank = (a, b) => (a[0] !== b[0] ? b[0] - a[0] : b[1] - a[1]);
        const players = Object.entries(allStats);
        const held = [];
        for (const [label, rankFn] of Object.entries(rankFns)) {
            if (players.length === 0) continue;
            const ranked = [...players].sort(([, a], [, b]) => compareRank(rankFn(a), rankFn(b)));
            const topRank = rankFn(ranked[0][1]);
            if (topRank[0] <= 0) continue;
            const winners = ranked.filter(([, p]) => compareRank(rankFn(p), topRank) === 0).map(([k]) => k);
            if (winners.includes(String(jersey))) held.push(label);
        }
        return held;
    }, [allStats, jersey]);

    const topSkill = useMemo(() => {
        const candidates = [
            { label: "Kills",   value: stats.attack?.K ?? 0 },
            { label: "Aces",    value: stats.serve?.SA ?? 0 },
            { label: "Assists", value: stats.set?.AST ?? 0 },
            { label: "Digs",    value: stats.defence?.DS ?? 0 },
            { label: "Blocks",  value: stats.block?.BK ?? 0 },
        ];
        return candidates.reduce((a, b) => (b.value > a.value ? b : a));
    }, [stats]);

    const playerActions = useMemo(
        () => allActions
            .filter(a => String(a.player_jersey) === String(jersey)
                || (a.co_players || []).some(p => String(p) === String(jersey)))
            .sort((a, b) => a.frame - b.frame),
        [allActions, jersey]
    );

    // Only offer tabs this player actually has at least one real action in --
    // a libero with zero attacks/blocks shouldn't get an "Attack" tab that
    // just leads to an all-zero chart every time.
    const availableChartTabs = useMemo(() => {
        const actionTypes = new Set(playerActions.map(a => a.action));
        return CHART_TABS.filter(t => actionTypes.has(t.action));
    }, [playerActions]);

    useEffect(() => {
        if (availableChartTabs.length === 0) return;
        if (!availableChartTabs.some(t => t.action === chartAction)) {
            setChartAction(availableChartTabs[0].action);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [availableChartTabs]);

    // Dynamic radar clip-path polygon, in the same coordinate scheme as the
    // original skeleton (percentages within the 114px .pp-radarShape box).
    const radarClipPath = useMemo(() => {
        const maxByCat = {};
        for (const ax of RADAR_AXES) {
            const k = `${ax.cat}.${ax.field}`;
            if (maxByCat[k] != null) continue;
            maxByCat[k] = Math.max(1, ...Object.values(allStats).map(s => s?.[ax.cat]?.[ax.field] ?? 0));
        }
        const points = RADAR_AXES.map(ax => {
            const mine = stats?.[ax.cat]?.[ax.field] ?? 0;
            const v = Math.min(1, mine / maxByCat[`${ax.cat}.${ax.field}`]);
            const rad = (ax.angle * Math.PI) / 180;
            const x = 50 + v * RADAR_MAX_RADIUS_PCT * Math.sin(rad);
            const y = 50 - v * RADAR_MAX_RADIUS_PCT * Math.cos(rad);
            return `${x.toFixed(1)}% ${y.toFixed(1)}%`;
        });
        return `polygon(${points.join(", ")})`;
    }, [allStats, stats]);

    const rallyBars = useMemo(() => {
        const filtered = allActions.filter(a => a.action === chartAction
            && (String(a.player_jersey) === String(jersey) || (a.co_players || []).some(p => String(p) === String(jersey))));
        return rallies.map(r => ({
            rally: r.rally_id,
            count: filtered.filter(a => a.frame >= r.start_frame && a.frame <= r.end_frame).length,
        }));
    }, [allActions, rallies, chartAction, jersey]);
    const maxBar = Math.max(1, ...rallyBars.map(b => b.count));

    if (loading) {
        return (
            <div className="pp-page">
                <div className="pp-shell"><div className="pp-heroCard">Loading…</div></div>
            </div>
        );
    }

    const name = rosterPlayer?.manualName || `#${jersey}`;
    const position = POSITION_LABEL[rosterPlayer?.position || ""];
    const teamName = rosterPlayer?.teamSide === "opponent" ? (video?.teamB || "Opponent") : (video?.teamA || "My Team");

    return (
        <div className="pp-page">
            <div className="pp-shell">
                {/* Top breadcrumb */}
                <div className="pp-topline">
                    <div className="pp-breadcrumbWrap">
                        <button className="pp-backBtn" type="button" aria-label="Back" onClick={() => navigate(-1)}>←</button>
                        <div className="pp-breadcrumb">Statistics / Player Profile</div>
                    </div>
                </div>

                {/* Hero */}
                <section className="pp-heroCard">
                    <div className="pp-heroLeft">
                        <div className="pp-avatarWrap">
                            <div
                                className="pp-avatar"
                                style={thumbnailUrl ? {
                                    backgroundImage: `url(${API}${thumbnailUrl})`,
                                    backgroundSize: "cover",
                                    backgroundPosition: "center",
                                } : undefined}
                            />
                            <div className="pp-jerseyTag">#{jersey}</div>
                        </div>

                        <div className="pp-playerInfo">
                            <div className="pp-nameRow">
                                <h1 className="pp-playerName">{name}</h1>
                                {position && <span className="pp-roleTag">{position.toUpperCase()}</span>}
                            </div>
                            <div className="pp-teamName">{teamName}</div>
                            <div className="pp-divider" />
                            <div className="pp-metaRow">
                                <div className="pp-metaItem">{stats.total_events ?? 0} total actions</div>
                                <div className="pp-metaItem">
                                    <select
                                        className="pp-positionSelect"
                                        value={rosterPlayer?.position || ""}
                                        onChange={(e) => handlePositionChange(e.target.value)}
                                    >
                                        <option value="">+ Position</option>
                                        <option value="libero">Libero</option>
                                        <option value="setter">Setter</option>
                                        <option value="hitter">Hitter</option>
                                        <option value="blocker">Blocker</option>
                                    </select>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="pp-highlightCard">
                        <div className="pp-highlightTitle">🏆 Highlights</div>
                        {crowns.length > 0 ? (
                            <div className="pp-crownRow">
                                {crowns.map((c) => (
                                    <span key={c} className="pp-crownBadge">👑 {c}</span>
                                ))}
                            </div>
                        ) : topSkill.value > 0 ? (
                            <div className="pp-topSkill">
                                <span className="pp-topSkillValue">{topSkill.value}</span>
                                <span className="pp-topSkillLabel">{topSkill.label}</span>
                            </div>
                        ) : (
                            <div className="pp-topSkillEmpty">No standout stat yet</div>
                        )}
                    </div>

                    <div className="pp-heroRight">
                        <button className="pp-statsBtn" type="button" onClick={() => navigate(`/match-statistics/${videoId}`)}>
                            View Full Stats
                        </button>
                    </div>
                </section>

                {/* Main content */}
                <div className="pp-content">
                    <div className="pp-mainCol">
                        <div className="pp-sectionTitle">
                            <span className="pp-sectionIcon">↗</span>
                            <span>Key Performance Metrics</span>
                        </div>

                        <div className="pp-metricsGrid">
                            <MetricCard title="KILLS" value={num(stats.attack?.K)} tag={`${num(stats.attack?.TA)} attempts`} />
                            <MetricCard title="ATTACK %" value={pct(stats.attack?.["ATK%"])} tag={`${num(stats.attack?.E)} errors`} />
                            <MetricCard title="SERVE ACES" value={num(stats.serve?.SA)} tag={`${pct(stats.serve?.EFF)} eff`} />
                            <MetricCard title="BLOCKS" value={num(stats.block?.BK)} tag={`${num(stats.block?.TA)} attempts`} />
                            <MetricCard title="DIGS" value={num(stats.defence?.DS)} tag={pct(stats.defence?.["DS%"])} />
                            <MetricCard title="ASSISTS" value={num(stats.set?.AST)} tag={`${num(stats.set?.TA)} sets`} />
                        </div>

                        <div className="pp-bottomGrid">
                            {/* Left chart card */}
                            <div className="pp-chartCard">
                                {availableChartTabs.length === 0 ? (
                                    <div className="pp-noData">No action data recorded for this player yet.</div>
                                ) : (
                                    <>
                                        <div className="pp-chartTabs">
                                            {availableChartTabs.map(t => (
                                                <button
                                                    key={t.action}
                                                    type="button"
                                                    className={`pp-chartTab ${chartAction === t.action ? "active" : ""}`}
                                                    onClick={() => setChartAction(t.action)}
                                                >
                                                    {t.label}
                                                </button>
                                            ))}
                                        </div>

                                        <div className="pp-cardTitle">{availableChartTabs.find(t => t.action === chartAction)?.label} per Rally</div>

                                        <div className="pp-chartPlaceholder">
                                            <div className="pp-chartGridLines"><span /><span /><span /><span /></div>
                                            <div className="pp-barsWrap">
                                                {!rallyBars.length && <div className="pp-noData">No rally data.</div>}
                                                {rallyBars.map(b => (
                                                    <div key={b.rally} className="pp-barGroup" title={`Rally ${b.rally}: ${b.count}`}>
                                                        <div className="pp-barTrack">
                                                            <div
                                                                className="pp-bar"
                                                                style={{
                                                                    height: `${Math.max(4, (b.count / maxBar) * 100)}%`,
                                                                    background: b.count ? ACTION_COLOR[chartAction] : "#e2e8f0",
                                                                }}
                                                            />
                                                        </div>
                                                        <div className="pp-barLabel">R{b.rally}</div>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    </>
                                )}
                            </div>

                            {/* Right chart card */}
                            <div className="pp-radarCard">
                                <div className="pp-cardTitle">Overall Skill Profile</div>
                                <div className="pp-radarWrap">
                                    <div className="pp-radar">
                                        <div className="pp-radarRing ring1" />
                                        <div className="pp-radarRing ring2" />
                                        <div className="pp-radarRing ring3" />
                                        <div className="pp-radarRing ring4" />
                                        <div className="pp-radarAxis axis1" />
                                        <div className="pp-radarAxis axis2" />
                                        <div className="pp-radarAxis axis3" />
                                        <div className="pp-radarAxis axis4" />
                                        <div className="pp-radarAxis axis5" />
                                        <div className="pp-radarAxis axis6" />
                                        <div className="pp-radarShape" style={{ clipPath: radarClipPath }} />
                                    </div>
                                    <div className="pp-radarLabels">
                                        <span className="top">Attack</span>
                                        <span className="rightTop">Block</span>
                                        <span className="rightBottom">Serve</span>
                                        <span className="bottom">Defense</span>
                                        <span className="leftBottom">Pass</span>
                                        <span className="leftTop">Set</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Right side */}
                    <aside className="pp-sideCol">
                        <div className="pp-actionsCard">
                            <div className="pp-actionsHeader">
                                <div className="pp-actionsTitle">▢ Actions ({playerActions.length})</div>
                            </div>

                            <div className="pp-actionsList">
                                {!playerActions.length && (
                                    <div className="pp-noData" style={{ padding: 16 }}>No actions recorded for this player.</div>
                                )}
                                {playerActions.map((a, i) => (
                                    <button
                                        key={i}
                                        className="pp-actionItem"
                                        onClick={() => navigate(`/match-analysis/${videoId}?seek=${a.time_sec}`)}
                                    >
                                        <div className="pp-actionDotWrap">
                                            <span className="pp-actionDot" style={{ background: ACTION_COLOR[a.action] ?? "#888" }} />
                                        </div>
                                        <div className="pp-actionText">
                                            <div className="pp-actionMain">{a.action_label}</div>
                                            <div className="pp-actionSub">
                                                {a.time_str}
                                                {typeof a.confidence === "number" ? ` · ${Math.round(a.confidence * 100)}%` : ""}
                                            </div>
                                        </div>
                                        <div className="pp-actionArrow">›</div>
                                    </button>
                                ))}
                            </div>
                        </div>
                    </aside>
                </div>
            </div>
        </div>
    );
}

function MetricCard({ title, value, tag }) {
    return (
        <div className="pp-metricCard">
            <div className="pp-metricTitle">{title}</div>
            <div className="pp-metricValue">{value}</div>
            <div className="pp-metricTag">{tag}</div>
        </div>
    );
}
