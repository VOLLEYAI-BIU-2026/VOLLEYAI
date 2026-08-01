# How VolleyAI works: the upload → analysis → stats pipeline

This is a code-level walkthrough of exactly what happens from the moment a coach
uploads a match video to the moment stats appear on screen. Every claim below is
tied to a specific file and line range in the current codebase — nothing here is
paraphrased from memory.

## The short version

1. Browser uploads the video file to the backend → a `Video` document is created in MongoDB.
2. Browser fires `start-analysis` (fire-and-forget) and navigates to the analysis page.
3. Backend runs **6 pipeline stages** as Python subprocesses, in a fixed order, most of them independent enough to fail without killing the whole run.
4. Once the pipeline finishes, results get copied into `backend/uploads/` (permanent, per-video) and a `rally_analysis_<id>.json` is derived from the merged data — this is the file that actually powers the stats UI and the AI recommendation feature.
5. The frontend polls a status endpoint every 3 seconds while this runs, then loads the finished video + stats.

---

## Step 1 — Uploading the file (frontend)

**File:** `src/components/UploadVideo.jsx`

The user picks a file or pastes a YouTube URL, then clicks Continue, which calls `handleContinue()` (line 153 onward):

- **File path** (line ~163–178): builds a `FormData` with the video file, `POST`s it to `/videos/upload-file`.
- **YouTube path** (line ~186–197): `POST`s the URL as JSON to `/videos/youtube`.

Either way, the response contains the new `video._id`. Two follow-up calls then happen before navigation:

```js
await applyGameSettings(data.video._id);   // line 68 — POST /videos/:id/jerseys (home/away),
                                            // optionally POST /videos/:id/team-roster/import-my-team
await startAnalysisAndGo(data.video._id);  // line 87 — POST /videos/:id/start-analysis (fire-and-forget),
                                            // then navigate(`/match-analysis/${videoId}`)
```

Note the `start-analysis` call isn't awaited for its result — the frontend doesn't wait for the pipeline to finish here; it just kicks it off and moves to a page that polls for progress separately (Step 4).

## Step 2 — Creating the video record (backend)

**File:** `backend/controllers/videoController.js`, `uploadFile()` — **lines 19–39**

```js
async function uploadFile(req, res) {
    const file = req.file;                       // multer already saved it to backend/uploads/
    const doc = await Video.create({
        userId: req.user.id,
        sourceType: "file",
        fileName: file.filename,
        filePath: `/uploads/${file.filename}`,    // raw upload — separate from analysis output
        status: "uploaded",
    });
    return res.status(201).json({ message: "File uploaded", video: doc });
}
```

At this point there's a `Video` document with `status: "uploaded"` and a raw video file sitting in `uploads/`. No analysis has happened yet.

## Step 3 — The pipeline orchestrator: `startAnalysis()`

**File:** `backend/controllers/videoController.js`, **lines 1638–1909** (~270 lines — the single most important function in the backend)

This is what actually runs the AI/CV pipeline. Breaking it down by section:

### Lines 1638–1667 — setup and stage script paths

Resolves the absolute path to the uploaded video and to each pipeline stage's Python script:

| Constant | Points to |
|---|---|
| `ACTION_STAGE` | `detection_models/action_detection/action.py` |
| `RALLY_STAGE` | `detection_models/rally_detect/mini_court/run_rally_stage.py` |
| `JERSEY_PIPELINE` | `detection_models/player_detection/predict_pipeline.py` |
| `SCORE_STAGE` | `detection_models/score_detection/read_scoreboard.py` |
| `MERGE_STAGE` | `detection_models/all_three/merge_pipeline.py` |
| `RENDER_STAGE` | `detection_models/all_three/render_video.py` |

Also defines two feature-flagged model swaps for scoreboard reading (`USE_SCORE_FULLFRAME_MODEL`, `USE_SCORE_LED_MODEL`, both `true`) — these toggle between the custom-trained models (`home_guest.pt`, `led_read.pt`) and the older fallback path (crop-based OCR via EasyOCR), which is still intact in `read_scoreboard.py` in case the newer models ever underperform.

### Lines 1688–1707 — cleanup before a new run

Deletes any leftover output files from a previous analysis run (`rally_analysis.json`, `player_stats.json`, `frame_jersey_map.json`, etc.) and wipes the working directories (`rally_detect_work/`, `chunked_jersey_work/`, the thumbnails folder). This exists specifically so the status check falls back to "none" if the server restarts mid-processing, and so a previous video's leftover thumbnails never leak into the next video's player-merge UI (there's a comment documenting a real bug this fixed).

### Lines 1709–1735 — job bookkeeping and per-video config

Registers the job in the in-memory `analysisJobs` map (`status: "processing"`), and builds CLI args from video-specific settings: team jersey colors (`--my-team-color`, `--opponent-color`, optional libero colors), and — if the coach pre-entered a roster — a `--known-jerseys` list that constrains OCR to only accept those specific numbers instead of any 1–99 reading.

### Lines 1758–1903 — the actual pipeline, stage by stage

Runs as an unawaited `(async () => { ... })()` — the HTTP response (`{status: "started"}`, line 1905) returns immediately while this runs in the background. Progress is tracked via the `analysisJobs[id]` object, polled separately (Step 4).

**Stage 1 — Action detection** (lines 1759–1766)
Runs `action.py` against the raw video. **Non-fatal**: if it fails, the pipeline logs a warning and continues without action data rather than aborting. Progress range: 0–25%.

**Stage 2 — Rally + ball tracking** (lines 1768–1789)
Runs `run_rally_stage.py` on CPU (deliberately — so it never competes with the GPU-bound stages for the single GPU). Also non-fatal. This is the stage that produces `rally_windows.json` and `ball_track.json` — the rally/downtime segmentation and ball trajectory. A comment here explains an important ordering decision: this stage now runs *before* jersey detection (moved up from after it), because the chunked jersey pipeline needs `rally_windows.json` up front to know where it's safe to cut a video into per-rally chunks without cutting mid-rally. Progress range: 25–45%.

**Stage 3 — Jersey OCR** (lines 1791–1828)
Runs `predict_pipeline.py` as a single continuous pass over the whole video (not chunked — a long comment block here documents that chunking was tried and reverted after being verified to perform worse than one continuous pass, once jersey-identity resolution became a two-pass, whole-history design). Passes `--skip-team-classification` because the player-detection model was retrained to only ever detect your own team, so there's no opponent to separate out by color anymore. Non-fatal. Progress range: 45–70%.

**Stage 3b — Scoreboard OCR** (lines 1830–1852)
Runs `read_scoreboard.py`, completely independent of every other stage (it has its own crop/upscale pipeline and models). If rally windows are available from Stage 2, it switches into a more accurate "rally-boundary attribution" mode — one score reading per completed rally rather than continuously scanning frames. Non-fatal. Progress range: 70–75%.

**Stage 4 — Merge** (lines 1854–1868)
Runs `merge_pipeline.py`, combining whatever data survived from stages 1–3b (jersey positions, action labels, ball track, rally windows) into one `volley_analytics.json`. **This is the one fatal stage** — if it fails, `failAnalysis()` is called and the whole job is marked failed, because everything downstream depends on this merged file existing. Progress range: 75–90%.

**Stage 5 — Render** (lines 1870–1888)
Runs `render_video.py` to produce the annotated output video (bounding boxes, jersey numbers, mini-court/ball-trail overlay if rally data exists). Non-fatal — if it fails, the system falls back to the plain jersey-tracking video from Stage 3 instead. Progress range: 90–100%.

**Finalization** (lines 1890–1902)
Calls `persistAnalysisOutputs(id)` (see below), merges its return value into the `Video` document, marks the in-memory job `status: "done"`.

### `runStage()` helper — lines 1608–1636

Every stage above goes through this one function. It spawns the Python subprocess (`spawn(pyCmd, [scriptPath, ...args])`), pipes stdout/stderr into the console for live logging, watches that output for a `NN%` pattern to update in-memory progress, and resolves with `{code, error}` rather than throwing — **the caller decides whether a given stage's failure is fatal or not**, which is why the same helper can back both fatal (merge) and non-fatal (everything else) stages.

## Step 4 — Persisting results: `persistAnalysisOutputs()`

**File:** `backend/controllers/videoController.js`, **lines 1464–1603**

Everything the pipeline stages wrote lives in a shared `RUNS_DIR` (`detection_models/all_three/runs/`) that gets wiped at the start of every new analysis run. This function copies whatever's relevant into `backend/uploads/`, named by video ID so it survives the next video's run:

- `analyzed_<id>.mp4` — the rendered video (or jersey-tracking fallback)
- `player_thumbs_<id>/` — per-player thumbnail crops
- `player_registry_<id>.json`, `jersey_registry_<id>.json`, `frame_jersey_map_<id>.json`
- `volley_analytics_<id>.json` — the raw merged detections (large)
- `scoreboard_readings_<id>.json`

Then, **lines 1546–1599**, the most important step for the stats UI: it calls `buildRallyAnalysis()` on the merged `volley_analytics.json` (plus scoreboard data) to produce **`rally_analysis_<id>.json`** — a per-rally breakdown (who scored, how, jersey involved, duration) with a running score. This is deliberately built from the *accumulated per-rally tally*, not the scoreboard's raw final OCR reading — a comment here notes a real case where the two disagreed (4-9 vs 5-8) and explains why the accumulated tally was chosen as more trustworthy (many independent reads vs. one OCR snapshot with no redundancy).

From that same `rally_analysis` data, this function also writes:
- `player_stats_<id>.json` — the per-player box score (same shape `MatchStatistics.jsx` renders)
- `rally_action_table_<id>.json` / `.csv` — a flat per-action table, not surfaced in the UI, written for offline analysis

## Step 5 — Polling from the frontend

**File:** `src/components/MatchAnalysis.jsx`, lines ~130–167

The page the user lands on (`/match-analysis/:videoId`) checks the video's `analytics.status` on load. If it's `"processing"`, it starts a `setInterval` polling `GET /videos/:id/analysis-status` every 3 seconds (line 147), updating a progress bar from the in-memory `analysisJobs[id].progress` value until status flips to `"done"` or `"failed"`.

`getAnalysisStatus()` itself (`videoController.js`, lines 1911–1916) is intentionally trivial — it just reads the in-memory job object, no disk I/O:

```js
async function getAnalysisStatus(req, res) {
    const job = analysisJobs[id];
    if (!job) return res.json({ status: "none", progress: 0 });
    return res.json({ status: job.status, progress: job.progress, error: job.error });
}
```

## Step 6 — Displaying results

Once status is `"done"`, `MatchAnalysis.jsx` loads the rendered video and rally data. From there:

- **`MatchStatistics.jsx`** fetches `/videos/:id/player-stats`, `/videos/:id/rally-analysis`, and roster data in parallel, rendering the Attack/Serve/Set/Defence/Block tables and the Rally tab (`RallyStatsTab.jsx`).
- **`RallyStatsTab.jsx`** computes rally length/streak stats client-side from the raw `rally_analysis_<id>.json` rally list, and hosts the AI Recommendations panel (see below).
- **`PlayerProfile.jsx`** reads the same `player-stats` endpoint, filtered to one jersey, for the Key Performance Metrics cards.

## The AI recommendation feature (built this session)

**File:** `backend/controllers/videoController.js`, `getAiRecommendation()`

This is a separate, on-demand endpoint (`POST /videos/:id/ai-recommendation`) — it doesn't run as part of the pipeline above. When the header button is clicked, it:

1. Reads the same `rally_analysis_<id>.json` the Rally tab already uses (same resolution logic as `getRallyAnalysis`).
2. Condenses it into a compact summary (final score, per-rally result/duration/outcome-category/scoring-jersey) — dropping frame numbers and other noise that isn't useful to an LLM.
3. Sends that summary to Google's Gemini API (`gemini-flash-latest`) with a prompt that explicitly explains the data schema — critically, that `scoring_player_jersey` is always *your own* player (the scorer on a won rally, or whoever made the error on a lost one), never an opponent. This was added after testing showed the model would otherwise hallucinate an "opposing player" from that field.
4. Requests structured JSON output (`overview`, `key_points`, `recommendations`) via Gemini's `responseSchema`, so the frontend can render each as a distinct section instead of parsing free text.

---

## Pipeline stages at a glance

| Stage | Script | Model(s) | Fatal on failure? |
|---|---|---|---|
| Action detection | `action_detection/action.py` | Fine-tuned YOLO (see `EXTERNAL_TOOLS.txt`) | No |
| Rally + ball tracking | `rally_detect/mini_court/run_rally_stage.py` | YOLO (ball) + Random Forest (rally/downtime classifier) | No |
| Jersey OCR | `player_detection/predict_pipeline.py` | YOLO (player) + jersey digit model | No |
| Scoreboard OCR | `score_detection/read_scoreboard.py` | `home_guest.pt` + `led_read.pt` (fallback: EasyOCR) | No |
| Merge | `all_three/merge_pipeline.py` | — (combines the above) | **Yes** |
| Render | `all_three/render_video.py` | — (draws overlays) | No |

Only the merge stage can take down an entire analysis run — every detection stage is designed to degrade gracefully, producing partial analytics rather than an all-or-nothing failure.
