import { API_BASE } from "../config.js";
import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import "./PlayerRegistry.css";

const API = API_BASE;

export default function PlayerRegistry() {
    const navigate = useNavigate();
    const [registry, setRegistry] = useState({});
    const [edits, setEdits] = useState({});
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState("");
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        fetch(`${API}/videos/player-registry`, { credentials: "include" })
            .then((r) => r.json())
            .then((data) => {
                if (data.status === "ok") setRegistry(data.registry);
                else setError("No registry found. Run triple_detection.py first.");
            })
            .catch(() => setError("Failed to load registry."))
            .finally(() => setLoading(false));
    }, []);

    const players = Object.entries(registry)
        .filter(([, data]) => data.confirmed || data.event_count >= 5)
        .sort(([, a], [, b]) => b.event_count - a.event_count);

    function handleChange(bid, value) {
        setEdits((prev) => ({ ...prev, [bid]: value }));
    }

    function getJersey(bid, data) {
        if (bid in edits) return edits[bid];
        return data.jersey !== null && data.jersey !== undefined ? String(data.jersey) : "";
    }

    async function handleSave() {
        setSaving(true);
        setSaved(false);
        setError("");
        try {
            const res = await fetch(`${API}/videos/player-registry`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(edits),
            });
            if (!res.ok) throw new Error();
            setSaved("saved");
            const data = await fetch(`${API}/videos/player-registry`, { credentials: "include" }).then((r) => r.json());
            if (data.status === "ok") { setRegistry(data.registry); setEdits({}); }
        } catch {
            setError("Save failed.");
        } finally {
            setSaving(false);
        }
    }

    async function handleSaveAndRecalculate() {
        setSaving(true);
        setSaved(false);
        setError("");
        try {
            const res = await fetch(`${API}/videos/player-registry/recalculate`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(edits),
            });
            if (!res.ok) throw new Error();
            setSaved("recalculated");
            const data = await fetch(`${API}/videos/player-registry`, { credentials: "include" }).then((r) => r.json());
            if (data.status === "ok") { setRegistry(data.registry); setEdits({}); }
        } catch {
            setError("Recalculation failed.");
        } finally {
            setSaving(false);
        }
    }

    if (loading) return <div className="pr-page"><div className="pr-loading">Loading...</div></div>;

    return (
        <div className="pr-page">
            <div className="pr-shell">
                <div className="pr-header">
                    <div className="pr-headerLeft">
                        <button className="pr-back" onClick={() => navigate(-1)}>â†</button>
                        <div>
                            <div className="pr-breadcrumb">Analytics / Player Registry</div>
                            <h1 className="pr-title">Player Registry</h1>
                        </div>
                    </div>
                    <div className="pr-headerRight">
                        <button className="pr-saveBtn" onClick={handleSave} disabled={saving || Object.keys(edits).length === 0}>
                            {saving ? "Saving..." : "Save"}
                        </button>
                        <button className="pr-recalcBtn" onClick={handleSaveAndRecalculate} disabled={saving}>
                            {saving ? "Calculating..." : "Save & Recalculate Stats"}
                        </button>
                        <button className="pr-statsBtn" onClick={() => navigate("/match-statistics")}>
                            Statistics â†’
                        </button>
                        <button className="pr-statsBtn" onClick={() => navigate("/match-analysis")}>
                            Analysis â†’
                        </button>
                    </div>
                </div>

                {error && <div className="pr-error">{error}</div>}
                {saved === "saved" && <div className="pr-success">Saved! Click "Save & Recalculate Stats" to update statistics.</div>}
                {saved === "recalculated" && <div className="pr-success">âœ“ Stats recalculated! <span className="pr-link" onClick={() => navigate("/match-statistics")}>View Statistics â†’</span></div>}

                <div className="pr-hint">
                    Players with <span className="pr-green">green border</span> were detected automatically.
                    Fill in jersey numbers for the rest.
                </div>

                <div className="pr-grid">
                    {players.map(([bid, data]) => {
                        const jersey = getJersey(bid, data);
                        const isConfirmed = data.confirmed && !(bid in edits);
                        return (
                            <div key={bid} className={`pr-card ${isConfirmed ? "pr-confirmed" : ""}`}>
                                <div className="pr-thumb">
                                    {data.thumbnailUrl ? (
                                        <img src={`${API}${data.thumbnailUrl}`} alt={`Player ${bid}`} />
                                    ) : (
                                        <div className="pr-noThumb">?</div>
                                    )}
                                </div>
                                <div className="pr-cardBody">
                                    <div className="pr-events">{data.event_count} events</div>
                                    <div className="pr-jerseyRow">
                                        <span className="pr-hash">#</span>
                                        <input
                                            className="pr-jerseyInput"
                                            type="number"
                                            min="1"
                                            max="99"
                                            placeholder="?"
                                            value={jersey}
                                            onChange={(e) => handleChange(bid, e.target.value)}
                                        />
                                        {isConfirmed && <span className="pr-check">âœ“</span>}
                                    </div>
                                    <div className="pr-bid">ID {bid}</div>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
