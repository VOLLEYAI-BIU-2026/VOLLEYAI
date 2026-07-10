import { API_BASE } from "../config.js";
import React, { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import "./JerseySetup.css";

const API = API_BASE;

// c1 = dominant jersey color, c2 = number/trim color (null = solid)
const COLOR_PRESETS = [
    // White base
    { key: "white_blue",    label: "White / Blue",     c1: "#f0f0f0", c2: "#2563eb" },
    { key: "white_navy",    label: "White / Navy",     c1: "#f0f0f0", c2: "#1e3a8a" },
    { key: "white_red",     label: "White / Red",      c1: "#f0f0f0", c2: "#dc2626" },
    { key: "white_green",   label: "White / Green",    c1: "#f0f0f0", c2: "#16a34a" },
    { key: "white_black",   label: "White / Black",    c1: "#f0f0f0", c2: "#111418" },
    // Blue
    { key: "blue_white",    label: "Blue / White",     c1: "#2563eb", c2: "#f0f0f0" },
    { key: "blue_gold",     label: "Blue / Gold",      c1: "#2563eb", c2: "#d97706" },
    { key: "blue_black",    label: "Blue / Black",     c1: "#2563eb", c2: "#111418" },
    { key: "blue_red",      label: "Blue / Red",       c1: "#2563eb", c2: "#dc2626" },
    // Navy
    { key: "navy_white",    label: "Navy / White",     c1: "#1e3a8a", c2: "#f0f0f0" },
    { key: "navy_gold",     label: "Navy / Gold",      c1: "#1e3a8a", c2: "#d97706" },
    { key: "navy_yellow",   label: "Navy / Yellow",    c1: "#1e3a8a", c2: "#eab308" },
    // Red
    { key: "red_white",     label: "Red / White",      c1: "#dc2626", c2: "#f0f0f0" },
    { key: "red_black",     label: "Red / Black",      c1: "#dc2626", c2: "#111418" },
    { key: "red_gold",      label: "Red / Gold",       c1: "#dc2626", c2: "#d97706" },
    // Maroon
    { key: "maroon_white",  label: "Maroon / White",   c1: "#7f1d1d", c2: "#f0f0f0" },
    { key: "maroon_gold",   label: "Maroon / Gold",    c1: "#7f1d1d", c2: "#d97706" },
    // Black
    { key: "black_white",   label: "Black / White",    c1: "#111418", c2: "#f0f0f0" },
    { key: "black_red",     label: "Black / Red",      c1: "#111418", c2: "#dc2626" },
    { key: "black_yellow",  label: "Black / Yellow",   c1: "#111418", c2: "#eab308" },
    { key: "black_gold",    label: "Black / Gold",     c1: "#111418", c2: "#d97706" },
    { key: "black_blue",    label: "Black / Blue",     c1: "#111418", c2: "#2563eb" },
    { key: "black_green",   label: "Black / Green",    c1: "#111418", c2: "#16a34a" },
    { key: "black_orange",  label: "Black / Orange",   c1: "#111418", c2: "#f97316" },
    { key: "black_purple",  label: "Black / Purple",   c1: "#111418", c2: "#9333ea" },
    // Yellow
    { key: "yellow_white",  label: "Yellow / White",   c1: "#eab308", c2: "#f0f0f0" },
    { key: "yellow_black",  label: "Yellow / Black",   c1: "#eab308", c2: "#111418" },
    { key: "yellow_blue",   label: "Yellow / Blue",    c1: "#eab308", c2: "#2563eb" },
    // Green
    { key: "green_white",   label: "Green / White",    c1: "#16a34a", c2: "#f0f0f0" },
    { key: "green_black",   label: "Green / Black",    c1: "#16a34a", c2: "#111418" },
    // Orange
    { key: "orange_white",  label: "Orange / White",   c1: "#f97316", c2: "#f0f0f0" },
    { key: "orange_black",  label: "Orange / Black",   c1: "#f97316", c2: "#111418" },
    // Purple
    { key: "purple_white",  label: "Purple / White",   c1: "#9333ea", c2: "#f0f0f0" },
    { key: "purple_gold",   label: "Purple / Gold",    c1: "#9333ea", c2: "#d97706" },
    { key: "purple_black",  label: "Purple / Black",   c1: "#9333ea", c2: "#111418" },
    // Gray
    { key: "gray_white",    label: "Gray / White",     c1: "#6b7280", c2: "#f0f0f0" },
    { key: "gray_black",    label: "Gray / Black",     c1: "#6b7280", c2: "#111418" },
    // Solid
    { key: "all_black",     label: "All Black",        c1: "#111418", c2: null },
    { key: "all_white",     label: "All White",        c1: "#f0f0f0", c2: null },
];

function swatchStyle(preset) {
    if (!preset) return {};
    const { c1, c2 } = preset;
    return {
        background: c2
            ? `linear-gradient(135deg, ${c1} 50%, ${c2} 50%)`
            : c1,
    };
}

// Manages one side's pair of colors (Team + Libero) inside a single shared
// swatch list. Interaction:
//   - 1st click on any swatch          -> sets T (team color)
//   - 2nd click on a *different* swatch -> sets L (libero color) — this is
//     how a libero becomes "registered" at all; if never clicked, L stays
//     unset (fully optional, matches "not every team has a libero")
//   - clicking directly on the T or L swatch "arms" that badge for reassignment
//   - any later click on a fresh swatch moves whichever badge is armed, or
//     if none is armed, moves whichever badge was most recently placed
function useTLPicker(defaultT) {
    const [tColor, setTColor]         = useState(defaultT);
    const [lColor, setLColor]         = useState(null);
    const [lastPlaced, setLastPlaced] = useState("T");
    const [armed, setArmed]           = useState(null);

    const handleClick = (key) => {
        if (key === tColor) { setArmed("T"); return; }
        if (key === lColor) { setArmed("L"); return; }

        const target = armed || (lColor === null ? "L" : lastPlaced);
        if (target === "T") setTColor(key); else setLColor(key);
        setLastPlaced(target);
        setArmed(null);
    };

    return { tColor, lColor, handleClick };
}

function TLPanel({ title, tColor, lColor, onClick, disabledKeys }) {
    const tPreset = COLOR_PRESETS.find(c => c.key === tColor);
    const lPreset = COLOR_PRESETS.find(c => c.key === lColor);

    return (
        <div className="js-panel">
            <div className="js-panel-header">
                <span className="js-section-label">{title}</span>
                <span className="js-current-badge-group">
                    <span className="js-current-badge">
                        <span className="js-current-dot" style={swatchStyle(tPreset)} />
                        <span className="js-current-name">T: {tPreset?.label}</span>
                    </span>
                    {lColor && (
                        <span className="js-current-badge">
                            <span className="js-current-dot" style={swatchStyle(lPreset)} />
                            <span className="js-current-name">L: {lPreset?.label}</span>
                        </span>
                    )}
                </span>
            </div>
            <div className="js-swatch-grid">
                {COLOR_PRESETS.map(c => {
                    const isT = c.key === tColor;
                    const isL = c.key === lColor;
                    const disabled = !isT && !isL && disabledKeys.includes(c.key);
                    return (
                        <button
                            key={c.key}
                            type="button"
                            title={disabled ? "Already used by the other side" : c.label}
                            className={`js-swatch-btn ${isT || isL ? "active" : ""} ${disabled ? "disabled" : ""}`}
                            onClick={() => onClick(c.key)}
                            disabled={disabled}
                        >
                            <span className="js-swatch-circle" style={swatchStyle(c)} />
                            {isT && <span className="js-swatch-watermark">T</span>}
                            {isL && <span className="js-swatch-watermark">L</span>}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

export default function JerseySetup() {
    const { videoId } = useParams();
    const navigate    = useNavigate();

    const team = useTLPicker("blue_white");
    const opp  = useTLPicker("black_white");
    const [loading, setLoading] = useState(false);
    const [isHomeTeam, setIsHomeTeam] = useState(true);

    const jerseyBody = () => ({
        myTeamColor: team.tColor,
        opponentColor: opp.tColor,
        liberoColor: team.lColor || "",
        opponentLiberoColor: opp.lColor || "",
        isHomeTeam,
    });

    const saveJerseys = async () => {
        try {
            await fetch(`${API}/videos/${videoId}/jerseys`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(jerseyBody()),
            });
        } catch { /* non-blocking */ }
    };

    const startAnalysis = async () => {
        setLoading(true);
        await saveJerseys();

        try {
            await fetch(`${API}/videos/${videoId}/start-analysis`, {
                method: "POST",
                credentials: "include",
            });
        } catch { /* pipeline starts in background */ }

        navigate(`/match-analysis/${videoId}`);
    };

    return (
        <div className="js-page">
            <div className="js-card">
                <button className="js-back" onClick={() => navigate(-1)}>←</button>

                <div className="js-icon">🏐</div>
                <h1 className="js-title">Setup Your Team</h1>
                <p className="js-sub">
                    Click a color for a side's main jersey (T), then click a different
                    color if that side has a libero (L). Click a T/L swatch again to
                    move it elsewhere. Jersey numbers are only read for <em>My Team</em>.
                </p>

                <div className="js-panels">
                    <TLPanel
                        title="My Team"
                        tColor={team.tColor}
                        lColor={team.lColor}
                        onClick={team.handleClick}
                        disabledKeys={[opp.tColor, opp.lColor].filter(Boolean)}
                    />
                    <TLPanel
                        title="Opponent"
                        tColor={opp.tColor}
                        lColor={opp.lColor}
                        onClick={opp.handleClick}
                        disabledKeys={[team.tColor, team.lColor].filter(Boolean)}
                    />
                </div>

                <div className="js-home-row">
                    <span className="js-home-title">Home</span>
                    <button
                        type="button"
                        className={`js-toggle ${isHomeTeam ? "on" : ""}`}
                        onClick={() => setIsHomeTeam(v => !v)}
                        aria-pressed={isHomeTeam}
                        aria-label="Toggle whether my team is Home or Guest on the scoreboard"
                    >
                        <span className="js-toggle-knob" />
                    </button>
                </div>

                <button
                    className="js-calib-btn"
                    onClick={() => navigate(`/add-players/${videoId}`)}
                >
                    📋 Add Players (optional)
                </button>

                <button
                    className="js-calib-btn"
                    onClick={async () => {
                        await saveJerseys();
                        navigate(`/court-setup/${videoId}`);
                    }}
                >
                    🎯 Court Calibration (optional)
                </button>

                <button
                    className="js-start-btn"
                    onClick={startAnalysis}
                    disabled={loading}
                >
                    {loading ? "Starting..." : "Start Analysis →"}
                </button>

                <button
                    className="js-skip"
                    onClick={async () => {
                        // Still saves whatever is currently selected — "skip" only
                        // means "don't require picking anything", not "discard any
                        // picks already made". Previously this navigated away with
                        // no save at all, silently dropping any in-progress color/
                        // libero/home-toggle selection.
                        await saveJerseys();
                        navigate(`/match-analysis/${videoId}`);
                    }}
                >
                    Skip — use current selection
                </button>
            </div>
        </div>
    );
}
