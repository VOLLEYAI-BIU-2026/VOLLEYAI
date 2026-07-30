import { API_BASE } from "../config.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import "./Home_screen.css";

const API = API_BASE;

function formatDate(iso, objectId) {
  let d = iso ? new Date(iso) : null;
  if (!d || isNaN(d.getTime())) {
    // Extract creation timestamp embedded in MongoDB ObjectId (first 4 bytes = Unix seconds)
    if (objectId && objectId.length >= 8) {
      d = new Date(parseInt(objectId.substring(0, 8), 16) * 1000);
    }
  }
  if (!d || isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function cardStatus(video) {
  const st = video.analytics?.status;
  if (st === "done") return "ready";
  if (st === "processing") return "processing";
  return "uploaded";
}

function VideoThumb({ src }) {
  const ref = useRef(null);
  function handleLoadedMetadata() {
    if (ref.current) ref.current.currentTime = 2;
  }
  if (!src) return null;
  return (
    <video
      ref={ref}
      src={`${API}${src}`}
      muted
      preload="metadata"
      className="hs-cardThumb"
      onLoadedMetadata={handleLoadedMetadata}
    />
  );
}

export default function HomeScreen() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const [videos, setVideos] = useState([]);
  const [search, setSearch] = useState("");
  const [teamName, setTeamName] = useState("");
  const [teamEdits, setTeamEdits] = useState({});
  const [editingId, setEditingId] = useState(null);
  const [dateEdits, setDateEdits] = useState({});
  const [editingDateId, setEditingDateId] = useState(null);
  const [scoreEdits, setScoreEdits] = useState({});
  const [editingScoreId, setEditingScoreId] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API}/auth/me`, { method: "GET", credentials: "include" });
        if (!res.ok) { navigate("/"); return; }
        const data = await res.json();
        setEmail(data.user.email || "");
      } catch { navigate("/"); }
    })();
  }, [navigate]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API}/auth/my-team`, { credentials: "include", cache: "no-store" });
        const data = await res.json();
        if (res.ok) setTeamName(data.teamName || "");
      } catch { /* leave blank */ }
    })();
  }, []);

  useEffect(() => {
    fetch(`${API}/videos/list`, { credentials: "include" })
      .then((r) => r.json())
      .then((data) => {
        const vids = data.videos || [];
        setVideos(vids);
        const edits = {};
        const dEdits = {};
        const sEdits = {};
        vids.forEach((v) => {
          edits[v._id] = { teamA: v.teamA || "", teamB: v.teamB || "" };
          dEdits[v._id] = v.matchDate ? new Date(v.matchDate).toISOString().slice(0, 10) : "";
          sEdits[v._id] = v.score || "";
        });
        setTeamEdits(edits);
        setDateEdits(dEdits);
        setScoreEdits(sEdits);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    function onDocClick(e) {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(e.target)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const initial = useMemo(() => (email.trim().charAt(0) || "U").toUpperCase(), [email]);

  async function handleLogout() {
    try { await fetch(`${API}/auth/logout`, { method: "POST", credentials: "include" }); }
    finally { navigate("/"); }
  }

  function handleTeamChange(videoId, field, value) {
    setTeamEdits((prev) => ({ ...prev, [videoId]: { ...prev[videoId], [field]: value } }));
  }

  async function handleEditSave(videoId) {
    const { teamA, teamB } = teamEdits[videoId] || {};
    try {
      const res = await fetch(`${API}/videos/${videoId}/teams`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamA, teamB }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.video) {
          setVideos((prev) =>
            prev.map((v) => (v._id === videoId ? { ...v, teamA: data.video.teamA, teamB: data.video.teamB } : v))
          );
        }
      }
    } catch {}
    setEditingId(null);
  }

  async function handleDateSave(videoId) {
    const matchDate = dateEdits[videoId] || null;
    try {
      const res = await fetch(`${API}/videos/${videoId}/teams`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchDate }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.video) {
          setVideos((prev) => prev.map((v) => (v._id === videoId ? { ...v, matchDate: data.video.matchDate } : v)));
        }
      }
    } catch {}
    setEditingDateId(null);
  }

  async function handleScoreSave(videoId) {
    const score = scoreEdits[videoId] ?? "";
    try {
      const res = await fetch(`${API}/videos/${videoId}/teams`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ score }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.video) {
          setVideos((prev) => prev.map((v) => (v._id === videoId ? { ...v, score: data.video.score } : v)));
        }
      }
    } catch {}
    setEditingScoreId(null);
  }

  async function handleDeleteVideo(videoId) {
    if (!window.confirm("Delete this video and all its analysis data? This can't be undone.")) return;
    try {
      const res = await fetch(`${API}/videos/${videoId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (res.ok) {
        setVideos((prev) => prev.filter((v) => v._id !== videoId));
        setTeamEdits((prev) => {
          const next = { ...prev };
          delete next[videoId];
          return next;
        });
      }
    } catch {}
  }

  return (
    <div className="hs-page">
      <div className="hs-container">
        <div className="hs-shell">

          <header className="hs-topbar">
            <div className="hs-brand">
              <div className="hs-brandName">VolleyAI</div>
            </div>
            <div className="hs-searchWrap">
              {teamName && <div className="hs-teamNameBadge">{teamName}</div>}
              <input
                className="hs-search"
                placeholder="Search matches..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="hs-avatarWrap" ref={menuRef}>
              <button type="button" className="hs-avatar" title={email || "Profile"} onClick={() => setMenuOpen((v) => !v)}>
                {initial}
              </button>
              {menuOpen && (
                <div className="hs-menu">
                  <div className="hs-menuEmail">{email}</div>
                  <button type="button" className="hs-menuItem" onClick={() => navigate("/my-team")}>My Team</button>
                  <button type="button" className="hs-menuItem" onClick={handleLogout}>Sign out</button>
                </div>
              )}
            </div>
          </header>

          <main className="hs-grid">

            <button className="hs-newCard" type="button" onClick={() => navigate("/upload-video")}>
              <div className="hs-plus">+</div>
              <div className="hs-newText">Start New Analysis</div>
            </button>

            {videos
              .filter((video) => {
                if (!search.trim()) return true;
                const q = search.trim().toLowerCase();
                const edits = teamEdits[video._id] || {};
                return (edits.teamA || video.teamA || "").toLowerCase().includes(q)
                  || (edits.teamB || video.teamB || "").toLowerCase().includes(q)
                  || (video.originalFileName || "").toLowerCase().includes(q);
              })
              .map((video) => {
              const status = cardStatus(video);
              const isReady = status === "ready";
              const isProcessing = status === "processing";
              const edits = teamEdits[video._id] || { teamA: "", teamB: "" };
              const isEditing = editingId === video._id;
              const isEditingDate = editingDateId === video._id;
              const isEditingScore = editingScoreId === video._id;

              return (
                <div key={video._id} className="hs-card">

                  {/* Media / thumbnail area */}
                  <div className="hs-cardMedia">
                    <VideoThumb src={video.filePath} />
                    <div className="hs-mediaGradient" />

                    {/* Badge — top left */}
                    <span className={`hs-badge ${status}`}>
                      {isProcessing && <span className="hs-spinner">⟳</span>}
                      {isReady ? "Ready" : isProcessing ? "Processing" : "Uploaded"}
                    </span>

                    {/* Score — below the status badge, top left. Once the
                        analysis has computed a real score (usScore/opponentScore,
                        from rally_analysis), that's authoritative and shown
                        read-only — no point letting a manual guess override real
                        data. Only falls back to the editable manual entry when
                        there's no computed score yet (not analyzed, or scoreboard
                        detection failed entirely). */}
                    {video.usScore != null && video.opponentScore != null ? (
                      <div className="hs-cardScore hs-cardScoreComputed" title="Computed from the analysis">
                        🏆 {video.usScore} - {video.opponentScore}
                      </div>
                    ) : isEditingScore ? (
                      <div className="hs-cardScore hs-cardScoreEditing" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="text"
                          className="hs-scoreInput"
                          placeholder="e.g. 3-1"
                          value={scoreEdits[video._id] ?? ""}
                          onChange={(e) => setScoreEdits((prev) => ({ ...prev, [video._id]: e.target.value }))}
                          autoFocus
                        />
                        <button className="hs-saveOverlayBtn" onClick={() => handleScoreSave(video._id)}>✓</button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="hs-cardScore hs-cardScoreBtn"
                        onClick={(e) => { e.stopPropagation(); setEditingScoreId(video._id); }}
                        title="Click to set the match score"
                      >
                        {video.score ? `🏆 ${video.score}` : "+ Score"}
                      </button>
                    )}

                    {/* Match date — top right. Falls back to the upload date until
                        set; click to set the actual date the match was played. */}
                    {isEditingDate ? (
                      <div className="hs-cardDate hs-cardDateEditing" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="date"
                          className="hs-dateInput"
                          value={dateEdits[video._id] || ""}
                          onChange={(e) => setDateEdits((prev) => ({ ...prev, [video._id]: e.target.value }))}
                          autoFocus
                        />
                        <button className="hs-saveOverlayBtn" onClick={() => handleDateSave(video._id)}>✓</button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="hs-cardDate hs-cardDateBtn"
                        onClick={(e) => { e.stopPropagation(); setEditingDateId(video._id); }}
                        title="Click to set the match date"
                      >
                        📅 {video.matchDate ? formatDate(video.matchDate, video._id) : formatDate(video.createdAt, video._id)}
                      </button>
                    )}

                    <button
                      className="hs-deleteOverlayBtn"
                      onClick={(e) => { e.stopPropagation(); handleDeleteVideo(video._id); }}
                      title="Delete video"
                    >🗑</button>

                    {/* Teams + edit at the bottom */}
                    <div className="hs-teamsOverlay">
                      {isEditing ? (
                        <div className="hs-teamsEditRow">
                          <input
                            className="hs-teamOverlayInput"
                            placeholder="Team A..."
                            value={edits.teamA}
                            onChange={(e) => handleTeamChange(video._id, "teamA", e.target.value)}
                            autoFocus
                          />
                          <span className="hs-vsOverlay">vs</span>
                          <input
                            className="hs-teamOverlayInput"
                            placeholder="Team B..."
                            value={edits.teamB}
                            onChange={(e) => handleTeamChange(video._id, "teamB", e.target.value)}
                          />
                          <button className="hs-saveOverlayBtn" onClick={() => handleEditSave(video._id)}>✓</button>
                        </div>
                      ) : (
                        <>
                          <div className="hs-teamsDisplayRow">
                            <span className="hs-teamOverlayText hs-teamLeft">{edits.teamA || "Team A"}</span>
                            <span className="hs-vsOverlay">vs</span>
                            <span className="hs-teamOverlayText hs-teamRight">{edits.teamB || "Team B"}</span>
                          </div>
                          <button
                            className="hs-editOverlayBtn"
                            onClick={() => setEditingId(video._id)}
                            title="Edit team names"
                          >✏️</button>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Action tabs */}
                  <div className="hs-actions">
                    <button
                      className={`hs-action ${!isReady ? "hs-action-dim" : ""}`}
                      onClick={() => navigate(`/match-analysis/${video._id}`)}
                      title="Video"
                    >
                      <span className="hs-actionIcon">▶</span>
                      <span>VIDEO</span>
                    </button>
                    <button
                      className={`hs-action ${!isReady ? "hs-action-dim" : ""}`}
                      onClick={() => navigate(`/match-statistics/${video._id}`)}
                      title="Stats"
                    >
                      <span className="hs-actionIcon">📈</span>
                      <span>STATS</span>
                    </button>
                  </div>

                </div>
              );
            })}

          </main>
        </div>
      </div>
    </div>
  );
}
