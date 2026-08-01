
const mongoose = require("mongoose");
const path = require("path");
const { spawn } = require("child_process");
const Video = require("../models/Video");
const User = require("../models/User");
const fs = require("fs");


function isValidYouTubeUrl(url) {
    const trimmed = (url || "").trim();
    if (!trimmed) return false;

    const re =
        /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/i;
    return re.test(trimmed);
}

async function uploadFile(req, res) {
    try {
        const file = req.file;
        if (!file) return res.status(400).json({ message: "No file uploaded" });

        const doc = await Video.create({
            userId: req.user.id,
            sourceType: "file",
            originalFileName: file.originalname,
            fileName: file.filename,
            filePath: `/uploads/${file.filename}`,
            fileSize: file.size,
            mimeType: file.mimetype,
            status: "uploaded",
        });

        return res.status(201).json({ message: "File uploaded", video: doc });
    } catch (err) {
        return res.status(500).json({ message: "Server error", error: err.message });
    }
}

async function addYoutube(req, res) {
    try {
        const { youtubeUrl } = req.body;

        if (!isValidYouTubeUrl(youtubeUrl)) {
            return res.status(400).json({ message: "Invalid YouTube URL" });
        }

        const doc = await Video.create({
            userId: req.user.id,
            sourceType: "youtube",
            youtubeUrl: youtubeUrl.trim(),
            status: "uploaded",
        });

        return res.status(201).json({ message: "YouTube link saved", video: doc });
    } catch (err) {
        return res.status(500).json({ message: "Server error", error: err.message });
    }
}

async function listVideos(req, res) {
    try {
        const videos = await Video.find({ userId: req.user.id })
            .sort({ createdAt: -1 })
            .select("_id originalFileName fileName status playerDetection analytics analyzedVideoPath teamA teamB matchDate score usScore opponentScore createdAt sourceType filePath cleanFramePath");
        return res.json({ videos });
    } catch (err) {
        return res.status(500).json({ message: "Server error", error: err.message });
    }
}

async function updateTeamNames(req, res) {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid video id" });
        }
        // Each field is only touched when the caller actually sent it -- the
        // home screen calls this endpoint separately for team names, match
        // date, and score edits, and an earlier version that always wrote
        // teamA/teamB would've silently blanked them out on every date-only
        // or score-only save.
        const { teamA, teamB, matchDate, score } = req.body;
        const update = {};
        if (teamA !== undefined) update.teamA = teamA ?? "";
        if (teamB !== undefined) update.teamB = teamB ?? "";
        if (matchDate !== undefined) update.matchDate = matchDate ? new Date(matchDate) : null;
        if (score !== undefined) update.score = score ?? "";
        const video = await Video.findOneAndUpdate(
            { _id: id, userId: req.user.id },
            { $set: update },
            { new: true }
        );
        if (!video) return res.status(404).json({ message: "Video not found" });
        return res.json({ video });
    } catch (err) {
        return res.status(500).json({ message: "Server error", error: err.message });
    }
}

async function getVideoById(req, res) {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid video id" });
        }

        const video = await Video.findOne({ _id: id, userId: req.user.id });
        if (!video) return res.status(404).json({ message: "Video not found" });

        return res.status(200).json({ video });
    } catch (err) {
        return res.status(500).json({ message: "Server error", error: err.message });
    }
}

async function deleteVideo(req, res) {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid video id" });
        }

        const video = await Video.findOne({ _id: id, userId: req.user.id });
        if (!video) return res.status(404).json({ message: "Video not found" });

        // Kill any in-flight analysis job first -- otherwise it keeps writing
        // to files we're about to delete out from under it.
        const job = analysisJobs[id];
        if (job?.status === "processing" && job.proc) {
            if (process.platform === "win32") {
                spawn("taskkill", ["/pid", String(job.proc.pid), "/t"]);
            } else {
                job.proc.kill("SIGINT");
            }
        }
        delete analysisJobs[id];

        const uploadsDir = path.join(__dirname, "..", "uploads");
        const filePaths = [
            video.filePath, video.cleanFramePath, video.normalizedFilePath,
            video.analyzedVideoPath, video.playerStatsPath, video.playerRegistryPath,
            video.jerseyRegistryPath, video.analyticsJsonPath, video.rallyAnalysisPath,
            video.calibrationJsonPath, video.scoreboardReadingsPath, video.frameJerseyMapPath,
        ].filter(Boolean);
        for (const rel of filePaths) {
            try { fs.unlinkSync(path.join(__dirname, "..", rel.replace(/^\//, ""))); } catch {}
        }

        // Per-video directories/files that aren't tracked as single-path fields.
        try { fs.rmSync(path.join(uploadsDir, `player_thumbs_${id}`), { recursive: true, force: true }); } catch {}
        for (const d of video.detections || []) {
            if (!d.imageUrl) continue;
            try { fs.unlinkSync(path.join(__dirname, "..", d.imageUrl.replace(/^\//, ""))); } catch {}
        }

        await Video.findByIdAndDelete(id);

        return res.status(200).json({ message: "Video deleted" });
    } catch (err) {
        return res.status(500).json({ message: "Server error", error: err.message });
    }
}

async function startCleanFrame(req, res) {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid video id" });
        }

        const video = await Video.findOne({ _id: id, userId: req.user.id });
        if (!video) return res.status(404).json({ message: "Video not found" });

        if (video.sourceType !== "file") {
            return res.status(400).json({ message: "Clean frame is supported only for uploaded files" });
        }

        if (!video.filePath || !video.fileName) {
            return res.status(400).json({ message: "Missing filePath/fileName" });
        }

        if (video.cleanFrameStatus === "done" && video.cleanFramePath) {
            return res.status(200).json({ message: "Already ready", framePath: video.cleanFramePath });
        }

        if (video.cleanFrameStatus === "processing") {
            return res.status(202).json({ message: "Already processing" });
        }

        const inputAbs = path.join(__dirname, "..", video.filePath.replace(/^\//, ""));

        // Validate file exists and is not empty
        try {
            const stat = fs.statSync(inputAbs);
            if (stat.size === 0) {
                video.cleanFrameStatus = "failed";
                video.cleanFrameError = "Video file is empty (0 bytes). Please re-upload the video.";
                await video.save();
                return res.status(400).json({ message: "Video file is empty. Please re-upload." });
            }
        } catch {
            video.cleanFrameStatus = "failed";
            video.cleanFrameError = "Video file not found on disk. Please re-upload.";
            await video.save();
            return res.status(400).json({ message: "Video file not found. Please re-upload." });
        }

        video.cleanFrameStatus = "processing";
        video.cleanFrameError = undefined;
        await video.save();
        const outRel = `/uploads/cleanframe_${video._id}.png`;
        const outAbs = path.join(__dirname, "..", outRel.replace(/^\//, ""));

        const pyCmd = process.platform === "win32" ? "py" : "python3";
        const py = spawn(pyCmd, [
            path.join(__dirname, "..", "python", "clean_frame.py"),
            "--input",
            inputAbs,
            "--output",
            outAbs,
            "--start", "2",
            "--end", "60",
            "--step", "2",
        ]);

        let stderr = "";
        py.stderr.on("data", (d) => (stderr += d.toString()));

        py.on("error", async (err) => {
            try {
                const v = await Video.findById(video._id);
                if (!v) return;
                v.cleanFrameStatus = "failed";
                v.cleanFrameError = `Failed to start Python process: ${err.message}`;
                await v.save();
            } catch { }
        });

        py.on("close", async (code) => {
            try {
                const v = await Video.findById(video._id);
                if (!v) return;

                if (code === 0) {
                    v.cleanFrameStatus = "done";
                    v.cleanFramePath = outRel;
                    v.cleanFrameError = undefined;
                } else {
                    v.cleanFrameStatus = "failed";
                    v.cleanFrameError = (stderr || `Python exited with code ${code}`).slice(-2000);
                }
                await v.save();
            } catch { }
        });

        return res.status(202).json({ message: "Started" });
    } catch (err) {
        return res.status(500).json({ message: "Server error", error: err.message });
    }
}
async function startPlayerDetection(req, res) {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid video id" });
        }

        const video = await Video.findOne({ _id: id, userId: req.user.id });
        if (!video) {
            return res.status(404).json({ message: "Video not found" });
        }

        if (video.sourceType !== "file") {
            return res.status(400).json({
                message: "Player detection is supported only for uploaded files",
            });
        }

        if (!video.filePath || !video.fileName) {
            return res.status(400).json({ message: "Missing filePath/fileName" });
        }

        if (video.playerDetection?.status === "processing") {
            return res.status(202).json({ message: "Player detection already processing" });
        }

        video.playerDetection.status = "processing";
        video.playerDetection.error = "";
        video.playerDetection.lastProcessedAt = null;
        video.detections = [];
        video.teamRoster = { players: [] };
        await video.save();

        const inputAbs = path.join(__dirname, "..", video.filePath.replace(/^\//, ""));
        const uploadsAbs = path.join(__dirname, "..", "uploads");
        const thumbsDir = path.join(uploadsAbs, `player_thumbs_${video._id}`);
        const resultJsonAbs = path.join(uploadsAbs, `player_detection_${video._id}.json`);
        const scriptPath = path.join(__dirname, "..", "python", "detect_players.py");
        const pyCmd = process.platform === "win32" ? "py" : "python3";

        if (!fs.existsSync(thumbsDir)) {
            fs.mkdirSync(thumbsDir, { recursive: true });
        }

        const py = spawn(pyCmd, [
            scriptPath,
            "--input", inputAbs,
            "--output_json", resultJsonAbs,
            "--thumbs_dir", thumbsDir,
            "--video_id", String(video._id),
        ]);

        let stderr = "";

        py.stderr.on("data", (d) => {
            stderr += d.toString();
            console.log("PYTHON STDERR:", d.toString());
        });

        py.stdout.on("data", (d) => {
            console.log("PYTHON STDOUT:", d.toString());
        });

        py.on("error", async (err) => {
            try {
                const v = await Video.findById(video._id);
                if (!v) return;
                v.playerDetection.status = "failed";
                v.playerDetection.error = `Failed to start Python process: ${err.message}`;
                await v.save();
            } catch { }
        });

        py.on("close", async (code) => {
            try {
                const v = await Video.findById(video._id);
                if (!v) return;

                if (code !== 0) {
                    v.playerDetection.status = "failed";
                    v.playerDetection.error = (stderr || `Python exited with code ${code}`).slice(-2000);
                    await v.save();
                    return;
                }

                if (!fs.existsSync(resultJsonAbs)) {
                    v.playerDetection.status = "failed";
                    v.playerDetection.error = "Detection JSON was not created";
                    await v.save();
                    return;
                }

                const raw = fs.readFileSync(resultJsonAbs, "utf8");
                const parsed = JSON.parse(raw);

                v.detections = (parsed.detections || []).map((d) => ({
                    detectionId: d.detectionId,
                    imageUrl: d.imageUrl,
                    frameTime: d.frameTime || 0,
                    confidence: d.confidence || 0,
                    assignedPlayerId: d.assignedPlayerId || null,
                }));

                v.playerDetection.status = "done";
                v.playerDetection.error = "";
                v.playerDetection.lastProcessedAt = new Date();

                await v.save();
                console.log("DONE SAVED TO DB");
            } catch (err) {
                try {
                    const v = await Video.findById(video._id);
                    if (v) {
                        v.playerDetection.status = "failed";
                        v.playerDetection.error = err.message;
                        await v.save();
                    }
                } catch { }
            }
        });

        return res.status(202).json({ message: "Player detection started" });
    } catch (err) {
        return res.status(500).json({ message: "Server error", error: err.message });
    }
}

async function getTeamRoster(req, res) {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid video id" });
        }

        const video = await Video.findOne({ _id: id, userId: req.user.id });
        if (!video) return res.status(404).json({ message: "Video not found" });

        return res.status(200).json({
            detectionStatus: video.playerDetection?.status || "none",
            detectionError: video.playerDetection?.error || "",
            detections: video.detections || [],
            players: video.teamRoster?.players || [],
        });
    } catch (err) {
        return res.status(500).json({ message: "Server error", error: err.message });
    }
}

async function savePlayerManualName(req, res) {
    try {
        const { id } = req.params;
        const { detectedId, jerseyNumber, teamSide, manualName } = req.body;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid video id" });
        }

        if (!detectedId) {
            return res.status(400).json({ message: "detectedId is required" });
        }

        const video = await Video.findOne({ _id: id, userId: req.user.id });
        if (!video) return res.status(404).json({ message: "Video not found" });

        const players = video.teamRoster?.players || [];

        const idx = players.findIndex(
            (p) => String(p.detectedId) === String(detectedId)
        );

        if (idx === -1) {
            return res.status(404).json({ message: "Detected player not found" });
        }

        video.teamRoster.players[idx].manualName = (manualName || "").trim();
        video.teamRoster.players[idx].jerseyNumber = (jerseyNumber || "").trim();
        video.teamRoster.players[idx].teamSide = teamSide || "unknown";

        await video.save();

        return res.status(200).json({
            message: "Player details saved",
            player: video.teamRoster.players[idx],
            players: video.teamRoster.players,
        });
    } catch (err) {
        return res.status(500).json({ message: "Server error", error: err.message });
    }
}
async function resetPlayerDetection(req, res) {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid video id" });
        }

        const video = await Video.findOne({ _id: id, userId: req.user.id });
        if (!video) {
            return res.status(404).json({ message: "Video not found" });
        }

        video.playerDetection.status = "none";
        video.playerDetection.error = "";
        video.playerDetection.lastProcessedAt = null;
        video.teamRoster = { players: [] };

        await video.save();

        return res.status(200).json({
            message: "Player detection reset",
        });
    } catch (err) {
        return res.status(500).json({
            message: "Server error",
            error: err.message,
        });
    }
}

async function createRosterPlayer(req, res) {
    try {
        const { id } = req.params;
        const { manualName, jerseyNumber, teamSide, position } = req.body;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid video id" });
        }

        const video = await Video.findOne({ _id: id, userId: req.user.id });
        if (!video) return res.status(404).json({ message: "Video not found" });

        const playerId = `player_${Date.now()}`;

        const player = {
            playerId,
            manualName: (manualName || "").trim(),
            jerseyNumber: (jerseyNumber || "").trim(),
            teamSide: teamSide || "unknown",
            position: position || "",
        };

        if (!video.teamRoster) video.teamRoster = { players: [] };
        video.teamRoster.players.push(player);

        await video.save();

        return res.status(201).json({
            message: "Player created",
            player,
            players: video.teamRoster.players,
        });
    } catch (err) {
        return res.status(500).json({ message: "Server error", error: err.message });
    }
}

// Upserts just a jersey's position -- the per-video roster otherwise only
// supports create/delete/bulk-import, with no way to edit a single existing
// entry. Called from the Player Profile page, which only knows a jersey
// number (not a roster playerId) -- update the existing roster entry for
// that jersey if one exists (e.g. imported from My Team, which already
// carries position over), otherwise create a minimal one, so this works
// whether or not the player was ever added to the roster before.
async function setRosterPlayerPosition(req, res) {
    try {
        const { id } = req.params;
        const { jerseyNumber, teamSide, position } = req.body;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid video id" });
        }
        if (!jerseyNumber) {
            return res.status(400).json({ message: "jerseyNumber is required" });
        }
        const allowedPositions = ["libero", "setter", "hitter", "blocker", ""];
        if (!allowedPositions.includes(position || "")) {
            return res.status(400).json({ message: "Invalid position" });
        }

        const video = await Video.findOne({ _id: id, userId: req.user.id });
        if (!video) return res.status(404).json({ message: "Video not found" });
        if (!video.teamRoster) video.teamRoster = { players: [] };

        const jerseyStr = String(jerseyNumber);
        const existing = video.teamRoster.players.find(p => p.jerseyNumber === jerseyStr);
        if (existing) {
            existing.position = position || "";
        } else {
            video.teamRoster.players.push({
                playerId: `player_${Date.now()}`,
                manualName: "",
                jerseyNumber: jerseyStr,
                teamSide: teamSide || "my_team",
                position: position || "",
            });
        }

        await video.save();
        return res.status(200).json({ message: "Position updated", players: video.teamRoster.players });
    } catch (err) {
        return res.status(500).json({ message: "Server error", error: err.message });
    }
}

async function importMyTeam(req, res) {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid video id" });
        }

        const video = await Video.findOne({ _id: id, userId: req.user.id });
        if (!video) return res.status(404).json({ message: "Video not found" });

        const user = await User.findById(req.user.id);
        const myTeamPlayers = user?.myTeamRoster?.players || [];

        if (!video.teamRoster) video.teamRoster = { players: [] };
        const existingJerseys = new Set(
            video.teamRoster.players.filter(p => p.teamSide === "my_team").map(p => p.jerseyNumber)
        );

        let imported = 0;
        for (const mp of myTeamPlayers) {
            if (existingJerseys.has(mp.jerseyNumber)) continue;
            video.teamRoster.players.push({
                playerId: `player_${Date.now()}_${imported}`,
                manualName: mp.name || "",
                jerseyNumber: mp.jerseyNumber,
                teamSide: "my_team",
                position: mp.position || "",
            });
            imported += 1;
        }

        await video.save();

        return res.status(200).json({
            message: `Imported ${imported} player(s) from My Team`,
            players: video.teamRoster.players,
        });
    } catch (err) {
        return res.status(500).json({ message: "Server error", error: err.message });
    }
}

async function deleteRosterPlayer(req, res) {
    try {
        const { id, playerId } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid video id" });
        }

        const video = await Video.findOne({ _id: id, userId: req.user.id });
        if (!video) return res.status(404).json({ message: "Video not found" });

        if (!video.teamRoster) video.teamRoster = { players: [] };
        video.teamRoster.players = video.teamRoster.players.filter(p => p.playerId !== playerId);

        await video.save();

        return res.status(200).json({ message: "Player removed", players: video.teamRoster.players });
    } catch (err) {
        return res.status(500).json({ message: "Server error", error: err.message });
    }
}

async function assignDetectionsToPlayer(req, res) {
    try {
        const { id } = req.params;
        const { detectionIds, playerId } = req.body;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid video id" });
        }

        const video = await Video.findOne({ _id: id, userId: req.user.id });
        if (!video) return res.status(404).json({ message: "Video not found" });

        if (!Array.isArray(detectionIds) || !playerId) {
            return res.status(400).json({ message: "detectionIds and playerId are required" });
        }

        video.detections = (video.detections || []).map((d) => {
            if (detectionIds.includes(d.detectionId)) {
                return { ...d.toObject?.() ? d.toObject() : d, assignedPlayerId: playerId };
            }
            return d;
        });

        await video.save();

        return res.status(200).json({
            message: "Detections assigned",
            detections: video.detections,
            players: video.teamRoster?.players || [],
        });
    } catch (err) {
        return res.status(500).json({ message: "Server error", error: err.message });
    }
}
async function getVideoAnalysis(req, res) {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid video id" });
        }

        const video = await Video.findOne({ _id: id, userId: req.user.id });
        if (!video) {
            return res.status(404).json({ message: "Video not found" });
        }

        return res.status(200).json({
            status: video.videoAnalysis?.status || "none",
            error: video.videoAnalysis?.error || "",
            rallies: video.videoAnalysis?.rallies || [],
            deadSegments: video.videoAnalysis?.deadSegments || [],
            optimizedSegments: video.videoAnalysis?.optimizedSegments || [],
        });
    } catch (err) {
        return res.status(500).json({ message: "Server error", error: err.message });
    }
}

function normalizeVideoWithFfmpeg(video) {
    return new Promise((resolve, reject) => {
        const inputAbs = path.join(__dirname, "..", video.filePath.replace(/^\//, ""));
        const outputName = `normalized_${video._id}.mp4`;
        const outputRel = `/uploads/${outputName}`;
        const outputAbs = path.join(__dirname, "..", "uploads", outputName);

        const ffmpegCmd = process.env.FFMPEG_PATH || "ffmpeg";

        if (fs.existsSync(outputAbs)) {
            fs.unlinkSync(outputAbs);
        }

        console.log("NORMALIZE INPUT =", inputAbs);
        console.log("NORMALIZE OUTPUT =", outputAbs);

        const ff = spawn(ffmpegCmd, [
            "-y",
            "-err_detect", "ignore_err",
            "-fflags", "+discardcorrupt",
            "-i", inputAbs,
            "-c:v", "libx264",
            "-preset", "fast",
            "-crf", "20",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            "-movflags", "+faststart",
            outputAbs,
        ]);

        let stderr = "";
        let stdout = "";

        ff.stdout.on("data", (d) => {
            stdout += d.toString();
            console.log("FFMPEG STDOUT:", d.toString());
        });

        ff.stderr.on("data", (d) => {
            stderr += d.toString();
            console.log("FFMPEG STDERR:", d.toString());
        });

        ff.on("close", (code) => {
            if (code !== 0) {
                reject(new Error(stderr || `ffmpeg exited with code ${code}`));
                return;
            }

            if (!fs.existsSync(outputAbs)) {
                reject(new Error("Normalized file was not created"));
                return;
            }

            resolve({
                normalizedFilePath: outputRel,
            });
        });

        ff.on("error", (err) => {
            reject(err);
        });
    });
}
async function analyzeRallies(req, res) {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid video id" });
        }

        const video = await Video.findOne({ _id: id, userId: req.user.id });
        if (!video) {
            return res.status(404).json({ message: "Video not found" });
        }

        if (video.sourceType !== "file") {
            return res.status(400).json({
                message: "Rally analysis is supported only for uploaded files",
            });
        }

        if (!video.filePath) {
            return res.status(400).json({ message: "Missing filePath" });
        }

        if (video.videoAnalysis?.status === "processing") {
            return res.status(202).json({ message: "Video analysis already processing" });
        }

        video.videoAnalysis = {
            status: "processing",
            error: "",
            rallies: [],
            deadSegments: [],
            optimizedSegments: [],
            lastProcessedAt: null,
        };
        await video.save();

        let analysisRelPath = video.filePath;

        if (!video.normalizedFilePath) {
            video.normalizationStatus = "processing";
            video.normalizationError = "";
            await video.save();

            try {
                const normalized = await normalizeVideoWithFfmpeg(video);

                video.normalizedFilePath = normalized.normalizedFilePath;
                video.normalizationStatus = "done";
                video.normalizationError = "";
                await video.save();

                analysisRelPath = normalized.normalizedFilePath;
            } catch (err) {
                video.normalizationStatus = "failed";
                video.normalizationError = err.message;
                video.videoAnalysis.status = "failed";
                video.videoAnalysis.error = `Normalization failed: ${err.message}`;
                await video.save();

                return res.status(500).json({
                    message: "Video normalization failed",
                    error: err.message,
                });
            }
        } else {
            analysisRelPath = video.normalizedFilePath;
        }

        const inputAbs = path.join(__dirname, "..", analysisRelPath.replace(/^\//, ""));
        const uploadsAbs = path.join(__dirname, "..", "uploads");
        const resultJsonAbs = path.join(uploadsAbs, `rally_analysis_${video._id}.json`);

        const pyCmd = process.platform === "win32" ? "py" : "python3";
        const scriptPath = path.join(__dirname, "..", "python", "analyze_rallies.py");

        console.log("Starting rally analysis...");
        console.log("scriptPath =", scriptPath);
        console.log("inputAbs =", inputAbs);
        console.log("resultJsonAbs =", resultJsonAbs);
        console.log("script exists =", fs.existsSync(scriptPath));
        console.log("input exists =", fs.existsSync(inputAbs));

        const py = spawn(pyCmd, [
            scriptPath,
            "--input", inputAbs,
            "--output_json", resultJsonAbs,
        ]);

        let stderr = "";

        py.stdout.on("data", (d) => {
            console.log("RALLY PYTHON STDOUT:", d.toString());
        });

        py.stderr.on("data", (d) => {
            stderr += d.toString();
            console.log("RALLY PYTHON STDERR:", d.toString());
        });

        py.on("error", async (err) => {
            try {
                const v = await Video.findById(video._id);
                if (!v) return;
                v.videoAnalysis.status = "failed";
                v.videoAnalysis.error = `Failed to start Python process: ${err.message}`;
                await v.save();
            } catch { }
        });

        py.on("close", async (code) => {
            try {
                const v = await Video.findById(video._id);
                if (!v) return;

                if (code !== 0) {
                    v.videoAnalysis.status = "failed";
                    v.videoAnalysis.error = stderr || `Python exited with code ${code}`;
                    await v.save();
                    return;
                }

                if (!fs.existsSync(resultJsonAbs)) {
                    v.videoAnalysis.status = "failed";
                    v.videoAnalysis.error = "Rally analysis JSON was not created";
                    await v.save();
                    return;
                }

                const raw = fs.readFileSync(resultJsonAbs, "utf8");
                const parsed = JSON.parse(raw);

                v.videoAnalysis.status = "done";
                v.videoAnalysis.error = "";
                v.videoAnalysis.rallies = parsed.rallies || [];
                v.videoAnalysis.deadSegments = parsed.deadSegments || [];
                v.videoAnalysis.optimizedSegments = parsed.optimizedSegments || [];
                v.videoAnalysis.lastProcessedAt = new Date();

                await v.save();
                console.log("Rally analysis saved to DB");
            } catch (err) {
                try {
                    const v = await Video.findById(video._id);
                    if (v) {
                        v.videoAnalysis.status = "failed";
                        v.videoAnalysis.error = err.message;
                        await v.save();
                    }
                } catch { }
            }
        });

        return res.status(202).json({ message: "Rally analysis started" });
    } catch (err) {
        return res.status(500).json({ message: "Server error", error: err.message });
    }
}

async function analyzeBall(req, res) {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid video id" });
        }

        const video = await Video.findOne({ _id: id, userId: req.user.id });
        if (!video) {
            return res.status(404).json({ message: "Video not found" });
        }

        if (video.sourceType !== "file") {
            return res.status(400).json({
                message: "Ball analysis is supported only for uploaded files",
            });
        }

        if (!video.filePath) {
            return res.status(400).json({ message: "Missing filePath" });
        }

        if (video.ballAnalysis?.status === "processing") {
            return res.status(202).json({ message: "Ball analysis already processing" });
        }

        video.ballAnalysis = {
            status: "processing",
            error: "",
            points: [],
            rallies: [],
            deadSegments: [],
            optimizedSegments: [],
            lastProcessedAt: null,
        };
        await video.save();

        let analysisRelPath = video.filePath;

        if (!video.normalizedFilePath) {
            video.normalizationStatus = "processing";
            video.normalizationError = "";
            await video.save();

            try {
                const normalized = await normalizeVideoWithFfmpeg(video);
                video.normalizedFilePath = normalized.normalizedFilePath;
                video.normalizationStatus = "done";
                video.normalizationError = "";
                await video.save();
                analysisRelPath = normalized.normalizedFilePath;
            } catch (err) {
                video.normalizationStatus = "failed";
                video.normalizationError = err.message;
                video.ballAnalysis.status = "failed";
                video.ballAnalysis.error = `Normalization failed: ${err.message}`;
                await video.save();

                return res.status(500).json({
                    message: "Video normalization failed",
                    error: err.message,
                });
            }
        } else {
            analysisRelPath = video.normalizedFilePath;
        }

        const inputAbs = path.join(__dirname, "..", analysisRelPath.replace(/^\//, ""));
        const uploadsAbs = path.join(__dirname, "..", "uploads");
        const resultJsonAbs = path.join(uploadsAbs, `ball_analysis_${video._id}.json`);

        const pyCmd = process.platform === "win32" ? "py" : "python3";
        const scriptPath = path.join(__dirname, "..", "python", "analyze_ball.py");

        const py = spawn(pyCmd, [
            scriptPath,
            "--input", inputAbs,
            "--output_json", resultJsonAbs,
        ]);

        let stderr = "";

        py.stdout.on("data", (d) => {
            console.log("BALL PYTHON STDOUT:", d.toString());
        });

        py.stderr.on("data", (d) => {
            stderr += d.toString();
            console.log("BALL PYTHON STDERR:", d.toString());
        });

        py.on("error", async (err) => {
            try {
                const v = await Video.findById(video._id);
                if (!v) return;
                v.ballAnalysis.status = "failed";
                v.ballAnalysis.error = `Failed to start Python process: ${err.message}`;
                await v.save();
            } catch { }
        });

        py.on("close", async (code) => {
            try {
                const v = await Video.findById(video._id);
                if (!v) return;

                if (code !== 0) {
                    v.ballAnalysis.status = "failed";
                    v.ballAnalysis.error = stderr || `Python exited with code ${code}`;
                    await v.save();
                    return;
                }

                if (!fs.existsSync(resultJsonAbs)) {
                    v.ballAnalysis.status = "failed";
                    v.ballAnalysis.error = "Ball analysis JSON was not created";
                    await v.save();
                    return;
                }

                const raw = fs.readFileSync(resultJsonAbs, "utf8");
                const parsed = JSON.parse(raw);

                v.ballAnalysis.status = "done";
                v.ballAnalysis.error = "";
                v.ballAnalysis.points = parsed.ballTrack || [];
                v.ballAnalysis.rallies = parsed.rallies || [];
                v.ballAnalysis.deadSegments = parsed.deadSegments || [];
                v.ballAnalysis.optimizedSegments = parsed.optimizedSegments || [];
                v.ballAnalysis.lastProcessedAt = new Date();

                await v.save();
                console.log("Ball analysis saved to DB");
            } catch (err) {
                try {
                    const v = await Video.findById(video._id);
                    if (v) {
                        v.ballAnalysis.status = "failed";
                        v.ballAnalysis.error = err.message;
                        await v.save();
                    }
                } catch { }
            }
        });

        return res.status(202).json({ message: "Ball analysis started" });
    } catch (err) {
        return res.status(500).json({ message: "Server error", error: err.message });
    }
}
async function getBallAnalysis(req, res) {
    try {
        const { id } = req.params;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid video id" });
        }

        const video = await Video.findOne({ _id: id, userId: req.user.id });
        if (!video) {
            return res.status(404).json({ message: "Video not found" });
        }

        return res.status(200).json({
            status: video.ballAnalysis?.status || "none",
            error: video.ballAnalysis?.error || "",
            points: video.ballAnalysis?.points || [],
            rallies: video.ballAnalysis?.rallies || [],
            deadSegments: video.ballAnalysis?.deadSegments || [],
            optimizedSegments: video.ballAnalysis?.optimizedSegments || [],
        });
    } catch (err) {
        return res.status(500).json({ message: "Server error", error: err.message });
    }
}
async function getPlayerStats(req, res) {
    try {
        const { id } = req.params;
        let video = null;
        if (id !== "latest") {
            if (!mongoose.Types.ObjectId.isValid(id)) {
                return res.status(400).json({ message: "Invalid video id" });
            }
            video = await Video.findOne({ _id: id, userId: req.user.id });
            if (!video) return res.status(404).json({ message: "Video not found" });
        }

        const runStatsPath = path.join(__dirname, "..", "detection_models", "all_three", "runs", "player_stats.json");
        const perVideoPath = video?.playerStatsPath
            ? path.join(__dirname, "..", video.playerStatsPath.replace(/^\//, ""))
            : null;

        // Use whichever file is newer — the per-video copy is written last during
        // a normal analysis run, but fall back to the raw runs/ copy if it's missing.
        let statsPath = perVideoPath || runStatsPath;
        if (perVideoPath && fs.existsSync(perVideoPath) && fs.existsSync(runStatsPath)) {
            const runMtime = fs.statSync(runStatsPath).mtimeMs;
            const vidMtime = fs.statSync(perVideoPath).mtimeMs;
            if (runMtime > vidMtime) statsPath = runStatsPath;
        }

        if (!fs.existsSync(statsPath)) {
            return res.status(200).json({ status: "none", stats: {} });
        }

        const raw = fs.readFileSync(statsPath, "utf8");
        const stats = JSON.parse(raw);
        return res.status(200).json({ status: "done", stats });
    } catch (err) {
        return res.status(500).json({ message: "Server error", error: err.message });
    }
}

const REGISTRY_PATH = path.join(__dirname, "..", "detection_models", "all_three", "runs", "player_registry.json");
const THUMBS_DIR    = path.join(__dirname, "..", "detection_models", "all_three", "runs", "player_thumbs");
const RALLY_PATH    = path.join(__dirname, "..", "detection_models", "all_three", "runs", "rally_analysis.json");

async function getPlayerRegistry(req, res) {
    try {
        if (!fs.existsSync(REGISTRY_PATH)) return res.status(200).json({ status: "none", registry: {} });
        const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));

        // Convert absolute thumbnail paths to API-accessible URLs
        const result = {};
        for (const [bid, data] of Object.entries(registry)) {
            let thumbUrl = null;
            if (data.thumbnail && fs.existsSync(data.thumbnail)) {
                const filename = path.basename(data.thumbnail);
                thumbUrl = `/player-thumbs/${filename}`;
            }
            result[bid] = { ...data, thumbnailUrl: thumbUrl };
        }
        return res.status(200).json({ status: "ok", registry: result });
    } catch (err) {
        return res.status(500).json({ message: "Server error", error: err.message });
    }
}

// ── Per-video player registry (coach-merge UI) ──────────────────────────
// Unlike getPlayerRegistry above (which operates on the single shared
// RUNS_DIR scratch file — last real run only), these work off the per-video
// copies saved under uploads/ so a merge survives and applies
// to the specific match the coach is looking at.

function resolveVideoRegistryPath(video) {
    // jerseyRegistryPath is the raw per-jersey registry (what triple_detection.py
    // writes); playerRegistryPath is merge_pipeline.py's event-count-enriched
    // copy of the same keys. Prefer the enriched one when present.
    const rel = video.playerRegistryPath || video.jerseyRegistryPath;
    if (!rel) return null;
    return path.join(__dirname, "..", rel.replace(/^\//, ""));
}

async function getPlayerRegistryForVideo(req, res) {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid video id" });
        }
        const video = await Video.findOne({ _id: id, userId: req.user.id });
        if (!video) return res.status(404).json({ message: "Video not found" });

        const registryPath = resolveVideoRegistryPath(video);
        if (!registryPath || !fs.existsSync(registryPath)) {
            return res.status(200).json({ status: "none", registry: {} });
        }

        const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
        const result = {};
        for (const [key, data] of Object.entries(registry)) {
            let thumbnailUrl = null;
            if (data.thumbnail && fs.existsSync(data.thumbnail)) {
                // Per-video thumbs live under uploads/player_thumbs_<id>/, which
                // is already served statically via /uploads.
                const uploadsAbs = path.join(__dirname, "..", "uploads");
                const rel = path.relative(uploadsAbs, data.thumbnail);
                thumbnailUrl = !rel.startsWith("..") ? `/uploads/${rel.split(path.sep).join("/")}` : null;
            }
            result[key] = { ...data, thumbnailUrl };
        }
        return res.status(200).json({ status: "ok", registry: result });
    } catch (err) {
        return res.status(500).json({ message: "Server error", error: err.message });
    }
}

async function mergePlayerRegistry(req, res) {
    try {
        const { id } = req.params;
        const { keepKey, mergeKeys } = req.body;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid video id" });
        }
        if (!keepKey || !Array.isArray(mergeKeys) || mergeKeys.length === 0) {
            return res.status(400).json({ message: "keepKey and a non-empty mergeKeys array are required" });
        }

        const video = await Video.findOne({ _id: id, userId: req.user.id });
        if (!video) return res.status(404).json({ message: "Video not found" });

        const registryPaths = [video.jerseyRegistryPath, video.playerRegistryPath]
            .filter(Boolean)
            .map(rel => path.join(__dirname, "..", rel.replace(/^\//, "")))
            .filter(p => fs.existsSync(p));

        if (registryPaths.length === 0) {
            return res.status(404).json({ message: "No registry file found for this video" });
        }

        // Registry entries only ever get a plural track_ids array once a
        // merge has already combined more than one track into them -- a
        // fresh, never-merged entry (the common case) only has the
        // singular track_id predict_pipeline.py wrote at generation time.
        // Normalize both shapes here so a first-time merge doesn't silently
        // treat a fresh entry as having zero tracks.
        const entryTrackIds = (entry) =>
            entry?.track_ids || (entry?.track_id != null ? [entry.track_id] : []);

        // Two entries can only be the same real physical player if their
        // underlying tracks were never on screen at the same time -- one
        // person can't be in two places at once. Blind merges (no check at
        // all, previously) risk silently combining two genuinely different
        // players' stats into one, corrupting both. Requires
        // frameJerseyMapPath (per-track frame timelines); older videos
        // analyzed before this existed skip the check rather than block
        // merging entirely.
        if (video.frameJerseyMapPath) {
            const fjmPath = path.join(__dirname, "..", video.frameJerseyMapPath.replace(/^\//, ""));
            if (fs.existsSync(fjmPath)) {
                const frameJerseyMap = JSON.parse(fs.readFileSync(fjmPath, "utf8"));
                const trackRanges = {}; // track_id -> [minFrame, maxFrame]
                for (const [frameStr, entries] of Object.entries(frameJerseyMap)) {
                    const frame = Number(frameStr);
                    for (const e of entries) {
                        const r = trackRanges[e.track_id];
                        if (!r) trackRanges[e.track_id] = [frame, frame];
                        else { if (frame < r[0]) r[0] = frame; if (frame > r[1]) r[1] = frame; }
                    }
                }
                const overlaps = (idsA, idsB) => idsA.some(a => {
                    const ra = trackRanges[a];
                    if (!ra) return false;
                    return idsB.some(b => {
                        const rb = trackRanges[b];
                        if (!rb) return false;
                        return Math.max(ra[0], rb[0]) <= Math.min(ra[1], rb[1]);
                    });
                });

                const anyRegistry = JSON.parse(fs.readFileSync(registryPaths[0], "utf8"));
                const keepTrackIds = entryTrackIds(anyRegistry[keepKey]);
                for (const mKey of mergeKeys) {
                    const mergeTrackIds = entryTrackIds(anyRegistry[mKey]);
                    if (overlaps(keepTrackIds, mergeTrackIds)) {
                        return res.status(409).json({
                            message: `Cannot merge #${anyRegistry[mKey]?.jersey} into #${anyRegistry[keepKey]?.jersey} -- `
                                + "they were both tracked on screen at the same time, so they can't be the same real player.",
                        });
                    }
                }
            }
        }

        let canonicalJersey = null;
        const relabelPairs = []; // [oldJersey, newJersey]

        for (const regPath of registryPaths) {
            const registry = JSON.parse(fs.readFileSync(regPath, "utf8"));
            const keep = registry[keepKey];
            if (!keep) continue;

            canonicalJersey = keep.jersey ?? canonicalJersey;
            let combinedTrackIds = entryTrackIds(keep);
            let combinedEventCount = keep.event_count || 0;

            for (const mKey of mergeKeys) {
                const merged = registry[mKey];
                if (!merged) continue;
                combinedTrackIds = combinedTrackIds.concat(entryTrackIds(merged));
                combinedEventCount += merged.event_count || 0;
                if (merged.jersey != null && merged.jersey !== keep.jersey) {
                    relabelPairs.push([merged.jersey, keep.jersey]);
                }
                if (!keep.thumbnail && merged.thumbnail) keep.thumbnail = merged.thumbnail;
                delete registry[mKey];
            }

            keep.track_ids = [...new Set(combinedTrackIds)];
            keep.event_count = combinedEventCount;
            registry[keepKey] = keep;

            fs.writeFileSync(regPath, JSON.stringify(registry, null, 4));
        }

        // Relabel downstream data so stats/actions built off the merged-away
        // jersey number(s) show up under the canonical number immediately,
        // instead of only fixing the registry and leaving stale data behind.
        if (canonicalJersey != null && relabelPairs.length > 0 && video.analyticsJsonPath) {
            const p = path.join(__dirname, "..", video.analyticsJsonPath.replace(/^\//, ""));
            if (fs.existsSync(p)) {
                const analytics = JSON.parse(fs.readFileSync(p, "utf8"));
                for (const frame of analytics.frames || []) {
                    for (const [oldJ] of relabelPairs) {
                        if (frame.active_player_jersey === oldJ) frame.active_player_jersey = canonicalJersey;
                    }
                }
                fs.writeFileSync(p, JSON.stringify(analytics, null, 2));

                // Re-run the full rally/stats build off the now-relabeled raw
                // frames rather than hand-patching the already-built
                // rally_analysis.json. A merge changes which jersey owns
                // which touches, but player_stats is keyed BY jersey number
                // (an object key, not a field value) -- a field-value walk
                // can rewrite every player_jersey:1 to player_jersey:7, but
                // it can never merge player_stats["1"] into
                // player_stats["7"], since there's no "1" field value to
                // find there. Verified directly: merging #1 into #7 left
                // both as fully separate, unmerged box-score lines, because
                // nothing had ever recomputed player_stats after the merge.
                // Recomputing from the corrected source data sidesteps the
                // whole class of bug instead of chasing every derived field
                // a patch-in-place approach could miss.
                let scoreboardData = null;
                if (video.scoreboardReadingsPath) {
                    const sbPath = path.join(__dirname, "..", video.scoreboardReadingsPath.replace(/^\//, ""));
                    if (fs.existsSync(sbPath)) {
                        try { scoreboardData = JSON.parse(fs.readFileSync(sbPath, "utf8")); } catch {}
                    }
                }
                const rallyData = buildRallyAnalysis(analytics, { scoreboardData, isHomeTeam: video.isHomeTeam ?? true });
                if (video.rallyAnalysisPath) {
                    const rp = path.join(__dirname, "..", video.rallyAnalysisPath.replace(/^\//, ""));
                    fs.writeFileSync(rp, JSON.stringify(rallyData, null, 2));
                }
                if (video.playerStatsPath) {
                    const sp = path.join(__dirname, "..", video.playerStatsPath.replace(/^\//, ""));
                    fs.writeFileSync(sp, JSON.stringify(rallyData.player_stats, null, 2));
                }
            }
        }

        return res.status(200).json({ status: "ok", canonicalJersey, mergedFrom: relabelPairs.map(p => p[0]) });
    } catch (err) {
        return res.status(500).json({ message: "Server error", error: err.message });
    }
}

// Drops one or more registry entries outright -- for phantom/junk tracks
// (e.g. a bystander or a brief false-positive detection) that never earned a
// single real event, where there's nothing worth merging into another
// player, just clutter to clear off the Merge Players grid. Unlike merge,
// this never needs to relabel analytics/rally data: an entry with no real
// events was never the active_player_jersey for any real action to begin
// with, so there's nothing downstream pointing at it.
async function deletePlayerRegistryEntries(req, res) {
    try {
        const { id } = req.params;
        const { keys } = req.body;

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid video id" });
        }
        if (!Array.isArray(keys) || keys.length === 0) {
            return res.status(400).json({ message: "A non-empty keys array is required" });
        }

        const video = await Video.findOne({ _id: id, userId: req.user.id });
        if (!video) return res.status(404).json({ message: "Video not found" });

        const registryPaths = [video.jerseyRegistryPath, video.playerRegistryPath]
            .filter(Boolean)
            .map(rel => path.join(__dirname, "..", rel.replace(/^\//, "")))
            .filter(p => fs.existsSync(p));

        if (registryPaths.length === 0) {
            return res.status(404).json({ message: "No registry file found for this video" });
        }

        let deleted = 0;
        for (const regPath of registryPaths) {
            const registry = JSON.parse(fs.readFileSync(regPath, "utf8"));
            for (const key of keys) {
                if (registry[key]) {
                    delete registry[key];
                    deleted++;
                }
            }
            fs.writeFileSync(regPath, JSON.stringify(registry, null, 4));
        }

        return res.status(200).json({ status: "ok", deleted: keys.length });
    } catch (err) {
        return res.status(500).json({ message: "Server error", error: err.message });
    }
}

// In-memory job tracking: videoId → { status, progress, error }
const analysisJobs = {};

const RUNS_DIR    = path.join(__dirname, "..", "detection_models", "all_three", "runs");

async function saveJerseys(req, res) {
    try {
        const { id } = req.params;
        // Accept either {players:[{jersey,name}]} (legacy) or {isHomeTeam} (current)
        const { players, jerseys, isHomeTeam } = req.body;
        if (!mongoose.Types.ObjectId.isValid(id))
            return res.status(400).json({ message: "Invalid id" });

        let playerList;
        if (players) {
            playerList = (players || []).map(p => ({
                jersey: Number(p.jersey),
                name: (p.name || "").trim(),
            }));
        } else {
            playerList = (jerseys || []).map(n => ({ jersey: Number(n), name: "" }));
        }

        const update = {
            knownPlayers: playerList,
            knownJerseys: playerList.map(p => p.jersey),
        };
        if (typeof isHomeTeam === "boolean") {
            update.isHomeTeam = isHomeTeam;
        }

        const video = await Video.findOneAndUpdate(
            { _id: id, userId: req.user.id },
            { $set: update },
            { new: true }
        );
        if (!video) return res.status(404).json({ message: "Video not found" });
        return res.json({ status: "ok" });
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
}

// Copies this run's outputs out of the shared scratch dir (RUNS_DIR) into
// per-video files under /uploads, and returns the $set fields for the Video
// doc. The pipeline only ever has ONE job's output in RUNS_DIR at a time, so
// without this copy, starting analysis on a second video silently destroys
// the first video's results (RUNS_DIR gets wiped at the top of startAnalysis).
async function persistAnalysisOutputs(id) {
    const uploadsDir = path.join(__dirname, "..", "uploads");
    const dbUpdates = {};

    // Processed video — prefer render_video.py's annotated output (jersey + action,
    // built from the merged data), then the plain jersey-tracking video as a fallback
    // if rendering failed. (No triple_detection.py in this pipeline — see startAnalysis.)
    const destVideo         = path.join(uploadsDir, `analyzed_${id}.mp4`);
    const srcRendered       = path.join(RUNS_DIR, "analyzed_video.mp4");
    const srcJerseyTracking = path.join(RUNS_DIR, "jersey_tracking.mp4");

    if (fs.existsSync(srcRendered) && fs.statSync(srcRendered).size > 0) {
        fs.copyFileSync(srcRendered, destVideo);
        dbUpdates.analyzedVideoPath = `/uploads/analyzed_${id}.mp4`;
    } else if (fs.existsSync(srcJerseyTracking) && fs.statSync(srcJerseyTracking).size > 0) {
        fs.copyFileSync(srcJerseyTracking, destVideo);
        dbUpdates.analyzedVideoPath = `/uploads/analyzed_${id}.mp4`;
    }

    // Player thumbnails — copy into a per-video folder so they survive the
    // next run, then point the persisted registry at the new folder.
    const destThumbsDir = path.join(uploadsDir, `player_thumbs_${id}`);
    if (fs.existsSync(THUMBS_DIR)) {
        fs.mkdirSync(destThumbsDir, { recursive: true });
        for (const f of fs.readdirSync(THUMBS_DIR)) {
            fs.copyFileSync(path.join(THUMBS_DIR, f), path.join(destThumbsDir, f));
        }
    }

    if (fs.existsSync(REGISTRY_PATH)) {
        const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
        for (const data of Object.values(registry)) {
            if (data.thumbnail) data.thumbnail = path.join(destThumbsDir, path.basename(data.thumbnail));
        }
        const destRegistry = path.join(uploadsDir, `player_registry_${id}.json`);
        fs.writeFileSync(destRegistry, JSON.stringify(registry, null, 4));
        dbUpdates.playerRegistryPath = `/uploads/player_registry_${id}.json`;
    }

    const srcStats = path.join(RUNS_DIR, "player_stats.json");
    if (fs.existsSync(srcStats)) {
        fs.copyFileSync(srcStats, path.join(uploadsDir, `player_stats_${id}.json`));
        dbUpdates.playerStatsPath = `/uploads/player_stats_${id}.json`;
    }

    const srcAnalytics = path.join(RUNS_DIR, "volley_analytics.json");
    if (fs.existsSync(srcAnalytics)) {
        fs.copyFileSync(srcAnalytics, path.join(uploadsDir, `volley_analytics_${id}.json`));
        dbUpdates.analyticsJsonPath = `/uploads/volley_analytics_${id}.json`;
    }

    const srcJerseyRegistry = path.join(RUNS_DIR, "jersey_registry.json");
    if (fs.existsSync(srcJerseyRegistry)) {
        fs.copyFileSync(srcJerseyRegistry, path.join(uploadsDir, `jersey_registry_${id}.json`));
        dbUpdates.jerseyRegistryPath = `/uploads/jersey_registry_${id}.json`;
    }

    // Per-track frame timelines -- otherwise only the shared RUNS_DIR copy
    // exists, which the next video's analysis wipes. The merge endpoint
    // needs this to survive per-video so it can check, at merge time
    // (possibly long after this run), whether two candidate entries were
    // ever active simultaneously.
    const srcFrameJerseyMap = path.join(RUNS_DIR, "frame_jersey_map.json");
    if (fs.existsSync(srcFrameJerseyMap)) {
        fs.copyFileSync(srcFrameJerseyMap, path.join(uploadsDir, `frame_jersey_map_${id}.json`));
        dbUpdates.frameJerseyMapPath = `/uploads/frame_jersey_map_${id}.json`;
    }

    // Scoreboard OCR — optional, non-fatal. Copy alongside the other per-video
    // outputs so it survives the next run's RUNS_DIR wipe, same as everything else.
    const srcScoreboard = path.join(RUNS_DIR, "scoreboard_readings.json");
    let scoreboardData = null;
    if (fs.existsSync(srcScoreboard)) {
        fs.copyFileSync(srcScoreboard, path.join(uploadsDir, `scoreboard_readings_${id}.json`));
        dbUpdates.scoreboardReadingsPath = `/uploads/scoreboard_readings_${id}.json`;
        try {
            scoreboardData = JSON.parse(fs.readFileSync(srcScoreboard, "utf8"));
        } catch (e) {
            console.warn("[SCORE] Failed to parse scoreboard_readings.json:", e.message);
        }
    }

    // Generate rally_analysis.json from ball_landings in volley_analytics.json
    const srcAnalyticsForRally = path.join(uploadsDir, `volley_analytics_${id}.json`);
    if (fs.existsSync(srcAnalyticsForRally)) {
        try {
            const video      = await Video.findById(id);
            const isHomeTeam = video?.isHomeTeam ?? true;
            const volleyData = JSON.parse(fs.readFileSync(srcAnalyticsForRally, "utf8"));
            const rallyData  = buildRallyAnalysis(volleyData, { scoreboardData, isHomeTeam });
            const rallyDest  = path.join(uploadsDir, `rally_analysis_${id}.json`);
            fs.writeFileSync(rallyDest, JSON.stringify(rallyData, null, 2));
            dbUpdates.rallyAnalysisPath = `/uploads/rally_analysis_${id}.json`;
            // Mirrored onto the Video doc so the home screen's card list can
            // show the real computed score without a per-card rally-analysis
            // fetch -- listVideos only ever reads the lightweight doc fields.
            // Deliberately the per-rally accumulated tally, not the
            // scoreboard's raw final OCR reading -- the two can disagree
            // (verified directly: one video read 4-9 from the accumulated
            // tally vs 5-8 off the board's last frame) and the accumulated
            // tally was chosen as the one to display: it's built from many
            // independent per-rally reads rather than a single OCR snapshot
            // of the board, which has no redundancy if that one frame
            // misread a digit.
            dbUpdates.usScore = rallyData.us_score;
            dbUpdates.opponentScore = rallyData.opponent_score;
            console.log(`[RALLY] Generated rally_analysis.json (score source: ${rallyData.score_source}): `
                + `${rallyData.total_won}W ${rallyData.total_lost}L, ${rallyData.score_events.length} score events`);

            // Same per-player breakdown MatchStatistics.jsx already renders —
            // written as its own file since getPlayerStats/player-stats route
            // reads video.playerStatsPath independently of rally_analysis.
            const statsDest = path.join(uploadsDir, `player_stats_${id}.json`);
            fs.writeFileSync(statsDest, JSON.stringify(rallyData.player_stats, null, 2));
            dbUpdates.playerStatsPath = `/uploads/player_stats_${id}.json`;

            // Flat per-action table (rally_id, action, player, rally winner) for
            // downstream stats work — not surfaced in the UI, just written + logged.
            const actionTable = buildRallyActionTable(rallyData);
            const tableJsonDest = path.join(uploadsDir, `rally_action_table_${id}.json`);
            const tableCsvDest  = path.join(uploadsDir, `rally_action_table_${id}.csv`);
            fs.writeFileSync(tableJsonDest, JSON.stringify(actionTable, null, 2));
            fs.writeFileSync(tableCsvDest, rallyActionTableToCsv(actionTable));
            console.log(`[RALLY TABLE] ${actionTable.length} action rows across ${rallyData.rallies.length} rallies `
                + `-> ${tableJsonDest} / ${tableCsvDest}`);
            const PREVIEW_ROWS = 50;
            console.table(actionTable.slice(0, PREVIEW_ROWS).map((r) => ({
                rally: r.rally_id, action: r.action, player: r.player_jersey ?? r.player_label,
                winner: r.rally_winner, decisive: r.decisive,
            })));
            if (actionTable.length > PREVIEW_ROWS) {
                console.log(`[RALLY TABLE] ...${actionTable.length - PREVIEW_ROWS} more rows in the CSV/JSON above.`);
            }
        } catch (e) {
            console.warn("[RALLY] Failed to generate rally_analysis.json:", e.message);
        }
    }

    return dbUpdates;
}

// Runs one pipeline stage as a subprocess, tracking stdout/stderr progress (`NN%`)
// into analysisJobs[id].progress, mapped from [progressStart, progressEnd].
// Resolves with { code, error } instead of throwing — caller decides fatal vs non-fatal.
function runStage(id, pyCmd, stage, scriptPath, scriptArgs, progressStart, progressEnd) {
    return new Promise((resolve) => {
        console.log(`[${stage}] Starting...`);
        let stderrBuf = "";
        const proc = spawn(pyCmd, [scriptPath, ...scriptArgs]);
        analysisJobs[id].proc = proc;

        const trackProgress = (txt) => {
            const m = txt.match(/(\d+)%/);
            if (m) analysisJobs[id].progress = progressStart + Math.round(parseInt(m[1]) * (progressEnd - progressStart) / 100);
        };
        proc.stdout.on("data", (data) => {
            const txt = data.toString();
            console.log(`[${stage}]`, txt.trim());
            trackProgress(txt);
        });
        proc.stderr.on("data", (data) => {
            const txt = data.toString();
            stderrBuf += txt;
            console.log(`[${stage}]`, txt.trim());
            trackProgress(txt);
        });
        proc.on("error", (err) => resolve({ code: null, error: `Failed to start: ${err.message}` }));
        proc.on("close", (code) => resolve({
            code,
            error: code !== 0 ? (stderrBuf.slice(-1500) || `exit code ${code}`) : null,
        }));
    });
}

async function startAnalysis(req, res) {
    try {
        const { id } = req.params;
        if (analysisJobs[id]?.status === "processing") {
            return res.status(409).json({ message: "Already processing" });
        }

        const video = await Video.findOne({ _id: id, userId: req.user.id });
        if (!video) return res.status(404).json({ message: "Video not found" });

        const videoAbs        = path.join(__dirname, "..", video.filePath.replace(/^\//, ""));
        const JERSEY_PIPELINE  = path.join(__dirname, "..", "detection_models", "player_detection", "predict_pipeline.py");
        // Runs JERSEY_PIPELINE once per rally-boundary-aligned chunk instead of one
        // continuous pass over the whole video -- ByteTrack's own tracking quality
        // was verified directly to degrade over a long continuous run, tracking
        // noticeably better when the identical footage is reprocessed as a short,
        // fresh segment. Needs rally_windows.json (RALLY stage) up front to know
        // where it's safe to cut, which is why RALLY now runs before JERSEY.
        const CHUNKED_JERSEY_PIPELINE = path.join(__dirname, "..", "detection_models", "player_detection", "chunked_jersey_pipeline.py");
        const ACTION_STAGE     = path.join(__dirname, "..", "detection_models", "action_detection", "action.py");
        const RALLY_STAGE      = path.join(__dirname, "..", "detection_models", "rally_detect", "mini_court", "run_rally_stage.py");
        const SCORE_STAGE      = path.join(__dirname, "..", "detection_models", "score_detection", "read_scoreboard.py");
        // Full-frame-trained model (guest_points/home_points/score_board) — detects
        // digit regions directly on the raw frame, no crop+upscale stage needed.
        // Verified directly against real footage: 100% board-detection rate,
        // accurate boxes, matches known-correct final values. Toggle to false to
        // instantly roll back to the original crop-based score.pt/score_board.pt
        // path (still fully intact in read_scoreboard.py) if this ever underperforms.
        const USE_SCORE_FULLFRAME_MODEL = true;
        const SCORE_FULLFRAME_MODEL = path.join(__dirname, "..", "detection_models", "score_detection", "home_guest.pt");
        // Dedicated single-digit (0-9) classifier, replacing EasyOCR for reading a
        // digit crop's value. Verified directly against real footage: correctly
        // composed two-digit values (e.g. 20, 10) matching an already-validated
        // score progression, 100% board detection across a real test clip. Toggle
        // to false to instantly fall back to EasyOCR (still fully intact in
        // read_scoreboard.py) if this ever underperforms.
        const USE_SCORE_LED_MODEL = true;
        const SCORE_LED_MODEL = path.join(__dirname, "..", "detection_models", "score_detection", "led_read.pt");
        const MERGE_STAGE      = path.join(__dirname, "..", "detection_models", "all_three", "merge_pipeline.py");
        const RENDER_STAGE     = path.join(__dirname, "..", "detection_models", "all_three", "render_video.py");

        const frameJerseyMap     = path.join(RUNS_DIR, "frame_jersey_map.json");
        const jerseyRegistryPath = path.join(RUNS_DIR, "jersey_registry.json");
        const actionDetPath      = path.join(RUNS_DIR, "action_detections.json");
        const ballTrackPath      = path.join(RUNS_DIR, "ball_track.json");
        const rallyWindowsPath   = path.join(RUNS_DIR, "rally_windows.json");
        const scoreboardReadingsPath = path.join(RUNS_DIR, "scoreboard_readings.json");
        const volleyAnalyticsPath = path.join(RUNS_DIR, "volley_analytics.json");
        const renderedVideoPath  = path.join(RUNS_DIR, "analyzed_video.mp4");

        // Clear old output so status falls back to "none" on server restart while processing
        for (const f of [
            "rally_analysis.json", "player_stats.json", "volley_analytics.json",
            "frame_jersey_map.json", "jersey_registry.json", "action_detections.json",
            "ball_track.json", "rally_windows.json", "scoreboard_readings.json",
            "player_registry.json", "analyzed_video.mp4",
        ]) {
            const p = path.join(RUNS_DIR, f);
            if (fs.existsSync(p)) fs.unlinkSync(p);
        }
        const rallyWorkDir = path.join(RUNS_DIR, "rally_detect_work");
        if (fs.existsSync(rallyWorkDir)) fs.rmSync(rallyWorkDir, { recursive: true, force: true });
        const chunkedJerseyWorkDir = path.join(RUNS_DIR, "chunked_jersey_work");
        if (fs.existsSync(chunkedJerseyWorkDir)) fs.rmSync(chunkedJerseyWorkDir, { recursive: true, force: true });
        // Stale thumbnails here would otherwise get copied forward into every
        // new video's player_thumbs_<id>/ folder regardless of whether they
        // came from this video at all — verified directly: a leftover
        // player_thumbs/ from days earlier was still being served as "this
        // match's" player pictures in the merge UI.
        if (fs.existsSync(THUMBS_DIR)) fs.rmSync(THUMBS_DIR, { recursive: true, force: true });

        analysisJobs[id] = { status: "processing", progress: 0, error: null, proc: null };
        await Video.findByIdAndUpdate(id, { "analytics.status": "processing", "analytics.error": "" });

        const pyCmd = process.platform === "win32" ? "py" : "python3";
        const colorArg = [
            "--my-team-color", video.myTeamColor || "blue_white",
            "--opponent-color", video.opponentColor || "black_white",
        ];
        // Optional third/fourth k-means cluster for a libero's contrasting jersey —
        // without this, a libero who doesn't match the main/opponent color hint
        // falls into OPPONENT/OTHER and never gets tracked/OCR'd (see predict_pipeline.py).
        if (video.liberoColor) colorArg.push("--libero-color", video.liberoColor);
        if (video.opponentLiberoColor) colorArg.push("--opponent-libero-color", video.opponentLiberoColor);

        // Optional roster pre-registration (AddPlayers page) — if the coach entered
        // jersey numbers ahead of time, constrain OCR to only accept those numbers.
        // Empty/omitted if no roster was entered, in which case predict_pipeline.py
        // behaves exactly as before (accepts any 1-99 reading).
        const knownJerseys = (video.teamRoster?.players || [])
            .filter(p => p.teamSide === "my_team" && p.jerseyNumber && p.jerseyNumber.trim())
            .map(p => p.jerseyNumber.trim())
            .join(",");
        const rosterArg = knownJerseys ? ["--known-jerseys", knownJerseys] : [];
        const calibArg = video.calibrationJsonPath ? [
            "--calib-json",
            path.join(__dirname, "..", video.calibrationJsonPath.replace(/^\//, "")),
        ] : [];

        // Helper: mark job as failed, persist error to DB, log clearly
        const failAnalysis = async (stage, rawError) => {
            const error = `[${stage} CRASHED] ${String(rawError).slice(0, 1500)}`;
            console.error(error);
            analysisJobs[id].status = "failed";
            analysisJobs[id].error  = error;
            try {
                await Video.findByIdAndUpdate(id, {
                    "analytics.status": "failed",
                    "analytics.error":  error,
                });
            } catch {}
        };

        // Run the whole pipeline in the background; respond to the client immediately
        // (status is polled via getAnalysisStatus). No triple_detection.py in this chain —
        // it ran its own redundant player-tracking pass and reconciled it against
        // frame_jersey_map via naive per-box IoU matching with no uniqueness constraint,
        // which could label two different players with the same jersey number in one
        // frame. predict_pipeline.py's own boxes are the single source of truth here;
        // action detections get attached to them in the merge step instead.
        (async () => {
            // ── Stage 1: action detection — non-fatal on failure ─────────────
            const actionResult = await runStage(id, pyCmd, "ACTION", ACTION_STAGE, [
                "--video",  videoAbs,
                "--output", actionDetPath,
            ], 0, 25);
            if (actionResult.error) {
                console.warn(`[ACTION] action.py failed (non-fatal) — continuing without action data: ${actionResult.error}`);
            }

            // ── Stage 2: rally + ball — non-fatal on failure. Independent of
            // jersey/action (reads only the raw video), runs on CPU so it never
            // contends with them for the single GPU. If this fails or is slow to
            // set up (first run needs `uv` to resolve rally_detect's own venv),
            // the rest of the pipeline still produces jersey+action analytics
            // exactly as before — rally/ball data is a pure enhancement (dead-time
            // trimming, ball landing/scoring, mini-court overlay), never required.
            // Now also runs before JERSEY (moved up from after it) — chunked
            // jersey processing below needs rally_windows.json up front to know
            // where it's safe to cut a chunk boundary (never mid-rally).
            const rallyArgs = [
                "--video",               videoAbs,
                "--output-ball-track",   ballTrackPath,
                "--output-rally-windows", rallyWindowsPath,
                "--work-dir",            rallyWorkDir,
                "--device",              "cpu",
            ];
            if (fs.existsSync(actionDetPath)) rallyArgs.push("--action-detections", actionDetPath);
            const rallyResult = await runStage(id, pyCmd, "RALLY", RALLY_STAGE, rallyArgs, 25, 45);
            if (rallyResult.error) {
                console.warn(`[RALLY] run_rally_stage failed (non-fatal) — continuing without rally/ball data: ${rallyResult.error}`);
            }

            // ── Stage 3: jersey OCR — non-fatal on failure. Always a single
            // continuous predict_pipeline.py pass over the whole video, not
            // chunked. Chunking was originally added because ByteTrack/BOTSORT
            // quality was verified to degrade over a long continuous run, but
            // that was before jersey identity resolution became a two-pass,
            // whole-history, roster-anchored design (collect every reading,
            // resolve offline, override a wrong color guess with a
            // roster-matching jersey read) -- verified directly on this exact
            // video that the single continuous pass now gets 0% zero-detection
            // across all 15 rallies, while the chunked path's own bootstrap-
            // chaining and chunk-boundary stitching is a separate, less-tested
            // code path that produced materially worse results on the same
            // video in the same run. Simpler and better, not a compromise.
            // --skip-team-classification: player_model.pt was retrained to
            // only ever detect our own team (never opponents), so color/
            // calibration-based team separation has nothing left to do --
            // verified directly this is a clean, better result than leaving
            // it on (0% zero-detection, all 8 roster players, no risk of
            // color k-means splitting our one team's color into two
            // artificial groups). Revisit if player_model.pt ever goes back
            // to detecting both teams -- a UI toggle for this is planned,
            // hardcoded on for now.
            const jerseyResult = await runStage(id, pyCmd, "JERSEY", JERSEY_PIPELINE, [
                "--video",            videoAbs,
                "--output",           path.join(RUNS_DIR, "jersey_tracking.mp4"),
                "--frame-jersey-map", frameJerseyMap,
                "--output-json",      jerseyRegistryPath,
                "--thumbs-dir",       THUMBS_DIR,
                "--skip-team-classification",
                ...colorArg,
                ...calibArg,
                ...rosterArg,
            ], 45, 70);
            if (jerseyResult.error) {
                console.warn(`[JERSEY] jersey pipeline failed (non-fatal) — continuing without jersey map: ${jerseyResult.error}`);
            } else {
                console.log(`[JERSEY] jersey pipeline done. Jersey map: ${frameJerseyMap}`);
            }

            // ── Stage 3b: scoreboard OCR — non-fatal on failure. Independent of
            // every other stage (own two models, own crop/upscale pipeline), so it
            // can only ever add data, never break jersey/action/rally analytics.
            // When rally windows are available, this switches into rally-boundary
            // attribution mode (one point per completed rally, timed to the rally's
            // own dead-time boundaries and attributed by image comparison rather than
            // OCR vote-accumulation) — falls back to continuous-scan mode otherwise.
            const scoreArgs = [
                "--video",        videoAbs,
                "--output",       scoreboardReadingsPath,
                "--sample-every", "5",
            ];
            if (fs.existsSync(rallyWindowsPath)) scoreArgs.push("--rally-windows", rallyWindowsPath);
            if (USE_SCORE_FULLFRAME_MODEL && fs.existsSync(SCORE_FULLFRAME_MODEL)) {
                scoreArgs.push("--fullframe-model", SCORE_FULLFRAME_MODEL);
            }
            if (USE_SCORE_LED_MODEL && fs.existsSync(SCORE_LED_MODEL)) {
                scoreArgs.push("--led-model", SCORE_LED_MODEL);
            }
            const scoreResult = await runStage(id, pyCmd, "SCORE", SCORE_STAGE, scoreArgs, 70, 75);
            if (scoreResult.error) {
                console.warn(`[SCORE] read_scoreboard failed (non-fatal) — continuing without scoreboard data: ${scoreResult.error}`);
            }

            // ── Stage 4: merge — fatal on failure ────────────────────────────
            const mergeArgs = [
                "--video",           videoAbs,
                "--output",          volleyAnalyticsPath,
                "--registry-output", REGISTRY_PATH,
                ...calibArg,
            ];
            if (fs.existsSync(frameJerseyMap))     mergeArgs.push("--frame-jersey-map", frameJerseyMap);
            if (fs.existsSync(jerseyRegistryPath)) mergeArgs.push("--jersey-registry", jerseyRegistryPath);
            if (fs.existsSync(actionDetPath))      mergeArgs.push("--action-detections", actionDetPath);
            if (fs.existsSync(ballTrackPath))      mergeArgs.push("--ball-track", ballTrackPath);
            if (fs.existsSync(rallyWindowsPath))   mergeArgs.push("--rally-windows", rallyWindowsPath);

            const mergeResult = await runStage(id, pyCmd, "MERGE", MERGE_STAGE, mergeArgs, 75, 90);
            if (mergeResult.error) { await failAnalysis("merge_pipeline", mergeResult.error); return; }

            // ── Stage 5: render annotated video — non-fatal on failure ──────
            // (persistAnalysisOutputs falls back to jersey_tracking.mp4 if this is missing.
            // Dead-time trimming + mini-court/ball-trail overlay both activate automatically
            // whenever rally/ball data exists; render_video.py degrades gracefully without it.)
            const renderArgs = [
                "--video",            videoAbs,
                "--output",           renderedVideoPath,
                "--volley-analytics", volleyAnalyticsPath,
            ];
            if (fs.existsSync(frameJerseyMap))     renderArgs.push("--frame-jersey-map", frameJerseyMap);
            if (fs.existsSync(jerseyRegistryPath)) renderArgs.push("--jersey-registry", jerseyRegistryPath);
            if (fs.existsSync(ballTrackPath))      renderArgs.push("--ball-track", ballTrackPath);
            if (fs.existsSync(rallyWindowsPath))   renderArgs.push("--rally-windows", rallyWindowsPath);
            if (calibArg.length)                   renderArgs.push(...calibArg);

            const renderResult = await runStage(id, pyCmd, "RENDER", RENDER_STAGE, renderArgs, 90, 100);
            if (renderResult.error) {
                console.warn(`[RENDER] render_video.py failed (non-fatal) — falling back to jersey_tracking.mp4: ${renderResult.error}`);
            }

            let dbUpdates = {
                "analytics.status": "done",
                "analytics.error":  "",
                "analytics.lastProcessedAt": new Date(),
            };
            try {
                const persisted = await persistAnalysisOutputs(id);
                dbUpdates = { ...dbUpdates, ...persisted };
            } catch (e) { console.log("[PERSIST] failed:", e.message); }
            try { await Video.findByIdAndUpdate(id, dbUpdates); } catch {}
            analysisJobs[id].status   = "done";
            analysisJobs[id].progress = 100;
            console.log(`[ANALYSIS] Done for video ${id}.`);
        })();

        return res.json({ status: "started" });
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
}

async function getAnalysisStatus(req, res) {
    const { id } = req.params;
    const job = analysisJobs[id];
    if (!job) return res.json({ status: "none", progress: 0 });
    return res.json({ status: job.status, progress: job.progress, error: job.error });
}

// Recover a video whose triple_detection finished but jersey pipeline crashed —
// the analyzed video file already exists, so just update the DB status to "done".

// ── Generate rally_analysis.json from ball_landings in volley_analytics.json ─
//
// Rules:
//  • One score_event per rally — no double scoring from bounce / re-detection.
//  • Take the FIRST valid landing in the rally (not last) to avoid bounces.
//  • Valid = confidence >= MIN_CONF and frame >= rally.start + MIN_FRAMES_DELAY.
//  • "outside" landings resolve via last_touch_team inferred from action frames.
//  • Score is NEVER updated inside triple_detection.py — only here.
//
// Whoever serves a rally is whoever WON the previous rally — side-out scoring
// rule, not a guess. "service" actions are already detected and already
// team-attributed by the existing action+jersey merge, so this needs no new
// model or scoreboard dependency at all: rally i's server tells us rally
// (i-1)'s winner. Only the very last rally is structurally unresolvable this
// way (no next rally to observe a serve from).
function buildServiceBasedWinners(rallyWindows, frames) {
    const winners = {}; // rallyIndex -> "my_team" | "opponent"
    for (let i = 1; i < rallyWindows.length; i++) {
        const win = rallyWindows[i];
        const serve = frames
            .filter(f => f.frame >= win.start && f.frame <= win.end && f.action === "service"
                         && (f.active_player_team === "my_team" || f.active_player_team === "opponent"))
            .sort((a, b) => a.frame - b.frame)[0];
        if (serve) winners[i - 1] = serve.active_player_team;
    }
    return winners;
}

function buildRallyAnalysis(volleyAnalytics, { scoreboardData, isHomeTeam = true } = {}) {
    const landings     = volleyAnalytics.ball_landings || [];
    const frames       = volleyAnalytics.frames        || [];
    const fps          = volleyAnalytics.fps           || 30;
    const deadSegs     = volleyAnalytics.dead_segments || [];
    const rallyWins    = volleyAnalytics.rally_windows || [];
    const lastFrame    = frames.length > 0 ? frames[frames.length - 1].frame : 0;

    const MIN_CONF          = 0.25;
    const MIN_FRAMES_DELAY  = Math.round(fps * 0.5);
    const LANDING_TOLERANCE = Math.round(fps * 0.5);

    // Touch actions for last_touch_team resolution — must match action.py's
    // actual model class names exactly (see ACTION_COLORS in action.py), not
    // generic touch-type names. "serve"/"spike"/"dig"/"bump"/"defence" never
    // occur in the real data, so every filter using this set was silently
    // dropping every "service" and "defense-move" frame.
    const TOUCH_ACTIONS = new Set(["attack", "block", "service", "setting", "defense-move"]);
    const BALL_ACTIONS  = TOUCH_ACTIONS;

    // ── helpers ───────────────────────────────────────────────────────────────
    const toTimeSec = f => parseFloat((f / fps).toFixed(3));
    const toTimeStr = f => {
        const s = Math.floor(f / fps);
        return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
    };

    // lastTouchBefore — search backwards for last meaningful ball-touch action
    const actionTimeline = frames
        .filter(f => TOUCH_ACTIONS.has(f.action) && (f.active_player_team === "my_team" || f.active_player_team === "opponent"))
        .map(f => ({ frame: f.frame, team: f.active_player_team }))
        .sort((a, b) => a.frame - b.frame);

    function lastTouchBefore(frameIdx) {
        for (let i = actionTimeline.length - 1; i >= 0; i--) {
            if (actionTimeline[i].frame <= frameIdx) return actionTimeline[i].team;
        }
        return null;
    }

    // ── 1. Build rally windows — priority order ───────────────────────────────

    // Method A: rally_windows built directly by rally_detect (analyze_rally_stats)
    function buildFromRallyWindows() {
        if (rallyWins.length === 0) return [];
        return rallyWins.map(w => ({ start: w.start_frame, end: w.end_frame }));
    }

    // Method B: dead_segments → invert to get rally windows
    function buildFromDeadSegments() {
        if (deadSegs.length === 0) return [];
        const sorted = [...deadSegs].sort((a, b) => a.start_frame - b.start_frame);
        const windows = [];
        let cursor = 0;
        for (const seg of sorted) {
            if (seg.start_frame > cursor) windows.push({ start: cursor, end: seg.start_frame });
            cursor = seg.end_frame ?? seg.start_frame;
        }
        if (cursor < lastFrame) windows.push({ start: cursor, end: lastFrame });
        return windows;
    }

    // Method C: fallback — group landings by 3-second gap
    function buildFromLandingGaps() {
        if (landings.length === 0) return [];
        const GAP = Math.round(fps * 3);
        const windows = [];
        let groupStart = null, groupEnd = null;
        for (const land of [...landings].sort((a, b) => a.frame - b.frame)) {
            if (groupStart === null) { groupStart = land.frame; groupEnd = land.frame; }
            else if (land.frame - groupEnd <= GAP) { groupEnd = land.frame; }
            else {
                windows.push({ start: groupStart, end: groupEnd });
                groupStart = land.frame; groupEnd = land.frame;
            }
        }
        if (groupStart !== null) windows.push({ start: groupStart, end: groupEnd });
        return windows;
    }

    let rallyWindows = buildFromRallyWindows();
    let windowSource = "rally_detect";
    if (rallyWindows.length === 0) {
        rallyWindows = buildFromDeadSegments();
        windowSource = "dead_segments";
    }
    if (rallyWindows.length === 0) {
        rallyWindows = buildFromLandingGaps();
        windowSource = "landing_gaps";
    }

    // In landing_gaps fallback the window IS defined by the landings, skip the delay
    const effectiveDelay = windowSource === "landing_gaps" ? 0 : MIN_FRAMES_DELAY;

    // render_video.py cuts every dead-time gap out of the rendered "Processed
    // Video" the frontend actually plays back (see its --rally-windows /
    // dead-time-trimming logic, active by default whenever dead_segments
    // exist) — so that video's own currentTime runs on a *compressed* clock:
    // only the rally windows survive, back-to-back, in order. Any timestamp
    // handed to the frontend for comparison against that currentTime (rally
    // boundaries, actions, score events) has to be expressed on that same
    // compressed clock, not the original recording's frame/fps time —
    // otherwise it drifts out of sync by however much dead time was cut
    // before it, and once it exceeds the trimmed video's own (much shorter)
    // total duration it becomes permanently unreachable during playback.
    // Verified directly: a scoreboard-confirmed point sitting in a dead-time
    // gap (its frame is *never included* in the trimmed video at all) had a
    // raw time_sec past the trimmed video's total length, so the live score
    // overlay could never reach it and stayed frozen at an earlier tally for
    // the rest of playback even though the final aggregate was correct.
    const trimActive = deadSegs.length > 0;
    const trimmedStartSec = [];
    let cumulativeTrimmedSec = 0;
    for (const win of rallyWindows) {
        trimmedStartSec.push(cumulativeTrimmedSec);
        cumulativeTrimmedSec += (win.end - win.start) / fps;
    }
    function toTrimmedTimeSec(frame) {
        if (!trimActive) return toTimeSec(frame);
        for (let idx = 0; idx < rallyWindows.length; idx++) {
            const win = rallyWindows[idx];
            if (frame <= win.end) {
                const clamped = Math.max(frame, win.start);
                return parseFloat((trimmedStartSec[idx] + (clamped - win.start) / fps).toFixed(3));
            }
        }
        return parseFloat(cumulativeTrimmedSec.toFixed(3)); // past the last rally — anchor to the trimmed video's end
    }
    // A frame inside a dead-time gap has no corresponding moment in the
    // rendered video at all -- render_video.py cuts those frames out
    // entirely (see its own dead-time-trimming logic). toTrimmedTimeSec's
    // clamp exists to place a rally-boundary frame at the right spot on the
    // trimmed clock, but for a frame that's genuinely mid-dead-time it just
    // silently snaps to whichever rally window comes next, collapsing
    // every action detected during that entire gap onto the same borrowed
    // timestamp -- verified directly against real output: six actions
    // spanning 450+ original frames (defense-move, two services, another
    // defense-move, a block, another defense-move) all displayed at the
    // identical "00:32", each with no corresponding action actually visible
    // there. Use this to drop those before they're ever displayed, rather
    // than let them borrow a misleading timestamp.
    function inAnyRallyWindow(frame) {
        return rallyWindows.some(w => frame >= w.start && frame <= w.end);
    }
    function toTrimmedTimeStr(frame) {
        const s = Math.floor(toTrimmedTimeSec(frame));
        return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
    }

    // ── 2. Score events ────────────────────────────────────────────────────────
    // Prefer the scoreboard OCR reading when available — it's ground truth off
    // the physical board rather than an inference from where the ball landed,
    // so it takes over entirely rather than being blended with the heuristic.
    // Falls back to the original ball-landing-per-rally logic exactly as before
    // when the scoreboard stage didn't run or never confirmed anything (same
    // non-fatal, additive pattern as every other optional stage in this pipeline).
    let usScore = 0, oppScore = 0;
    let scoreEvents = [];
    let scoreSource = "ball_landing";
    const rallyMeta = [];

    const scoreboardChanges = (scoreboardData?.score_changes || [])
        .filter(c => c.field === "home_points" || c.field === "guest_points")
        .sort((a, b) => a.frame - b.frame);

    // Rally groups the scoreboard stage couldn't resolve on its own — it runs
    // before this merge step, so it has no action/team data (see
    // read_scoreboard.py's run_rally_attribution). It confirmed via OCR that
    // the run split one point to each team, just not which rally is whose.
    // Resolve using each rally's last recorded action: a team's own attack
    // landing is the most common way a rally actually ends in that team's
    // favor. Not certain (an attack can still be dug/blocked), but a
    // reasonable signal — falls back to a deterministic chronological split
    // if the heuristic's guesses don't add up to the OCR-confirmed totals.
    const resolvedAmbiguous = [];
    for (const group of (scoreboardData?.ambiguous_groups || [])) {
        const usDelta  = isHomeTeam ? group.home_points_delta : group.guest_points_delta;
        const oppDelta = isHomeTeam ? group.guest_points_delta : group.home_points_delta;

        const guesses = group.rally_indices.map(idx => {
            const win = rallyWindows[idx];
            if (!win) return { idx, win: null, team: "opponent" };
            const lastAction = frames
                .filter(f => f.frame >= win.start && f.frame <= win.end && f.action && f.action !== "none"
                             && (f.active_player_team === "my_team" || f.active_player_team === "opponent"))
                .sort((a, b) => a.frame - b.frame)
                .pop();
            const team = (lastAction && lastAction.action === "attack" && lastAction.active_player_team === "my_team")
                ? "my_team" : "opponent";
            return { idx, win, team };
        });

        const guessedUs = guesses.filter(g => g.team === "my_team").length;
        const matches = guessedUs === usDelta && (guesses.length - guessedUs) === oppDelta;

        guesses.forEach((g, i) => {
            const team = matches ? g.team : (i < usDelta ? "my_team" : "opponent");
            if (g.win) resolvedAmbiguous.push({ frame: g.win.end, team, ambiguous: true, rally_index: g.idx });
        });
    }

    const scoreTimeline = [
        ...scoreboardChanges.map(c => ({
            frame: c.frame,
            team: (c.field === "home_points") === isHomeTeam ? "my_team" : "opponent",
        })),
        ...resolvedAmbiguous,
    ].sort((a, b) => a.frame - b.frame);

    // rally_events (rally_attribution mode only) already carries the rally_index
    // read_scoreboard.py resolved each confirmed change to — it can legitimately
    // land several seconds after the rally's own end (a scoreboard operator
    // updating late), which is exactly why gap_reference_frame_after samples
    // deep into the gap rather than right at the rally boundary. Matching by
    // that already-resolved rally_index avoids re-deriving attribution from raw
    // frame position against LANDING_TOLERANCE (~0.5s, sized for ball landings,
    // not for a delayed board update), which was silently dropping confirmed
    // scoreboard reads whenever the operator lagged more than half a second.
    const scoreByRallyIndex = new Map();
    for (const ev of (scoreboardData?.rally_events || [])) {
        if (!ev.field) continue; // inconclusive rally, no direct confirmation
        scoreByRallyIndex.set(ev.rally_index, {
            frame: ev.frame,
            team: (ev.field === "home_points") === isHomeTeam ? "my_team" : "opponent",
            ambiguous: false,
        });
    }
    for (const resolved of resolvedAmbiguous) {
        scoreByRallyIndex.set(resolved.rally_index, { frame: resolved.frame, team: resolved.team, ambiguous: true });
    }

    // Rallies where the board's value-delta shows *some* change but not a
    // clean, isolated +1 on one field (a noisy read, both fields moving a
    // little, a jump >1) — read_scoreboard.py already flags these as
    // inconclusive (field: null) rather than guessing which field changed.
    // Bring in service detection here specifically as a tiebreaker: whoever
    // serves next actually won the previous rally, by rule, which is a much
    // narrower and safer question than "what does this crop say" once we
    // already know from the board that *something* happened. Only integer
    // value-deltas count here (led_model mode) — the older float image-diff
    // scores are never exactly zero even when nothing changed, so treating
    // "nonzero" as a signal there would misfire on every single rally.
    const ambiguousChangeRallyIndices = new Set();
    // Rallies where the board explicitly confirmed a zero-zero diff — not
    // "we have no reading here" but "we checked and nothing changed". Found
    // via real footage: a rally_detect boundary glitch produced a ~2s window
    // that was really just a player walking to the service line, sandwiched
    // between two real rallies. The board correctly reported diffs:{0,0} for
    // it, but service-detection (a rule-based fallback that assumes every
    // rally window is real) doesn't know that and will happily invent a point
    // from whoever serves the next window — silently turning a correct "no
    // score change" read into a wrong one. Any rally in this set is fully
    // void: no fallback may score it, and none of its actions count (see
    // uses below) — it isn't a real point of play, not just an unconfirmed one.
    const confirmedNoChangeRallyIndices = new Set();
    for (const ev of (scoreboardData?.rally_events || [])) {
        if (ev.field || !ev.diffs) continue; // already directly confirmed, or no diff data at all
        const { home_points: h, guest_points: g } = ev.diffs;
        const isIntegerDelta = Number.isInteger(h) && Number.isInteger(g);
        if (isIntegerDelta && (h !== 0 || g !== 0)) {
            ambiguousChangeRallyIndices.add(ev.rally_index);
        } else if (isIntegerDelta && h === 0 && g === 0) {
            confirmedNoChangeRallyIndices.add(ev.rally_index);
        }
    }

    // Per-rally cascading fallback — try the most reliable source first, and
    // only fall through to the next for whichever *specific* rallies the
    // stronger source couldn't resolve, rather than picking one source for
    // the whole match. A missed serve detection (e.g. the server was out of
    // frame) shouldn't throw away an otherwise-good signal for every other
    // rally — it should just mean that ONE rally falls through to the next
    // available source instead.
    //   1. Service-detection — tied to an actual game rule, no visual
    //      board/landing dependency at all.
    //   2. Scoreboard OCR — direct confirmed changes + last-action-resolved
    //      ambiguous groups.
    //   3. Ball-landing + court-calibration heuristic — the original method.
    const serviceWinners = buildServiceBasedWinners(rallyWindows, frames);
    const sourceCounts = { service_detection: 0, scoreboard_ocr: 0, ball_landing: 0, unknown: 0 };

    for (let idx = 0; idx < rallyWindows.length; idx++) {
        const win     = rallyWindows[idx];
        const rallyId = idx + 1;
        let scoring = null;
        let result  = "unknown";
        let landingUsed = null;
        // See confirmedNoChangeRallyIndices above — a board-confirmed zero-zero
        // diff overrides both fallbacks below; a direct scoreboard_ocr match is
        // still allowed to win if one genuinely lands inside this window, since
        // that would be stronger, more specific evidence than the diff read.
        const voided = confirmedNoChangeRallyIndices.has(idx);

        // Scoreboard OCR goes first now: it's tied to actual on-court state
        // and, since the gap-bias fix + burst-sampling work, has proven
        // reliable on its own. Service-detection used to be tried first, but
        // was found to occasionally add wrong points that a correct
        // scoreboard read would have gotten right — so it's now a fallback,
        // used only for whichever specific rallies scoreboard OCR couldn't
        // resolve (e.g. the opponent served and the board wasn't legible in
        // that gap — opponent serves have no jersey/team data to fall back
        // on at all, so scoreboard is the only signal available there).
        const sbPoint = scoreByRallyIndex.get(idx) || scoreTimeline.find(p =>
            p.frame >= win.start + effectiveDelay && p.frame <= win.end + LANDING_TOLERANCE);
        if (sbPoint) {
            const isUs = sbPoint.team === "my_team";
            if (isUs) usScore++; else oppScore++;
            scoring = {
                type: sbPoint.ambiguous ? "scoreboard_ocr_ambiguous_resolved" : "scoreboard_ocr",
                rally_id: rallyId, frame: sbPoint.frame, time_sec: toTrimmedTimeSec(sbPoint.frame),
                us: usScore, opp: oppScore, scoring_team: sbPoint.team,
            };
            result = isUs ? "point_my_team" : "point_opponent";
            sourceCounts.scoreboard_ocr++;
        }

        // The board showed *some* change this rally but couldn't be read
        // cleanly enough to confirm which field — use who served next to
        // settle it. This is still fundamentally scoreboard-driven (the
        // board is what told us a point happened at all); service detection
        // is only the tiebreaker for "which team", not an independent guess
        // about whether a point happened in the first place — so it's
        // preferred over the plain service-detection fallback below.
        const serviceTeam = serviceWinners[idx];
        if (!scoring && !voided && ambiguousChangeRallyIndices.has(idx) && serviceTeam) {
            const isUs = serviceTeam === "my_team";
            if (isUs) usScore++; else oppScore++;
            scoring = {
                type: "scoreboard_ambiguous_service_resolved", rally_id: rallyId,
                frame: win.end, time_sec: toTrimmedTimeSec(win.end),
                us: usScore, opp: oppScore, scoring_team: serviceTeam,
            };
            result = isUs ? "point_my_team" : "point_opponent";
            sourceCounts.service_detection++;
        }

        if (!scoring && !voided && serviceTeam) {
            const isUs = serviceTeam === "my_team";
            if (isUs) usScore++; else oppScore++;
            scoring = {
                type: "service_detection", rally_id: rallyId,
                frame: win.end, time_sec: toTrimmedTimeSec(win.end),
                us: usScore, opp: oppScore, scoring_team: serviceTeam,
            };
            result = isUs ? "point_my_team" : "point_opponent";
            sourceCounts.service_detection++;
        }

        if (!scoring && !voided) {
            // A rally can bounce/dig the ball near the ground many times before
            // it actually ends (a deep dig, a low set, a defensive save) — only
            // the *last* landing in the window is the shot that actually ended
            // the rally. Verified directly against real footage: one rally's
            // window had 12 separate landing events across its ~20 seconds, and
            // picking the first (as this used to) grabbed an early mid-rally dig
            // instead of the actual point-ending landing — coincidentally same
            // side that one time, but nothing guarantees that in general.
            const validLandings = landings
                .filter(l =>
                    l.frame >= win.start + effectiveDelay &&
                    l.frame <= win.end + LANDING_TOLERANCE &&
                    (l.confidence == null || l.confidence >= MIN_CONF)
                )
                .sort((a, b) => a.frame - b.frame);

            if (validLandings.length > 0) {
                const land = validLandings[validLandings.length - 1];
                landingUsed = land;

                if (land.landed_side === "unknown") {
                    scoring = {
                        rally_id: rallyId, type: "no_calibration",
                        frame: land.frame, time_sec: toTrimmedTimeSec(land.frame),
                        us: usScore, opp: oppScore,
                        landed_side: "unknown", court_position: null, scoring_team: "unknown",
                    };

                } else if (land.landed_side === "opponent") {
                    usScore++;
                    result  = "point_my_team";
                    scoring = {
                        rally_id: rallyId, type: "ball_landing",
                        frame: land.frame, time_sec: toTrimmedTimeSec(land.frame),
                        us: usScore, opp: oppScore,
                        landed_side: "opponent", court_position: land.court_position || null,
                        scoring_team: "my_team",
                    };

                } else if (land.landed_side === "my_team") {
                    oppScore++;
                    result  = "point_opponent";
                    scoring = {
                        rally_id: rallyId, type: "ball_landing",
                        frame: land.frame, time_sec: toTrimmedTimeSec(land.frame),
                        us: usScore, opp: oppScore,
                        landed_side: "my_team", court_position: land.court_position || null,
                        scoring_team: "opponent",
                    };

                } else {
                    // outside — resolve by last touch
                    result = "outside";
                    const lastTeam = land.last_touch_team || lastTouchBefore(land.frame);
                    if (lastTeam === "my_team") {
                        oppScore++;
                        scoring = {
                            rally_id: rallyId, type: "ball_out",
                            frame: land.frame, time_sec: toTrimmedTimeSec(land.frame),
                            us: usScore, opp: oppScore,
                            landed_side: "outside", court_position: land.court_position || null,
                            scoring_team: "opponent", last_touch_team: lastTeam,
                        };
                    } else if (lastTeam === "opponent") {
                        usScore++;
                        scoring = {
                            rally_id: rallyId, type: "ball_out",
                            frame: land.frame, time_sec: toTrimmedTimeSec(land.frame),
                            us: usScore, opp: oppScore,
                            landed_side: "outside", court_position: land.court_position || null,
                            scoring_team: "my_team", last_touch_team: lastTeam,
                        };
                    } else {
                        scoring = {
                            rally_id: rallyId, type: "unknown_out",
                            frame: land.frame, time_sec: toTrimmedTimeSec(land.frame),
                            us: usScore, opp: oppScore,
                            landed_side: "outside", court_position: land.court_position || null,
                            scoring_team: "unknown",
                        };
                    }
                }
                sourceCounts.ball_landing++;
            }
        }

        if (!scoring) sourceCounts.unknown++;
        if (scoring) scoreEvents.push(scoring);
        rallyMeta.push({ win, rallyId, result, landing: landingUsed, scoreEvent: scoring, voided });
    }

    // Informational summary of which source actually resolved how many
    // rallies — the dominant one, for the single existing score_source field.
    scoreSource = Object.entries(sourceCounts).sort((a, b) => b[1] - a[1])[0][0];

    // ── Fold fragmented rally windows back together ───────────────────────────
    // rally_detect can split one continuous rally into two adjacent windows —
    // a brief mid-rally tracking gap, not a real dead gap — and the board
    // naturally hasn't changed yet at the first window's own boundary, since
    // the point hasn't been decided there, so it reads as a confirmed
    // zero-zero diff and gets voided even though real touches happened inside
    // it. Verified directly against real footage: a voided window had 68
    // real action-labeled frames (services, digs, attacks, blocks across 5
    // players) immediately followed by a short window carrying the actual
    // scoring result and zero detected actions of its own — clearly one
    // rally split in two, not an empty "walking to the service line" gap
    // (the case this void logic was originally built for, and still
    // correctly leaves alone since it has ~no action-labeled frames). Detect
    // that specific pattern and fold the void window's frames into the next
    // rally instead of discarding them as if nothing happened. Walking
    // backwards so a chain of several fragments in a row folds all the way
    // into the eventual resolved rally, not just its immediate neighbor.
    const MIN_VOID_ACTION_FRAMES = 10;
    for (let i = rallyMeta.length - 2; i >= 0; i--) {
        const cur = rallyMeta[i];
        if (!cur.voided) continue;
        const next = rallyMeta[i + 1];
        if (next.result === "unknown") continue; // nothing resolved yet to fold into
        const activeFrames = frames.filter(f => f.frame >= cur.win.start && f.frame <= cur.win.end
                                                  && TOUCH_ACTIONS.has(f.action)).length;
        if (activeFrames < MIN_VOID_ACTION_FRAMES) continue;
        next.win = { start: cur.win.start, end: next.win.end };
        rallyMeta.splice(i, 1);
    }
    rallyMeta.forEach((rm, idx) => { rm.rallyId = idx + 1; }); // renumber to close any gap left by a fold

    // A void window that never got folded above (its neighbor is itself
    // unresolved, or — verified against real footage — it's the very last
    // rally in a clip that was cut off before the point concluded and the
    // scoreboard ever got a chance to confirm it) still deserves its real
    // touches counted rather than dropped. Leave `result` at its "unknown"
    // default instead of guessing a winner — every consumer already treats
    // "unknown" as "don't count this rally's outcome" (see
    // classifyRallyOutcome's final `return null`), so this only recovers the
    // action log and per-player attempt counts, never a fabricated point.
    for (const rm of rallyMeta) {
        if (!rm.voided) continue;
        const activeFrames = frames.filter(f => f.frame >= rm.win.start && f.frame <= rm.win.end
                                                  && TOUCH_ACTIONS.has(f.action)).length;
        if (activeFrames >= MIN_VOID_ACTION_FRAMES) rm.voided = false;
    }

    // ── 3. Flat action list ───────────────────────────────────────────────────
    // The per-frame action detector flickers within a single real action (e.g.
    // one serve fires "service" for a few frames, drops to "none", fires again
    // a second later) and, separately, a contested play near the net (a double
    // block) can have the IoU-based attribution flip between two players almost
    // every frame. Both turn one real action into a dozen fake list entries if
    // taken literally frame-by-frame. So: group by action type within a
    // MAX_GAP_FRAMES tolerance (~1.5s — long enough to bridge both flicker and a
    // brief re-occurrence of the same action, short enough not to fuse two
    // genuinely separate plays). A run's attribution is either one dominant
    // player (flicker noise around a single real actor — e.g. one player almost
    // always wins the IoU, with a rare stray frame elsewhere) or a real split
    // between two players who were both legitimately near the play the whole
    // time (e.g. a double block, both jumping together at the net) — verified
    // against real data: one such run split 20/16 frames between two players,
    // and picking only the top vote-getter silently erased the other's block.
    // So credit every player who accounts for a substantial share of the run,
    // not just the single top vote-getter.
    const MAX_GAP_FRAMES = Math.round(fps * 1.5);
    const CO_PARTICIPANT_MIN_SHARE = 0.3;

    const allActions     = [];
    const round3 = n => Math.round(n * 1000) / 1000;
    const pushRun = (run) => {
        const total = [...run.playerVotes.values()].reduce((s, c) => s + c, 0);
        const participants = [...run.playerVotes.entries()]
            .sort((a, b) => b[1] - a[1])
            .filter(([, count]) => count / total >= CO_PARTICIPANT_MIN_SHARE)
            .map(([player]) => player);
        // Pick whichever label the model was most confident about on
        // average, not just whichever had more supporting frames — a label
        // that only won on frame count can still be the wrong one if the
        // model was consistently unsure about it and consistently sure
        // about the alternative.
        const winningAction = [...run.actionVotes.keys()]
            .map(action => [action, run.actionConfSum.get(action) / run.actionVotes.get(action)])
            .sort((a, b) => b[1] - a[1])[0];
        allActions.push({
            frame:         run.startFrame,
            time_sec:      toTrimmedTimeSec(run.startFrame),
            time_str:      toTrimmedTimeStr(run.startFrame),
            action:        winningAction[0],
            action_label:  winningAction[0],
            confidence:    round3(winningAction[1]),
            // Closest the eventual "active player" actually got to the ball
            // during this run — a real touch happens right where the ball
            // is, so this is what lets a later pass tell a genuine actor
            // apart from a bystander who was mis-attributed the action.
            dist_to_ball:  run.minDistToBall,
            result:        "unknown",
            player_label:  participants.length ? participants.map(p => `#${p}`).join(" & ") : "?",
            player_jersey: participants[0] ?? null,
            co_players:    participants.length > 1 ? participants : undefined,
        });
    };
    let run = null; // { startFrame, lastFrame, playerVotes: Map, actionVotes: Map, actionConfSum: Map, minDistToBall }
    for (const f of frames) {
        if (!f.action || f.action === "none") continue;
        if (!BALL_ACTIONS.has(f.action)) continue;
        if (trimActive && !inAnyRallyWindow(f.frame)) continue;
        const playerKey = f.active_player_jersey ?? f.active_player_id ?? null;
        const conf = f.action_confidence ?? 0;
        const dist = typeof f.distance_to_ball === "number" ? f.distance_to_ball : null;
        const sameRun = run && run.actionVotes.has(f.action) && f.frame - run.lastFrame <= MAX_GAP_FRAMES;
        if (sameRun) {
            run.lastFrame = f.frame;
            run.playerVotes.set(playerKey, (run.playerVotes.get(playerKey) || 0) + 1);
            run.actionVotes.set(f.action, (run.actionVotes.get(f.action) || 0) + 1);
            run.actionConfSum.set(f.action, (run.actionConfSum.get(f.action) || 0) + conf);
            if (dist !== null && (run.minDistToBall === null || dist < run.minDistToBall)) run.minDistToBall = dist;
        } else {
            if (run) pushRun(run);
            run = {
                startFrame: f.frame, lastFrame: f.frame,
                playerVotes: new Map([[playerKey, 1]]),
                actionVotes: new Map([[f.action, 1]]),
                actionConfSum: new Map([[f.action, conf]]),
                minDistToBall: dist,
            };
        }
    }
    if (run) pushRun(run);

    // A rally can only legitimately start with one serve — verified against
    // real footage that a single genuine serve can still produce multiple
    // separate "service" runs in one rally (the model drops to "none" for
    // longer than MAX_GAP_FRAMES mid-motion — e.g. toss, then contact, then
    // follow-through — each re-triggering as its own run instead of being
    // bridged into the first). Keep only one "service" per rally — whichever
    // the model was most confident about, not just whichever came first —
    // any others in the same rally are the same real serve, not repeats.
    // Scoped off rallyMeta (not the raw rallyWindows list it was built from)
    // so this can never disagree with the window each rally is finally
    // displayed with.
    for (const rm of rallyMeta) {
        const servesInRally = allActions
            .filter(a => a.action === "service" && a.frame >= rm.win.start && a.frame <= rm.win.end);
        if (servesInRally.length <= 1) continue;
        const best = servesInRally.reduce((a, b) => (b.confidence ?? 0) > (a.confidence ?? 0) ? b : a);
        for (const extra of servesInRally) {
            if (extra === best) continue;
            const idx = allActions.indexOf(extra);
            if (idx !== -1) allActions.splice(idx, 1);
        }
    }

    // ── Compress immediately-repeated short action patterns ────────────────
    // The same action on the same player can still be re-detected after a
    // gap too long to bridge into one run, or a short multi-action exchange
    // (e.g. "attack #13, defense #2") can get logged twice back-to-back —
    // same players, same actions, same order — which is one real exchange
    // re-triggered, not two. Detect a 1-3 event window that immediately
    // repeats (same player + same action per position) within
    // PATTERN_REPEAT_MAX_GAP of itself and drop the repeat. Kept
    // order-sensitive and gap-limited so two genuinely separate exchanges
    // later in a long rally are never collapsed — only a near-immediate
    // literal repeat is.
    const PATTERN_REPEAT_MAX_GAP = Math.round(fps * 3);
    const sameActionEvent = (a, b) => a.player_jersey === b.player_jersey && a.action === b.action;
    const avgConfidence = block => block.reduce((s, ev) => s + (ev.confidence ?? 0), 0) / block.length;
    for (let i = 0; i < allActions.length; ) {
        let collapsed = false;
        for (const L of [3, 2, 1]) {
            if (i + 2 * L > allActions.length) continue;
            const first  = allActions.slice(i, i + L);
            const repeat = allActions.slice(i + L, i + 2 * L);
            if (!first.every((ev, k) => sameActionEvent(ev, repeat[k]))) continue;
            if (repeat[0].frame - first[first.length - 1].frame > PATTERN_REPEAT_MAX_GAP) continue;
            // Keep whichever occurrence the model was more confident about,
            // not just whichever happened first.
            if (avgConfidence(repeat) > avgConfidence(first)) {
                allActions.splice(i, L);
            } else {
                allActions.splice(i + L, L);
            }
            collapsed = true;
            break;
        }
        if (!collapsed) i++;
    }

    // ── Collapse one real touch fragmented across several different players ──
    // Only one player is ever actually making a given touch at a real
    // instant — a defensive scramble (several players clustered near the
    // ball) is the noisiest case for both signals this pipeline leans on:
    // ball-proximity swings between several close-together players, and a
    // stray different label sneaking in for a frame or two ends a run
    // early. One real defensive play can fragment into several short runs
    // that each land on a *different* player, all within about the same
    // instant — verified directly against real output: one real scramble
    // produced three separate "defense-move" entries covering five
    // different players, all at the same displayed second. Cluster
    // same-action entries within BURST_WINDOW of each other
    // regardless of player, and keep only the one whose recorded
    // distance-to-ball was smallest — syncing the action to the ball's
    // actual recorded position, the same idea already used to sync actions
    // to players in merge_pipeline.py — tie-breaking on confidence when
    // distance is unknown or equal. Trade-off worth knowing: a genuinely
    // separate second real touch that happens to land inside the same
    // window (e.g. a dig that's immediately re-touched by a different
    // player) will also get collapsed to one; tighten BURST_WINDOW if that
    // turns out to matter more than the fragmentation noise it's fixing.
    const BURST_WINDOW = Math.round(fps * 2);
    for (let i = 0; i < allActions.length; ) {
        let j = i + 1;
        while (
            j < allActions.length &&
            allActions[j - 1].action === allActions[j].action &&
            allActions[j].frame - allActions[j - 1].frame <= BURST_WINDOW
        ) j++;
        if (j - i > 1) {
            const cluster = allActions.slice(i, j);
            const best = cluster.reduce((a, b) => {
                const da = a.dist_to_ball ?? Infinity, db = b.dist_to_ball ?? Infinity;
                if (da !== db) return db < da ? b : a;
                return (b.confidence ?? 0) > (a.confidence ?? 0) ? b : a;
            });
            allActions.splice(i, j - i, best);
        }
        i++;
    }

    // ── Same player flip-flopping between different action labels ──────────
    // Two genuinely separate touches by the same player almost never land
    // this close together — a real sequence needs the ball to leave and come
    // back. Adjacent same-player entries with different labels within
    // FLIP_WINDOW of each other are one real touch the action model was
    // unsure about mid-motion, not several — keep whichever label it was
    // more confident about. Exception: "block" immediately followed by
    // "defense-move" for the same player is the one case that's genuinely
    // common (a deflected block scrambled back by the same player) — treat
    // it as the defensive touch regardless of confidence, not a clean block.
    // Runs pairwise so a longer flip-flopping burst (verified against real
    // output: one player logged setting/defense-move/setting/attack across
    // four entries in under a second) collapses down to one entry instead of
    // just its adjacent pairs.
    const FLIP_WINDOW = MAX_GAP_FRAMES;
    for (let i = 0; i < allActions.length - 1; ) {
        const cur = allActions[i], next = allActions[i + 1];
        if (cur.player_jersey == null || cur.player_jersey !== next.player_jersey
            || cur.action === next.action
            || next.frame - cur.frame > FLIP_WINDOW) {
            i++;
            continue;
        }
        if (cur.action === "block" && next.action === "defense-move") {
            allActions.splice(i, 2, next);
        } else {
            const winner = (next.confidence ?? 0) > (cur.confidence ?? 0) ? next : cur;
            allActions.splice(i, 2, winner);
        }
        // Don't advance — the merged entry may still flip-flop with its new neighbor.
    }

    // For a lost rally, identifies which of our players was most likely
    // responsible for failing to stop/return the point-winning play — tiered
    // fallback since the action model doesn't classify every real defensive
    // attempt (a dive/fall/mistimed contact often shows no recognized action
    // at all): prefer the last frame with an actual classified action by our
    // team, falling back to the last frame where our team simply has the
    // ball-proximity "active player" (computed independently of action
    // classification, see merge_pipeline.py), so a player clearly in the play
    // who didn't register a clean action still gets surfaced instead of
    // showing up as "no data".
    function findResponsiblePlayer(win, team) {
        const inWindow = frames.filter(f => f.frame >= win.start && f.frame <= win.end
                                              && f.active_player_team === team);
        const withAction = inWindow.filter(f => f.action && f.action !== "none");
        if (withAction.length > 0) {
            const last = withAction[withAction.length - 1];
            return { jersey: last.active_player_jersey, action: last.action, source: "action" };
        }
        if (inWindow.length > 0) {
            const last = inWindow[inWindow.length - 1];
            return { jersey: last.active_player_jersey, action: null, source: "ball_proximity" };
        }
        return null;
    }

    // Classifies how a rally was actually decided — kill / error / ace / etc.
    // We deliberately never look at the opponent's action detections: their
    // players aren't jersey-tracked and their action attribution isn't trusted,
    // so every category here is derived from OUR team's actions only. When we
    // win with no qualifying action from us, that's scored as an inferred
    // opponent error (by elimination, not detection) — same idea in reverse
    // for a loss with no action from us (inferred opponent kill).
    //
    // The attack/block check only looks at the final END_WINDOW_SEC of the
    // rally rather than literally the last action row: the action model
    // sometimes fires extra confused detections (e.g. follow-through read as
    // "setting" or "defense-move") in the moments right after the real
    // scoring attack, so "last row" can point at noise instead of the actual
    // finishing hit. Scanning a short end window filters out stale early-rally
    // actions — but real footage also showed a genuine, sustained sequence of
    // TWO real events inside that same window (our attack got dug back, then
    // we blocked their comeback attempt, then lost anyway) — so within the
    // window we only let "attack" and "block" compete (the two real finishing
    // actions; "setting"/"defense-move" are prep/non-decisive and never
    // override them), and whichever of the two happened LAST wins, since a
    // later real action is a better proxy for the actual point-ending touch
    // than an earlier one, however "attack" is treated by default.
    const END_WINDOW_SEC = 2.5;
    // Tried using ball-trajectory direction reversal as a signal here (the
    // physical signature of a real second touch) — reverted. It produced a
    // false positive: a ball's natural parabolic arc, as seen through an
    // angled camera, can look like an X-direction reversal on its own with
    // no contact involved, and the reversal in the real noise case (jersey
    // 42, frame 674->691) happened to fall mid-arc, before the phantom
    // "block" label even started. Tested end-to-end and it stopped fixing
    // the bug it was meant to fix. Not abandoning the idea — it may still
    // work with a stricter check (e.g. requiring the reversal to land
    // tightly on the transition frame itself, not just somewhere in a
    // several-frame window) — but that needs more real examples before
    // trusting it again, so back to the simpler heuristic below for now.
    //
    // Distrusts a type-switch from the SAME player unless enough time has
    // passed for it to be a genuine second touch — a same-player switch
    // faster than this is physically implausible (land, recover, reposition
    // takes longer). A different player performing the next action is
    // trusted immediately regardless of how little time passed (a
    // deflection immediately dug by a teammate can be genuinely fast).
    const MIN_SAME_PLAYER_TRANSITION_FRAMES = Math.round(fps * 1.0);
    function pickFinisher(candidates) {
        if (!candidates.length) return null;
        let winner = candidates[0];
        for (const c of candidates) {
            if (c.action === winner.action) {
                // Within MAX_GAP_FRAMES this is the same continuing touch as
                // far as the rest of this file is concerned (it's the exact
                // threshold allActions/pushRun already uses to bridge one
                // real action's flickering frames) — so, same as pushRun
                // already does via confidence-weighted voting, trust
                // whichever frame the model was more confident about, not
                // just whichever is one frame later. Verified against real
                // output: rally 10 had a real defense-move at 0.79
                // confidence, then 8 straight "none" frames, then an
                // isolated single-frame defense-move at 0.36 confidence from
                // a completely different player only 9 frames later — well
                // inside the bridging window — that overrode the real touch
                // and handed the rally's whole loss-reason credit to the
                // wrong player. Once frames are far enough apart to be a
                // genuinely separate, later touch (beyond MAX_GAP_FRAMES),
                // recency wins regardless of confidence, same as before.
                const withinSameRun = c.frame - winner.frame <= MAX_GAP_FRAMES;
                if (withinSameRun && (c.action_confidence ?? 0) < (winner.action_confidence ?? 0)) {
                    continue;
                }
                winner = c;
                continue;
            }
            const samePlayer = c.active_player_jersey === winner.active_player_jersey;
            if (samePlayer && (c.frame - winner.frame) < MIN_SAME_PLAYER_TRANSITION_FRAMES) continue;
            winner = c;
        }
        return winner;
    }

    function classifyRallyOutcome(win, result, servingTeam, rallyActions = []) {
        const windowStart = Math.max(win.start, win.end - Math.round(fps * END_WINDOW_SEC));
        const finishers = frames.filter(f => f.frame >= windowStart && f.frame <= win.end
                                               && f.active_player_team === "my_team"
                                               && (f.action === "attack" || f.action === "block"));
        const lastFinisher = pickFinisher(finishers);

        // Whether we served this rally comes from the side-out chain
        // (deriveServingTeams below), not a raw "did the action model detect
        // a service action" check — that detection fires for only a handful
        // of rallies in a full match and can never fire at all for the
        // opponent's serve (predict_pipeline.py doesn't track them), so it's
        // far too sparse to gate ace/service_error on by itself.
        const weServed = servingTeam === "my_team";
        const anyOtherOurAction = frames.some(f => f.frame >= win.start && f.frame <= win.end
                                                     && f.active_player_team === "my_team"
                                                     && f.action && f.action !== "none" && f.action !== "service");

        if (result === "point_my_team") {
            if (lastFinisher) {
                return lastFinisher.action === "attack"
                    ? { category: "kill", jersey: lastFinisher.active_player_jersey, action: "attack", source: "action", frame: lastFinisher.frame }
                    : { category: "block_kill", jersey: lastFinisher.active_player_jersey, action: "block", source: "action", frame: lastFinisher.frame };
            }
            if (weServed && !anyOtherOurAction) {
                const jersey = resolveServerJersey(win);
                return { category: "ace", jersey, action: "service", source: jersey != null ? "action" : "inferred", frame: win.start };
            }
            // lastFinisher only looks at the final END_WINDOW_SEC (2.5s) of
            // raw frames — a real attack or block can sit further back than
            // that if the rally window runs on a bit longer after it
            // (trailing dead air before the window's official end), which
            // drops it out of that search entirely and falls through to
            // "opponent_error" despite a real finishing touch being exactly
            // why we won. Verified against real output: rally with a block at
            // #13&10 202 frames (3.4s) before window end, followed only by an
            // unrelated defense-move — wrongly credited as an opponent error
            // with no player attached. Fall back to the rally's own last-two
            // compressed actions (no fixed time window, whatever the model
            // actually logged last) and credit whichever of attack/block is
            // found there before giving up and calling it an opponent error.
            // If both show up in the last two (an attack and a block, in
            // either order), trust whichever one the model was more
            // confident about rather than just picking the more recent —
            // recency alone can't tell a real finishing touch from a stray
            // trailing misclassification.
            const recentFinishers = rallyActions.slice(-2).filter(a => a.action === "attack" || a.action === "block");
            if (recentFinishers.length > 0) {
                const finisher = recentFinishers.reduce((a, b) => (b.confidence ?? 0) > (a.confidence ?? 0) ? b : a);
                return finisher.action === "attack"
                    ? { category: "kill", jersey: finisher.player_jersey, action: "attack", source: "action", frame: finisher.frame }
                    : { category: "block_kill", jersey: finisher.player_jersey, action: "block", source: "action", frame: finisher.frame };
            }
            return { category: "opponent_error", jersey: null, action: null, source: "inferred", frame: win.end };
        }

        if (result === "point_opponent") {
            if (weServed && !anyOtherOurAction) {
                const jersey = resolveServerJersey(win);
                return { category: "service_error", jersey, action: "service", source: jersey != null ? "action" : "inferred", frame: win.start };
            }
            // Unlike the win branch above, a lost rally's real final touch can
            // legitimately be a defense-move or a setting — a block can be
            // immediately followed by a failed dig that's the actual last thing
            // that happened, and crediting the earlier block instead (as an
            // attack/block-only search does) blames the wrong player. Verified
            // against real footage: a block at frame 3320 was being credited
            // over a real, later defense-move at frame 3324 that was the
            // rally's true final touch. So all four of our action types compete
            // here on recency, and only the type of whichever is genuinely last
            // determines the category.
            const lastTouch = pickFinisher(frames.filter(f => f.frame >= windowStart && f.frame <= win.end
                                                   && f.active_player_team === "my_team"
                                                   && (f.action === "attack" || f.action === "block"
                                                       || f.action === "defense-move" || f.action === "setting")));
            if (lastTouch) {
                if (lastTouch.action === "attack") return { category: "attack_error", jersey: lastTouch.active_player_jersey, action: "attack", source: "action", frame: lastTouch.frame };
                if (lastTouch.action === "block") return { category: "block_error", jersey: lastTouch.active_player_jersey, action: "block", source: "action", frame: lastTouch.frame };
                if (lastTouch.action === "defense-move") return { category: "defense_attempt", jersey: lastTouch.active_player_jersey, action: "defense-move", source: "action", frame: lastTouch.frame };
                // A set with no attack following it (in a rally we lost) means
                // the set itself was the fault — e.g. shanked over the net or
                // a fault — since a good set would normally be followed by a
                // detected attack.
                return { category: "set_error", jersey: lastTouch.active_player_jersey, action: "setting", source: "action", frame: lastTouch.frame };
            }
            // Same gap as the win branch above: lastTouch only looks at the
            // final END_WINDOW_SEC (2.5s) of raw frames, and a real touch can
            // sit further back than that if the rally window runs on a bit
            // longer after it. Verified against real output: rally with a
            // block at 0.80 confidence and a defense-move at 0.79
            // confidence, both roughly 10s before window end — neither
            // within reach of lastTouch — wrongly landed on the blank
            // "opponent_kill" (no player blamed) despite two real touches
            // sitting right there. Fall back to the rally's own last-two
            // compressed actions and trust whichever of
            // attack/block/defense-move/setting the model was more
            // confident about, same tiebreak idea as the win branch.
            const recentTouch = rallyActions.slice(-2)
                .filter(a => a.action === "attack" || a.action === "block"
                              || a.action === "defense-move" || a.action === "setting")
                .reduce((best, a) => (best == null || (a.confidence ?? 0) > (best.confidence ?? 0)) ? a : best, null);
            if (recentTouch) {
                if (recentTouch.action === "attack") return { category: "attack_error", jersey: recentTouch.player_jersey, action: "attack", source: "action", frame: recentTouch.frame };
                if (recentTouch.action === "block") return { category: "block_error", jersey: recentTouch.player_jersey, action: "block", source: "action", frame: recentTouch.frame };
                if (recentTouch.action === "defense-move") return { category: "defense_attempt", jersey: recentTouch.player_jersey, action: "defense-move", source: "action", frame: recentTouch.frame };
                return { category: "set_error", jersey: recentTouch.player_jersey, action: "setting", source: "action", frame: recentTouch.frame };
            }
            return { category: "opponent_kill", jersey: null, action: null, source: "inferred", frame: win.end };
        }

        return null;
    }

    // Which team served each rally — side-out scoring means whoever WON a
    // rally serves the next one, a hard game rule rather than a guess. This
    // is the only reliable way to know who served: the action model can
    // detect a "service" action for AT MOST ~3 rallies in a full match (see
    // real match verification, video 6a5668a6f0d3c15a183d2011 — 19 rallies,
    // 3 detected serves total) and can NEVER detect the opponent's serve at
    // all, since predict_pipeline.py only ever tracks our own team. Without
    // this, "no detected service" is ambiguous between "opponent served" and
    // "we served but the model missed it" — this resolves that ambiguity
    // structurally instead of leaning on a rarely-firing detection.
    //
    // Re-anchors on any rally where the action model DID detect one of our
    // own players serving (only ever fires for us, so it's direct evidence,
    // stronger than the inferred chain) — this stops one "unknown" result
    // from poisoning every rally after it; the chain just resumes from the
    // next confirmed point. A void rally (no real point played) doesn't
    // change who's serving.
    function deriveServingTeams(rallyList) {
        const serving = new Array(rallyList.length).fill(null);
        let nextServerFromChain = null;
        for (let i = 0; i < rallyList.length; i++) {
            const r = rallyList[i];
            const detectedServe = (r.actions || []).some(a => a.action === "service" && a.player_jersey != null);
            const fromChainOrDetection = detectedServe ? "my_team" : nextServerFromChain;

            if (r.void_rally) {
                serving[i] = fromChainOrDetection;
                continue; // no real point played -- server carries over unchanged
            }
            serving[i] = fromChainOrDetection;
            nextServerFromChain =
                r.result === "point_my_team" ? "my_team" :
                r.result === "point_opponent" ? "opponent" :
                null; // this rally's winner is unresolved -- chain breaks until the next detected serve re-anchors it
        }
        return serving;
    }

    // Who actually served, once we know the TEAM served (from
    // deriveServingTeams above) — only when directly action-detected. A
    // ball-proximity fallback used to credit whichever of our players was
    // nearest the ball in the rally's opening beat, on the theory that
    // proximity is available even when the serve motion itself was never
    // labeled — but proximity-to-ball at the start of a rally isn't the same
    // signal as "who tossed and struck the ball" (e.g. a receiving-side
    // player can be the nearest-tracked my_team player during the opponent's
    // toss). Verified against real output: it credited a serve to a player
    // who never served. Every caller already treats a null return as "server
    // unknown" and simply skips the per-player credit rather than crediting
    // team-level stats to nobody, so leaving a rally's server uncredited here
    // is strictly better than guessing wrong.
    function resolveServerJersey(win) {
        const detected = allActions.find(a => a.action === "service" && a.frame >= win.start && a.frame <= win.end
                                                && a.player_jersey != null);
        return detected ? detected.player_jersey : null;
    }

    // ── 4. Attach actions to rallies ──────────────────────────────────────────
    // Two passes: first each rally's own window/result/actions/void status
    // (independent of who served), then deriveServingTeams over the FULL
    // sequence (the side-out chain needs every rally's result up front), and
    // only then classifyRallyOutcome/findResponsiblePlayer — both of which
    // now depend on serving_team for ace/service_error detection.
    const rallyBase = rallyMeta.map((rm, idx) => {
        // A board-confirmed zero-zero diff means this window wasn't a real
        // point of play (see confirmedNoChangeRallyIndices) — its actions are
        // noise (e.g. a player's post-serve follow-through misread as a
        // defensive touch), not real events, so they're dropped entirely
        // rather than polluting the action feed or player stats. Read off
        // rm.voided (set when rallyMeta was built) rather than recomputing
        // via confirmedNoChangeRallyIndices.has(idx) — the fold-fragmented-
        // windows pass above can remove entries from rallyMeta, so idx here
        // no longer necessarily matches the original rallyWindows position.
        const voided = rm.voided;
        return {
            rally_id:    rm.rallyId,
            start_frame: rm.win.start,
            end_frame:   rm.win.end,
            start_sec:   toTrimmedTimeSec(rm.win.start),
            end_sec:     toTrimmedTimeSec(rm.win.end),
            result:      rm.result,
            score_event: rm.scoreEvent || null,
            actions:     voided ? [] : allActions.filter(a => a.frame >= rm.win.start && a.frame <= rm.win.end),
            void_rally:  voided,
        };
    });

    const servingTeams = deriveServingTeams(rallyBase);

    const rallies = rallyBase.map((rb, idx) => {
        const win = { start: rb.start_frame, end: rb.end_frame };
        const servingTeam = servingTeams[idx];
        return {
            ...rb,
            serving_team: servingTeam,
            defensive_player: rb.result === "point_opponent" ? findResponsiblePlayer(win, "my_team") : null,
            point_outcome: classifyRallyOutcome(win, rb.result, servingTeam, rb.actions),
        };
    });

    // Per-player stat sheet, shaped to match what MatchStatistics.jsx already
    // renders (Attack: K/E/TA/ATK%, Serve: SA/SE/TA/PCT/EFF, Block: BK/BA/BE,
    // Defence: DS/DE, Set: AST/TA/SE). TA (total attempts) counts every real
    // attack/serve/block/setting/defense-move by our team, not just the
    // rally-ending ones — run-bridged with the same MAX_GAP_FRAMES tolerance
    // as allActions so per-frame flicker isn't counted as multiple attempts,
    // but computed directly from `frames` (not allActions) and restricted to
    // my_team only, since allActions doesn't carry a team tag and opponent
    // action/team attribution isn't trusted (see classifyRallyOutcome above —
    // same reasoning applies here). K/E/SA/SE/BK/BE/DE/SE come from
    // point_outcome, the subset of attempts that actually decided a rally.
    // DS (defensive save) is everything else: a dig only "fails" if it was
    // the rally's actual last touch and we lost it (that's DE) — every other
    // dig kept the ball alive, so DS = TA - DE. Receive is intentionally never
    // populated — there's no reception class in the model, and knowing when
    // the ball *first* crossed to our side would require trusting opponent
    // detections, which we don't. Set's quality-grade columns (3/2/1/0, RTG)
    // are left absent for the same reason: no shot-quality signal exists.
    // Finds the compressed action event (from a rally's own r.actions list,
    // built earlier with independent confidence-based run merging) that
    // corresponds to a raw single-frame pick from classifyRallyOutcome.
    // The two use different frame-numbering (po.frame is one specific raw
    // frame; ev.frame is a compressed run's *start* frame), so they're
    // matched by closest frame distance within the rally, not equality.
    function findMatchingAction(rallyActions, actionType, targetFrame) {
        let best = null, bestDist = Infinity;
        for (const ev of rallyActions) {
            if (ev.action !== actionType) continue;
            const d = Math.abs(ev.frame - targetFrame);
            if (d < bestDist) { bestDist = d; best = ev; }
        }
        return best;
    }

    function buildPlayerStats(rallies) {
        const players = {};
        const ensure = jersey => {
            if (!players[jersey]) {
                players[jersey] = {
                    attack:  { K: 0, E: 0, TA: 0 },
                    serve:   { SA: 0, SE: 0, TA: 0, RW: 0 },
                    block:   { BK: 0, BE: 0, BT: 0, TA: 0 },
                    defence: { DS: 0, DE: 0, TA: 0 },
                    set:     { AST: 0, SE: 0, TA: 0 },
                    total_events: 0,
                };
            }
            return players[jersey];
        };

        // Every count below (TA, DS/DE, BK/BA/BE) is sourced from each
        // rally's own r.actions -- the confidence-scored, gap-bridged,
        // pattern-deduped compressed event list already built earlier in
        // this function -- never from a separate raw-frame pass. Two
        // independent event representations for the same stat WILL drift:
        // verified directly, a raw-frame run-bridging pass here previously
        // produced a higher defence.TA than DS+DE could ever add up to,
        // because that pass wasn't scoped to real rally windows the way
        // r.actions already is (a dead-time touch can appear in a whole-
        // video raw-frame scan but never makes it into any rally's
        // r.actions, per the dead-time-drop fix above). One canonical
        // source per rally fixes that structurally instead of chasing every
        // place the two could disagree.
        for (const r of rallies) {
            if (r.void_rally) continue;
            const po = r.point_outcome;

            // Cross-referenced once per rally, reused below. po.frame is one
            // specific raw frame (from classifyRallyOutcome, which scans raw
            // `frames`); r.actions entries are compressed runs keyed by
            // their *start* frame, so these are matched by closest frame
            // distance within the rally, not exact equality (see
            // findMatchingAction).
            const blockFinish = po?.frame != null && (po.category === "block_kill" || po.category === "block_error")
                ? findMatchingAction(r.actions, "block", po.frame)
                : null;
            const defenceLoss = po?.category === "defense_attempt" && po.frame != null
                ? findMatchingAction(r.actions, "defense-move", po.frame)
                : null;

            for (const ev of r.actions) {
                const jersey = ev.player_jersey;
                if (ev.action === "attack") {
                    if (jersey != null) ensure(jersey).attack.TA++;
                } else if (ev.action === "block") {
                    // Raw touch count only -- BK/BE (the official box-score
                    // block credit) go to the primary jersey alone, decided
                    // below via blockFinish. Every real participant (primary
                    // + co_players) still gets their touch counted here,
                    // though -- co_players lost box-score credit when BA was
                    // removed (the joint-block signal wasn't trustworthy
                    // enough to split kill/error credit on), but they were
                    // still really there, and dropping them from TA/BT
                    // entirely would make a real touch vanish from their
                    // stats altogether, not just lose its credit. A touch
                    // that isn't the rally's decisive one is neither a stuff
                    // nor an error -- there's no ball-proximity signal to say
                    // whether it actually helped, so it's counted as a
                    // neutral touch (BT) rather than guessed into BK/BE.
                    const touchedPlayers = [...new Set([jersey, ...(ev.co_players || [])].filter(j => j != null))];
                    for (const p of touchedPlayers) {
                        ensure(p).block.TA++;
                        if (ev !== blockFinish) ensure(p).block.BT++;
                    }
                } else if (ev.action === "defense-move") {
                    if (jersey == null) continue;
                    ensure(jersey).defence.TA++;
                    if (ev === defenceLoss) ensure(jersey).defence.DE++;
                    else                    ensure(jersey).defence.DS++;
                } else if (ev.action === "setting") {
                    if (jersey != null) ensure(jersey).set.TA++;
                }
            }

            // Blocks: only the rally's final, decisive block earns BK/BE.
            // co_players used to trigger a full "Block Assist" for 2+
            // participants, but verified against real output: every single
            // block detected across four real matches showed exactly 2
            // co-participants — never 1, never 3+ — which isn't a believable
            // real-world rate of joint blocks. That's the ball-proximity
            // vote-share signal picking up whichever second player was
            // merely standing near the blocker at net, not confirming an
            // actual shared touch. But that same vote-share signal is also
            // what picks the single "primary" jersey — not trustworthy
            // enough to award a clean 100% to one player and 0% to the
            // other when a block did come back with 2+ participants, so
            // it's split evenly across whoever showed up instead of handed
            // entirely to whichever one got marginally more of the vote.
            if (blockFinish) {
                const participants = [...new Set(
                    [blockFinish.player_jersey, ...(blockFinish.co_players || [])].filter(j => j != null)
                )];
                if (participants.length > 0) {
                    const share = 1 / participants.length;
                    for (const p of participants) {
                        if (po.category === "block_kill") ensure(p).block.BK += share;
                        else ensure(p).block.BE += share;
                    }
                }
            } else if (po && po.jersey != null && (po.category === "block_kill" || po.category === "block_error")) {
                // classifyRallyOutcome named a block finisher but no
                // matching compressed event was found (shouldn't normally
                // happen) — credit solo rather than silently drop it.
                if (po.category === "block_kill") ensure(po.jersey).block.BK++;
                else ensure(po.jersey).block.BE++;
            }
        }

        // Serve TA/RW -- side-out chain decides WHETHER we served this
        // rally at all (far more complete than requiring a detected
        // "service" action, which the model fires for only a small fraction
        // of real serves); resolveServerJersey decides WHICH player.
        for (const r of rallies) {
            if (r.void_rally) continue;
            if (r.serving_team !== "my_team") continue;
            const jersey = resolveServerJersey({ start: r.start_frame, end: r.end_frame });
            if (jersey != null) {
                const p = ensure(jersey);
                p.serve.TA++;
                // Rally won on this player's serve — broader than an ace (SA):
                // credits the serve for every point won during the rally it
                // started, however many touches it took to get there.
                if (r.result === "point_my_team") p.serve.RW++;
            }
        }

        // Point-ending credit for everything except block (handled above):
        // K/E/SA/SE/set-SE, plus assist linkage to the preceding set. A lost
        // rally's final dig (defense_attempt) is already credited as a DE
        // in the per-event loop above, so it's deliberately not repeated
        // here.
        for (const r of rallies) {
            const po = r.point_outcome;
            if (!po || po.jersey == null) continue;
            if (po.category === "block_kill" || po.category === "block_error") continue;

            const p = ensure(po.jersey);
            if      (po.category === "kill")          p.attack.K++;
            else if (po.category === "attack_error")  p.attack.E++;
            else if (po.category === "ace")           p.serve.SA++;
            else if (po.category === "service_error") p.serve.SE++;
            else if (po.category === "set_error")     p.set.SE++;

            if (po.category === "kill" && po.frame != null) {
                // Excludes the scorer's own jersey: a stray single-frame
                // "setting" mislabel right before a player's own attack (arm
                // windup misclassified) otherwise outranks the real setter's
                // earlier, genuine set — verified directly against real
                // output, where jersey #13 had one raw frame self-labeled
                // "setting" one frame before their own kill, starving #10 (the
                // actual setter, several frames earlier) of the assist.
                const setter = frames.filter(f => f.frame >= r.start_frame && f.frame < po.frame
                                                    && f.active_player_team === "my_team" && f.action === "setting"
                                                    && f.active_player_jersey !== po.jersey)
                                      .pop();
                let setterJersey = setter?.active_player_jersey ?? null;
                // Fallback: the raw-frame search above requires a DIFFERENT
                // player's set somewhere in the whole rally — if that finds
                // nothing, fall back to the rally's own last-two compressed
                // actions before the point (same no-fixed-window idea as the
                // kill/block_kill fallback above). This one does NOT exclude
                // the scorer's own jersey — a self-set immediately before a
                // self-kill is unusual but real, and when it's the only
                // setting touch logged anywhere in the rally, crediting it is
                // better than leaving a real assist blank.
                if (setterJersey == null) {
                    const recentSet = [...r.actions.filter(a => a.frame < po.frame).slice(-2)]
                        .reverse().find(a => a.action === "setting");
                    if (recentSet) setterJersey = recentSet.player_jersey;
                }
                if (setterJersey != null) ensure(setterJersey).set.AST++;
            }
        }

        for (const jersey of Object.keys(players)) {
            const p = players[jersey];
            p.attack["ATK%"]  = p.attack.TA > 0  ? (p.attack.K - p.attack.E) / p.attack.TA : null;
            p.serve.PCT       = p.serve.TA > 0   ? (p.serve.TA - p.serve.SE) / p.serve.TA  : null;
            p.serve.EFF       = p.serve.TA > 0   ? (p.serve.SA - p.serve.SE) / p.serve.TA  : null;
            p.defence["DS%"]  = p.defence.TA > 0 ? p.defence.DS / p.defence.TA : null;
            // BK/BE can be fractional (a 3-way joint block splits 1/3 each) --
            // round for clean display before anything downstream reads them.
            p.block.BK = Math.round(p.block.BK * 100) / 100;
            p.block.BE = Math.round(p.block.BE * 100) / 100;
            // BT deliberately excluded from both sides of this ratio -- a
            // touch that neither scored nor errored can't be verified as
            // having helped, so it shouldn't inflate or deflate the rate.
            const blockDecisive = p.block.BK + p.block.BE;
            p.block["WIN%"]   = blockDecisive > 0 ? p.block.BK / blockDecisive : null;
            p.total_events    = p.attack.TA + p.serve.TA + p.block.TA + p.defence.TA + p.set.TA;
        }
        return players;
    }
    const playerStats = buildPlayerStats(rallies);

    return {
        rallies,
        all_actions:    allActions,
        score_events:   scoreEvents,
        total_rallies:  rallyMeta.length,
        total_won:      usScore,
        total_lost:     oppScore,
        us_score:       usScore,
        opponent_score: oppScore,
        window_source:  windowSource,
        score_source:   scoreSource,
        score_sources_breakdown: sourceCounts,
        player_stats:   playerStats,
    };
}

// Flattens rallyData.rallies into one row per action (rally_id, action, player,
// rally winner) — a stats-ready table, not something the UI renders. Written to
// disk (and logged) after every run so the numbers behind rally_analysis_<id>.json
// are easy to pull into a spreadsheet/notebook without re-deriving them.
const RALLY_WINNER_LABELS = {
    point_my_team: "us",
    point_opponent: "opponent",
    outside: "outside",
    unknown: "unknown",
};

function buildRallyActionTable(rallyData) {
    const rows = [];
    for (const rally of rallyData.rallies) {
        const winner = RALLY_WINNER_LABELS[rally.result] ?? rally.result;
        const po = rally.point_outcome ?? null;

        // point_outcome.frame is a raw last-touch frame from the per-frame feed,
        // while each action row's `frame` is the *start* frame of its bridged
        // run (see allActions/pushRun above) — the two numbering schemes never
        // line up, so match on (action type, jersey) instead and take the last
        // such row, which is the actual finishing touch. The jersey can also
        // show up only as a co-participant (e.g. a shared dig/block credited
        // to a co_players entry rather than the run's primary jersey), so check
        // both.
        let decisiveIdx = -1;
        if (po && po.action != null) {
            for (let i = rally.actions.length - 1; i >= 0; i--) {
                const a = rally.actions[i];
                const jerseyMatches = (a.player_jersey ?? null) === (po.jersey ?? null)
                    || (a.co_players ?? []).includes(po.jersey);
                if (a.action === po.action && jerseyMatches) {
                    decisiveIdx = i;
                    break;
                }
            }
        }

        rally.actions.forEach((a, i) => {
            rows.push({
                rally_id:      rally.rally_id,
                frame:         a.frame,
                time_sec:      a.time_sec,
                action:        a.action,
                player_jersey: a.player_jersey ?? null,
                player_label:  a.player_label ?? null,
                co_players:    a.co_players ?? [],
                serving_team:  rally.serving_team ?? null,
                rally_winner:  winner,
                decisive:      i === decisiveIdx,
                point_outcome: i === decisiveIdx ? po.category : null,
            });
        });

        // point_outcome categories like ace/opponent_error/opponent_kill have
        // no matching per-frame action row (there was nothing to detect — a
        // clean serve winner, or a fault with no our-team touch at all) — add
        // a synthetic row so the decisive cause of the rally is never silently
        // dropped from the table.
        if (po && decisiveIdx === -1) {
            rows.push({
                rally_id:      rally.rally_id,
                frame:         po.frame ?? null,
                time_sec:      null,
                action:        po.action ?? null,
                player_jersey: po.jersey ?? null,
                player_label:  po.jersey != null ? `#${po.jersey}` : null,
                co_players:    [],
                serving_team:  rally.serving_team ?? null,
                rally_winner:  winner,
                decisive:      true,
                point_outcome: po.category,
            });
        }
    }
    return rows;
}

function rallyActionTableToCsv(rows) {
    const cols = [
        "rally_id", "frame", "time_sec", "action", "player_jersey", "player_label",
        "co_players", "serving_team", "rally_winner", "decisive", "point_outcome",
    ];
    const esc = (v) => {
        if (v === null || v === undefined) return "";
        const s = Array.isArray(v) ? v.join(";") : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.join(",")];
    for (const row of rows) lines.push(cols.map((c) => esc(row[c])).join(","));
    return lines.join("\n");
}

async function recoverAnalysis(req, res) {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid video id" });
        }
        const video = await Video.findOne({ _id: id, userId: req.user.id });
        if (!video) return res.status(404).json({ message: "Video not found" });

        const uploadsDir = path.join(__dirname, "..", "uploads");
        const analyzedPath = path.join(uploadsDir, `analyzed_${id}.mp4`);

        if (!fs.existsSync(analyzedPath)) {
            return res.status(404).json({ message: "No analyzed video found — please re-run the analysis." });
        }

        const dbUpdates = {
            "analytics.status": "done",
            "analytics.error":  "",
            "analytics.lastProcessedAt": new Date(),
            analyzedVideoPath: `/uploads/analyzed_${id}.mp4`,
        };

        // Restore any other files that were already persisted
        const statsPath = path.join(uploadsDir, `player_stats_${id}.json`);
        if (fs.existsSync(statsPath)) dbUpdates.playerStatsPath = `/uploads/player_stats_${id}.json`;

        const registryPath = path.join(uploadsDir, `player_registry_${id}.json`);
        if (fs.existsSync(registryPath)) dbUpdates.playerRegistryPath = `/uploads/player_registry_${id}.json`;

        const rallyPath = path.join(uploadsDir, `rally_analysis_${id}.json`);
        if (fs.existsSync(rallyPath)) dbUpdates.rallyAnalysisPath = `/uploads/rally_analysis_${id}.json`;

        const analyticsPath = path.join(uploadsDir, `volley_analytics_${id}.json`);
        if (fs.existsSync(analyticsPath)) dbUpdates.analyticsJsonPath = `/uploads/volley_analytics_${id}.json`;

        await Video.findByIdAndUpdate(id, dbUpdates);
        console.log(`[RECOVER] Video ${id} recovered to done.`);
        return res.json({ message: "Recovered successfully." });
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
}

async function stopAnalysis(req, res) {
    const { id } = req.params;
    const job = analysisJobs[id];
    if (!job || job.status !== "processing") {
        return res.status(400).json({ message: "No active job for this video" });
    }

    res.json({ message: "Stopping — please wait up to 15 seconds..." });

    // On Windows taskkill sends a soft terminate; on Unix use SIGINT
    if (job.proc) {
        if (process.platform === "win32") {
            spawn("taskkill", ["/pid", String(job.proc.pid), "/t"]);
        } else {
            job.proc.kill("SIGINT");
        }
    }

    // Wait for the process to actually close (writer.release() runs inside Python)
    await new Promise(resolve => {
        if (!job.proc) return resolve();
        job.proc.once("close", resolve);
        setTimeout(resolve, 15000); // max 15 sec fallback
    });

    let dbUpdates = { "analytics.status": "done", "analytics.error": "", "analytics.lastProcessedAt": new Date() };
    try {
        const persisted = await persistAnalysisOutputs(id);
        dbUpdates = { ...dbUpdates, ...persisted };
    } catch (e) { console.log("[PERSIST] failed:", e.message); }

    try { await Video.findByIdAndUpdate(id, dbUpdates); } catch {}
    analysisJobs[id].status   = "done";
    analysisJobs[id].progress = 100;
}

async function getRallyAnalysis(req, res) {
    try {
        const { id } = req.params;
        let rallyPath = RALLY_PATH;

        if (id && id !== "latest") {
            if (!mongoose.Types.ObjectId.isValid(id)) {
                return res.status(400).json({ message: "Invalid video id" });
            }
            const video = await Video.findOne({ _id: id, userId: req.user.id });
            if (!video) return res.status(404).json({ message: "Video not found" });
            if (video.rallyAnalysisPath) {
                rallyPath = path.join(__dirname, "..", video.rallyAnalysisPath.replace(/^\//, ""));
            }
        }

        if (!fs.existsSync(rallyPath)) return res.status(404).json({ message: "No rally data yet. Run the model and recalculate." });
        const data = JSON.parse(fs.readFileSync(rallyPath, "utf8"));
        return res.json(data);
    } catch (err) {
        return res.status(500).json({ message: "Error reading rally data", error: err.message });
    }
}

const AI_RECOMMENDATION_SCHEMA = {
    type: "object",
    properties: {
        overview: {
            type: "string",
            description: "2-3 sentence overall summary of how the team performed this match.",
        },
        key_points: {
            type: "array",
            items: { type: "string" },
            description: "3-5 short, specific, notable stats or patterns from this match (each one sentence).",
        },
        recommendations: {
            type: "array",
            minItems: 2,
            maxItems: 3,
            items: {
                type: "object",
                properties: {
                    title: { type: "string", description: "Short recommendation title" },
                    issue: { type: "string", description: "The specific stat/pattern this addresses" },
                    action: { type: "string", description: "Concrete drill or action to take" },
                },
                required: ["title", "issue", "action"],
            },
            description: "Exactly 2-3 of the most impactful recommendations — do not pad with minor ones.",
        },
    },
    required: ["overview", "key_points", "recommendations"],
};

function buildAiRecommendationPrompt(rallyData, jerseyPositions = {}) {
    const summary = {
        final_score: { us: rallyData.us_score, opponent: rallyData.opponent_score },
        total_rallies: rallyData.total_rallies,
        rallies_won: rallyData.total_won,
        rallies_lost: rallyData.total_lost,
        // Only jerseys with a coach-entered position show up here — a player
        // left blank on the roster is simply absent from this map, never
        // sent as null/unknown, so the model has no basis to guess one.
        ...(Object.keys(jerseyPositions).length > 0 ? { player_positions: jerseyPositions } : {}),
        rallies: (rallyData.rallies || []).map((r) => ({
            rally_id: r.rally_id,
            result: r.result,
            duration_sec: r.end_sec != null && r.start_sec != null ? +(r.end_sec - r.start_sec).toFixed(1) : null,
            point_outcome_category: r.point_outcome?.category || null,
            scoring_player_jersey: r.point_outcome?.jersey || null,
        })),
    };

    return `You are a volleyball coach analyst. This data tracks ONLY our own team — there is no data on individual opponent players, so never refer to a specific jersey number as belonging to the opponent.

Field meanings:
- "result": "point_my_team" means our team scored; "point_opponent" means the opponent scored (i.e. we lost the rally).
- "scoring_player_jersey": always one of OUR players. On a rally we won, it's the player who scored (kill, block kill, ace). On a rally we lost, it's the one of OUR players most responsible for the error (block error, defensive miss) — not an opponent.
- "point_outcome_category": ace/kill/block_kill = we won the point; block_error/service_error/defense_attempt = how we lost the point.
- "player_positions" (may be absent entirely): maps a jersey number to their position (libero/setter/hitter/blocker), but only for players the coach has actually entered a position for. When present, weigh your analysis by position-appropriate expectations — e.g. a low kill count is normal for a libero but worth flagging for a hitter; judge a setter primarily on sets/assists, not blocks. For any jersey NOT listed in "player_positions", their position is simply unknown — do not guess or assume one, and do not mention position for that player at all.

Analyze this match's rally-by-rally stats and return your findings.

Match stats (JSON):
${JSON.stringify(summary)}`;
}

async function getAiRecommendation(req, res) {
    try {
        const { id } = req.params;
        let rallyPath = RALLY_PATH;
        let video = null;

        if (id && id !== "latest") {
            if (!mongoose.Types.ObjectId.isValid(id)) {
                return res.status(400).json({ message: "Invalid video id" });
            }
            video = await Video.findOne({ _id: id, userId: req.user.id });
            if (!video) return res.status(404).json({ message: "Video not found" });
            if (video.rallyAnalysisPath) {
                rallyPath = path.join(__dirname, "..", video.rallyAnalysisPath.replace(/^\//, ""));
            }
        }

        if (!fs.existsSync(rallyPath)) return res.status(404).json({ message: "No rally data yet. Run the model and recalculate." });

        if (!process.env.GEMINI_API_KEY) {
            return res.status(500).json({ message: "AI recommendations are not configured (missing GEMINI_API_KEY)." });
        }

        const rallyData = JSON.parse(fs.readFileSync(rallyPath, "utf8"));
        if (!rallyData.rallies || rallyData.rallies.length === 0) {
            return res.status(404).json({ message: "No rally data yet. Run the model and recalculate." });
        }

        // Only jerseys with a coach-entered, non-blank position — TeamRosterPlayerSchema
        // defaults position to "", which must never be forwarded as if it were a real value.
        const jerseyPositions = {};
        for (const p of video?.teamRoster?.players || []) {
            if (p.jerseyNumber && p.position) jerseyPositions[String(p.jerseyNumber)] = p.position;
        }

        const prompt = buildAiRecommendationPrompt(rallyData, jerseyPositions);
        const model = "gemini-flash-latest";
        const geminiRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        responseMimeType: "application/json",
                        responseSchema: AI_RECOMMENDATION_SCHEMA,
                    },
                }),
            }
        );

        const geminiData = await geminiRes.json();
        if (!geminiRes.ok) {
            return res.status(502).json({ message: "AI recommendation request failed", error: geminiData?.error?.message });
        }

        const text = geminiData.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "{}";
        const recommendation = JSON.parse(text);
        return res.json(recommendation);
    } catch (err) {
        return res.status(500).json({ message: "Error generating AI recommendation", error: err.message });
    }
}

module.exports = {
    uploadFile,
    addYoutube,
    listVideos,
    updateTeamNames,
    getVideoById,
    startCleanFrame,
    startPlayerDetection,
    getTeamRoster,
    createRosterPlayer,
    setRosterPlayerPosition,
    deleteRosterPlayer,
    importMyTeam,
    getPlayerRegistryForVideo,
    mergePlayerRegistry,
    deletePlayerRegistryEntries,
    assignDetectionsToPlayer,
    resetPlayerDetection,
    analyzeRallies,
    getVideoAnalysis,
    analyzeBall,
    getBallAnalysis,
    getPlayerStats,
    getPlayerRegistry,
    getRallyAnalysis,
    getAiRecommendation,
    startAnalysis,
    getAnalysisStatus,
    recoverAnalysis,
    saveJerseys,
    stopAnalysis,
    deleteVideo,
};