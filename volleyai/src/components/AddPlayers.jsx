import { API_BASE } from "../config.js";
import React, { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import "./AddPlayers.css";

const API = API_BASE;

export default function AddPlayers() {
    const { videoId } = useParams();
    const navigate = useNavigate();

    const [players, setPlayers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

    const [jerseyNumber, setJerseyNumber] = useState("");
    const [manualName, setManualName] = useState("");
    const [teamSide, setTeamSide] = useState("my_team");
    const [useMyTeam, setUseMyTeam] = useState(false);
    const [importing, setImporting] = useState(false);

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch(`${API}/videos/${videoId}/team-roster`, {
                    credentials: "include",
                    cache: "no-store",
                });
                const data = await res.json();
                if (res.ok) setPlayers(data.players || []);
            } catch { /* start empty */ }
            setLoading(false);
        })();
    }, [videoId]);

    async function handleUseMyTeamToggle() {
        const next = !useMyTeam;
        setUseMyTeam(next);
        if (!next) return; // turning off just stops future auto-imports — already-imported players stay

        setImporting(true);
        try {
            const res = await fetch(`${API}/videos/${videoId}/team-roster/import-my-team`, {
                method: "POST",
                credentials: "include",
            });
            const data = await res.json();
            if (res.ok) setPlayers(data.players || []);
        } catch { /* leave roster as-is on failure */ }
        setImporting(false);
    }

    async function addPlayer(e) {
        e.preventDefault();
        setError("");

        const trimmedJersey = jerseyNumber.trim();
        if (!trimmedJersey) {
            setError("Enter a jersey number.");
            return;
        }
        if (players.some(p => p.jerseyNumber === trimmedJersey && p.teamSide === teamSide)) {
            setError(`#${trimmedJersey} is already on this roster.`);
            return;
        }

        setSaving(true);
        try {
            const res = await fetch(`${API}/videos/${videoId}/team-roster/create-player`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ jerseyNumber: trimmedJersey, manualName, teamSide }),
            });
            const data = await res.json();
            if (!res.ok) {
                setError(data.message || "Failed to add player.");
                return;
            }
            setPlayers(data.players || []);
            setJerseyNumber("");
            setManualName("");
        } catch {
            setError("Server error. Please try again.");
        } finally {
            setSaving(false);
        }
    }

    async function removePlayer(playerId) {
        try {
            const res = await fetch(`${API}/videos/${videoId}/team-roster/${playerId}`, {
                method: "DELETE",
                credentials: "include",
            });
            const data = await res.json();
            if (res.ok) setPlayers(data.players || []);
        } catch { /* leave list as-is on failure */ }
    }

    const myTeam = players.filter(p => p.teamSide === "my_team");
    const opponent = players.filter(p => p.teamSide === "opponent");
    const other = players.filter(p => p.teamSide !== "my_team" && p.teamSide !== "opponent");

    function renderGroup(label, group) {
        if (!group.length) return null;
        return (
            <div className="ap-group">
                <div className="ap-groupLabel">{label}</div>
                <div className="ap-list">
                    {group.map(p => (
                        <div key={p.playerId} className="ap-row">
                            <span className="ap-badge">#{p.jerseyNumber || "?"}</span>
                            <span className="ap-name">{p.manualName || "—"}</span>
                            {p.position && <span className="ap-position">{p.position}</span>}
                            <button className="ap-removeBtn" onClick={() => removePlayer(p.playerId)} aria-label="Remove">
                                ✕
                            </button>
                        </div>
                    ))}
                </div>
            </div>
        );
    }

    return (
        <div className="ap-page">
            <div className="ap-card">
                <button className="ap-back" onClick={() => navigate(-1)}>←</button>

                <div className="ap-icon">📋</div>
                <h1 className="ap-title">Add Your Players</h1>
                <p className="ap-sub">
                    Entering your roster's jersey numbers ahead of time helps the AI read them
                    more accurately — it only has to match against your real numbers instead of
                    guessing blindly. Completely optional; you can skip this and analyze without it.
                </p>

                <div className="ap-myTeamRow">
                    <button
                        type="button"
                        className={`ap-toggle ${useMyTeam ? "on" : ""}`}
                        onClick={handleUseMyTeamToggle}
                        aria-pressed={useMyTeam}
                        aria-label="Use My Team roster"
                        disabled={importing}
                    >
                        <span className="ap-toggle-knob" />
                    </button>
                    <span className="ap-myTeamLabel">
                        Use My Team {importing && "— importing..."}
                    </span>
                </div>

                <form className="ap-form" onSubmit={addPlayer}>
                    <input
                        className="ap-input ap-inputNumber"
                        placeholder="Jersey #"
                        value={jerseyNumber}
                        onChange={(e) => setJerseyNumber(e.target.value)}
                        inputMode="numeric"
                    />
                    <input
                        className="ap-input ap-inputName"
                        placeholder="Name (optional)"
                        value={manualName}
                        onChange={(e) => setManualName(e.target.value)}
                    />
                    <select
                        className="ap-select"
                        value={teamSide}
                        onChange={(e) => setTeamSide(e.target.value)}
                    >
                        <option value="my_team">My Team</option>
                        <option value="opponent">Opponent</option>
                    </select>
                    <button className="ap-addBtn" type="submit" disabled={saving}>
                        {saving ? "..." : "+ Add"}
                    </button>
                </form>

                {error && <div className="ap-error">{error}</div>}

                <div className="ap-roster">
                    {loading ? (
                        <div className="ap-empty">Loading roster...</div>
                    ) : players.length === 0 ? (
                        <div className="ap-empty">No players added yet.</div>
                    ) : (
                        <>
                            {renderGroup("My Team", myTeam)}
                            {renderGroup("Opponent", opponent)}
                            {renderGroup("Other", other)}
                        </>
                    )}
                </div>

                <button className="ap-doneBtn" onClick={() => navigate(-1)}>
                    Done
                </button>
            </div>
        </div>
    );
}
