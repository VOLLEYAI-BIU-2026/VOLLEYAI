import React, { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import "./JerseySetup.css";

const API = "http://localhost:5000";

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

export default function JerseySetup() {
    const { videoId } = useParams();
    const navigate    = useNavigate();

    const [myTeamColor, setMyTeamColor]     = useState("blue_white");
    const [opponentColor, setOpponentColor] = useState("black_white");
    const [loading, setLoading]             = useState(false);

    const pickMyTeam = (key) => {
        setMyTeamColor(key);
        if (opponentColor === key) {
            const fallback = COLOR_PRESETS.find(c => c.key !== key);
            if (fallback) setOpponentColor(fallback.key);
        }
    };

    const pickOpponent = (key) => {
        if (key === myTeamColor) return;
        setOpponentColor(key);
    };

    const myPreset  = COLOR_PRESETS.find(c => c.key === myTeamColor);
    const oppPreset = COLOR_PRESETS.find(c => c.key === opponentColor);

    const startAnalysis = async () => {
        setLoading(true);
        try {
            await fetch(`${API}/videos/${videoId}/jerseys`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ myTeamColor, opponentColor }),
            });
        } catch { /* non-blocking */ }

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
                    Pick each team's jersey colors so the AI can tell your players apart.
                    Jersey numbers are only read for <em>My Team</em>.
                </p>

                <div className="js-panels">
                    {/* ── My Team ── */}
                    <div className="js-panel">
                        <div className="js-panel-header">
                            <span className="js-section-label">My Team</span>
                            <span className="js-current-badge">
                                <span className="js-current-dot" style={swatchStyle(myPreset)} />
                                <span className="js-current-name">{myPreset?.label}</span>
                            </span>
                        </div>
                        <div className="js-swatch-grid">
                            {COLOR_PRESETS.map(c => (
                                <button
                                    key={c.key}
                                    type="button"
                                    title={c.label}
                                    className={`js-swatch-btn ${myTeamColor === c.key ? "active" : ""}`}
                                    onClick={() => pickMyTeam(c.key)}
                                >
                                    <span className="js-swatch-circle" style={swatchStyle(c)} />
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* ── Opponent ── */}
                    <div className="js-panel">
                        <div className="js-panel-header">
                            <span className="js-section-label">Opponent</span>
                            <span className="js-current-badge">
                                <span className="js-current-dot" style={swatchStyle(oppPreset)} />
                                <span className="js-current-name">{oppPreset?.label}</span>
                            </span>
                        </div>
                        <div className="js-swatch-grid">
                            {COLOR_PRESETS.map(c => {
                                const disabled = c.key === myTeamColor;
                                return (
                                    <button
                                        key={c.key}
                                        type="button"
                                        title={disabled ? "Already used by My Team" : c.label}
                                        className={`js-swatch-btn ${opponentColor === c.key ? "active" : ""} ${disabled ? "disabled" : ""}`}
                                        onClick={() => pickOpponent(c.key)}
                                        disabled={disabled}
                                    >
                                        <span className="js-swatch-circle" style={swatchStyle(c)} />
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                </div>

                <button
                    className="js-calib-btn"
                    onClick={async () => {
                        try {
                            await fetch(`${API}/videos/${videoId}/jerseys`, {
                                method: "POST",
                                credentials: "include",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ myTeamColor, opponentColor }),
                            });
                        } catch { /* non-blocking */ }
                        navigate(`/court-setup/${videoId}`);
                    }}
                >
                    🎯 כיול מגרש (אופציונלי)
                </button>

                <button
                    className="js-start-btn"
                    onClick={startAnalysis}
                    disabled={loading}
                >
                    {loading ? "Starting..." : "Start Analysis →"}
                </button>

                <button className="js-skip" onClick={() => navigate(`/match-analysis/${videoId}`)}>
                    Skip — use default (blue / white)
                </button>
            </div>
        </div>
    );
}
