import { API_BASE } from "../config.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import "./Home_screen.css";

const API = `${API_BASE}";

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
  const [teamEdits, setTeamEdits] = useState({});
  const [editingId, setEditingId] = useState(null);

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
    fetch(`${API}/videos/list`, { credentials: "include" })
      .then((r) => r.json())
      .then((data) => {
        const vids = data.videos || [];
        setVideos(vids);
        const edits = {};
        vids.forEach((v) => { edits[v._id] = { teamA: v.teamA || "", teamB: v.teamB || "" }; });
        setTeamEdits(edits);
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

  return (
    <div className="hs-page">
      <div className="hs-container">
        <div className="hs-shell">

          <header className="hs-topbar">
            <div className="hs-brand">
              <div className="hs-logo">ðŸ</div>
              <div className="hs-brandName">VolleyAI</div>
            </div>
            <div className="hs-searchWrap">
              <input className="hs-search" placeholder="Search matches..." />
            </div>
            <div className="hs-avatarWrap" ref={menuRef}>
              <button type="button" className="hs-avatar" title={email || "Profile"} onClick={() => setMenuOpen((v) => !v)}>
                {initial}
              </button>
              {menuOpen && (
                <div className="hs-menu">
                  <div className="hs-menuEmail">{email}</div>
                  <button type="button" className="hs-menuItem" onClick={handleLogout}>Sign out</button>
                </div>
              )}
            </div>
          </header>

          <main className="hs-grid">

            {videos.map((video) => {
              const status = cardStatus(video);
              const isReady = status === "ready";
              const isProcessing = status === "processing";
              const edits = teamEdits[video._id] || { teamA: "", teamB: "" };
              const isEditing = editingId === video._id;

              return (
                <div key={video._id} className="hs-card">

                  {/* Media / thumbnail area */}
                  <div className="hs-cardMedia">
                    <VideoThumb src={video.filePath} />
                    <div className="hs-mediaGradient" />

                    {/* Badge â€” top left */}
                    <span className={`hs-badge ${status}`}>
                      {isProcessing && <span className="hs-spinner">âŸ³</span>}
                      {isReady ? "Ready" : isProcessing ? "Processing" : "Uploaded"}
                    </span>

                    {/* Date â€” top right, always visible */}
                    <div className="hs-cardDate">
                      ðŸ“… {formatDate(video.createdAt, video._id)}
                    </div>

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
                          <button className="hs-saveOverlayBtn" onClick={() => handleEditSave(video._id)}>âœ“</button>
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
                          >âœï¸</button>
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
                      <span className="hs-actionIcon">â–¶</span>
                      <span>VIDEO</span>
                    </button>
                    <button
                      className={`hs-action ${!isReady ? "hs-action-dim" : ""}`}
                      onClick={() => navigate(`/match-statistics/${video._id}`)}
                      title="Stats"
                    >
                      <span className="hs-actionIcon">ðŸ“ˆ</span>
                      <span>STATS</span>
                    </button>
                  </div>

                </div>
              );
            })}

            <button className="hs-newCard" type="button" onClick={() => navigate("/upload-video")}>
              <div className="hs-plus">+</div>
              <div className="hs-newText">Start New Analysis</div>
            </button>

          </main>
        </div>
      </div>
    </div>
  );
}
