
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
module.exports = {
    uploadFile,
    addYoutube,
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
};