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
router.get("/rally-analysis", requireAuth, getRallyAnalysis);
router.get("/:id/rally-analysis", requireAuth, getRallyAnalysis);
router.post("/:id/ai-recommendation", requireAuth, getAiRecommendation);
router.patch("/:id/teams", requireAuth, updateTeamNames);
router.post("/:id/jerseys", requireAuth, saveJerseys);
router.post("/:id/start-analysis", requireAuth, startAnalysis);
router.get("/:id/analysis-status", requireAuth, getAnalysisStatus);
router.post("/:id/stop-analysis", requireAuth, stopAnalysis);
router.post("/:id/recover-analysis", requireAuth, recoverAnalysis);
router.delete("/:id", requireAuth, deleteVideo);

router.post("/:id/clean-frame", requireAuth, startCleanFrame);
router.get("/:id", requireAuth, getVideoById);
router.post("/:id/detect-players", requireAuth, startPlayerDetection);
router.get("/:id/team-roster", requireAuth, getTeamRoster);
router.post("/:id/reset-player-detection", requireAuth, resetPlayerDetection);
router.post("/:id/detect-players", requireAuth, startPlayerDetection);
router.get("/:id/team-roster", requireAuth, getTeamRoster);
router.post("/:id/team-roster/create-player", requireAuth, createRosterPlayer);
router.patch("/:id/team-roster/position", requireAuth, setRosterPlayerPosition);
router.delete("/:id/team-roster/:playerId", requireAuth, deleteRosterPlayer);
router.post("/:id/team-roster/import-my-team", requireAuth, importMyTeam);
router.get("/:id/player-registry", requireAuth, getPlayerRegistryForVideo);
router.post("/:id/player-registry/merge", requireAuth, mergePlayerRegistry);
router.post("/:id/player-registry/delete", requireAuth, deletePlayerRegistryEntries);
router.post("/:id/team-roster/assign", requireAuth, assignDetectionsToPlayer);
router.post("/:id/reset-player-detection", requireAuth, resetPlayerDetection);
router.post("/:id/analyze-rallies", requireAuth, analyzeRallies);
router.get("/:id/video-analysis", requireAuth, getVideoAnalysis);
router.post("/:id/analyze-ball", requireAuth, analyzeBall);
router.get("/:id/ball-analysis", requireAuth, getBallAnalysis);
router.get("/:id/player-stats", requireAuth, getPlayerStats);

module.exports = router;