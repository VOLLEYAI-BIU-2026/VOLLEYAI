import { API_BASE } from "../config.js";
import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import "./PlayerSelect.css";

const API = API_BASE;

export default function PlayerSelect() {
  const { videoId = "latest" } = useParams();
  const navigate = useNavigate();

  const [stats, setStats] = useState({});
  const [rosterMap, setRosterMap] = useState({});
  const [nameMap, setNameMap] = useState({});
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function fetchAll() {
      try {
        const [statsRes, rosterRes, registryRes] = await Promise.all([
          fetch(`${API}/videos/${videoId}/player-stats`, { credentials: "include" }),
          fetch(`${API}/videos/${videoId}/team-roster`, { credentials: "include" }),
          fetch(`${API}/videos/${videoId}/player-registry`, { credentials: "include" }),
        ]);

        const statsData = await statsRes.json();
        if (statsData.status === "done") setStats(statsData.stats);
        else setError("No stats available yet. Run the analysis first.");

        // team-roster is a manually-curated roster (name/position/team a
        // coach fills in by hand) — often never set up, so it's only used
        // here for a display name, never for team affiliation.
        if (rosterRes.ok) {
          const rosterData = await rosterRes.json();
          const map = {};
          for (const p of rosterData.players || []) {
            if (p.jerseyNumber && p.manualName) map[p.jerseyNumber] = p.manualName;
          }
          setNameMap(map);
        }

        // The player registry is the pipeline's own auto-detected team
        // assignment (by jersey color at detection time) — the same source
        // every other team/opponent split in this app already uses, and
        // actually populated without any manual setup.
        if (registryRes.ok) {
          const regData = await registryRes.json();
          if (regData.status === "ok") {
            const map = {};
            for (const data of Object.values(regData.registry)) {
              if (data.jersey != null) map[String(data.jersey)] = data.team || "unknown";
            }
            setRosterMap(map);
          }
        }
      } catch {
        setError("Failed to load players.");
      } finally {
        setLoading(false);
      }
    }
    fetchAll();
  }, [videoId]);

  const players = Object.entries(stats)
    .map(([key, s]) => ({
      key,
      label: `#${key}`,
      name: nameMap[key] || null,
      teamSide: rosterMap[key] || "unknown",
      totalEvents: s.total_events ?? 0,
    }))
    .filter((p) =>
      search
        ? p.label.toLowerCase().includes(search.toLowerCase())
          || (p.name || "").toLowerCase().includes(search.toLowerCase())
        : true
    )
    .sort((a, b) => b.totalEvents - a.totalEvents);

  return (
    <div className="pls-page">
      <div className="pls-shell">
        <div className="pls-header">
          <div className="pls-headerLeft">
            <button className="pls-backBtn" onClick={() => navigate(-1)}>←</button>
            <div>
              <div className="pls-breadcrumb">Analytics / Statistics / Player Stats</div>
              <h1 className="pls-title">Select a Player</h1>
            </div>
          </div>
        </div>

        <div className="pls-searchWrap">
          <span className="pls-searchIcon">⌕</span>
          <input
            className="pls-search"
            type="text"
            placeholder="Search player..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {loading ? (
          <div className="pls-emptyState"><div className="pls-emptyTitle">Loading...</div></div>
        ) : error ? (
          <div className="pls-emptyState">
            <div className="pls-emptyIcon">📊</div>
            <div className="pls-emptyTitle">{error}</div>
          </div>
        ) : players.length === 0 ? (
          <div className="pls-emptyState">
            <div className="pls-emptyIcon">📊</div>
            <div className="pls-emptyTitle">No players found{search ? " matching your search" : ""}.</div>
          </div>
        ) : (
          <div className="pls-grid">
            {players.map((p) => (
              <button
                key={p.key}
                type="button"
                className={`pls-card pls-team-${p.teamSide}`}
                onClick={() => navigate(`/player-profile/${videoId}/${p.key}`)}
              >
                <div className="pls-jersey">{p.label}</div>
                {p.name && <div className="pls-name">{p.name}</div>}
                <div className="pls-meta">
                  <span className={`pls-teamBadge pls-teamBadge-${p.teamSide}`}>
                    {p.teamSide === "my_team" ? "My Team" : p.teamSide === "opponent" ? "Opponent" : "Unknown"}
                  </span>
                  <span className="pls-events">{p.totalEvents} actions</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
