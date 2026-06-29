
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

function normalizeStep(step) {
    const n = Number(step);
    return n === 2 ? 2 : 1;
}

async function listVideos(req, res) {
    try {
        const videos = await Video.find({ userId: req.user.id })
            .sort({ createdAt: -1 })
            .select("_id originalFileName fileName status playerDetection teamA teamB createdAt sourceType filePath cleanFramePath");
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

async function saveCourtSetup(req, res) {
    try {
        const { id } = req.params;
        const { step, points } = req.body;
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid video id" });
        }

        const video = await Video.findOne({ _id: id, userId: req.user.id });
        if (!video) return res.status(404).json({ message: "Video not found" });

        const s = normalizeStep(step);

        if (!video.courtSetup) video.courtSetup = {};
        if (s === 1) video.courtSetup.step1 = points;
        else video.courtSetup.step2 = points;

        await video.save();

        return res.status(200).json({ message: "Saved", video });
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

        video.cleanFrameStatus = "processing";
        video.cleanFrameError = undefined;
        await video.save();

        const inputAbs = path.join(__dirname, "..", video.filePath.replace(/^\//, ""));
        const outRel = `/uploads/cleanframe_${video._id}.png`;
        const outAbs = path.join(__dirname, "..", outRel.replace(/^\//, ""));

        const fixedSecond = 2;

        const pyCmd = process.platform === "win32" ? "py" : "python";
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
        const pyCmd = process.platform === "win32" ? "py" : "python";

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

        const inputAbs = path.join(__dirname, "..", video.filePath.replace(/^\//, ""));
        const uploadsAbs = path.join(__dirname, "..", "uploads");
        const resultJsonAbs = path.join(uploadsAbs, `rally_analysis_${video._id}.json`);

        const pyCmd = process.platform === "win32" ? "py" : "python";
        const scriptPath = path.join(__dirname, "..", "python", "analyze_rallies.py");

        const py = spawn(pyCmd, [
            scriptPath,
            "--input", inputAbs,
            "--output_json", resultJsonAbs,
            "--court_setup", JSON.stringify(video.courtSetup?.step2 || {}),
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

        const ffmpegCmd =
            "C:\\Users\\user\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg.Essentials_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.0.1-essentials_build\\bin\\ffmpeg.exe";

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

        const pyCmd = process.platform === "win32" ? "py" : "python";
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

        const pyCmd = process.platform === "win32" ? "py" : "python";
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
        if (id !== "latest") {
            if (!mongoose.Types.ObjectId.isValid(id)) {
                return res.status(400).json({ message: "Invalid video id" });
            }
            const video = await Video.findOne({ _id: id, userId: req.user.id });
            if (!video) return res.status(404).json({ message: "Video not found" });
        }

        const statsPath = path.join(
            __dirname, "..", "detection_models", "all_three", "runs", "player_stats.json"
        );

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

        const AGGREGATOR = path.join(__dirname, "..", "detection_models", "all_three", "stats_aggregator.py");
        const proc = spawn("python", [AGGREGATOR]);

        proc.on("close", (code) => {
            if (code === 0) return res.status(200).json({ status: "ok" });
            return res.status(500).json({ message: "Aggregator failed", code });
        });
        proc.on("error", (err) => res.status(500).json({ message: err.message }));
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
        // Accept either {players:[{jersey,name}]} (new) or {jerseys:[n]} (legacy)
        const { players, jerseys } = req.body;
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

        const video = await Video.findOneAndUpdate(
            { _id: id, userId: req.user.id },
            {
                $set: {
                    knownPlayers: playerList,
                    knownJerseys: playerList.map(p => p.jersey),
                },
            },
            { new: true }
        );
        if (!video) return res.status(404).json({ message: "Video not found" });
        return res.json({ status: "ok" });
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
}

async function startAnalysis(req, res) {
    try {
        const { id } = req.params;
        if (analysisJobs[id]?.status === "processing") {
            return res.status(409).json({ message: "Already processing" });
        }

        const video = await Video.findOne({ _id: id, userId: req.user.id });
        if (!video) return res.status(404).json({ message: "Video not found" });

        const videoAbs = path.join(__dirname, "..", video.filePath.replace(/^\//, ""));
        const DETECTOR  = path.join(__dirname, "..", "detection_models", "all_three", "triple_detection.py");
        const AGGREGATOR = path.join(__dirname, "..", "detection_models", "all_three", "stats_aggregator.py");

        // Clear old output so status falls back to "none" on server restart while processing
        for (const f of ["rally_analysis.json", "player_stats.json", "volley_analytics.json"]) {
            const p = path.join(RUNS_DIR, f);
            if (fs.existsSync(p)) fs.unlinkSync(p);
        }

        analysisJobs[id] = { status: "processing", progress: 0, error: null };

        const pyCmd = process.platform === "win32" ? "py" : "python";
        const knownPlayers = video.knownPlayers || [];
        const jerseyArg = knownPlayers.length > 0
            ? ["--jerseys", knownPlayers.map(p => p.jersey).join(",")]
            : (video.knownJerseys || []).length > 0
                ? ["--jerseys", video.knownJerseys.join(",")]
                : [];
        const namesArg = knownPlayers.some(p => p.name)
            ? ["--names", knownPlayers.filter(p => p.name).map(p => `${p.jersey}:${p.name}`).join(",")]
            : [];

        // Court boundary args from CourtSetup screen
        const cs = video.courtSetup?.step1;
        let courtArg = [];
        let netYArg  = [];
        let nearYArg = [];
        let farYArg  = [];
        if (cs?.nearLeft && cs?.nearRight && cs?.farLeft && cs?.farRight) {
            const poly = [
                cs.nearLeft.x,  cs.nearLeft.y,
                cs.nearRight.x, cs.nearRight.y,
                cs.farRight.x,  cs.farRight.y,
                cs.farLeft.x,   cs.farLeft.y,
            ].map(n => n.toFixed(4)).join(",");
            courtArg = ["--court", poly];

            // Near baseline Y (our side ground level) — average of near corners
            const nearY = ((cs.nearLeft.y + cs.nearRight.y) / 2).toFixed(4);
            nearYArg = ["--near_y", nearY];

            // Far baseline Y (opponent side ground level) — average of far corners
            const farY  = ((cs.farLeft.y  + cs.farRight.y)  / 2).toFixed(4);
            farYArg  = ["--far_y",  farY];
        }
        if (cs?.netLeft && cs?.netRight) {
            const netY = ((cs.netLeft.y + cs.netRight.y) / 2).toFixed(4);
            netYArg = ["--net_y", netY];
        }

        console.log(`[ANALYSIS] Starting: ${pyCmd} ${DETECTOR} --video ${videoAbs} ${[...jerseyArg, ...namesArg, ...netYArg, ...nearYArg, ...farYArg].join(" ")}`);
        const proc = spawn(pyCmd, [DETECTOR, "--video", videoAbs, ...jerseyArg, ...namesArg, ...netYArg, ...nearYArg, ...farYArg]);

        proc.stdout.on("data", (data) => {
            const txt = data.toString();
            console.log("[DETECTOR]", txt.trim());
            const match = txt.match(/(\d+)%/);
            if (match) analysisJobs[id].progress = parseInt(match[1]);
        });

        proc.stderr.on("data", (data) => {
            const txt = data.toString();
            console.log("[DETECTOR]", txt.trim());
            const match = txt.match(/(\d+)%/);
            if (match) analysisJobs[id].progress = parseInt(match[1]);
        });

        proc.on("close", (code) => {
            if (code === 0) {
                const agg = spawn(pyCmd, [AGGREGATOR, ...courtArg, ...netYArg, "--side", "bottom", ...nearYArg, ...farYArg]);
                agg.on("close", (aggCode) => {
                    analysisJobs[id].status = aggCode === 0 ? "done" : "failed";
                    analysisJobs[id].progress = 100;
                    if (aggCode !== 0) analysisJobs[id].error = "Aggregator failed";
                });
            } else {
                analysisJobs[id].status = "failed";
                analysisJobs[id].error = `Detection failed (exit ${code})`;
            }
        });

        proc.on("error", (err) => {
            analysisJobs[id].status = "failed";
            analysisJobs[id].error = err.message;
        });

        return res.json({ status: "started" });
    } catch (err) {
        return res.status(500).json({ message: err.message });
    }
}

async function getAnalysisStatus(req, res) {
    const { id } = req.params;
    const job = analysisJobs[id];
    if (!job) return res.json({ status: "none", progress: 0 });
    return res.json(job);
}

async function getRallyAnalysis(req, res) {
    try {
        if (!fs.existsSync(RALLY_PATH)) return res.status(404).json({ message: "No rally data yet. Run the model and recalculate." });
        const data = JSON.parse(fs.readFileSync(RALLY_PATH, "utf8"));
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
    saveCourtSetup,
    startCleanFrame,
    startPlayerDetection,
    getTeamRoster,
    createRosterPlayer,
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
    saveJerseys,
};