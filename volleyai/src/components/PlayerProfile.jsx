import "./PlayerProfile.css";

export default function PlayerProfile() {
  const metricTitles = [
    "ATTACK EFF",
    "KILL %",
    "PASS RATING",
    "RECEPTION",
    "SERVE ACES",
    "DIGS/SET",
  ];

  const statTabs = ["Attack", "Block", "Serve", "Defense", "Pass"];

  return (
    <div className="pp-page">
      <div className="pp-shell">
        {/* Top breadcrumb */}
        <div className="pp-topline">
          <div className="pp-breadcrumbWrap">
            <button className="pp-backBtn" type="button" aria-label="Back">
              ←
            </button>
            <div className="pp-breadcrumb">Team / Roster / Profile</div>
          </div>

          <button className="pp-shareBtn" type="button" aria-label="Share">
            ⤴
          </button>
        </div>

        {/* Hero */}
        <section className="pp-heroCard">
          <div className="pp-heroLeft">
            <div className="pp-avatarWrap">
              <div className="pp-avatar" />
              <div className="pp-jerseyTag">#</div>
            </div>

            <div className="pp-playerInfo">
              <div className="pp-nameRow">
                <h1 className="pp-playerName">Player Name</h1>
                <span className="pp-roleTag">POSITION</span>
              </div>

              <div className="pp-teamName">Team Name</div>

              <div className="pp-divider" />

              <div className="pp-metaRow">
                <div className="pp-metaItem">
                  <span className="pp-metaSkeleton short" />
                </div>
                <div className="pp-metaItem">
                  <span className="pp-metaSkeleton short" />
                </div>
                <div className="pp-metaItem">
                  <span className="pp-metaSkeleton short" />
                </div>
              </div>
            </div>
          </div>

          <div className="pp-heroRight">
            <button className="pp-statsBtn" type="button">
              View Full Stats
            </button>
            <button className="pp-moreBtn" type="button">
              ⋯
            </button>
          </div>
        </section>

        {/* Main content */}
        <div className="pp-content">
          {/* Left side */}
          <div className="pp-mainCol">
            <div className="pp-sectionTitle">
              <span className="pp-sectionIcon">↗</span>
              <span>Key Performance Metrics</span>
            </div>

            <div className="pp-metricsGrid">
              {metricTitles.map((title) => (
                <div key={title} className="pp-metricCard">
                  <div className="pp-metricTitle">{title}</div>
                  <div className="pp-skeletonValue" />
                  <div className="pp-skeletonTag" />
                </div>
              ))}
            </div>

            <div className="pp-bottomGrid">
              {/* Left chart card */}
              <div className="pp-chartCard">
                <div className="pp-chartTabs">
                  {statTabs.map((tab, index) => (
                    <button
                      key={tab}
                      type="button"
                      className={`pp-chartTab ${index === 0 ? "active" : ""}`}
                    >
                      {tab}
                    </button>
                  ))}
                </div>

                <div className="pp-cardTitle">Chart Area</div>

                <div className="pp-chartPlaceholder">
                  <div className="pp-chartGridLines">
                    <span />
                    <span />
                    <span />
                    <span />
                  </div>

                  <div className="pp-barsWrap pp-barsSkeleton">
                    {[1, 2, 3, 4].map((item) => (
                      <div key={item} className="pp-barGroup">
                        <div className="pp-barTrack">
                          <div className="pp-bar pp-barEmpty" />
                        </div>
                        <div className="pp-barLabelSkeleton" />
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Right chart card */}
              <div className="pp-radarCard">
                <div className="pp-cardTitle">Overall Skill Profile</div>

                <div className="pp-radarWrap">
                  <div className="pp-radar">
                    <div className="pp-radarRing ring1" />
                    <div className="pp-radarRing ring2" />
                    <div className="pp-radarRing ring3" />
                    <div className="pp-radarRing ring4" />
                    <div className="pp-radarAxis axis1" />
                    <div className="pp-radarAxis axis2" />
                    <div className="pp-radarAxis axis3" />
                    <div className="pp-radarAxis axis4" />
                    <div className="pp-radarAxis axis5" />
                    <div className="pp-radarAxis axis6" />
                    <div className="pp-radarShape pp-radarShapeEmpty" />
                  </div>

                  <div className="pp-radarLabels">
                    <span className="top">Attack</span>
                    <span className="rightTop">Block</span>
                    <span className="rightBottom">Serve</span>
                    <span className="bottom">Defense</span>
                    <span className="leftBottom">Pass</span>
                    <span className="leftTop">Set</span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Right side */}
          <aside className="pp-sideCol">
            <div className="pp-actionsCard">
              <div className="pp-actionsHeader">
                <div className="pp-actionsTitle">▢ My Actions</div>
                <button className="pp-viewAllBtn" type="button">
                  View All
                </button>
              </div>

              <div className="pp-actionsList">
                {[1, 2, 3, 4, 5].map((item) => (
                  <div key={item} className="pp-actionItem">
                    <div className="pp-actionThumb">
                      <div className="pp-playBtn">▶</div>
                    </div>

                    <div className="pp-actionText">
                      <div className="pp-actionLine long" />
                      <div className="pp-actionLine medium" />
                      <div className="pp-actionLine short" />
                    </div>

                    <div className="pp-actionArrow">›</div>
                  </div>
                ))}
              </div>

              <button className="pp-filterClipsBtn" type="button">
                Filter Clips
              </button>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}