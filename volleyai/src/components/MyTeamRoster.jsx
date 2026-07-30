import { API_BASE } from "../config.js";
import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import "./MyTeamRoster.css";

const API = API_BASE;

const POSITIONS = [
    { value: "",         label: "Position (optional)" },
    { value: "libero",   label: "Libero" },
    { value: "setter",   label: "Setter" },
    { value: "hitter",   label: "Hitter" },
    { value: "blocker",  label: "Blocker" },
];

function positionLabel(value) {
    return POSITIONS.find(p => p.value === value)?.label || "";
}

export default function MyTeamRoster() {
    const navigate = useNavigate();

    const [players, setPlayers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");

    const [jerseyNumber, setJerseyNumber] = useState("");
    const [name, setName] = useState("");
    const [position, setPosition] = useState("");

    const [teamName, setTeamName] = useState("");
    const [savedTeamName, setSavedTeamName] = useState("");
    const [teamNameSaving, setTeamNameSaving] = useState(false);

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch(`${API}/auth/my-team`, {
                    credentials: "include",
                    cache: "no-store",
                });
                const data = await res.json();
                if (res.ok) {
                    setPlayers(data.players || []);
                    setTeamName(data.teamName || "");
                    setSavedTeamName(data.teamName || "");
                }
            } catch { /* start empty */ }
            setLoading(false);
        })();
    }, []);

    async function saveTeamName() {
        const trimmed = teamName.trim();
        if (trimmed === savedTeamName) return;
        setTeamNameSaving(true);
        try {
            const res = await fetch(`${API}/auth/my-team/name`, {
                method: "PATCH",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ teamName: trimmed }),
            });
            const data = await res.json();
            if (res.ok) {
                setTeamName(data.teamName || "");
                setSavedTeamName(data.teamName || "");
            }
        } catch { /* leave field as typed on failure */ }
        setTeamNameSaving(false);
    }

    async function addPlayer(e) {
        e.preventDefault();
        setError("");

        const trimmedJersey = jerseyNumber.trim();
        if (!trimmedJersey) {
            setError("Enter a jersey number.");
            return;
        }
        if (players.some(p => p.jerseyNumber === trimmedJersey)) {
            setError(`#${trimmedJersey} is already on your team.`);
            return;
        }

        setSaving(true);
        try {
            const res = await fetch(`${API}/auth/my-team`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ jerseyNumber: trimmedJersey, name, position }),
            });
            const data = await res.json();
            if (!res.ok) {
                setError(data.message || "Failed to add player.");
                return;
            }
            setPlayers(data.players || []);
            setJerseyNumber("");
            setName("");
            setPosition("");
        } catch {
            setError("Server error. Please try again.");
        } finally {
            setSaving(false);
        }
    }

    async function removePlayer(playerId) {
        try {
            const res = await fetch(`${API}/auth/my-team/${playerId}`, {
                method: "DELETE",
                credentials: "include",
            });
            const data = await res.json();
            if (res.ok) setPlayers(data.players || []);
        } catch { /* leave list as-is on failure */ }
    }

    return (
        <div className="mt-page">
            <div className="mt-card">
                <button className="mt-back" onClick={() => navigate(-1)}>←</button>

                <div className="mt-icon">🏐</div>
                <h1 className="mt-title">My Team</h1>
                <p className="mt-sub">
                    Save your roster once — jersey number, name, and position — and reuse
                    it for every match instead of retyping it each time. Enable the
                    "Use My Team" toggle when setting up a new match to pull this in.
                </p>

                <div className="mt-teamNameRow">
                    <label className="mt-teamNameLabel" htmlFor="teamName">Team name</label>
                    <input
                        id="teamName"
                        className="mt-input mt-teamNameInput"
                        placeholder="e.g. Maccabi"
                        value={teamName}
                        onChange={(e) => setTeamName(e.target.value)}
                        onBlur={saveTeamName}
                        disabled={teamNameSaving}
                    />
                </div>

                <form className="mt-form" onSubmit={addPlayer}>
                    <input
                        className="mt-input mt-inputNumber"
                        placeholder="Jersey #"
                        value={jerseyNumber}
                        onChange={(e) => setJerseyNumber(e.target.value)}
                        inputMode="numeric"
                    />
                    <input
                        className="mt-input mt-inputName"
                        placeholder="Name (optional)"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                    />
                    <select
                        className="mt-select"
                        value={position}
                        onChange={(e) => setPosition(e.target.value)}
                    >
                        {POSITIONS.map(p => (
                            <option key={p.value} value={p.value}>{p.label}</option>
                        ))}
                    </select>
                    <button className="mt-addBtn" type="submit" disabled={saving}>
                        {saving ? "..." : "+ Add"}
                    </button>
                </form>

                {error && <div className="mt-error">{error}</div>}

                <div className="mt-roster">
                    {loading ? (
                        <div className="mt-empty">Loading roster...</div>
                    ) : players.length === 0 ? (
                        <div className="mt-empty">No players saved yet.</div>
                    ) : (
                        <div className="mt-list">
                            {players.map(p => (
                                <div key={p.playerId} className="mt-row">
                                    <span className="mt-badge">#{p.jerseyNumber}</span>
                                    <span className="mt-name">{p.name || "—"}</span>
                                    {p.position && <span className="mt-position">{positionLabel(p.position)}</span>}
                                    <button className="mt-removeBtn" onClick={() => removePlayer(p.playerId)} aria-label="Remove">
                                        ✕
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                <button className="mt-doneBtn" onClick={() => navigate(-1)}>
                    Done
                </button>
            </div>
        </div>
    );
}
