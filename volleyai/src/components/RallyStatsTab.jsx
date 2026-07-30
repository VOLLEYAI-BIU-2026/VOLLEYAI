import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import "./RallyStatsTab.css";

const BUCKET_BAR_WIDTH = 64;
const BUCKET_GAP = 40;
const PLOT_HEIGHT = 140;
const LEFT_GUTTER = 34;
const TOP_PAD = 10;
const BOTTOM_GUTTER = 34;

function formatDuration(sec) {
  if (sec == null) return "-";
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}:${String(r).padStart(2, "0")}` : `${r}s`;
}

const RESULT_LABEL = {
  point_my_team: "Won",
  point_opponent: "Lost",
  outside: "Ball out",
  unknown: "Unresolved",
};
const RESULT_CLASS = {
  point_my_team: "rst-badgeWon",
  point_opponent: "rst-badgeLost",
  outside: "rst-badgeNeutral",
  unknown: "rst-badgeNeutral",
};

// point_outcome.category → plain-language cause, for the outcomes-timeline tooltip.
const CAUSE_LABEL = {
  kill: "Kill",
  block_kill: "Block kill",
  ace: "Ace",
  opponent_error: "Opponent error",
  attack_error: "Attack error",
  block_error: "Block error",
  defense_attempt: "Defense error",
  set_error: "Set error",
  service_error: "Service error",
  opponent_kill: "Opponent kill",
};

function outcomeShortLabel(r) {
  if (r.result === "point_my_team" || r.result === "point_opponent") {
    const po = r.point_outcome;
    const cause = po ? CAUSE_LABEL[po.category] || po.category : (r.result === "point_my_team" ? "Won" : "Lost");
    const jersey = po?.jersey != null ? ` — #${po.jersey}` : "";
    return `${cause}${jersey}`;
  }
  return r.result === "outside" ? "Ball out" : "Unresolved";
}

function roundedTopBarPath(x, y, width, height, radius) {
  if (height <= 0) return "";
  const r = Math.min(radius, width / 2, height);
  return `M ${x} ${y + height}
          L ${x} ${y + r}
          Q ${x} ${y} ${x + r} ${y}
          L ${x + width - r} ${y}
          Q ${x + width} ${y} ${x + width} ${y + r}
          L ${x + width} ${y + height}
          Z`;
}

// Mirror of roundedTopBarPath for a bar that grows DOWNWARD from the
// baseline (the outcomes timeline's loss bars) — rounds the bottom two
// corners (the data-end, now pointing away from the baseline) and keeps the
// top edge flat and square against the baseline.
function roundedBottomBarPath(x, y, width, height, radius) {
  if (height <= 0) return "";
  const r = Math.min(radius, width / 2, height);
  return `M ${x} ${y}
          L ${x} ${y + height - r}
          Q ${x} ${y + height} ${x + r} ${y + height}
          L ${x + width - r} ${y + height}
          Q ${x + width} ${y + height} ${x + width} ${y + height - r}
          L ${x + width} ${y}
          Z`;
}

// Longest run of consecutive decisive rallies (in match order) won or lost
// in a row — unresolved/outside rallies are skipped rather than treated as
// streak-breakers, since they're rare edge cases (mostly a clip cut off
// mid-rally) and "did we win the next real point" is what a streak means.
function computeStreaks(decisiveInOrder) {
  let longestWin = 0, longestLoss = 0, curWin = 0, curLoss = 0;
  let winRange = null, lossRange = null, curWinStart = null, curLossStart = null;
  for (const r of decisiveInOrder) {
    if (r.result === "point_my_team") {
      if (curWin === 0) curWinStart = r.rally_id;
      curWin++;
      curLoss = 0;
      if (curWin > longestWin) { longestWin = curWin; winRange = [curWinStart, r.rally_id]; }
    } else {
      if (curLoss === 0) curLossStart = r.rally_id;
      curLoss++;
      curWin = 0;
      if (curLoss > longestLoss) { longestLoss = curLoss; lossRange = [curLossStart, r.rally_id]; }
    }
  }
  return { longestWin, winRange, longestLoss, lossRange };
}

function formatStreakRange(range) {
  if (!range) return "No streak yet";
  return range[0] === range[1] ? `Rally ${range[0]}` : `Rallies ${range[0]}–${range[1]}`;
}

// Splits decisive (won/lost) rallies into three roughly-equal-count groups by
// duration — terciles rather than fixed second thresholds, since a fixed cut
// (e.g. "long = 20s+") would put a whole small match's rallies in one bucket.
function bucketByDuration(rallies) {
  const sorted = [...rallies].sort((a, b) => a.duration - b.duration);
  const n = sorted.length;
  if (n === 0) return [];
  const third = Math.ceil(n / 3);
  return [
    { label: "Short", group: sorted.slice(0, third) },
    { label: "Medium", group: sorted.slice(third, third * 2) },
    { label: "Long", group: sorted.slice(third * 2) },
  ]
    .filter((b) => b.group.length > 0)
    .map((b) => {
      const won = b.group.filter((r) => r.result === "point_my_team").length;
      const total = b.group.length;
      return {
        label: b.label,
        total,
        won,
        winPct: total > 0 ? won / total : null,
        minD: Math.min(...b.group.map((r) => r.duration)),
        maxD: Math.max(...b.group.map((r) => r.duration)),
      };
    });
}

function BucketChart({ buckets }) {
  const [hoverIdx, setHoverIdx] = useState(null);
  if (!buckets.length) return null;

  const plotWidth = buckets.length * (BUCKET_BAR_WIDTH + BUCKET_GAP);
  const svgWidth = LEFT_GUTTER + plotWidth + 8;
  const svgHeight = TOP_PAD + PLOT_HEIGHT + BOTTOM_GUTTER;
  const yFor = (pct) => TOP_PAD + PLOT_HEIGHT - pct * PLOT_HEIGHT;
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const hovered = hoverIdx != null ? buckets[hoverIdx] : null;

  return (
    <div className="rst-chartCard">
      <div className="rst-chartTitle">Win % by rally length</div>
      <div className="rst-scrollWrap">
        <div className="rst-svgWrap" style={{ width: svgWidth }}>
          <svg width={svgWidth} height={svgHeight} role="img" aria-label="Win percentage by rally length">
            {ticks.map((t) => {
              const y = yFor(t);
              return (
                <g key={t}>
                  <line x1={LEFT_GUTTER} x2={svgWidth} y1={y} y2={y} className="rst-gridline" />
                  <text x={LEFT_GUTTER - 6} y={y + 3} textAnchor="end" className="rst-axisLabel">
                    {Math.round(t * 100)}%
                  </text>
                </g>
              );
            })}
            <line x1={LEFT_GUTTER} x2={svgWidth} y1={TOP_PAD + PLOT_HEIGHT} y2={TOP_PAD + PLOT_HEIGHT} className="rst-baseline" />
            {buckets.map((b, i) => {
              const x = LEFT_GUTTER + i * (BUCKET_BAR_WIDTH + BUCKET_GAP) + BUCKET_GAP / 2;
              const pct = b.winPct ?? 0;
              const barY = yFor(pct);
              const barH = TOP_PAD + PLOT_HEIGHT - barY;
              const isHover = hoverIdx === i;
              return (
                <g key={b.label}>
                  {b.winPct != null && (
                    <path d={roundedTopBarPath(x, barY, BUCKET_BAR_WIDTH, barH, 4)} className={`rst-bar${isHover ? " rst-barHover" : ""}`} />
                  )}
                  <rect
                    x={x - BUCKET_GAP / 2} y={TOP_PAD} width={BUCKET_BAR_WIDTH + BUCKET_GAP} height={PLOT_HEIGHT}
                    fill="transparent" tabIndex={0} role="img"
                    aria-label={`${b.label} rallies (${formatDuration(b.minD)}–${formatDuration(b.maxD)}): ${Math.round((b.winPct ?? 0) * 100)}% won, ${b.won} of ${b.total}`}
                    onMouseEnter={() => setHoverIdx(i)}
                    onMouseLeave={() => setHoverIdx(null)}
                    onFocus={() => setHoverIdx(i)}
                    onBlur={() => setHoverIdx(null)}
                  />
                  <text x={x + BUCKET_BAR_WIDTH / 2} y={TOP_PAD + PLOT_HEIGHT + 16} textAnchor="middle" className="rst-tickLabel">
                    {b.label}
                  </text>
                  <text x={x + BUCKET_BAR_WIDTH / 2} y={TOP_PAD + PLOT_HEIGHT + 30} textAnchor="middle" className="rst-tickSubLabel">
                    {formatDuration(b.minD)}–{formatDuration(b.maxD)}
                  </text>
                </g>
              );
            })}
          </svg>
          {hovered && (
            <div
              className="rst-tooltip"
              style={{
                left: LEFT_GUTTER + hoverIdx * (BUCKET_BAR_WIDTH + BUCKET_GAP) + BUCKET_GAP / 2 + BUCKET_BAR_WIDTH / 2,
                top: yFor(hovered.winPct ?? 0),
              }}
            >
              <div className="rst-tooltipValue">{Math.round((hovered.winPct ?? 0) * 100)}%</div>
              <div className="rst-tooltipLabel">{hovered.won} won of {hovered.total}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const OT_GAP = 5;
const OT_MIN_BAR_WIDTH = 10;
const OT_MAX_BAR_WIDTH = 100;
const OT_HALF_HEIGHT = 55;
const OT_GUTTER = 8;
const OT_END_PAD = 8;
const OT_LABEL_SPACE = 20;

// One bar per rally, growing up (won, green) or down (lost, red) from a
// center baseline — a classic "game log" read: a run of same-color bars is
// a streak, visible at a glance, with the specific cause on hover. A flat
// neutral tick marks a rally with no resolved winner (rare — usually a clip
// cut off mid-rally) so it doesn't silently vanish from the sequence.
//
// Bar width is computed from the card's actual rendered width (not a fixed
// constant) so the chart fills the space it's given instead of rendering as
// a narrow strip inside a much wider card — clamped to a sane range so it
// neither shrinks to unreadable slivers nor balloons for a two-rally match.
// Only once even the minimum width would overflow does it fall back to a
// horizontally-scrollable strip, same as the other charts on this page.
function OutcomeTimelineChart({ rallies }) {
  const [hoverIdx, setHoverIdx] = useState(null);
  const containerRef = useRef(null);
  const svgRef = useRef(null);
  const [containerWidth, setContainerWidth] = useState(0);
  // Screen-space anchor for the hovered bar (viewport px), captured off the
  // real DOM element on hover — not derived from SVG-local coordinates —
  // because the tooltip renders through a portal (see below) and needs
  // real screen coordinates to position itself.
  const [anchor, setAnchor] = useState(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setContainerWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  if (!rallies.length) return null;

  const n = rallies.length;
  const available = containerWidth - OT_GUTTER - OT_END_PAD - n * OT_GAP;
  const fittedBarWidth = available > 0 ? available / n : OT_MIN_BAR_WIDTH;
  const barWidth = Math.max(OT_MIN_BAR_WIDTH, Math.min(OT_MAX_BAR_WIDTH, fittedBarWidth));

  const plotWidth = n * (barWidth + OT_GAP);
  const svgWidth = Math.max(containerWidth, OT_GUTTER + plotWidth + OT_END_PAD);
  const svgHeight = OT_HALF_HEIGHT * 2 + OT_LABEL_SPACE;
  const midY = OT_HALF_HEIGHT + 2;
  const hovered = hoverIdx != null ? rallies[hoverIdx] : null;

  // The chart lives inside a horizontally-scrollable strip (rst-scrollWrap)
  // — a tooltip positioned relative to that ancestor gets clipped by its
  // overflow whenever it pokes above/below the strip's own box (which a
  // "won" bar's tooltip, sitting near the very top of the plot, reliably
  // does). Compute the bar's real on-screen position instead and portal the
  // tooltip to <body>, so it paints above everything with no clipping
  // ancestor at all — the standard fix for a tooltip inside a scroll area.
  function showTooltip(i, isLoss) {
    setHoverIdx(i);
    const svgBox = svgRef.current?.getBoundingClientRect();
    if (!svgBox) return;
    const x = OT_GUTTER + i * (barWidth + OT_GAP) + barWidth / 2;
    const y = isLoss ? midY + OT_HALF_HEIGHT - 10 : midY - OT_HALF_HEIGHT + 10;
    setAnchor({ left: svgBox.left + x, top: svgBox.top + y, below: isLoss });
  }
  function hideTooltip() {
    setHoverIdx(null);
    setAnchor(null);
  }

  return (
    <div className="rst-chartCard">
      <div className="rst-chartTitle">Rally-by-rally outcomes</div>
      <div className="rst-legendRow">
        <span className="rst-legendItem"><span className="rst-legendSwatch rst-swatchWon" />Won</span>
        <span className="rst-legendItem"><span className="rst-legendSwatch rst-swatchLost" />Lost</span>
        <span className="rst-legendItem"><span className="rst-legendSwatch rst-swatchNeutral" />Unresolved</span>
      </div>
      <div className="rst-scrollWrap" ref={containerRef}>
        <div className="rst-svgWrap" style={{ width: svgWidth }}>
          <svg ref={svgRef} width={svgWidth} height={svgHeight} role="img" aria-label="Rally outcomes across the match, in order">
            <line x1={OT_GUTTER} x2={svgWidth} y1={midY} y2={midY} className="rst-baseline" />
            {rallies.map((r, i) => {
              const x = OT_GUTTER + i * (barWidth + OT_GAP);
              const isWin = r.result === "point_my_team";
              const isLoss = r.result === "point_opponent";
              const barH = isWin || isLoss ? OT_HALF_HEIGHT - 6 : 3;
              const isHover = hoverIdx === i;
              const colorClass = isWin ? "rst-outWon" : isLoss ? "rst-outLost" : "rst-outNeutral";
              const path = isLoss
                ? roundedBottomBarPath(x, midY, barWidth, barH, 4)
                : roundedTopBarPath(x, midY - barH, barWidth, barH, isWin ? 4 : 2);
              return (
                <g key={r.rally_id}>
                  <path d={path} className={`${colorClass}${isHover ? " rst-outHover" : ""}`} />
                  <rect
                    x={x - OT_GAP / 2} y={2} width={barWidth + OT_GAP} height={svgHeight - OT_LABEL_SPACE + 2}
                    fill="transparent" tabIndex={0} role="img"
                    aria-label={`Rally ${r.rally_id}: ${outcomeShortLabel(r)}`}
                    onMouseEnter={() => showTooltip(i, isLoss)}
                    onMouseLeave={hideTooltip}
                    onFocus={() => showTooltip(i, isLoss)}
                    onBlur={hideTooltip}
                  />
                  <text x={x + barWidth / 2} y={svgHeight - 6} textAnchor="middle" className="rst-tickSubLabel">
                    {r.rally_id}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      </div>
      {hovered && anchor && createPortal(
        <div
          className={`rst-tooltip rst-tooltipFixed${anchor.below ? " rst-tooltipBelow" : ""}`}
          style={{ left: anchor.left, top: anchor.top }}
        >
          <div className="rst-tooltipValue">{outcomeShortLabel(hovered)}</div>
          <div className="rst-tooltipLabel">Rally {hovered.rally_id} · {formatDuration(hovered.duration)}</div>
        </div>,
        document.body
      )}
    </div>
  );
}

function RallyCard({ label, rally }) {
  if (!rally) {
    return (
      <div className="rst-card">
        <div className="rst-cardLabel">{label}</div>
        <div className="rst-cardEmpty">No rallies yet</div>
      </div>
    );
  }
  return (
    <div className="rst-card">
      <div className="rst-cardLabel">{label}</div>
      <div className="rst-cardValue">{formatDuration(rally.duration)}</div>
      <div className="rst-cardMeta">
        <span className={`rst-badge ${RESULT_CLASS[rally.result] || "rst-badgeNeutral"}`}>
          {RESULT_LABEL[rally.result] || "Unresolved"}
        </span>
        <span className="rst-cardRallyId">Rally {rally.rally_id}</span>
      </div>
    </div>
  );
}

export default function RallyStatsTab({ rallies }) {
  const nonVoid = rallies
    .filter((r) => !r.void_rally)
    .map((r) => ({ ...r, duration: r.end_sec - r.start_sec }));

  if (nonVoid.length === 0) {
    return (
      <div className="rst-emptyState">
        <div className="rst-emptyIcon">⏱️</div>
        <div className="rst-emptyTitle">No rally data yet</div>
        <div className="rst-emptyText">Run the analysis to see rally-length stats.</div>
      </div>
    );
  }

  const longest = nonVoid.reduce((a, b) => (b.duration > a.duration ? b : a));
  const shortest = nonVoid.reduce((a, b) => (b.duration < a.duration ? b : a));

  const decisive = nonVoid.filter((r) => r.result === "point_my_team" || r.result === "point_opponent");
  const won = decisive.filter((r) => r.result === "point_my_team");
  const lost = decisive.filter((r) => r.result === "point_opponent");
  const avg = (arr) => (arr.length ? arr.reduce((s, r) => s + r.duration, 0) / arr.length : null);
  const avgWon = avg(won);
  const avgLost = avg(lost);

  const buckets = bucketByDuration(decisive);
  const withEnoughData = buckets.filter((b) => b.winPct != null);
  let insight = "Not enough rallies yet to tell whether length affects your win rate.";
  if (withEnoughData.length >= 2) {
    const best = withEnoughData.reduce((a, b) => (b.winPct > a.winPct ? b : a));
    const worst = withEnoughData.reduce((a, b) => (b.winPct < a.winPct ? b : a));
    if (best.winPct - worst.winPct >= 0.15) {
      insight = `You're winning more in ${best.label.toLowerCase()} rallies (${Math.round(best.winPct * 100)}%) than ${worst.label.toLowerCase()} ones (${Math.round(worst.winPct * 100)}%).`;
    } else {
      insight = "Win rate looks similar across short, medium, and long rallies — no strong pattern yet.";
    }
  }

  const decisiveInOrder = [...decisive].sort((a, b) => a.rally_id - b.rally_id);
  const { longestWin, winRange, longestLoss, lossRange } = computeStreaks(decisiveInOrder);
  const outcomesInOrder = [...nonVoid].sort((a, b) => a.rally_id - b.rally_id);

  return (
    <div className="rst-wrap">
      <div className="rst-cardRow">
        <RallyCard label="Longest rally" rally={longest} />
        <RallyCard label="Shortest rally" rally={shortest} />
        <div className="rst-card">
          <div className="rst-cardLabel">Avg. duration — won</div>
          <div className="rst-cardValue rst-valueWon">{formatDuration(avgWon)}</div>
          <div className="rst-cardMeta"><span className="rst-cardRallyId">{won.length} rallies</span></div>
        </div>
        <div className="rst-card">
          <div className="rst-cardLabel">Avg. duration — lost</div>
          <div className="rst-cardValue rst-valueLost">{formatDuration(avgLost)}</div>
          <div className="rst-cardMeta"><span className="rst-cardRallyId">{lost.length} rallies</span></div>
        </div>
      </div>

      <div className="rst-cardRow rst-cardRowHalf">
        <div className="rst-card">
          <div className="rst-cardLabel">Longest win streak</div>
          <div className="rst-cardValue rst-valueWon">{longestWin || "-"}</div>
          <div className="rst-cardMeta">
            <span className="rst-cardRallyId">{formatStreakRange(winRange)}</span>
          </div>
        </div>
        <div className="rst-card">
          <div className="rst-cardLabel">Longest losing streak</div>
          <div className="rst-cardValue rst-valueLost">{longestLoss || "-"}</div>
          <div className="rst-cardMeta">
            <span className="rst-cardRallyId">{formatStreakRange(lossRange)}</span>
          </div>
        </div>
      </div>

      <OutcomeTimelineChart rallies={outcomesInOrder} />

      <BucketChart buckets={buckets} />

      <div className="rst-insight">{insight}</div>
    </div>
  );
}
