import { API_BASE } from "../config.js";
import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import "./MatchStatistics.css";

const API = API_BASE;

const TABS = ["Attack", "Serve", "Set", "Defence", "Block"];

function fmt(val, decimals = 0) {
  if (val === null || val === undefined) return "-";
  if (decimals > 0) return Number(val).toFixed(decimals);
  return val;
}

function pct(val) {
  if (val === null || val === undefined) return "-";
  return (Number(val) * 100).toFixed(1) + "%";
}

// A player only belongs in a given tab's table if they actually attempted
// that action at least once — e.g. a player who never served shouldn't show
// up in the Serve tab just because they have attack/dig stats elsewhere.
function hasTabContribution(p, tab) {
  switch (tab) {
    case "Attack":  return (p.attack?.TA ?? 0) > 0;
    case "Serve":   return (p.serve?.TA ?? 0) > 0;
    case "Set":     return (p.set?.TA ?? 0) > 0;
    case "Defence": return (p.defence?.TA ?? 0) > 0;
    case "Block":   return (p.block?.BA ?? 0) > 0;
    default:        return true;
  }
}

// How many <td> columns (including NAME) each tab's table has, for the
// colSpan of the "nobody did this yet" row.
const TAB_COLSPAN = { Attack: 5, Serve: 7, Set: 9, Defence: 4, Block: 4 };

const STAT_DEFS = {
  Attack: {
    K:     { full: "Kill",              desc: "An attack that lands for a point." },
    E:     { full: "Attack Error",      desc: "An attack that results in a point for the opponent — hit out, into the net, blocked for a point, etc." },
    TA:    { full: "Total Attempts",    desc: "Total number of attack attempts." },
    "ATK%":{ full: "Attack Percentage", desc: "Hitting efficiency: (Kills − Errors) ÷ Total Attempts." },
  },
  Serve: {
    SA:  { full: "Service Ace",     desc: "A serve that scores directly — unreturned or leads straight to a point." },
    SE:  { full: "Service Error",   desc: "A serve that doesn't end up in play on the opponent's side — into the net, out of bounds, foot fault." },
    TA:  { full: "Total Attempts",  desc: "Total number of serves." },
    PCT: { full: "Serve Percentage",desc: "Share of serves that stayed in play: (Attempts − Errors) ÷ Attempts." },
    EFF: { full: "Serve Efficiency",desc: "Net serving value: (Aces − Errors) ÷ Attempts." },
    RW:  { full: "Rally Won on Serve", desc: "Rallies your team won that started with this player's serve — broader than an Ace, counts any point won during that rally, however many touches it took." },
  },
  Set: {
    AST: { full: "Assist",           desc: "A set that directly leads to a kill." },
    TA:  { full: "Total Attempts",   desc: "Total number of sets." },
    SE:  { full: "Set Error",        desc: "A set that directly results in an unplayable ball or a lost point." },
    "3": { full: "Set Grade 3",      desc: "Perfect set — hitter had a full choice of attack. Not currently tracked by the model." },
    "2": { full: "Set Grade 2",      desc: "Good set — hitter had a limited choice of attack. Not currently tracked by the model." },
    "1": { full: "Set Grade 1",      desc: "Poor set — hitter had almost no options. Not currently tracked by the model." },
    "0": { full: "Set Grade 0",      desc: "Unplayable set. Not currently tracked by the model." },
    RTG: { full: "Set Rating",       desc: "Average quality grade across all sets. Not currently tracked by the model." },
  },
  Defence: {
    DS:    { full: "Dig Save",                desc: "A dig that keeps the ball in play." },
    DE:    { full: "Defence Error",           desc: "A dig attempt that fails to keep the ball in play." },
    "DS%": { full: "Dig Success Percentage",  desc: "Share of defensive attempts that were successful: Digs Saved ÷ Total Attempts." },
  },
  Block: {
    BK: { full: "Block Kill",  desc: "A block that scores directly for a point." },
    BA: { full: "Block Attempt", desc: "Total number of block attempts — touches at the net." },
    BE: { full: "Block Error", desc: "A block attempt that results in a point for the opponent — net touch, deflected out, etc." },
  },
};

function StatTh({ tab, stat, children }) {
  const def = STAT_DEFS[tab]?.[stat];
  if (!def) return <th>{children}</th>;
  return (
    <th>
      <span className="ms-statTh">
        {children}
        <span className="ms-tooltip">
          <strong>{def.full}</strong>
          <span>{def.desc}</span>
        </span>
      </span>
    </th>
  );
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

  const rosterPlayers = Object.entries(stats)
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
    });

  const players = rosterPlayers
    .filter((p) => hasTabContribution(p, activeTab))
    .filter((p) =>
      search ? p.label.toLowerCase().includes(search.toLowerCase()) : true
    )
    .sort((a, b) => b.total_events - a.total_events);

  // Team row = sum of every rostered player's raw counts, not just the
  // currently searched/sorted subset — a search shouldn't change what
  // "the team" totals to.
  const teamTotals = (() => {
    const t = {
      attack:  { K: 0, E: 0, TA: 0 },
      serve:   { SA: 0, SE: 0, TA: 0, RW: 0 },
      block:   { BK: 0, BA: 0, BE: 0 },
      defence: { DS: 0, DE: 0, TA: 0 },
      set:     { AST: 0, SE: 0, TA: 0 },
    };
    for (const p of rosterPlayers) {
      t.attack.K   += p.attack?.K ?? 0;
      t.attack.E   += p.attack?.E ?? 0;
      t.attack.TA  += p.attack?.TA ?? 0;
      t.serve.SA   += p.serve?.SA ?? 0;
      t.serve.SE   += p.serve?.SE ?? 0;
      t.serve.TA   += p.serve?.TA ?? 0;
      t.serve.RW   += p.serve?.RW ?? 0;
      t.block.BK   += p.block?.BK ?? 0;
      t.block.BA   += p.block?.BA ?? 0;
      t.block.BE   += p.block?.BE ?? 0;
      t.defence.DS += p.defence?.DS ?? 0;
      t.defence.DE += p.defence?.DE ?? 0;
      t.defence.TA += p.defence?.TA ?? 0;
      t.set.AST    += p.set?.AST ?? 0;
      t.set.SE     += p.set?.SE ?? 0;
      t.set.TA     += p.set?.TA ?? 0;
    }
    t.attack["ATK%"] = t.attack.TA  > 0 ? (t.attack.K - t.attack.E) / t.attack.TA : null;
    t.serve.PCT      = t.serve.TA   > 0 ? (t.serve.TA - t.serve.SE) / t.serve.TA  : null;
    t.serve.EFF      = t.serve.TA   > 0 ? (t.serve.SA - t.serve.SE) / t.serve.TA  : null;
    t.defence["DS%"] = t.defence.TA > 0 ? t.defence.DS / t.defence.TA            : null;
    return t;
  })();

  function exportCSV() {
    // Full box score across every category, regardless of which tab happens
    // to be open — uses rosterPlayers (not the tab-filtered `players`), so a
    // player who e.g. never blocked still shows up with their serve/attack
    // numbers instead of being silently dropped depending on the active tab.
    const headers = ["Player", "K", "E", "TA", "ATK%", "SA", "SE", "RW", "AST", "DS", "DE", "BS", "BA"];
    const rows = rosterPlayers.map((p) => [
      p.label,
      p.attack?.K ?? 0,
      p.attack?.E ?? 0,
      p.attack?.TA ?? 0,
      p.attack?.["ATK%"] ?? 0,
      p.serve?.SA ?? 0,
      p.serve?.SE ?? 0,
      p.serve?.RW ?? 0,
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
            ) : rosterPlayers.length === 0 ? (
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
                        <StatTh tab="Attack" stat="K">K</StatTh>
                        <StatTh tab="Attack" stat="E">E</StatTh>
                        <StatTh tab="Attack" stat="TA">TA</StatTh>
                        <StatTh tab="Attack" stat="ATK%">ATK%</StatTh>
                      </tr>
                    </>
                  )}
                  {activeTab === "Serve" && (
                    <>
                      <tr className="ms-groupRow">
                        <th rowSpan={2} className="ms-nameCol">NAME</th>
                        <th colSpan={6} className="ms-groupHead">SERVE</th>
                      </tr>
                      <tr>
                        <StatTh tab="Serve" stat="SA">SA</StatTh>
                        <StatTh tab="Serve" stat="SE">SE</StatTh>
                        <StatTh tab="Serve" stat="TA">TA</StatTh>
                        <StatTh tab="Serve" stat="PCT">PCT</StatTh>
                        <StatTh tab="Serve" stat="EFF">EFF</StatTh>
                        <StatTh tab="Serve" stat="RW">RW</StatTh>
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
                        <StatTh tab="Set" stat="AST">AST</StatTh>
                        <StatTh tab="Set" stat="TA">TA</StatTh>
                        <StatTh tab="Set" stat="SE">SE</StatTh>
                        <StatTh tab="Set" stat="3">3</StatTh>
                        <StatTh tab="Set" stat="2">2</StatTh>
                        <StatTh tab="Set" stat="1">1</StatTh>
                        <StatTh tab="Set" stat="0">0</StatTh>
                        <StatTh tab="Set" stat="RTG">RTG.</StatTh>
                      </tr>
                    </>
                  )}
                  {activeTab === "Defence" && (
                    <>
                      <tr className="ms-groupRow">
                        <th rowSpan={2} className="ms-nameCol">NAME</th>
                        <th colSpan={3} className="ms-groupHead">DEFENCE</th>
                      </tr>
                      <tr>
                        <StatTh tab="Defence" stat="DS">DS</StatTh>
                        <StatTh tab="Defence" stat="DE">DE</StatTh>
                        <StatTh tab="Defence" stat="DS%">DS%</StatTh>
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
                        <StatTh tab="Block" stat="BK">BK</StatTh>
                        <StatTh tab="Block" stat="BA">BA</StatTh>
                        <StatTh tab="Block" stat="BE">BE</StatTh>
                      </tr>
                    </>
                  )}
                </thead>
                <tbody>
                  <tr className="ms-teamRow">
                    <td className="ms-nameCell">Team</td>
                    {activeTab === "Attack" && (
                      <>
                        <td className="ms-highlight">{fmt(teamTotals.attack.K)}</td>
                        <td className="ms-error">{fmt(teamTotals.attack.E)}</td>
                        <td>{fmt(teamTotals.attack.TA)}</td>
                        <td>{pct(teamTotals.attack["ATK%"])}</td>
                      </>
                    )}
                    {activeTab === "Serve" && (
                      <>
                        <td className="ms-highlight">{fmt(teamTotals.serve.SA)}</td>
                        <td className="ms-error">{fmt(teamTotals.serve.SE)}</td>
                        <td>{fmt(teamTotals.serve.TA)}</td>
                        <td>{pct(teamTotals.serve.PCT)}</td>
                        <td>{pct(teamTotals.serve.EFF)}</td>
                        <td className="ms-highlight">{fmt(teamTotals.serve.RW)}</td>
                      </>
                    )}
                    {activeTab === "Set" && (
                      <>
                        <td className="ms-highlight">{fmt(teamTotals.set.AST)}</td>
                        <td>{fmt(teamTotals.set.TA)}</td>
                        <td className="ms-error">{fmt(teamTotals.set.SE)}</td>
                        <td>{fmt(teamTotals.set["3"])}</td>
                        <td>{fmt(teamTotals.set["2"])}</td>
                        <td>{fmt(teamTotals.set["1"])}</td>
                        <td className="ms-error">{fmt(teamTotals.set["0"])}</td>
                        <td className="ms-highlight">{fmt(teamTotals.set.RTG, 2)}</td>
                      </>
                    )}
                    {activeTab === "Defence" && (
                      <>
                        <td className="ms-highlight">{fmt(teamTotals.defence.DS)}</td>
                        <td className="ms-error">{fmt(teamTotals.defence.DE)}</td>
                        <td>{pct(teamTotals.defence["DS%"])}</td>
                      </>
                    )}
                    {activeTab === "Block" && (
                      <>
                        <td className="ms-highlight">{fmt(teamTotals.block.BK)}</td>
                        <td>{fmt(teamTotals.block.BA)}</td>
                        <td className="ms-error">{fmt(teamTotals.block.BE)}</td>
                      </>
                    )}
                  </tr>
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
                          <td className="ms-highlight">{fmt(p.serve?.RW)}</td>
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
                      {activeTab === "Defence" && (
                        <>
                          <td className="ms-highlight">{fmt(p.defence?.DS)}</td>
                          <td className="ms-error">{fmt(p.defence?.DE)}</td>
                          <td>{pct(p.defence?.["DS%"])}</td>
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
                  {players.length === 0 && (
                    <tr>
                      <td className="ms-noContrib" colSpan={TAB_COLSPAN[activeTab]}>
                        No players recorded a {activeTab.toLowerCase()} attempt{search ? " matching your search" : ""}.
                      </td>
                    </tr>
                  )}
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
