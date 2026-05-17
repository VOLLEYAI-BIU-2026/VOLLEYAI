const mongoose = require("mongoose");

const PointSchema = new mongoose.Schema(
    { x: Number, y: Number },
    { _id: false }
);

const StepPointsSchema = new mongoose.Schema(
    {
        netTopLeft: PointSchema,
        netTopRight: PointSchema,
        farLineLeft: PointSchema,
        farLineRight: PointSchema,
        middleLineLeft: PointSchema,
        middleLineRight: PointSchema,
    },
    { _id: false }
);

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

        courtSetup: {
            step1: StepPointsSchema,
            step2: StepPointsSchema,
        },

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

        status: { type: String, default: "uploaded" },
    },
    { timestamps: true }
);

module.exports = mongoose.model("Video", VideoSchema);