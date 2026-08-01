# VolleyAI, explained: authentication, data model, and frontend structure

This is the companion to `VIDEO_PIPELINE.md` (which covers upload → analysis →
stats in depth). This file covers everything *around* that pipeline: how
accounts work, what's actually stored in the database, and how the frontend is
organized. Every code block below is quoted directly from the current source
— nothing paraphrased.

---

## 1. Tech stack, in one paragraph

React + Vite frontend, Express + MongoDB (Mongoose) backend, both talking over
a REST API secured by a JWT stored in an httpOnly cookie. The backend also
shells out to Python for every piece of computer vision — see
`VIDEO_PIPELINE.md` for that half.

---

## 2. Authentication

**File:** `backend/controllers/authController.js`

There are three ways into the app: email/password, Google OAuth, and a
password-reset flow. All three end the same way — a signed JWT written to a
cookie — which is why every other endpoint only needs *one* check to know
who's asking.

### 2a. Signup — lines 7–39

```js
async function signup(req, res) {
  const emailNorm = (req.body.email || "").trim().toLowerCase();
  const { password } = req.body;
  ...
  const existing = await User.findOne({ email: emailNorm });
  if (existing) {
    return res.status(409).json({ message: "User already exists" });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const user = await User.create({
    email: emailNorm,
    passwordHash,
    provider: "local",
  });

  setAuthCookie(res, { id: user._id.toString(), email: user.email });
  ...
}
```

In plain terms: normalize the email (trim + lowercase, so `Foo@X.com` and
`foo@x.com` are the same account), reject if it already exists, hash the
password with bcrypt (never stored in plain text), create the user, then
immediately log them in by setting the auth cookie — no separate "verify your
email" step.

### 2b. Login — lines 41–75

Same shape in reverse: look up the user by normalized email, and — this is
the one subtlety worth knowing — **check whether the account even has a
password**:

```js
if (!user.passwordHash) {
  return res.status(400).json({ message: "This account uses Google sign-in" });
}
```

A Google-only account has no `passwordHash` at all (see the User model
below), so trying to log in with a password on that account fails with a
specific, helpful message rather than a generic "wrong password."

### 2c. Google OAuth — lines 160–211

The frontend (`Login.jsx`, using the `@react-oauth/google` library's
`useGoogleLogin` hook) gets a Google **access token** in the browser, then
sends *that* to the backend — the backend never talks to Google's OAuth
consent screen directly, it just verifies the token:

```js
const googleRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
  headers: { Authorization: `Bearer ${accessToken}` },
});
...
const profile = await googleRes.json();
const googleSub = profile.sub;          // Google's stable, unique user ID
const emailNorm = (profile.email || "").trim().toLowerCase();
```

Then it handles three cases in order:
1. **`googleSub` already known** → this exact Google account has signed in before, log them in.
2. **Not found by `googleSub`, but the email matches an existing local account** → link the two: save `googleSub` onto that existing user, so from now on either sign-in method works for the same account.
3. **Neither matches** → brand new user, create one with `provider: "google"` and no password.

```js
let user = await User.findOne({ googleSub });
if (!user) {
  user = await User.findOne({ email: emailNorm });
  if (user) {
    user.googleSub = googleSub;
    user.provider = user.provider || "local";
    await user.save();
  }
}
if (!user) {
  user = await User.create({ email: emailNorm, googleSub, provider: "google" });
}
```

### 2d. Password reset — lines 77–158

Two-step flow, both time-limited:

```js
const resetToken = crypto.randomBytes(32).toString("hex");
const resetTokenHash = crypto.createHash("sha256").update(resetToken).digest("hex");

user.resetPasswordTokenHash = resetTokenHash;
user.resetPasswordExpiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes
```

Notice **only the hash of the token is stored**, never the raw token — the
raw token only ever exists in the emailed link and the user's browser. Even
if the database were compromised, an attacker couldn't reset anyone's
password with the stored hash alone. `resetPassword()` does the reverse: hash
whatever token the user submits, look up a matching, non-expired
`resetPasswordTokenHash`, and if found, allow a new password.

`forgotPassword()` also deliberately returns the *same* success message
whether or not the email exists (`"If an account exists, a reset link will be
sent"`) — this prevents an attacker from using the endpoint to check which
emails have accounts on the system.

### 2e. The cookie itself

**File:** `backend/utils/authCookie.js`

```js
function setAuthCookie(res, payload) {
  const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: "7d" });
  res.cookie("access_token", token, {
    httpOnly: true,
    secure: false,
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}
```

The JWT payload is just `{ id, email }` — no roles or permissions, since this
app doesn't have any (every user only ever sees their own data, scoped by
`userId` on every query). `httpOnly: true` means client-side JavaScript can't
read the cookie at all (protects against XSS stealing the token); `secure:
false` means it works over plain HTTP for local development — this would need
to become `true` behind HTTPS in a real production deployment.

### 2f. Guarding every protected route

**File:** `backend/requireAuth.js`, in full (it's short):

```js
function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.access_token;
    if (!token) return res.status(401).json({ message: "Not authenticated" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ message: "Not authenticated" });
  }
}
```

This is Express middleware — every route that needs a logged-in user
(basically everything except `/auth/login`, `/auth/signup`, etc.) lists this
as an argument before its actual handler, e.g. from `videoRoutes.js`:

```js
router.post("/:id/start-analysis", requireAuth, startAnalysis);
```

If the cookie is missing, expired, or has a bad signature, the request never
reaches `startAnalysis` at all — `requireAuth` responds with 401 first. If it
succeeds, every controller function downstream can trust `req.user.id` is a
real, logged-in user's ID.

---

## 3. What's actually in the database

Two Mongoose models. Understanding these is basically understanding the
entire data model of the app.

### 3a. User — `backend/models/User.js`

```js
const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String },      // absent for Google-only accounts
  googleSub: { type: String },          // Google's user ID, absent for local accounts
  provider: { type: String, enum: ["local", "google"], default: "local" },

  resetPasswordTokenHash: { type: String },
  resetPasswordExpiresAt: { type: Date },

  myTeamRoster: {
    teamName: { type: String, default: "" },
    players: { type: [MyTeamPlayerSchema], default: [] },
  },
}, { timestamps: true });
```

The interesting part is `myTeamRoster` — this is a coach's **persistent,
account-level roster** (jersey numbers, names, positions), separate from any
one video. It exists so a coach doesn't have to retype their roster every
time they upload a new match — there's a "Use My Team" import button on the
per-video roster screen that copies from here.

### 3b. Video — `backend/models/Video.js` (232 lines — the biggest schema by far)

One document per uploaded match. Broadly, it tracks four things:

**Upload metadata** — where the file lives, how it got here:
```js
sourceType: { type: String, enum: ["file", "youtube"], required: true },
filePath: String, fileName: String, originalFileName: String,
fileSize: Number, mimeType: String, youtubeUrl: String,
```

**Per-video roster** — *this* match's players, distinct from the account-level `myTeamRoster` above (a coach might play different lineups in different matches):
```js
teamRoster: {
  players: { type: [TeamRosterPlayerSchema], default: [] },
},
```
Each entry has a `teamSide` (`my_team` / `opponent` / `unknown`) and optional `position` (`libero` / `setter` / `hitter` / `blocker`).

**Analysis pipeline state and output paths** — the `analytics` sub-object
tracks the *pipeline's* status (`none`/`processing`/`done`/`failed` — this is
what `getAnalysisStatus` reads from, indirectly, via the in-memory
`analysisJobs` map described in `VIDEO_PIPELINE.md`), while a flat list of
`*Path` fields point at everything the pipeline wrote to `uploads/`:

```js
analyzedVideoPath:      { type: String, default: null }, // /uploads/analyzed_<id>.mp4
playerStatsPath:        { type: String, default: null }, // /uploads/player_stats_<id>.json
rallyAnalysisPath:      { type: String, default: null }, // /uploads/rally_analysis_<id>.json
scoreboardReadingsPath: { type: String, default: null }, // /uploads/scoreboard_readings_<id>.json
```

**Match configuration and cached scores** — settings the coach picks before
analysis starts, plus a couple of fields mirrored from the analysis output so
the home screen's card list doesn't need an extra fetch per video:

```js
myTeamColor: { type: String, default: "blue_white" },
opponentColor: { type: String, default: "black_white" },
isHomeTeam: { type: Boolean, default: false }, // which scoreboard side is "us"

usScore: { type: Number, default: null },       // mirrored from rally_analysis.json
opponentScore: { type: Number, default: null },  // so listVideos doesn't need a per-card fetch
```

Two older sub-objects — `videoAnalysis` and `ballAnalysis` — still exist in
the schema (rally lists, dead-time segments, ball points) but aren't part of
the current pipeline described in `VIDEO_PIPELINE.md`; they read as an
earlier iteration of the same idea, now superseded by `analytics` +
`rally_analysis_<id>.json`.

---

## 4. Frontend structure

**File:** `src/main.jsx` — the actual entry point:

```jsx
ReactDOM.createRoot(document.getElementById("root")).render(
  <GoogleOAuthProvider clientId={import.meta.env.VITE_GOOGLE_CLIENT_ID}>
    <ThemeProvider>
      <BrowserRouter>
        <App />
        <ThemeToggle />
      </BrowserRouter>
    </ThemeProvider>
  </GoogleOAuthProvider>
);
```

Three nested providers wrap the whole app: Google OAuth (so `useGoogleLogin`
works anywhere), theme (light/dark), and the router. `<ThemeToggle />` sits
outside `<App />` deliberately — it's a floating button rendered on every
page regardless of route.

**File:** `src/App.jsx` — every route in the app, all in one place:

| Route | Component | Needs login? |
|---|---|---|
| `/` | `Login` | no |
| `/signup` | `SignUp` | no |
| `/forgot-password`, `/reset-password` | `ForgotPassword`, `ResetPassword` | no |
| `/home` | `HomeScreen` | yes (list of uploaded matches) |
| `/upload-video` | `UploadVideo` | yes |
| `/teams-roster/:videoId` | `TeamsRoster` | yes (this match's roster) |
| `/my-team` | `MyTeamRoster` | yes (account-level roster) |
| `/match-analysis/:videoId` | `MatchAnalysis` | yes (analysis progress + playback) |
| `/match-statistics/:videoId` | `MatchStatistics` | yes (the stats tabs + AI recommendations) |
| `/player-profile/:videoId/:jersey` | `PlayerProfile` | yes (one player's detail page) |
| `/player-select/:videoId`, `/player-merge/:videoId` | `PlayerSelect`, `PlayerMerge` | yes (reconciling auto-detected jerseys with real players) |

Note there's no route-level auth guard here (no `<ProtectedRoute>` wrapper) —
each "yes" page instead makes its own `fetch(..., { credentials: "include" })`
calls, and the backend's `requireAuth` middleware is what actually enforces
the login requirement; an unauthenticated visit to e.g. `/home` would render
the page shell but every data fetch inside it would fail with 401.

---

## 5. How the pieces connect — the coach's actual path through the app

1. **Sign up / log in** (`Login.jsx` or `SignUp.jsx`) → backend sets the `access_token` cookie → browser navigates to `/home`.
2. **Upload a video** (`UploadVideo.jsx`) → creates a `Video` document, kicks off the analysis pipeline in the background, navigates to `/match-analysis/:videoId` — see `VIDEO_PIPELINE.md` from here on for the CV/ML side.
3. While that page polls for progress, the coach can separately visit `/teams-roster/:videoId` to set up this match's roster (optionally importing from their persistent `/my-team` roster).
4. Once analysis finishes, `/match-statistics/:videoId` renders the Attack/Serve/Set/Defence/Block tables and the Rally tab — all reading from `player_stats_<id>.json` and `rally_analysis_<id>.json`, the files `persistAnalysisOutputs()` wrote.
5. From there, `/player-profile/:videoId/:jersey` gives a per-player breakdown, and the AI Recommendations button (also on `/match-statistics/:videoId`) generates a Gemini-powered summary of the same rally data.
