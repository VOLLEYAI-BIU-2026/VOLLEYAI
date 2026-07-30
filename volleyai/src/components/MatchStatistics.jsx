import { API_BASE } from "../config.js";
import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import RallyActionChart from "./RallyActionChart.jsx";
import RallyStatsTab from "./RallyStatsTab.jsx";
import "./MatchStatistics.css";

const API = API_BASE;

const TABS = ["Rally", "Attack", "Serve", "Set", "Defence", "Block"];

// Which raw action type each tab's chart counts per rally, and the chart's title.
const TAB_ACTION_TYPE = {
  Attack:  "attack",
  Serve:   "service",
  Set:     "setting",
  Defence: "defense-move",
  Block:   "block",
};
const TAB_CHART_TITLE = {
  Attack:  "Attacks per rally",
  Serve:   "Serves per rally",
  Set:     "Sets per rally",
  Defence: "Defensive touches per rally",
  Block:   "Blocks per rally",
};

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
    case "Block":   return (p.block?.TA ?? 0) > 0;
    default:        return true;
  }
}

// How many <td> columns (including NAME) each tab's table has, for the
// colSpan of the "nobody did this yet" row.
const TAB_COLSPAN = { Attack: 5, Serve: 7, Set: 4, Defence: 4, Block: 5 };

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
  },
  Defence: {
    DS:    { full: "Dig Save",                desc: "A dig that keeps the ball in play." },
    DE:    { full: "Defence Error",           desc: "A dig attempt that fails to keep the ball in play." },
    "DS%": { full: "Dig Success Percentage",  desc: "Share of defensive attempts that were successful: Digs Saved ÷ Total Attempts." },
  },
  Block: {
    BK:    { full: "Block Kill",   desc: "A block that scores directly for a point." },
    BE:    { full: "Block Error",  desc: "A block attempt that results in a point for the opponent — net touch, deflected out, etc." },
    BT:    { full: "Block Touch",  desc: "A block contact that didn't decide the rally — neither a kill nor an error. Not counted toward Win%: there's no signal to confirm it actually helped." },
    "WIN%":{ full: "Block Win %",  desc: "Share of decisive blocks that scored: Kills ÷ (Kills + Errors). Touches (BT) are excluded from both sides." },
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

  const [activeTab, setActiveTab] = useState("Rally");
  const [search, setSearch] = useState("");
  const teamFilter = "all";
  const [stats, setStats] = useState({});
  const [rosterMap, setRosterMap] = useState({});
  const [validJerseys, setValidJerseys] = useState(null);
  const [rallies, setRallies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [aiStatus, setAiStatus] = useState("idle"); // idle | loading | error | done
  const [aiResult, setAiResult] = useState(null);
  const [aiErrorMsg, setAiErrorMsg] = useState("");

  async function generateAiRecommendation() {
    setActiveTab("Rally");
    setAiStatus("loading");
    setAiErrorMsg("");
    try {
      const res = await fetch(`${API}/videos/${videoId}/ai-recommendation`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) {
        setAiErrorMsg(data.message || "Failed to generate recommendation.");
        setAiStatus("error");
        return;
      }
      setAiResult(data);
      setAiStatus("done");
    } catch {
      setAiErrorMsg("Failed to reach the server.");
      setAiStatus("error");
    }
  }

  useEffect(() => {
    async function fetchAll() {
      try {
        const [statsRes, rosterRes, registryRes, rallyRes] = await Promise.all([
          fetch(`${API}/videos/${videoId}/player-stats`, { credentials: "include" }),
          fetch(`${API}/videos/${videoId}/team-roster`, { credentials: "include" }),
          fetch(`${API}/videos/player-registry`, { credentials: "include" }),
          fetch(`${API}/videos/${videoId}/rally-analysis`, { credentials: "include" }),
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

        if (rallyRes.ok) {
          const rallyData = await rallyRes.json();
          setRallies(rallyData.rallies || []);
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

  const tabEligiblePlayers = rosterPlayers.filter((p) => hasTabContribution(p, activeTab));

  const players = tabEligiblePlayers
    .filter((p) =>
      search ? p.label.toLowerCase().includes(search.toLowerCase()) : true
    )
    .sort((a, b) => b.total_events - a.total_events);

  // Crowns whoever leads the tab's own headline stat (the same column
  // already styled ms-highlight) — computed off the full tab roster, not the
  // search-narrowed `players` list, so typing in the search box can't make
  // the "best" player appear to change. A raw-count tie (e.g. two players
  // both on 1 kill) falls through to an efficiency tiebreaker rather than
  // crowning both — verified against real output: #3 and #13 tied at K:1,
  // but #3's ATK% (0.5) was clearly better than #13's (0.25), and only one
  // of them is "the" best attacker. Only a genuine tie on both keys crowns
  // more than one player; nobody's crowned when the whole tab is at zero.
  const bestPlayerRank = {
    Attack:  (p) => [p.attack?.K ?? 0, p.attack?.["ATK%"] ?? -Infinity],
    Serve:   (p) => [p.serve?.SA ?? 0, p.serve?.EFF ?? -Infinity],
    Set:     (p) => [p.set?.AST ?? 0, p.set?.TA ?? 0],
    Defence: (p) => [p.defence?.DS ?? 0, p.defence?.["DS%"] ?? -Infinity],
    Block:   (p) => [p.block?.BK ?? 0, p.block?.["WIN%"] ?? -Infinity],
  }[activeTab];
  const compareRank = (a, b) => a[0] !== b[0] ? b[0] - a[0] : b[1] - a[1];
  let bestPlayerKeys = new Set();
  if (bestPlayerRank && tabEligiblePlayers.length > 0) {
    const ranked = [...tabEligiblePlayers].sort((a, b) => compareRank(bestPlayerRank(a), bestPlayerRank(b)));
    const topRank = bestPlayerRank(ranked[0]);
    if (topRank[0] > 0) {
      bestPlayerKeys = new Set(
        ranked.filter((p) => compareRank(bestPlayerRank(p), topRank) === 0).map((p) => p.key)
      );
    }
  }

  // One count per rally of the active tab's action type — e.g. how many
  // attacks happened in each rally, for the chart under the Attack table.
  const rallyChartData = rallies.map((r) => ({
    rally_id: r.rally_id,
    count: (r.actions || []).filter((a) => a.action === TAB_ACTION_TYPE[activeTab]).length,
  }));

  // Team row = sum of every rostered player's raw counts, not just the
  // currently searched/sorted subset — a search shouldn't change what
  // "the team" totals to.
  const teamTotals = (() => {
    const t = {
      attack:  { K: 0, E: 0, TA: 0 },
      serve:   { SA: 0, SE: 0, TA: 0, RW: 0 },
      block:   { BK: 0, BE: 0, BT: 0 },
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
      t.block.BE   += p.block?.BE ?? 0;
      t.block.BT   += p.block?.BT ?? 0;
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
    // BK/BE can be fractional (joint blocks split evenly) -- round off
    // summation drift before it's displayed or divided.
    t.block.BK = Math.round(t.block.BK * 100) / 100;
    t.block.BE = Math.round(t.block.BE * 100) / 100;
    const blockDecisive = t.block.BK + t.block.BE;
    t.block["WIN%"]  = blockDecisive > 0 ? t.block.BK / blockDecisive : null;
    return t;
  })();

  function exportCSV() {
    // Full box score across every category, regardless of which tab happens
    // to be open — uses rosterPlayers (not the tab-filtered `players`), so a
    // player who e.g. never blocked still shows up with their serve/attack
    // numbers instead of being silently dropped depending on the active tab.
    const headers = ["Player", "K", "E", "TA", "ATK%", "SA", "SE", "RW", "AST", "DS", "DE", "BK", "BE"];
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
      p.block?.BK ?? 0,
      p.block?.BE ?? 0,
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
            <button className="ms-aiHeaderBtn" onClick={generateAiRecommendation} disabled={aiStatus === "loading"}>
              {aiStatus === "loading" ? "Analyzing… 🪄🎩" : aiStatus === "done" ? "Regenerate AI Recommendations 🪄🎩" : "Get AI Recommendations 🪄🎩"}
            </button>
            <button className="ms-registryBtn" onClick={() => navigate(`/player-select/${videoId}`)}>
              Player Stats
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

        {activeTab === "Rally" ? (
          <RallyStatsTab rallies={rallies} aiStatus={aiStatus} aiResult={aiResult} aiErrorMsg={aiErrorMsg} />
        ) : (
          <>
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
                        <th colSpan={3} className="ms-groupHead">SET</th>
                      </tr>
                      <tr>
                        <StatTh tab="Set" stat="AST">AST</StatTh>
                        <StatTh tab="Set" stat="TA">TA</StatTh>
                        <StatTh tab="Set" stat="SE">SE</StatTh>
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
                        <th colSpan={4} className="ms-groupHead">BLOCK</th>
                      </tr>
                      <tr>
                        <StatTh tab="Block" stat="BK">BK</StatTh>
                        <StatTh tab="Block" stat="BE">BE</StatTh>
                        <StatTh tab="Block" stat="BT">BT</StatTh>
                        <StatTh tab="Block" stat="WIN%">WIN%</StatTh>
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
                        <td className="ms-error">{fmt(teamTotals.block.BE)}</td>
                        <td>{fmt(teamTotals.block.BT)}</td>
                        <td>{pct(teamTotals.block["WIN%"])}</td>
                      </>
                    )}
                  </tr>
                  {players.map((p) => (
                    <tr key={p.key}>
                      <td
                        className="ms-nameCell ms-nameCellLink"
                        onClick={() => navigate(`/player-profile/${videoId}/${p.key}`)}
                        title="View player profile"
                      >
                        {p.label}
                        {bestPlayerKeys.has(p.key) && (
                          <span className="ms-crown" title={`Best ${activeTab.toLowerCase()} in this match`}>👑</span>
                        )}
                      </td>
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
                          <td className="ms-error">{fmt(p.block?.BE)}</td>
                          <td>{fmt(p.block?.BT)}</td>
                          <td>{pct(p.block?.["WIN%"])}</td>
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

        {!loading && !error && (
          <RallyActionChart data={rallyChartData} title={TAB_CHART_TITLE[activeTab]} />
        )}
          </>
        )}

      </div>
    </div>
  );
}
