const express = require("express");
const router = express.Router();
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const requireAuth = require("../requireAuth");
const {
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

router.post("/upload-file", requireAuth, upload.single("video"), uploadFile);
router.post("/youtube", requireAuth, addYoutube);
router.post("/:id/clean-frame", requireAuth, startCleanFrame);

router.get("/:id", requireAuth, getVideoById);
router.post("/:id/court-setup", requireAuth, saveCourtSetup);
router.post("/:id/detect-players", requireAuth, startPlayerDetection);
router.get("/:id/team-roster", requireAuth, getTeamRoster);
router.post("/:id/reset-player-detection", requireAuth, resetPlayerDetection);
router.post("/:id/detect-players", requireAuth, startPlayerDetection);
router.get("/:id/team-roster", requireAuth, getTeamRoster);
router.post("/:id/team-roster/create-player", requireAuth, createRosterPlayer);
router.post("/:id/team-roster/assign", requireAuth, assignDetectionsToPlayer);
router.post("/:id/reset-player-detection", requireAuth, resetPlayerDetection);
router.post("/:id/analyze-rallies", requireAuth, analyzeRallies);
router.get("/:id/video-analysis", requireAuth, getVideoAnalysis);
router.post("/:id/analyze-ball", requireAuth, analyzeBall);
router.get("/:id/ball-analysis", requireAuth, getBallAnalysis);

module.exports = router;