import { useState } from "react";
import "./MatchStatistics.css";

export default function MatchStatistics() {
  const [activeTab, setActiveTab] = useState("Attack");
  const [filtersOpen, setFiltersOpen] = useState(false);

  const [draftRotation, setDraftRotation] = useState("All");
  const [draftSet, setDraftSet] = useState("All");

  const [appliedRotation, setAppliedRotation] = useState("All");
  const [appliedSet, setAppliedSet] = useState("All");

  const tabs = ["Attack", "Serve", "Passing", "Setting", "Blocking", "Defense"];
  const rotations = ["All", "1", "2", "3", "4", "5", "6"];
  const sets = ["All", "1", "2", "3", "4", "5"];

  function openFilters() {
    setDraftRotation(appliedRotation);
    setDraftSet(appliedSet);
    setFiltersOpen(true);
  }

  function handleApplyFilters() {
    setAppliedRotation(draftRotation);
    setAppliedSet(draftSet);
    setFiltersOpen(false);
  }

  return (
    <div className="ms-page">
      <div className="ms-shell">
        <div className="ms-header">
          <div className="ms-headerLeft">
            <button className="ms-backBtn" type="button" aria-label="Back">
              <span>←</span>
            </button>

            <div>
              <div className="ms-breadcrumb">Analytics / Statistics</div>
              <h1 className="ms-title">Full Match Statistics</h1>
            </div>
          </div>

          <button className="ms-exportBtn" type="button">
            ↓ Export CSV
          </button>
        </div>

        <div className="ms-tabs">
          {tabs.map((tab) => (
            <button
              key={tab}
              type="button"
              className={`ms-tab ${activeTab === tab ? "active" : ""}`}
              onClick={() => setActiveTab(tab)}
            >
              {tab}
            </button>
          ))}
        </div>

        <div className="ms-filters">
          <div className="ms-filtersLeft">
            <div className="ms-searchWrap">
              <span className="ms-searchIcon">⌕</span>
              <input
                className="ms-search"
                type="text"
                placeholder="Search player..."
              />
            </div>

            <button className="ms-teamFilter" type="button">
              All Teams ▾
            </button>

            <div className="ms-filterAnchor">
              <button
                className={`ms-filterToggle ${filtersOpen ? "active" : ""}`}
                type="button"
                onClick={() => {
                  if (filtersOpen) {
                    setFiltersOpen(false);
                  } else {
                    openFilters();
                  }
                }}
              >
                ☰ Filters
              </button>

              {filtersOpen && (
                <div className="ms-filterPopup">
                  <div className="ms-filterSection">
                    <h3 className="ms-filterTitle">Rotation</h3>

                    <div className="ms-chipRow">
                      {rotations.map((rotation) => (
                        <button
                          key={rotation}
                          type="button"
                          className={`ms-chip ${draftRotation === rotation ? "active" : ""}`}
                          onClick={() => setDraftRotation(rotation)}
                        >
                          {rotation}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="ms-filterSection">
                    <h3 className="ms-filterTitle">Set Number</h3>

                    <div className="ms-chipRow">
                      {sets.map((setNum) => (
                        <button
                          key={setNum}
                          type="button"
                          className={`ms-chip ${draftSet === setNum ? "active" : ""}`}
                          onClick={() => setDraftSet(setNum)}
                        >
                          {setNum}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="ms-filterActions">
                    <button
                      className="ms-applyBtn"
                      type="button"
                      onClick={handleApplyFilters}
                    >
                      Apply Filters
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="ms-countText">No players yet</div>
        </div>

        <div className="ms-tableCard">
          <div className="ms-tableWrap">
            <table className="ms-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>PLAYER</th>
                  <th>TEAM</th>
                  <th>POS</th>
                  <th>SETS ↕</th>
                  <th>KILLS ↕</th>
                  <th className="ms-errorsColHead">ERRORS ↕</th>
                  <th>TOTAL ↕</th>
                  <th>EFF % ↕</th>
                  <th>KILL % ↕</th>
                </tr>
              </thead>

              <tbody>
                <tr>
                  <td colSpan="10" className="ms-emptyCell">
                    <div className="ms-emptyState">
                      <div className="ms-emptyIcon">📊</div>
                      <div className="ms-emptyTitle">No statistics yet</div>
                      <div className="ms-emptyText">
                        Once player and match data are available, statistics will appear here.
                      </div>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="ms-tableFooter">
            <div className="ms-footerLeft">Showing 0 to 0 of 0 entries</div>

            <div className="ms-footerRight">
              <button className="ms-pageBtn muted" type="button">
                Previous
              </button>
              <button className="ms-pageBtn muted" type="button">
                Next
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}