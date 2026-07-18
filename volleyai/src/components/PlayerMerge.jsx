import { API_BASE } from "../config.js";
import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import "./PlayerMerge.css";

const API = API_BASE;

function labelFor(key, data) {
    if (data.jersey != null) return `#${data.jersey}`;
    return key.startsWith("id_") ? `Unlabeled (${key.slice(3)})` : key;
}

export default function PlayerMerge() {
    const navigate = useNavigate();
    const { videoId } = useParams();

    const [registry, setRegistry] = useState({});
    const [selected, setSelected] = useState(new Set());
    const [keepKey, setKeepKey] = useState(null);
    const [loading, setLoading] = useState(true);
    const [merging, setMerging] = useState(false);
    const [error, setError] = useState("");
    const [success, setSuccess] = useState("");

    function loadRegistry() {
        setLoading(true);
        fetch(`${API}/videos/${videoId}/player-registry`, { credentials: "include" })
            .then((r) => r.json())
            .then((data) => {
                if (data.status === "ok") setRegistry(data.registry);
                else setError("No player registry found for this match yet.");
            })
            .catch(() => setError("Failed to load player registry."))
            .finally(() => setLoading(false));
    }

    useEffect(loadRegistry, [videoId]);

    const entries = Object.entries(registry).sort(([, a], [, b]) => (b.event_count || 0) - (a.event_count || 0));

    function toggleSelect(key) {
        setError("");
        setSuccess("");
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(key)) {
                next.delete(key);
            } else {
                next.add(key);
            }
            // Default the canonical (kept) entry to whichever selected card has the most events.
            if (next.size > 0) {
                let best = null;
                for (const k of next) {
                    const d = registry[k];
                    if (!best || (d.event_count || 0) > (registry[best].event_count || 0)) best = k;
                }
                setKeepKey(best);
            } else {
                setKeepKey(null);
            }
            return next;
        });
    }

    async function handleMerge() {
        if (selected.size < 2 || !keepKey) return;
        setMerging(true);
        setError("");
        setSuccess("");
        try {
            const mergeKeys = [...selected].filter((k) => k !== keepKey);
            const res = await fetch(`${API}/videos/${videoId}/player-registry/merge`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ keepKey, mergeKeys }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.message || "Merge failed");
            setSuccess(`Merged ${mergeKeys.length} entr${mergeKeys.length === 1 ? "y" : "ies"} into ${labelFor(keepKey, registry[keepKey])}.`);
            setSelected(new Set());
            setKeepKey(null);
            loadRegistry();
        } catch (err) {
            setError(err.message || "Merge failed.");
        } finally {
            setMerging(false);
        }
    }

    if (loading) return <div className="pm-page"><div className="pm-loading">Loading...</div></div>;

    return (
        <div className="pm-page">
            <div className="pm-shell">
                <div className="pm-header">
                    <div className="pm-headerLeft">
                        <button className="pm-back" onClick={() => navigate(-1)}>←</button>
                        <div>
                            <div className="pm-breadcrumb">Match Analysis / Merge Players</div>
                            <h1 className="pm-title">Merge Players</h1>
                        </div>
                    </div>
                    <button
                        className="pm-mergeBtn"
                        onClick={handleMerge}
                        disabled={selected.size < 2 || merging}
                    >
                        {merging ? "Merging..." : `Merge Selected (${selected.size})`}
                    </button>
                </div>

                {error && <div className="pm-error">{error}</div>}
                {success && <div className="pm-success">{success}</div>}

                <div className="pm-hint">
                    Same physical player showing up as two different jersey numbers (e.g. a misread "2" that's
                    really "42")? Select both cards below, pick which number to keep, and merge them into one
                    identity — their events and stats will be combined.
                </div>

                <div className="pm-grid">
                    {entries.map(([key, data]) => {
                        const isSelected = selected.has(key);
                        const isKeep = keepKey === key && isSelected;
                        return (
                            <div
                                key={key}
                                className={`pm-card ${isSelected ? "pm-selected" : ""} ${isKeep ? "pm-keep" : ""}`}
                                onClick={() => toggleSelect(key)}
                            >
                                <div className="pm-thumb">
                                    {data.thumbnailUrl ? (
                                        <img src={`${API}${data.thumbnailUrl}`} alt={labelFor(key, data)} />
                                    ) : (
                                        <div className="pm-noThumb">?</div>
                                    )}
                                    <input
                                        type="checkbox"
                                        className="pm-checkbox"
                                        checked={isSelected}
                                        onChange={() => toggleSelect(key)}
                                        onClick={(e) => e.stopPropagation()}
                                    />
                                </div>
                                <div className="pm-cardBody">
                                    <div className="pm-label">{labelFor(key, data)}</div>
                                    <div className="pm-events">{data.event_count || 0} events</div>
                                    {isSelected && (
                                        <button
                                            type="button"
                                            className={`pm-keepBtn ${isKeep ? "active" : ""}`}
                                            onClick={(e) => { e.stopPropagation(); setKeepKey(key); }}
                                        >
                                            {isKeep ? "Keeping this number" : "Keep this number"}
                                        </button>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}
