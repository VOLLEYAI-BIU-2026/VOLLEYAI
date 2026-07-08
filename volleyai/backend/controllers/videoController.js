
const mongoose = require("mongoose");
const path = require("path");
const { spawn } = require("child_process");
const Video = require("../models/Video");
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
            .select("_id originalFileName fileName status playerDetection analytics analyzedVideoPath teamA teamB createdAt sourceType filePath cleanFramePath");
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
        const { teamA, teamB } = req.body;
        const video = await Video.findOneAndUpdate(
            { _id: id, userId: req.user.id },
            { $set: { teamA: teamA ?? "", teamB: teamB ?? "" } },
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
        const { manualName, jerseyNumber, teamSide } = req.body;

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

        // Use whichever file is newer — saveAndRecalculate updates runs/ but not the per-video copy
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

async function updatePlayerRegistry(req, res) {
    try {
        if (!fs.existsSync(REGISTRY_PATH)) return res.status(404).json({ message: "Registry not found" });
        const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
        const updates = req.body;

        for (const [bid, jersey] of Object.entries(updates)) {
            if (registry[bid]) {
                registry[bid].jersey = jersey === "" ? null : Number(jersey);
                registry[bid].confirmed = jersey !== "" && jersey !== null;
            }
        }
        fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 4));
        return res.status(200).json({ status: "ok" });
    } catch (err) {
        return res.status(500).json({ message: "Server error", error: err.message });
    }
}

async function saveAndRecalculate(req, res) {
    try {
        if (!fs.existsSync(REGISTRY_PATH)) return res.status(404).json({ message: "Registry not found" });
        const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
        const updates = req.body;

        for (const [bid, jersey] of Object.entries(updates)) {
            if (registry[bid]) {
                registry[bid].jersey = jersey === "" ? null : Number(jersey);
                registry[bid].confirmed = jersey !== "" && jersey !== null;
            }
        }
        fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 4));
        return res.status(200).json({ status: "ok" });
    } catch (err) {
        return res.status(500).json({ message: "Server error", error: err.message });
    }
}

// In-memory job tracking: videoId → { status, progress, error }
const analysisJobs = {};

const RUNS_DIR    = path.join(__dirname, "..", "detection_models", "all_three", "runs");

const TEAM_COLOR_PRESETS = new Set([
    // White base
    "white_blue", "white_navy", "white_red", "white_green", "white_black",
    // Blue / Navy
    "blue_white", "blue_gold", "blue_black", "blue_red",
    "navy_white", "navy_gold", "navy_yellow",
    // Red / Maroon
    "red_white", "red_black", "red_gold",
    "maroon_white", "maroon_gold",
    // Black
    "black_white", "black_red", "black_yellow", "black_gold",
    "black_blue", "black_green", "black_orange", "black_purple",
    // Yellow
    "yellow_white", "yellow_black", "yellow_blue",
    // Green
    "green_white", "green_black",
    // Orange
    "orange_white", "orange_black",
    // Purple
    "purple_white", "purple_gold", "purple_black",
    // Gray
    "gray_white", "gray_black",
    // Solid
    "all_black", "all_white",
]);

async function saveJerseys(req, res) {
    try {
        const { id } = req.params;
        // Accept either {players:[{jersey,name}]} (legacy) or {myTeamColor,opponentColor} (current)
        const { players, jerseys, myTeamColor, opponentColor } = req.body;
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
        if (myTeamColor && TEAM_COLOR_PRESETS.has(myTeamColor)) {
            update.myTeamColor = myTeamColor;
        }
        if (opponentColor && TEAM_COLOR_PRESETS.has(opponentColor) && opponentColor !== update.myTeamColor) {
            update.opponentColor = opponentColor;
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

    // Generate rally_analysis.json from ball_landings in volley_analytics.json
    const srcAnalyticsForRally = path.join(uploadsDir, `volley_analytics_${id}.json`);
    if (fs.existsSync(srcAnalyticsForRally)) {
        try {
            const volleyData = JSON.parse(fs.readFileSync(srcAnalyticsForRally, "utf8"));
            const rallyData  = buildRallyAnalysis(volleyData);
            const rallyDest  = path.join(uploadsDir, `rally_analysis_${id}.json`);
            fs.writeFileSync(rallyDest, JSON.stringify(rallyData, null, 2));
            dbUpdates.rallyAnalysisPath = `/uploads/rally_analysis_${id}.json`;
            console.log(`[RALLY] Generated rally_analysis.json: ${rallyData.total_won}W ${rallyData.total_lost}L, ${rallyData.score_events.length} score events`);
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
        const ACTION_STAGE     = path.join(__dirname, "..", "detection_models", "action_detection", "action.py");
        const MERGE_STAGE      = path.join(__dirname, "..", "detection_models", "all_three", "merge_pipeline.py");
        const RENDER_STAGE     = path.join(__dirname, "..", "detection_models", "all_three", "render_video.py");

        const frameJerseyMap     = path.join(RUNS_DIR, "frame_jersey_map.json");
        const jerseyRegistryPath = path.join(RUNS_DIR, "jersey_registry.json");
        const actionDetPath      = path.join(RUNS_DIR, "action_detections.json");
        const volleyAnalyticsPath = path.join(RUNS_DIR, "volley_analytics.json");
        const renderedVideoPath  = path.join(RUNS_DIR, "analyzed_video.mp4");

        // Clear old output so status falls back to "none" on server restart while processing
        for (const f of [
            "rally_analysis.json", "player_stats.json", "volley_analytics.json",
            "frame_jersey_map.json", "jersey_registry.json", "action_detections.json",
            "player_registry.json", "analyzed_video.mp4",
        ]) {
            const p = path.join(RUNS_DIR, f);
            if (fs.existsSync(p)) fs.unlinkSync(p);
        }

        analysisJobs[id] = { status: "processing", progress: 0, error: null, proc: null };
        await Video.findByIdAndUpdate(id, { "analytics.status": "processing", "analytics.error": "" });

        const pyCmd = process.platform === "win32" ? "py" : "python3";
        const colorArg = [
            "--my-team-color", video.myTeamColor || "blue_white",
            "--opponent-color", video.opponentColor || "black_white",
        ];

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
            // ── Stage 1: jersey OCR — non-fatal on failure ───────────────────
            const jerseyResult = await runStage(id, pyCmd, "JERSEY", JERSEY_PIPELINE, [
                "--video",            videoAbs,
                "--output",           path.join(RUNS_DIR, "jersey_tracking.mp4"),
                "--frame-jersey-map", frameJerseyMap,
                "--output-json",      jerseyRegistryPath,
                ...colorArg,
                ...calibArg,
                ...rosterArg,
            ], 0, 35);
            if (jerseyResult.error) {
                console.warn(`[JERSEY] predict_pipeline failed (non-fatal) — continuing without jersey map: ${jerseyResult.error}`);
            } else {
                console.log(`[JERSEY] predict_pipeline done. Jersey map: ${frameJerseyMap}`);
            }

            // ── Stage 2: action detection — non-fatal on failure ─────────────
            const actionResult = await runStage(id, pyCmd, "ACTION", ACTION_STAGE, [
                "--video",  videoAbs,
                "--output", actionDetPath,
            ], 35, 65);
            if (actionResult.error) {
                console.warn(`[ACTION] action.py failed (non-fatal) — continuing without action data: ${actionResult.error}`);
            }

            // ── Stage 3: merge — fatal on failure ────────────────────────────
            const mergeArgs = [
                "--video",           videoAbs,
                "--output",          volleyAnalyticsPath,
                "--registry-output", REGISTRY_PATH,
                ...calibArg,
            ];
            if (fs.existsSync(frameJerseyMap))     mergeArgs.push("--frame-jersey-map", frameJerseyMap);
            if (fs.existsSync(jerseyRegistryPath)) mergeArgs.push("--jersey-registry", jerseyRegistryPath);
            if (fs.existsSync(actionDetPath))      mergeArgs.push("--action-detections", actionDetPath);

            const mergeResult = await runStage(id, pyCmd, "MERGE", MERGE_STAGE, mergeArgs, 65, 80);
            if (mergeResult.error) { await failAnalysis("merge_pipeline", mergeResult.error); return; }

            // ── Stage 4: render annotated video — non-fatal on failure ──────
            // (persistAnalysisOutputs falls back to jersey_tracking.mp4 if this is missing;
            // no rally stage yet, so no dead-time trimming — output is full-length.)
            const renderArgs = [
                "--video",            videoAbs,
                "--output",           renderedVideoPath,
                "--volley-analytics", volleyAnalyticsPath,
            ];
            if (fs.existsSync(frameJerseyMap))     renderArgs.push("--frame-jersey-map", frameJerseyMap);
            if (fs.existsSync(jerseyRegistryPath)) renderArgs.push("--jersey-registry", jerseyRegistryPath);

            const renderResult = await runStage(id, pyCmd, "RENDER", RENDER_STAGE, renderArgs, 80, 100);
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
// ── Court calibration: receive 4 clicked pixel points from browser ──────────
async function saveCourtCalibration(req, res) {
    try {
        const { id } = req.params;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid video id" });
        }
        const video = await Video.findOne({ _id: id, userId: req.user.id });
        if (!video) return res.status(404).json({ message: "Video not found" });

        const { imagePoints } = req.body; // [[x1,y1],[x2,y2],[x3,y3],[x4,y4]]
        if (!Array.isArray(imagePoints) || imagePoints.length !== 4) {
            return res.status(400).json({ message: "imagePoints must be an array of 4 [x,y] pairs" });
        }

        const calibJsonPath = path.join(__dirname, "..", "uploads", `calib_${id}.json`);
        const CALIB_SCRIPT  = path.join(__dirname, "..", "detection_models", "all_three", "court_calibration.py");
        const pyCmd = process.platform === "win32" ? "py" : "python3";
        const flat = imagePoints.flat().map(String); // [x1,y1,x2,y2,x3,y3,x4,y4]

        await new Promise((resolve, reject) => {
            let stderr = "";
            const proc = spawn(pyCmd, [
                CALIB_SCRIPT,
                "--image-points", ...flat,
                "--save", calibJsonPath,
            ]);
            proc.stderr.on("data", d => { stderr += d.toString(); });
            proc.on("close", code => {
                if (code !== 0) {
                    const msg = stderr.includes("collinear")
                        ? "הנקודות שבחרת נמצאות על אותו קו ישר — בחר שוב ווודא שנקודות הרשת ונקודות קו הסיום רחוקות אחת מהשנייה"
                        : stderr.slice(-400);
                    reject(new Error(msg));
                } else resolve();
            });
            proc.on("error", reject);
        });

        await Video.findByIdAndUpdate(id, { calibrationJsonPath: `/uploads/calib_${id}.json` });
        return res.json({ message: "Calibration saved", calibrationJsonPath: `/uploads/calib_${id}.json` });
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
}

// ── Generate rally_analysis.json from ball_landings in volley_analytics.json ─
//
// Rules:
//  • One score_event per rally — no double scoring from bounce / re-detection.
//  • Take the FIRST valid landing in the rally (not last) to avoid bounces.
//  • Valid = confidence >= MIN_CONF and frame >= rally.start + MIN_FRAMES_DELAY.
//  • "outside" landings resolve via last_touch_team inferred from action frames.
//  • Score is NEVER updated inside triple_detection.py — only here.
//
function buildRallyAnalysis(volleyAnalytics) {
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

    // ── 2. Score one landing per rally ────────────────────────────────────────
    let usScore = 0, oppScore = 0;
    const scoreEvents = [];
    const rallyMeta   = [];

    for (let idx = 0; idx < rallyWindows.length; idx++) {
        const win     = rallyWindows[idx];
        const rallyId = idx + 1;

        const validLandings = landings
            .filter(l =>
                l.frame >= win.start + effectiveDelay &&
                l.frame <= win.end + LANDING_TOLERANCE &&
                (l.confidence == null || l.confidence >= MIN_CONF)
            )
            .sort((a, b) => a.frame - b.frame);

        if (validLandings.length === 0) {
            rallyMeta.push({ win, rallyId, result: "unknown", landing: null, scoreEvent: null });
            continue;
        }

        // Take FIRST valid landing — never last (avoids counting bounces)
        const land = validLandings[0];
        let result  = "unknown";
        let scoring = null;

        if (land.landed_side === "unknown") {
            scoring = {
                rally_id: rallyId, type: "no_calibration",
                frame: land.frame, time_sec: toTimeSec(land.frame),
                us: usScore, opp: oppScore,
                landed_side: "unknown", court_position: null, scoring_team: "unknown",
            };

        } else if (land.landed_side === "opponent") {
            usScore++;
            result  = "point_my_team";
            scoring = {
                rally_id: rallyId, type: "ball_landing",
                frame: land.frame, time_sec: toTimeSec(land.frame),
                us: usScore, opp: oppScore,
                landed_side: "opponent", court_position: land.court_position || null,
                scoring_team: "my_team",
            };

        } else if (land.landed_side === "my_team") {
            oppScore++;
            result  = "point_opponent";
            scoring = {
                rally_id: rallyId, type: "ball_landing",
                frame: land.frame, time_sec: toTimeSec(land.frame),
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
                    frame: land.frame, time_sec: toTimeSec(land.frame),
                    us: usScore, opp: oppScore,
                    landed_side: "outside", court_position: land.court_position || null,
                    scoring_team: "opponent", last_touch_team: lastTeam,
                };
            } else if (lastTeam === "opponent") {
                usScore++;
                scoring = {
                    rally_id: rallyId, type: "ball_out",
                    frame: land.frame, time_sec: toTimeSec(land.frame),
                    us: usScore, opp: oppScore,
                    landed_side: "outside", court_position: land.court_position || null,
                    scoring_team: "my_team", last_touch_team: lastTeam,
                };
            } else {
                scoring = {
                    rally_id: rallyId, type: "unknown_out",
                    frame: land.frame, time_sec: toTimeSec(land.frame),
                    us: usScore, opp: oppScore,
                    landed_side: "outside", court_position: land.court_position || null,
                    scoring_team: "unknown",
                };
            }
        }

        scoreEvents.push(scoring);
        rallyMeta.push({ win, rallyId, result, landing: land, scoreEvent: scoring });
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
    const pushRun = (run) => {
        const total = [...run.playerVotes.values()].reduce((s, c) => s + c, 0);
        const participants = [...run.playerVotes.entries()]
            .sort((a, b) => b[1] - a[1])
            .filter(([, count]) => count / total >= CO_PARTICIPANT_MIN_SHARE)
            .map(([player]) => player);
        allActions.push({
            frame:         run.startFrame,
            time_sec:      toTimeSec(run.startFrame),
            time_str:      toTimeStr(run.startFrame),
            action:        run.action,
            action_label:  run.action,
            result:        "unknown",
            player_label:  participants.length ? participants.map(p => `#${p}`).join(" & ") : "?",
            player_jersey: participants[0] ?? null,
            co_players:    participants.length > 1 ? participants : undefined,
        });
    };
    let run = null; // { action, startFrame, lastFrame, playerVotes: Map }
    for (const f of frames) {
        if (!f.action || f.action === "none") continue;
        if (!BALL_ACTIONS.has(f.action)) continue;
        const playerKey = f.active_player_jersey ?? f.active_player_id ?? null;
        if (run && run.action === f.action && f.frame - run.lastFrame <= MAX_GAP_FRAMES) {
            run.lastFrame = f.frame;
            run.playerVotes.set(playerKey, (run.playerVotes.get(playerKey) || 0) + 1);
        } else {
            if (run) pushRun(run);
            run = { action: f.action, startFrame: f.frame, lastFrame: f.frame, playerVotes: new Map([[playerKey, 1]]) };
        }
    }
    if (run) pushRun(run);

    // ── 4. Attach actions to rallies ──────────────────────────────────────────
    const rallies = rallyMeta.map(rm => ({
        rally_id:    rm.rallyId,
        start_frame: rm.win.start,
        end_frame:   rm.win.end,
        start_sec:   toTimeSec(rm.win.start),
        end_sec:     toTimeSec(rm.win.end),
        result:      rm.result,
        score_event: rm.scoreEvent || null,
        actions:     allActions.filter(a => a.frame >= rm.win.start && a.frame <= rm.win.end),
    }));

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
    };
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
    deleteRosterPlayer,
    assignDetectionsToPlayer,
    resetPlayerDetection,
    analyzeRallies,
    getVideoAnalysis,
    analyzeBall,
    getBallAnalysis,
    getPlayerStats,
    getPlayerRegistry,
    updatePlayerRegistry,
    saveAndRecalculate,
    getRallyAnalysis,
    startAnalysis,
    getAnalysisStatus,
    recoverAnalysis,
    saveJerseys,
    saveCourtCalibration,
};