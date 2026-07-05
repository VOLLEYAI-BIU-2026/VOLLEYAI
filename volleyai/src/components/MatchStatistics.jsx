import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import "./MatchStatistics.css";

const API = "http://localhost:5000";

const TABS = ["Attack", "Serve", "Receive", "Set", "Defence", "Block"];

function fmt(val, decimals = 0) {
  if (val === null || val === undefined) return "-";
  if (decimals > 0) return Number(val).toFixed(decimals);
  return val;
}

function pct(val) {
  if (val === null || val === undefined) return "-";
  return (Number(val) * 100).toFixed(1) + "%";
}

export default function MatchStatistics() {
  const { videoId = "latest" } = useParams();
  const navigate = useNavigate();

  const [activeTab, setActiveTab] = useState("Attack");
  const [search, setSearch] = useState("");
  const teamFilter = "all";
  const [stats, setStats] = useState({});
  const [rosterMap, setRosterMap] = useState({});
  const [validJerseys, setValidJerseys] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function fetchAll() {
      try {
        const [statsRes, rosterRes, registryRes] = await Promise.all([
          fetch(`${API}/videos/${videoId}/player-stats`, { credentials: "include" }),
          fetch(`${API}/videos/${videoId}/team-roster`, { credentials: "include" }),
          fetch(`${API}/videos/player-registry`, { credentials: "include" }),
        ]);

        const statsData = await statsRes.json();
        if (statsData.status === "done") setStats(statsData.stats);
        else setError("No stats available yet. Run the analysis first.");

        if (rosterRes.ok) {
          const rosterData = await rosterRes.json();
          const map = {};
          for (const p of rosterData.players || []) {
            if (p.jerseyNumber) map[p.jerseyNumber] = p.teamSide;
          }
          setRosterMap(map);
        }

        if (registryRes.ok) {
          const regData = await registryRes.json();
          if (regData.status === "ok") {
            const jerseys = new Set(
              Object.values(regData.registry)
                .filter((d) => d.jersey !== null && d.jersey !== undefined)
                .map((d) => String(d.jersey))
            );
            setValidJerseys(jerseys);
          }
        }
      } catch {
        setError("Failed to load stats.");
      } finally {
        setLoading(false);
      }
    }
    fetchAll();
  }, [videoId]);

  const players = Object.entries(stats)
    .map(([key, s]) => ({
      label: `#${key}`,
      key,
      teamSide: rosterMap[key] || "unknown",
      ...s,
    }))
    .filter((p) => !validJerseys || validJerseys.has(p.key))
    .filter((p) => {
      if (teamFilter === "my_team") return p.teamSide === "my_team";
      if (teamFilter === "opponent") return p.teamSide === "opponent";
      return true;
    })
    .filter((p) =>
      search ? p.label.toLowerCase().includes(search.toLowerCase()) : true
    )
    .sort((a, b) => b.total_events - a.total_events);

  function exportCSV() {
    const headers = ["Player", "K", "E", "TA", "ATK%", "SA", "SE", "AST", "DS", "DE", "BS", "BA"];
    const rows = players.map((p) => [
      p.label,
      p.attack?.K ?? 0,
      p.attack?.E ?? 0,
      p.attack?.TA ?? 0,
      p.attack?.["ATK%"] ?? 0,
      p.serve?.SA ?? 0,
      p.serve?.SE ?? 0,
      p.set?.AST ?? 0,
      p.defence?.DS ?? 0,
      p.defence?.DE ?? 0,
      p.block?.BS ?? 0,
      p.block?.BA ?? 0,
    ]);
    const csv = [headers, ...rows].map((r) => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "player_stats.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="ms-page">
      <div className="ms-shell">

        {/* Header */}
        <div className="ms-header">
          <div className="ms-headerLeft">
            <button className="ms-backBtn" onClick={() => navigate(-1)}>←</button>
            <div>
              <div className="ms-breadcrumb">Analytics / Statistics</div>
              <h1 className="ms-title">Player Statistics</h1>
            </div>
          </div>
          <div className="ms-headerRight">
            <button className="ms-registryBtn" onClick={() => navigate("/player-registry")}>
              Player Registry
            </button>
            <button className="ms-exportBtn" onClick={exportCSV}>↓ Export CSV</button>
          </div>
        </div>

        {/* Tabs */}
        <div className="ms-tabs">
          {TABS.map((tab) => (
            <button
              key={tab}
              className={`ms-tab ${activeTab === tab ? "active" : ""}`}
              onClick={() => setActiveTab(tab)}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* Filters */}
        <div className="ms-filters">
          <div className="ms-filtersLeft">
            <div className="ms-searchWrap">
              <span className="ms-searchIcon">⌕</span>
              <input
                className="ms-search"
                type="text"
                placeholder="Search player..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
          <div className="ms-countText">
            {players.length} player{players.length !== 1 ? "s" : ""}
          </div>
        </div>

        {/* Table */}
        <div className="ms-tableCard">
          <div className="ms-tableWrap">
            {loading ? (
              <div className="ms-emptyState"><div className="ms-emptyTitle">Loading...</div></div>
            ) : error ? (
              <div className="ms-emptyState">
                <div className="ms-emptyIcon">📊</div>
                <div className="ms-emptyTitle">{error}</div>
              </div>
            ) : players.length === 0 ? (
              <div className="ms-emptyState">
                <div className="ms-emptyIcon">📊</div>
                <div className="ms-emptyTitle">No statistics yet</div>
                <div className="ms-emptyText">Run the triple detection pipeline to generate stats.</div>
                <button className="ms-registryLink" onClick={() => navigate("/player-registry")}>
                  Assign jersey numbers in Player Registry →
                </button>
              </div>
            ) : (
              <table className="ms-table">
                <thead>
                  {activeTab === "Attack" && (
                    <>
                      <tr className="ms-groupRow">
                        <th rowSpan={2} className="ms-nameCol">NAME</th>
                        <th colSpan={4} className="ms-groupHead">ATTACK</th>
                      </tr>
                      <tr>
                        <th>K</th><th>E</th><th>TA</th><th>ATK%</th>
                      </tr>
                    </>
                  )}
                  {activeTab === "Serve" && (
                    <>
                      <tr className="ms-groupRow">
                        <th rowSpan={2} className="ms-nameCol">NAME</th>
                        <th colSpan={5} className="ms-groupHead">SERVE</th>
                      </tr>
                      <tr>
                        <th>SA</th><th>SE</th><th>TA</th><th>PCT</th><th>EFF</th>
                      </tr>
                    </>
                  )}
                  {activeTab === "Receive" && (
                    <>
                      <tr className="ms-groupRow">
                        <th rowSpan={2} className="ms-nameCol">NAME</th>
                        <th colSpan={6} className="ms-groupHead">RECEIVE</th>
                      </tr>
                      <tr>
                        <th>TA</th><th>3</th><th>2</th><th>1</th><th>0</th><th>PASS RTG</th>
                      </tr>
                    </>
                  )}
                  {activeTab === "Set" && (
                    <>
                      <tr className="ms-groupRow">
                        <th rowSpan={2} className="ms-nameCol">NAME</th>
                        <th colSpan={8} className="ms-groupHead">SET</th>
                      </tr>
                      <tr>
                        <th>AST</th><th>TA</th><th>SE</th><th>3</th><th>2</th><th>1</th><th>0</th><th>RTG.</th>
                      </tr>
                    </>
                  )}
                  {activeTab === "Defence" && (
                    <>
                      <tr className="ms-groupRow">
                        <th rowSpan={2} className="ms-nameCol">NAME</th>
                        <th colSpan={2} className="ms-groupHead">DEFENCE</th>
                      </tr>
                      <tr>
                        <th>DS</th><th>DE</th>
                      </tr>
                    </>
                  )}
                  {activeTab === "Block" && (
                    <>
                      <tr className="ms-groupRow">
                        <th rowSpan={2} className="ms-nameCol">NAME</th>
                        <th colSpan={3} className="ms-groupHead">BLOCK</th>
                      </tr>
                      <tr>
                        <th>BK</th><th>BA</th><th>BE</th>
                      </tr>
                    </>
                  )}
                </thead>
                <tbody>
                  {players.map((p) => (
                    <tr key={p.key}>
                      <td className="ms-nameCell">{p.label}</td>
                      {activeTab === "Attack" && (
                        <>
                          <td className="ms-highlight">{fmt(p.attack?.K)}</td>
                          <td className="ms-error">{fmt(p.attack?.E)}</td>
                          <td>{fmt(p.attack?.TA)}</td>
                          <td>{pct(p.attack?.["ATK%"])}</td>
                        </>
                      )}
                      {activeTab === "Serve" && (
                        <>
                          <td className="ms-highlight">{fmt(p.serve?.SA)}</td>
                          <td className="ms-error">{fmt(p.serve?.SE)}</td>
                          <td>{fmt(p.serve?.TA)}</td>
                          <td>{pct(p.serve?.PCT)}</td>
                          <td>{pct(p.serve?.EFF)}</td>
                        </>
                      )}
                      {activeTab === "Set" && (
                        <>
                          <td className="ms-highlight">{fmt(p.set?.AST)}</td>
                          <td>{fmt(p.set?.TA)}</td>
                          <td className="ms-error">{fmt(p.set?.SE)}</td>
                          <td>{fmt(p.set?.["3"])}</td>
                          <td>{fmt(p.set?.["2"])}</td>
                          <td>{fmt(p.set?.["1"])}</td>
                          <td className="ms-error">{fmt(p.set?.["0"])}</td>
                          <td className="ms-highlight">{fmt(p.set?.RTG, 2)}</td>
                        </>
                      )}
                      {activeTab === "Receive" && (
                        <>
                          <td>{fmt(p.receive?.TA)}</td>
                          <td className="ms-highlight">{fmt(p.receive?.["3"])}</td>
                          <td>{fmt(p.receive?.["2"])}</td>
                          <td>{fmt(p.receive?.["1"])}</td>
                          <td className="ms-error">{fmt(p.receive?.["0"])}</td>
                          <td className="ms-highlight">{fmt(p.receive?.PASS_RTG, 2)}</td>
                        </>
                      )}
                      {activeTab === "Defence" && (
                        <>
                          <td className="ms-highlight">{fmt(p.defence?.DS)}</td>
                          <td className="ms-error">{fmt(p.defence?.DE)}</td>
                        </>
                      )}
                      {activeTab === "Block" && (
                        <>
                          <td className="ms-highlight">{fmt(p.block?.BK)}</td>
                          <td>{fmt(p.block?.BA)}</td>
                          <td className="ms-error">{fmt(p.block?.BE)}</td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="ms-tableFooter">
            <div className="ms-footerLeft">Showing {players.length} players</div>
          </div>
        </div>

      </div>
    </div>
  );
}
