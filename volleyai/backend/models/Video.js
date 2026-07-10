const mongoose = require("mongoose");

const DetectionThumbSchema = new mongoose.Schema(
    {
        detectionId: { type: String, required: true },
        imageUrl: String,
        frameTime: Number,
        confidence: Number,
        assignedPlayerId: { type: String, default: null },
    },
    { _id: false }
);

const TeamRosterPlayerSchema = new mongoose.Schema(
    {
        playerId: { type: String, required: true },
        jerseyNumber: { type: String, default: "" },
        manualName: { type: String, default: "" },
        teamSide: {
            type: String,
            enum: ["my_team", "opponent", "unknown"],
            default: "unknown",
        },
    },
    { _id: false }
);

const VideoSchema = new mongoose.Schema(
    {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        sourceType: { type: String, enum: ["file", "youtube"], required: true },

        filePath: String,
        fileName: String,
        originalFileName: String,
        fileSize: Number,
        mimeType: String,
        youtubeUrl: String,

        cleanFrameStatus: {
            type: String,
            enum: ["none", "processing", "done", "failed"],
            default: "none",
        },
        cleanFramePath: { type: String },
        cleanFrameError: { type: String },

        playerDetection: {
            status: {
                type: String,
                enum: ["none", "processing", "done", "failed"],
                default: "none",
            },
            error: {
                type: String,
                default: "",
            },
            lastProcessedAt: {
                type: Date,
                default: null,
            },
        },

        detections: {
            type: [DetectionThumbSchema],
            default: [],
        },

        teamRoster: {
            players: {
                type: [TeamRosterPlayerSchema],
                default: [],
            },
        },
        videoAnalysis: {
            status: {
                type: String,
                enum: ["none", "processing", "done", "failed"],
                default: "none",
            },
            error: {
                type: String,
                default: "",
            },
            rallies: {
                type: [
                    {
                        rallyId: String,
                        start: Number,
                        end: Number,
                        label: String,
                    },
                ],
                default: [],
            },
            deadSegments: {
                type: [
                    {
                        start: Number,
                        end: Number,
                    },
                ],
                default: [],
            },
            optimizedSegments: {
                type: [
                    {
                        sourceStart: Number,
                        sourceEnd: Number,
                    },
                ],
                default: [],
            },
            lastProcessedAt: {
                type: Date,
                default: null,
            },
        },
        normalizedFilePath: String,
        normalizationStatus: {
            type: String,
            enum: ["none", "processing", "done", "failed"],
            default: "none",
        },
        normalizationError: {
            type: String,
            default: "",
        },

        ballAnalysis: {
            status: {
                type: String,
                enum: ["none", "processing", "done", "failed"],
                default: "none",
            },
            error: {
                type: String,
                default: "",
            },
            points: {
                type: [
                    {
                        time: Number,
                        x: Number,
                        y: Number,
                        radius: Number,
                        confidence: Number,
                    },
                ],
                default: [],
            },
            rallies: {
                type: [
                    {
                        rallyId: String,
                        start: Number,
                        end: Number,
                        label: String,
                    },
                ],
                default: [],
            },
            deadSegments: {
                type: [
                    {
                        start: Number,
                        end: Number,
                    },
                ],
                default: [],
            },
            optimizedSegments: {
                type: [
                    {
                        sourceStart: Number,
                        sourceEnd: Number,
                    },
                ],
                default: [],
            },
            lastProcessedAt: {
                type: Date,
                default: null,
            },
        },

        // Triple-detection pipeline (players + ball + actions + stats)
        analytics: {
            status: {
                type: String,
                enum: ["none", "processing", "done", "failed"],
                default: "none",
            },
            error:           { type: String, default: "" },
            lastProcessedAt: { type: Date,   default: null },
        },
        analyzedVideoPath: { type: String, default: null }, // /uploads/analyzed_<id>.mp4
        playerStatsPath:   { type: String, default: null }, // /uploads/player_stats_<id>.json
        playerRegistryPath:{ type: String, default: null }, // /uploads/player_registry_<id>.json
        analyticsJsonPath: { type: String, default: null }, // /uploads/volley_analytics_<id>.json
        rallyAnalysisPath:    { type: String, default: null }, // /uploads/rally_analysis_<id>.json
        calibrationJsonPath:  { type: String, default: null }, // /uploads/calib_<id>.json
        scoreboardReadingsPath: { type: String, default: null }, // /uploads/scoreboard_readings_<id>.json

        status: { type: String, default: "uploaded" },
        teamA: { type: String, default: "" },
        teamB: { type: String, default: "" },
        knownJerseys: { type: [Number], default: [] },
        knownPlayers: {
            type: [{ jersey: Number, name: { type: String, default: "" } }],
            default: [],
        },
        myTeamColor: { type: String, default: "blue_white" }, // preset key, see TEAM_COLOR_PRESETS in triple_detection.py
        opponentColor: { type: String, default: "black_white" }, // preset key, see TEAM_COLOR_PRESETS in triple_detection.py
        liberoColor: { type: String, default: "" }, // preset key, optional — enables a dedicated k-means cluster for the libero's contrasting jersey
        opponentLiberoColor: { type: String, default: "" }, // preset key, optional — same, for the opponent's libero
        isHomeTeam: { type: Boolean, default: true }, // which side of the physical scoreboard is "us" — "home" if true, "guest" if false
    },
    { timestamps: true }
);

module.exports = mongoose.model("Video", VideoSchema);