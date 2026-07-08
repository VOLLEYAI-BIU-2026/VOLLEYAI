const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const requireAuth = require("../requireAuth");
const {
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
} = require("../controllers/videoController");

const uploadDir = path.join(__dirname, "..", "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
        cb(null, `${Date.now()}_${safe}`);
    },
});

const upload = multer({
    storage,
    limits: { fileSize: 2 * 1024 * 1024 * 1024 },
});

router.get("/list", requireAuth, listVideos);
router.post("/upload-file", requireAuth, upload.single("video"), uploadFile);
router.post("/youtube", requireAuth, addYoutube);

router.get("/latest/player-stats", requireAuth, (req, res) => { req.params.id = "latest"; return getPlayerStats(req, res); });
router.get("/player-registry", requireAuth, getPlayerRegistry);
router.post("/player-registry", requireAuth, updatePlayerRegistry);
router.post("/player-registry/recalculate", requireAuth, saveAndRecalculate);
router.get("/rally-analysis", requireAuth, getRallyAnalysis);
router.get("/:id/rally-analysis", requireAuth, getRallyAnalysis);
router.patch("/:id/teams", requireAuth, updateTeamNames);
router.post("/:id/jerseys", requireAuth, saveJerseys);
router.post("/:id/start-analysis", requireAuth, startAnalysis);
router.get("/:id/analysis-status", requireAuth, getAnalysisStatus);
router.post("/:id/recover-analysis", requireAuth, recoverAnalysis);
router.post("/:id/calibrate", requireAuth, saveCourtCalibration);

router.post("/:id/clean-frame", requireAuth, startCleanFrame);
router.get("/:id", requireAuth, getVideoById);
router.post("/:id/detect-players", requireAuth, startPlayerDetection);
router.get("/:id/team-roster", requireAuth, getTeamRoster);
router.post("/:id/reset-player-detection", requireAuth, resetPlayerDetection);
router.post("/:id/detect-players", requireAuth, startPlayerDetection);
router.get("/:id/team-roster", requireAuth, getTeamRoster);
router.post("/:id/team-roster/create-player", requireAuth, createRosterPlayer);
router.delete("/:id/team-roster/:playerId", requireAuth, deleteRosterPlayer);
router.post("/:id/team-roster/assign", requireAuth, assignDetectionsToPlayer);
router.post("/:id/reset-player-detection", requireAuth, resetPlayerDetection);
router.post("/:id/analyze-rallies", requireAuth, analyzeRallies);
router.get("/:id/video-analysis", requireAuth, getVideoAnalysis);
router.post("/:id/analyze-ball", requireAuth, analyzeBall);
router.get("/:id/ball-analysis", requireAuth, getBallAnalysis);
router.get("/:id/player-stats", requireAuth, getPlayerStats);

module.exports = router;