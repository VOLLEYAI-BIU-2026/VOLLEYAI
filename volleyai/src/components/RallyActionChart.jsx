import { useState } from "react";
import "./RallyActionChart.css";

const BAR_WIDTH = 20;
const BAR_GAP = 6;
const PLOT_HEIGHT = 140;
const LEFT_GUTTER = 34;
const BOTTOM_GUTTER = 22;
const TOP_PAD = 10;

// Rounds only the two corners at the bar's data-end (the top, since bars
// grow from the bottom baseline) — the baseline stays a flat, square edge.
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

// Clean y-axis ceiling (1/2/5 × 10^n) rather than the raw max, so ticks land
// on round numbers instead of whatever the tallest bar happens to be.
function niceCeil(max) {
  if (max <= 5) return Math.max(1, max);
  const magnitude = 10 ** Math.floor(Math.log10(max));
  const residual = max / magnitude;
  const niceResidual = residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 5 ? 5 : 10;
  return niceResidual * magnitude;
}

function buildTicks(niceMax) {
  const stepCount = Math.min(niceMax, 5);
  const step = niceMax / stepCount;
  const ticks = new Set();
  for (let i = 0; i <= stepCount; i++) ticks.add(Math.round(i * step));
  return [...ticks].sort((a, b) => a - b);
}

// One bar per rally, showing how many of the active tab's action type
// occurred in that rally — e.g. attacks per rally on the Attack tab. A
// single series, so no legend: the title names what's plotted.
export default function RallyActionChart({ data, title }) {
  const [hoverIdx, setHoverIdx] = useState(null);

  if (!data.length) return null;

  const niceMax = niceCeil(Math.max(...data.map((d) => d.count)));
  const ticks = buildTicks(niceMax);
  const plotWidth = data.length * (BAR_WIDTH + BAR_GAP);
  const svgWidth = LEFT_GUTTER + plotWidth + 8;
  const svgHeight = TOP_PAD + PLOT_HEIGHT + BOTTOM_GUTTER;

  const yFor = (count) => TOP_PAD + PLOT_HEIGHT - (niceMax > 0 ? (count / niceMax) * PLOT_HEIGHT : 0);
  const hovered = hoverIdx != null ? data[hoverIdx] : null;

  return (
    <div className="rac-card">
      <div className="rac-title">{title}</div>
      <div className="rac-scrollWrap">
        <div className="rac-svgWrap" style={{ width: svgWidth }}>
          <svg width={svgWidth} height={svgHeight} role="img" aria-label={title}>
            {ticks.map((t) => {
              const y = yFor(t);
              return (
                <g key={t}>
                  <line x1={LEFT_GUTTER} x2={svgWidth} y1={y} y2={y} className="rac-gridline" />
                  <text x={LEFT_GUTTER - 6} y={y + 3} textAnchor="end" className="rac-axisLabel">{t}</text>
                </g>
              );
            })}
            <line
              x1={LEFT_GUTTER} x2={svgWidth}
              y1={TOP_PAD + PLOT_HEIGHT} y2={TOP_PAD + PLOT_HEIGHT}
              className="rac-baseline"
            />
            {data.map((d, i) => {
              const x = LEFT_GUTTER + i * (BAR_WIDTH + BAR_GAP);
              const barY = yFor(d.count);
              const barH = TOP_PAD + PLOT_HEIGHT - barY;
              const isHover = hoverIdx === i;
              return (
                <g key={d.rally_id}>
                  {d.count > 0 && (
                    <path
                      d={roundedTopBarPath(x, barY, BAR_WIDTH, barH, 4)}
                      className={`rac-bar${isHover ? " rac-barHover" : ""}`}
                    />
                  )}
                  {/* Hit target spans the full plot height, not just the bar,
                      so a zero-count rally is still reachable/hoverable. */}
                  <rect
                    x={x - BAR_GAP / 2} y={TOP_PAD} width={BAR_WIDTH + BAR_GAP} height={PLOT_HEIGHT}
                    fill="transparent"
                    tabIndex={0}
                    role="img"
                    aria-label={`Rally ${d.rally_id}: ${d.count}`}
                    onMouseEnter={() => setHoverIdx(i)}
                    onMouseLeave={() => setHoverIdx(null)}
                    onFocus={() => setHoverIdx(i)}
                    onBlur={() => setHoverIdx(null)}
                  />
                  <text
                    x={x + BAR_WIDTH / 2} y={TOP_PAD + PLOT_HEIGHT + 15}
                    textAnchor="middle" className="rac-tickLabel"
                  >
                    {d.rally_id}
                  </text>
                </g>
              );
            })}
          </svg>
          {hovered && (
            <div
              className="rac-tooltip"
              style={{
                left: LEFT_GUTTER + hoverIdx * (BAR_WIDTH + BAR_GAP) + BAR_WIDTH / 2,
                top: yFor(hovered.count),
              }}
            >
              <div className="rac-tooltipValue">{hovered.count}</div>
              <div className="rac-tooltipLabel">Rally {hovered.rally_id}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
