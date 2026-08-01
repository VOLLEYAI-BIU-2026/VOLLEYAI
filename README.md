# VOLLEYAI

AI-powered volleyball match analysis. Coaches upload match footage; the backend runs a set of detection pipelines (player tracking, jersey/action recognition, ball tracking, rally segmentation, scoreboard OCR) and the frontend turns the results into per-player stats, rally-by-rally breakdowns, and an AI-generated coaching recommendation.

## Repo layout

```
VOLLEYAI/
├── README.md
└── volleyai/     # the actual application (frontend + backend), see below
```

There's no Docker/VM deployment setup at the moment (an earlier attempt was removed) — the app runs directly via `pm2` (backend) and a built static frontend. See "Running locally" below.

## `volleyai/` — the app

```
volleyai/
├── src/            # React frontend (Vite)
├── backend/        # Express backend + Python detection pipelines
├── package.json     # frontend deps/scripts
└── vite.config.js
```

### Frontend (`volleyai/src/`)

React + Vite SPA. One component per screen, routed in `App.jsx`:

| Component | Purpose |
|---|---|
| `Login.jsx` / `SignUp.jsx` / `ForgotPassword.jsx` / `ResetPassword.jsx` | Auth screens (email/password + Google OAuth) |
| `Home_screen.jsx` | Landing page — list of uploaded matches |
| `UploadVideo.jsx` | Upload a match video or paste a YouTube link |
| `VideoAnalysis.jsx` | Kicks off / tracks the detection pipeline for a video |
| `TeamsRoster.jsx` / `MyTeamRoster.jsx` | Manage your team's player roster (jersey numbers, names) |
| `PlayerMerge.jsx` / `PlayerSelect.jsx` | Reconcile auto-detected jersey numbers with real players |
| `MatchStatistics.jsx` | Main stats page — tabs for Rally/Attack/Serve/Set/Defence/Block, plus the **AI Recommendations** button (header) |
| `RallyStatsTab.jsx` | Rally tab body — rally length/streak charts, outcome timeline, and the AI recommendation result panel |
| `RallyActionChart.jsx` | Per-rally action-count chart shared by the Attack/Serve/Set/Defence/Block tabs |
| `MatchAnalysis.jsx` | Video playback with overlaid detections |
| `PlayerProfile.jsx` | Per-player detail page — Key Performance Metrics cards + action list |
| `ThemeContext.jsx` / `ThemeToggle.jsx` | Light/dark theme |
| `Toast.jsx` | Shared toast notifications |

Frontend env (`.env` in `volleyai/`): `VITE_GOOGLE_CLIENT_ID` (Google OAuth client ID — public, not secret).

### Backend (`volleyai/backend/`)

Express API + the Python video pipelines it orchestrates.

```
backend/
├── server.js              # entrypoint
├── controllers/
│   ├── authController.js   # signup/login/Google OAuth/roster CRUD
│   └── videoController.js  # upload, pipeline orchestration, stats/rally endpoints, AI recommendation
├── routes/
│   ├── authRoutes.js
│   └── videoRoutes.js
├── models/                 # Mongoose schemas
│   ├── User.js
│   └── Video.js
├── config/db.js            # MongoDB connection
├── utils/
│   ├── authCookie.js        # JWT cookie helpers
│   └── sendEmail.js         # password-reset emails
├── python/                 # standalone helper scripts (frame extraction, ball tracking experiments)
├── detection_models/        # the actual ML pipelines — see below
└── uploads/                 # per-video runtime output (raw video, analysis JSON, thumbnails) — gitignored, NOT sample data
```

Backend env (`.env` in `volleyai/backend/`):

| Var | Purpose |
|---|---|
| `MONGO_URI` | MongoDB Atlas connection string |
| `JWT_SECRET` | Signs the `access_token` auth cookie |
| `PORT` | Defaults to 5000 |
| `APP_URL` / `CORS_ORIGINS` | Allowed frontend origin(s) |
| `GEMINI_API_KEY` | Google Gemini API key — powers the "AI Recommendations" button on the stats page (free tier at aistudio.google.com) |

### Detection pipelines (`backend/detection_models/`)

Each subfolder is a largely independent Python pipeline, invoked by `videoController.js` via `child_process.spawn`. Several use their own `uv`-managed virtualenv (`.venv/` + `pyproject.toml` + `uv.lock`) rather than the shared `requirements.txt`.

| Folder | What it does |
|---|---|
| `player_detection/` | YOLO-based player detection + jersey number OCR + team-side classification |
| `action_detection/` | Classifies the action happening per frame (attack, block, set, serve, defense-move, etc.) |
| `ball_tracking/` / `ball_and_player/` | Ball detection/tracking, standalone and combined with player detection |
| `rally_detect/` | Segments the match into rallies, determines who scored each point and why (`rally_analysis_<videoId>.json` — the source for the Rally stats tab and the AI recommendation prompt) |
| `score_detection/` | Scoreboard OCR (reads the on-screen score) |
| `all_three/` | Merges player + action + jersey detection into one pipeline; also renders annotated output video and player thumbnails |
| `stats/` | Scratch output videos from stats-pipeline experiments |
| `old_models/` | Retired/backup model checkpoints, kept for reference — gitignored, not part of the active pipeline |

Pipeline stage scripts referenced directly by `videoController.js`: `action_detection/action.py`, `rally_detect/mini_court/run_rally_stage.py`, plus clean-frame/player-detection scripts under `backend/python/`.

### Where match data actually lives

Per-video runtime output goes to `backend/uploads/`, named by MongoDB video `_id`:

- `rally_analysis_<id>.json` — rally-by-rally results, score, per-rally point outcome. Feeds the Rally stats tab and the AI recommendation.
- `player_stats_<id>.json` — per-player box score (kills, blocks, digs, etc.). Feeds Player Statistics and the Player Profile page.
- `volley_analytics_<id>.json` — raw per-frame detections (large).
- `analyzed_<id>.mp4` — annotated output video.

This folder is gitignored and can grow large (raw uploads + annotated renders) — check its size periodically.

## Running locally

### 0. Prerequisites

- **Node.js** (v18+)
- **Python 3.12+** on `PATH` as `python3` (macOS/Linux) or `py` (Windows) — this runs `backend/requirements.txt` and is the interpreter the pipeline stages actually invoke via `child_process.spawn`
- **[uv](https://docs.astral.sh/uv/getting-started/installation/)** — required for `action_detection/` and `rally_detect/`, which each manage their own isolated virtualenv instead of using the shared `requirements.txt`. Install it once, globally:
  ```bash
  # macOS/Linux
  curl -LsSf https://astral.sh/uv/install.sh | sh
  # Windows (PowerShell)
  powershell -c "irm https://astral.sh/uv/install.ps1 | iex"
  ```
- A MongoDB Atlas connection string (or local MongoDB)

### 1. Env files

Copy the two templates and fill in real values:
```bash
cp volleyai/.env.example volleyai/.env
cp volleyai/backend/.env.example volleyai/backend/.env
```
See the env var tables above for what each key does.

### 2. Install dependencies

```bash
# Node — backend
cd volleyai/backend
npm install

# Node — frontend
cd ../
npm install

# Python — shared pipelines (player/ball/score detection)
cd backend
python3 -m pip install -r requirements.txt   # Windows: py -m pip install -r requirements.txt

# Python — action_detection (isolated uv venv)
cd detection_models/action_detection
uv sync
cd ../..

# Python — rally_detect (isolated uv venv)
cd detection_models/rally_detect
uv sync
cd ../../../..
```

### 3. Run it

```bash
# Backend
cd volleyai/backend
pm2 start server.js --name volleyai-backend   # or: npm run dev (nodemon, foreground)

# Frontend
cd volleyai
npm run dev   # http://localhost:5173
```

**Process supervision:** the backend runs under `pm2` and is configured to auto-restart on boot via a systemd service (`pm2-jesicemal.service`, installed with `pm2 startup` + `pm2 save`). If the backend is ever down after a machine restart, `pm2 status` / `pm2 resurrect` is the manual fallback — but this should no longer be necessary.

## Known operational notes

- This dev machine is WSL2. `systemd --user` doesn't work here (a known WSL2 cgroup-delegation limitation), but system-level `systemd` does — the pm2 auto-start service relies on that, not the user session manager.
- **Windows-specific:** `merge_pipeline.py` (and anything else calling `cv2.VideoCapture`) depends on OpenCV's bundled FFmpeg DLL, which some antivirus software silently quarantines after install — this shows up as the whole analysis crashing with exit code `3221225794` (`STATUS_DLL_INIT_FAILED`) regardless of which video is uploaded. If hit, add a Defender exclusion for the Python `site-packages` folder and reinstall: `py -m pip install opencv-python --no-cache-dir --force-reinstall`.
- **Security history:** an earlier commit had a real MongoDB URI and JWT secret hardcoded in a now-deleted Docker setup (`.env` at repo root, removed in a later commit). The file itself is gone, but it's still visible in git history — the exposed MongoDB user (`yahavatias13_db_user`) should be rotated on Atlas if that hasn't been done yet, since removing the file doesn't undo an already-exposed credential.
