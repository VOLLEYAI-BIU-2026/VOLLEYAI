import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import "./TeamsRoster.css";

const API = "http://localhost:5000";

export default function TeamsRoster() {
    const { videoId } = useParams();
    const navigate = useNavigate();
    const pollRef = useRef(null);

    const [detections, setDetections] = useState([]);
    const [players, setPlayers] = useState([]);
    const [selectedGroup, setSelectedGroup] = useState("unknown");
    const [selectedDetectionIds, setSelectedDetectionIds] = useState([]);
    const [detectionStatus, setDetectionStatus] = useState("none");
    const [detectionError, setDetectionError] = useState("");
    const [loading, setLoading] = useState(true);

    const [isModalOpen, setIsModalOpen] = useState(false);
    const [newPlayer, setNewPlayer] = useState({
        manualName: "",
        jerseyNumber: "",
        teamSide: "unknown",
    });

    const visibleDetections = useMemo(() => {
        if (selectedGroup === "unknown") {
            return detections.filter((d) => !d.assignedPlayerId);
        }
        return detections.filter((d) => d.assignedPlayerId === selectedGroup);
    }, [detections, selectedGroup]);

    useEffect(() => {
        init();
        return () => {
            if (pollRef.current) clearTimeout(pollRef.current);
        };
    }, [videoId]);

    async function init() {
        setLoading(true);
        const data = await fetchRoster();

        if (data.detectionStatus === "none") {
            await startDetection();
            schedulePoll();
        } else if (data.detectionStatus === "processing") {
            applyData(data);
            schedulePoll();
        } else {
            applyData(data);
        }

        setLoading(false);
    }

    async function fetchRoster() {
        const res = await fetch(`${API}/videos/${videoId}/team-roster`, {
            credentials: "include",
            cache: "no-store",
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || "Failed to load roster");
        return data;
    }

    function applyData(data) {
        setDetections(data.detections || []);
        setPlayers(data.players || []);
        setDetectionStatus(data.detectionStatus || "none");
        setDetectionError(data.detectionError || "");
    }

    async function startDetection() {
        const res = await fetch(`${API}/videos/${videoId}/detect-players`, {
            method: "POST",
            credentials: "include",
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok && res.status !== 202) {
            throw new Error(data.message || "Failed to start detection");
        }
    }

    function schedulePoll() {
        if (pollRef.current) clearTimeout(pollRef.current);

        pollRef.current = setTimeout(async () => {
            try {
                const data = await fetchRoster();
                applyData(data);

                if (data.detectionStatus === "processing") {
                    schedulePoll();
                }
            } catch (err) {
                console.error(err);
            }
        }, 2500);
    }

    function toggleDetection(detectionId) {
        setSelectedDetectionIds((prev) =>
            prev.includes(detectionId)
                ? prev.filter((id) => id !== detectionId)
                : [...prev, detectionId]
        );
    }

    async function createPlayer() {
        const res = await fetch(`${API}/videos/${videoId}/team-roster/create-player`, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(newPlayer),
        });

        const data = await res.json();
        if (!res.ok) {
            alert(data.message || "Failed to create player");
            return;
        }

        setPlayers(data.players || []);
        setIsModalOpen(false);
        setNewPlayer({ manualName: "", jerseyNumber: "", teamSide: "unknown" });
    }

    async function assignSelectedToPlayer(playerId) {
        if (!selectedDetectionIds.length) {
            alert("Select images first");
            return;
        }

        const res = await fetch(`${API}/videos/${videoId}/team-roster/assign`, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                detectionIds: selectedDetectionIds,
                playerId,
            }),
        });

        const data = await res.json();
        if (!res.ok) {
            alert(data.message || "Failed to assign detections");
            return;
        }

        setDetections(data.detections || []);
        setPlayers(data.players || []);
        setSelectedDetectionIds([]);
    }

    function handleFinish() {
        navigate(`/match-statistics/${videoId}`);
    }

    return (
        <div className="tr-page">
            <div className="tr-topbar">
                <h1 className="tr-title">Player Identification</h1>
                <button className="tr-saveBtn" onClick={handleFinish}>
                    Save & Finish
                </button>
            </div>

            <div className="tr-layout">
                <aside className="tr-sidebar">
                    <button
                        className={`tr-sideItem ${selectedGroup === "unknown" ? "active" : ""}`}
                        onClick={() => setSelectedGroup("unknown")}
                    >
                        <div>
                            <div className="tr-sideTitle">Unknown</div>
                            <div className="tr-sideSub">
                                {detections.filter((d) => !d.assignedPlayerId).length} images
                            </div>
                        </div>
                    </button>

                    {players.map((player) => (
                        <button
                            key={player.playerId}
                            className={`tr-sideItem ${selectedGroup === player.playerId ? "active" : ""}`}
                            onClick={() => {
                                if (selectedDetectionIds.length) {
                                    assignSelectedToPlayer(player.playerId);
                                } else {
                                    setSelectedGroup(player.playerId);
                                }
                            }}
                        >
                            <div>
                                <div className="tr-sideTitle">
                                    {player.jerseyNumber || "No Number"} {player.manualName ? `(${player.manualName})` : ""}
                                </div>
                                <div className="tr-sideSub">{player.teamSide}</div>
                            </div>
                        </button>
                    ))}

                    <button className="tr-addPlayerBtn" onClick={() => setIsModalOpen(true)}>
                        ADD PLAYER
                    </button>
                </aside>

                <main className="tr-main">
                    <div className="tr-mainHeader">
                        <div className="tr-mainTitle">
                            {selectedGroup === "unknown" ? "Unknown" : "Player Images"}
                        </div>
                        <div className="tr-mainSub">
                            Tap on the pictures to assign them to a player
                        </div>
                    </div>

                    {detectionStatus === "processing" && (
                        <div className="tr-hintBar">Processing uploaded video and detecting players...</div>
                    )}

                    {detectionStatus === "failed" && (
                        <div className="tr-hintBar">Detection failed: {detectionError}</div>
                    )}

                    <div className="tr-grid">
                        {loading ? (
                            <div className="tr-empty">Loading...</div>
                        ) : !visibleDetections.length ? (
                            <div className="tr-empty">No detected players to display.</div>
                        ) : (
                            visibleDetections.map((det) => (
                                <button
                                    key={det.detectionId}
                                    className={`tr-thumb ${selectedDetectionIds.includes(det.detectionId) ? "selected" : ""}`}
                                    onClick={() => toggleDetection(det.detectionId)}
                                >
                                    <img src={`${API}${det.imageUrl}`} alt={det.detectionId} />
                                </button>
                            ))
                        )}
                    </div>
                </main>
            </div>

            {isModalOpen && (
                <div className="tr-modalOverlay">
                    <div className="tr-modal">
                        <div className="tr-modalHeader">
                            <div className="tr-modalTitle">Add Player</div>
                            <button className="tr-closeBtn" onClick={() => setIsModalOpen(false)}>✕</button>
                        </div>

                        <div className="tr-modalBody">
                            <label className="tr-label">Jersey Number</label>
                            <input
                                className="tr-input"
                                value={newPlayer.jerseyNumber}
                                onChange={(e) => setNewPlayer((p) => ({ ...p, jerseyNumber: e.target.value }))}
                            />

                            <label className="tr-label">Player Name</label>
                            <input
                                className="tr-input"
                                value={newPlayer.manualName}
                                onChange={(e) => setNewPlayer((p) => ({ ...p, manualName: e.target.value }))}
                            />

                            <label className="tr-label">Team Side</label>
                            <select
                                className="tr-select"
                                value={newPlayer.teamSide}
                                onChange={(e) => setNewPlayer((p) => ({ ...p, teamSide: e.target.value }))}
                            >
                                <option value="unknown">Unknown</option>
                                <option value="my_team">My Team</option>
                                <option value="opponent">Opponent</option>
                            </select>

                            <button className="tr-modalAddBtn" onClick={createPlayer}>
                                Save Player
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}