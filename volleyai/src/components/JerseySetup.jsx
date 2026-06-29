import React, { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import "./JerseySetup.css";

const API = "http://localhost:5000";

export default function JerseySetup() {
    const { videoId } = useParams();
    const navigate    = useNavigate();

    const [players, setPlayers] = useState([]);   // [{jersey, name}]
    const [jersey, setJersey]   = useState("");
    const [name, setName]       = useState("");
    const [error, setError]     = useState("");
    const [loading, setLoading] = useState(false);

    const addPlayer = () => {
        const num = parseInt(jersey.trim(), 10);
        if (isNaN(num) || num < 1 || num > 99) {
            setError("Enter a jersey number between 1 and 99");
            return;
        }
        if (players.some(p => p.jersey === num)) {
            setError(`#${num} already added`);
            return;
        }
        setPlayers(prev =>
            [...prev, { jersey: num, name: name.trim() }]
                .sort((a, b) => a.jersey - b.jersey)
        );
        setJersey("");
        setName("");
        setError("");
    };

    const removePlayer = (n) => setPlayers(prev => prev.filter(p => p.jersey !== n));

    const handleKey = (e) => { if (e.key === "Enter") addPlayer(); };

    const startAnalysis = async () => {
        setLoading(true);
        try {
            await fetch(`${API}/videos/${videoId}/jerseys`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ players }),
            });
        } catch { /* non-blocking */ }
        navigate(`/match-analysis/${videoId}`);
    };

    return (
        <div className="js-page">
            <div className="js-card">
                <button className="js-back" onClick={() => navigate(-1)}>←</button>

                <div className="js-icon">🏐</div>
                <h1 className="js-title">Setup Your Team</h1>
                <p className="js-sub">
                    Add your players' jersey numbers and names so the AI can identify them accurately.
                </p>

                <div className="js-input-row">
                    <input
                        className="js-input js-input-num"
                        type="number"
                        min="1" max="99"
                        placeholder="#"
                        value={jersey}
                        onChange={e => { setJersey(e.target.value); setError(""); }}
                        onKeyDown={handleKey}
                    />
                    <input
                        className="js-input js-input-name"
                        type="text"
                        placeholder="Player name (optional)"
                        value={name}
                        onChange={e => setName(e.target.value)}
                        onKeyDown={handleKey}
                    />
                    <button className="js-add-btn" onClick={addPlayer}>Add</button>
                </div>

                {error && <div className="js-error">{error}</div>}

                <div className="js-players">
                    {players.length === 0 && (
                        <div className="js-empty">No players added yet</div>
                    )}
                    {players.map(p => (
                        <div key={p.jersey} className="js-player-row">
                            <span className="js-badge">#{p.jersey}</span>
                            <span className="js-pname">{p.name || <span className="js-noname">No name</span>}</span>
                            <button className="js-remove" onClick={() => removePlayer(p.jersey)}>×</button>
                        </div>
                    ))}
                </div>

                <button
                    className="js-start-btn"
                    onClick={startAnalysis}
                    disabled={loading}
                >
                    {loading ? "Starting..." : "Start Analysis →"}
                </button>

                <button className="js-skip" onClick={() => navigate(`/match-analysis/${videoId}`)}>
                    Skip — run without player list
                </button>
            </div>
        </div>
    );
}
