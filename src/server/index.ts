/**
 * INDEX.TS - Main entry point for the MCP Streamable HTTP Server
 * 
 * This file sets up and starts the Express server with MCP (Model Context Protocol) support.
 * It provides endpoints for MCP communication and audio file processing.
 * 
 * Key Features:
 * - Express server with CORS and static file serving
 * - MCP endpoint (/mcp) for handling MCP protocol requests
 * - Audio export endpoint (/api/audio-export) for processing uploaded audio files
 * - MCP server initialization and connection to StreamableHTTPServerTransport
 * - Graceful shutdown handling on SIGINT
 * 
 * Endpoints:
 * - POST /mcp - Handles MCP protocol requests
 * - POST /api/audio-export - Accepts audio file uploads, converts format, and uploads to S3
 * - GET/DELETE /mcp - Returns method not allowed (405)
 * 
 * Used by the audio editor widget for exporting trimmed/edited audio in various formats.
 */

/* ----------------------------- ENV VARS ----------------------------- */
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = process.env.VERCEL ? process.cwd() : path.resolve(__dirname, "../..");
dotenv.config({ path: path.join(projectRoot, ".env") });

/* ----------------------------- IMPORTS ----------------------------- */
import express, { Request, Response } from "express";
import cors from "cors";
import multer from "multer";
import fs from "node:fs";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "./create-server.js";
import { finalizeLocalAudioExport, processAudioFromUrl, processAudioFromFile, generatePresignedUploadUrl, normalizeAudioExportFormat, detectBPMAndKey, separateVoiceFromMusic, processDualTrackAudio } from "./services/audio.js";
import { trackWidgetEvent, trackEvent } from "./services/analytics.js";

/* ----------------------------- CONSTANTS ----------------------------- */
const PORT = process.env.PORT || 8000;
const TEMP_DIR = process.env.VERCEL ? "/tmp" : path.join(projectRoot, "tmp");

/* ----------------------------- HELPER FUNCTIONS ----------------------------- */
// Ensure temp directory exists (only needed in non-Vercel environments)
if (!process.env.VERCEL) {
  try {
    await fs.promises.mkdir(TEMP_DIR, { recursive: true });
  } catch (error) {
    console.error(`Failed to create temp directory ${TEMP_DIR}:`, error);
  }
}

// Multer configuration for file uploads
const upload = multer({
  dest: TEMP_DIR,
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB
  },
});

// handleAudioExport - Handles the audio export request
async function handleAudioExport(req: Request, res: Response): Promise<void> {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "Missing audio file" });
    return;
  }

  // Log file size for debugging
  console.log("[Audio Export] Received file:", {
    size: file.size,
    sizeMB: (file.size / (1024 * 1024)).toFixed(2),
    originalName: file.originalname,
    mimetype: file.mimetype,
  });

  // Check file size before processing (additional safety check)
  const maxSize = 500 * 1024 * 1024; // 500MB
  if (file.size > maxSize) {
    console.error("[Audio Export] File too large:", {
      size: file.size,
      sizeMB: (file.size / (1024 * 1024)).toFixed(2),
      maxSizeMB: (maxSize / (1024 * 1024)).toFixed(2),
    });
    res.status(413).json({ 
      error: "File too large. Maximum file size is 500MB. Please try a smaller file or compress your audio." 
    });
    // Clean up the uploaded file
    try {
      await fs.promises.unlink(file.path);
    } catch {
      // ignore cleanup errors
    }
    return;
  }

  const filePath = file.path;

  try {
    const result = await finalizeLocalAudioExport({
      sourcePath: filePath,
      format: req.body.format,
      trackName: req.body.trackName || file.originalname || "audio"
    });

    console.log("[Audio Export] Uploaded audio via API:", {
      format: result.format,
      fileName: result.fileName,
      downloadUrl: result.downloadUrl,
    });

    res.json({
      downloadUrl: result.downloadUrl,
      fileName: result.fileName,
      format: result.format,
      extension: result.extension,
    });
  } catch (error) {
    console.error("Failed to export audio", error);
    const errorMessage = error instanceof Error ? error.message : "Failed to export audio";
    res.status(500).json({ error: errorMessage });
  } finally {
    try {
      await fs.promises.unlink(filePath);
    } catch {
      // ignore cleanup errors
    }
  }
}

/* ----------------------------- EXPRESS APP ----------------------------- */
// Initialize Express app
const app = express();

// Middleware setup
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(projectRoot, "public")));
app.use(
  cors({
    origin: true,
    methods: "*",
    allowedHeaders: "Authorization, Origin, Content-Type, Accept, *",
  })
);
app.options("*", cors());

// Initialize transport
const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined, // set to undefined for stateless servers
});

// MCP endpoint
app.post("/mcp", async (req: Request, res: Response) => {
  console.log("Received MCP request:", req.body);
  try {
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: null,
      });
    }
  }
});

// Method not allowed handlers
const methodNotAllowed = (req: Request, res: Response) => {
  console.log(`Received ${req.method} MCP request`);
  res.status(405).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed.",
    },
    id: null,
  });
};

app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

app.post("/api/audio-export", upload.single("audio"), handleAudioExport);

// handleAudioProcess - Handles audio processing with parameters (server-side processing)
async function handleAudioProcess(req: Request, res: Response): Promise<void> {
  // Handle both multipart/form-data (with file) and application/x-www-form-urlencoded (with URL)
  const audioUrl = req.body.audioUrl;
  const vocalsUrl = req.body.vocalsUrl;
  const musicUrl = req.body.musicUrl;
  const vocalsEnabled = req.body.vocalsEnabled;
  const musicEnabled = req.body.musicEnabled;
  const format = req.body.format;
  const trackName = req.body.trackName;
  const startTime = req.body.startTime;
  const duration = req.body.duration;
  const fadeInEnabled = req.body.fadeInEnabled;
  const fadeInDuration = req.body.fadeInDuration;
  const fadeOutEnabled = req.body.fadeOutEnabled;
  const fadeOutDuration = req.body.fadeOutDuration;
  const file = req.file;

  // Validate required parameters
  if (!format) {
    res.status(400).json({ error: "Missing format parameter" });
    return;
  }

  if (startTime === undefined || duration === undefined) {
    res.status(400).json({ error: "Missing startTime or duration parameters" });
    return;
  }

  // Check if this is a dual track request
  const isDualTrack = vocalsUrl && musicUrl;

  if (isDualTrack) {
    // Dual track processing
    const processingStartTime = Date.now();
    try {
      console.log("[Audio Process] Processing dual tracks:", {
        vocalsUrl,
        musicUrl,
        format,
        startTime,
        duration,
        vocalsEnabled,
        musicEnabled,
        fadeInEnabled,
        fadeInDuration,
        fadeOutEnabled,
        fadeOutDuration,
      });

      const result = await processDualTrackAudio({
        vocalsUrl: vocalsUrl as string,
        musicUrl: musicUrl as string,
        format: normalizeAudioExportFormat(format as string),
        trackName: (trackName as string) || "audio",
        startTime: parseFloat(startTime as string),
        duration: parseFloat(duration as string),
        vocalsEnabled: vocalsEnabled === "true" || vocalsEnabled === true,
        musicEnabled: musicEnabled === "true" || musicEnabled === true,
        fadeInEnabled: fadeInEnabled === "true" || fadeInEnabled === true,
        fadeInDuration: fadeInDuration ? parseFloat(fadeInDuration as string) : 0,
        fadeOutEnabled: fadeOutEnabled === "true" || fadeOutEnabled === true,
        fadeOutDuration: fadeOutDuration ? parseFloat(fadeOutDuration as string) : 0,
      });

      console.log("[Audio Process] Processed dual tracks:", {
        format: result.format,
        fileName: result.fileName,
        downloadUrl: result.downloadUrl,
      });

      const vocalsEnabledBool = vocalsEnabled === "true" || vocalsEnabled === true;
      const musicEnabledBool = musicEnabled === "true" || musicEnabled === true;

      if (vocalsEnabledBool && musicEnabledBool) {
        // Both tracks enabled
        await trackEvent("fe_dual_track_exported", {
          format: result.format,
          duration: parseFloat(duration as string),
          vocals_enabled: true,
          music_enabled: true,
          fade_in_enabled: fadeInEnabled === "true" || fadeInEnabled === true,
          fade_out_enabled: fadeOutEnabled === "true" || fadeOutEnabled === true,
          processing_time_ms: Date.now() - processingStartTime,
          source: "api",
        });
      } else if (vocalsEnabledBool && !musicEnabledBool) {
        // Only vocals enabled
        await trackEvent("fe_only_vocal_track_exported", {
          format: result.format,
          duration: parseFloat(duration as string),
          fade_in_enabled: fadeInEnabled === "true" || fadeInEnabled === true,
          fade_out_enabled: fadeOutEnabled === "true" || fadeOutEnabled === true,
          processing_time_ms: Date.now() - processingStartTime,
          source: "api",
        });
      } else if (!vocalsEnabledBool && musicEnabledBool) {
        // Only music enabled
        await trackEvent("fe_only_music_track_exported", {
          format: result.format,
          duration: parseFloat(duration as string),
          fade_in_enabled: fadeInEnabled === "true" || fadeInEnabled === true,
          fade_out_enabled: fadeOutEnabled === "true" || fadeOutEnabled === true,
          processing_time_ms: Date.now() - processingStartTime,
          source: "api",
        });
      }

      res.json({
        downloadUrl: result.downloadUrl,
        fileName: result.fileName,
        format: result.format,
        extension: result.extension,
      });
    } catch (error) {
      console.error("Failed to process dual track audio", error);
      const errorMessage = error instanceof Error ? error.message : "Failed to process dual track audio";
      res.status(500).json({ error: errorMessage });
    }
    return;
  }

  // Single track processing (original behavior)
  if (!audioUrl && !file) {
    res.status(400).json({ error: "Either audioUrl or audio file must be provided" });
    return;
  }

  try {
    let result;

    if (audioUrl) {
      // Process from URL
      console.log("[Audio Process] Processing from URL:", {
        audioUrl,
        format,
        startTime,
        duration,
        fadeInEnabled,
        fadeInDuration,
        fadeOutEnabled,
        fadeOutDuration,
      });

      result = await processAudioFromUrl({
        audioUrl: audioUrl as string,
        format: normalizeAudioExportFormat(format as string),
        trackName: (trackName as string) || "audio",
        startTime: parseFloat(startTime as string),
        duration: parseFloat(duration as string),
        fadeInEnabled: fadeInEnabled === "true" || fadeInEnabled === true,
        fadeInDuration: fadeInDuration ? parseFloat(fadeInDuration as string) : 0,
        fadeOutEnabled: fadeOutEnabled === "true" || fadeOutEnabled === true,
        fadeOutDuration: fadeOutDuration ? parseFloat(fadeOutDuration as string) : 0,
      });
    } else if (file) {
      // Process uploaded file
      console.log("[Audio Process] Processing uploaded file:", {
        fileName: file.originalname,
        size: file.size,
        format,
        startTime,
        duration,
        fadeInEnabled,
        fadeInDuration,
        fadeOutEnabled,
        fadeOutDuration,
      });

      result = await processAudioFromFile({
        filePath: file.path,
        format: normalizeAudioExportFormat(format as string),
        trackName: (trackName as string) || file.originalname || "audio",
        startTime: parseFloat(startTime as string),
        duration: parseFloat(duration as string),
        fadeInEnabled: fadeInEnabled === "true" || fadeInEnabled === true,
        fadeInDuration: fadeInDuration ? parseFloat(fadeInDuration as string) : 0,
        fadeOutEnabled: fadeOutEnabled === "true" || fadeOutEnabled === true,
        fadeOutDuration: fadeOutDuration ? parseFloat(fadeOutDuration as string) : 0,
      });

      // Clean up uploaded file
      try {
        await fs.promises.unlink(file.path);
      } catch {
        // ignore cleanup errors
      }
    } else {
      res.status(400).json({ error: "Either audioUrl or audio file must be provided" });
      return;
    }

    console.log("[Audio Process] Processed audio:", {
      format: result.format,
      fileName: result.fileName,
      downloadUrl: result.downloadUrl,
    });

    res.json({
      downloadUrl: result.downloadUrl,
      fileName: result.fileName,
      format: result.format,
      extension: result.extension,
    });
  } catch (error) {
    console.error("Failed to process audio", error);
    const errorMessage = error instanceof Error ? error.message : "Failed to process audio";
    res.status(500).json({ error: errorMessage });
  }
}

// New endpoint for server-side processing (accepts JSON params + optional file)
app.post("/api/audio-process", upload.single("audio"), handleAudioProcess);

// handlePresignedUrl - Generates presigned S3 upload URL for direct client uploads
async function handlePresignedUrl(req: Request, res: Response): Promise<void> {
  const { fileName, contentType } = req.body;

  if (!fileName) {
    res.status(400).json({ error: "Missing fileName parameter" });
    return;
  }

  try {
    const result = await generatePresignedUploadUrl(
      fileName as string,
      (contentType as string) || "audio/mpeg"
    );

    res.json({
      uploadUrl: result.uploadUrl,
      fileKey: result.fileKey,
      publicUrl: result.publicUrl,
    });
  } catch (error) {
    console.error("Failed to generate presigned URL", error);
    const errorMessage = error instanceof Error ? error.message : "Failed to generate presigned URL";
    res.status(500).json({ error: errorMessage });
  }
}

app.post("/api/s3-presigned-url", express.json(), handlePresignedUrl);

// handleDetectBPMKey - Handles BPM and Key detection request
async function handleDetectBPMKey(req: Request, res: Response): Promise<void> {
  const audioUrl = req.body.audioUrl;

  if (!audioUrl) {
    res.status(400).json({ error: "Missing audioUrl parameter" });
    return;
  }

  const startTime = Date.now();
  try {
    const result = await detectBPMAndKey({
      audioUrl: audioUrl as string,
    });

    console.log("[BPM/Key Detection] Detected:", {
      bpm: result.bpm,
      key: result.key,
      audioUrl,
    });

    await trackEvent("fe_bpm_detection_completed", {
      bpm: result.bpm ?? null,
      key: result.key ?? null,
      processing_time_ms: Date.now() - startTime,
      source: "api",
    });

    res.json({
      bpm: result.bpm,
      key: result.key,
    });
  } catch (error) {
    console.error("[BPM/Key Detection] Error:", error);
    const errorMessage = error instanceof Error ? error.message : "Failed to detect BPM and key";
    
    await trackEvent("fe_bpm_detection_error", {
      error_type: "detection_failed",
      error_message: errorMessage,
      processing_time_ms: Date.now() - startTime,
      source: "api",
    });
    
    res.status(500).json({ error: errorMessage });
  }
}

app.post("/api/detect-bpm-key", express.json(), handleDetectBPMKey);

// handleExtractVocals - Handles vocal extraction request
async function handleExtractVocals(req: Request, res: Response): Promise<void> {
  const audioUrl = req.body.audioUrl;
  const trackName = req.body.trackName;
  const file = req.file;

  if (!audioUrl && !file) {
    res.status(400).json({ error: "Either audioUrl or audio file must be provided" });
    return;
  }

  try {
    let resultAudioUrl = audioUrl;

    // If file is uploaded, upload to S3 first to get public URL
    if (file) {
      console.log("[Extract Vocals] Uploading file to S3 first:", {
        fileName: file.originalname,
        size: file.size,
      });

      const result = await generatePresignedUploadUrl(
        file.originalname,
        file.mimetype || "audio/mpeg"
      );

      const s3UploadResponse = await fetch(result.uploadUrl, {
        method: "PUT",
        body: await fs.promises.readFile(file.path),
        headers: {
          "Content-Type": file.mimetype || "audio/mpeg",
        },
      });

      if (!s3UploadResponse.ok) {
        throw new Error("Failed to upload file to S3");
      }

      resultAudioUrl = result.publicUrl;
      console.log("[Extract Vocals] File uploaded to S3:", result.publicUrl);

      // Clean up uploaded file
      try {
        await fs.promises.unlink(file.path);
      } catch {
        // ignore cleanup errors
      }
    }

    if (!resultAudioUrl) {
      res.status(400).json({ error: "No audio URL available" });
      return;
    }

    console.log("[Extract Vocals] Extracting vocals:", {
      audioUrl: resultAudioUrl,
      trackName,
    });

    const startTime = Date.now();
    const result = await separateVoiceFromMusic({
      audioUrl: resultAudioUrl,
      suggestedTrackName: trackName || null,
    });

    console.log("[Extract Vocals] Extraction complete:", {
      trackName: result.trackName,
      vocalsFileName: result.vocalsFileName,
      musicFileName: result.musicFileName,
    });

    await trackEvent("fe_vocal_extraction_completed", {
      vocals_file_name: result.vocalsFileName,
      music_file_name: result.musicFileName,
      processing_time_ms: Date.now() - startTime,
      source: "api",
    });

    res.json({
      vocalsUrl: result.vocalsUrl,
      vocalsFileName: result.vocalsFileName,
      musicUrl: result.musicUrl,
      musicFileName: result.musicFileName,
      trackName: result.trackName,
    });
  } catch (error) {
    console.error("[Extract Vocals] Error:", error);
    const errorMessage = error instanceof Error ? error.message : "Failed to extract vocals";
    
    await trackEvent("fe_vocal_extraction_error", {
      error_type: "extraction_failed",
      error_message: errorMessage,
      source: "api",
    });
    
    res.status(500).json({ error: errorMessage });
  }
}

app.post("/api/extract-vocals", upload.single("audio"), handleExtractVocals);

// handleAnalyticsTrack - Handles analytics event tracking from widget frontend
async function handleAnalyticsTrack(req: Request, res: Response): Promise<void> {
  const { eventName, parameters, sessionId } = req.body;

  if (!eventName || typeof eventName !== "string") {
    res.status(400).json({ error: "Missing or invalid eventName parameter" });
    return;
  }

  console.log("[Analytics] Received event from frontend:", {
    eventName,
    hasParameters: !!parameters,
    hasSessionId: !!sessionId,
    parameterKeys: parameters ? Object.keys(parameters) : [],
  });

  try {
    await trackWidgetEvent(eventName, parameters || {}, sessionId);
    res.json({ success: true });
  } catch (error) {
    console.error("[Analytics] Error tracking event:", error);
    const errorMessage = error instanceof Error ? error.message : "Failed to track event";
    res.status(500).json({ error: errorMessage });
  }
}

app.post("/api/analytics/track", express.json(), handleAnalyticsTrack);

// Error handling middleware to ensure CORS headers are always sent (must be after all routes)
app.use((err: any, req: Request, res: Response, next: express.NextFunction) => {
  // Set CORS headers manually even on errors
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Origin, Content-Type, Accept, *");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  
  if (res.headersSent) {
    return next(err);
  }
  
  // Handle specific error types
  if (err instanceof multer.MulterError) {
    console.error("[Audio Export] Multer error:", {
      code: err.code,
      field: err.field,
      message: err.message,
    });
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ 
        error: "File too large. Maximum file size is 500MB. Please try trimming a shorter segment or selecting a smaller audio portion." 
      });
      return;
    }
  }
  
  // Handle 413 errors that might come from hosting platform (e.g., Vercel's 4.5MB limit)
  if (err.status === 413 || err.statusCode === 413) {
    console.error("[Audio Export] Request too large (likely hosting platform limit):", {
      message: err.message,
    });
    res.status(413).json({ 
      error: "Request too large. Please try trimming a shorter segment. The audio is being automatically downsampled, but very long clips may still exceed limits." 
    });
    return;
  }
  
  // Log other errors for debugging
  console.error("[Audio Export] Unexpected error:", {
    message: err.message,
    stack: err.stack,
    status: err.status || err.statusCode,
  });
  
  // Default error handler
  const status = err.status || err.statusCode || 500;
  const message = err.message || "Internal server error";
  res.status(status).json({ error: message });
});

const { server } = createServer();

// Server setup
const setupServer = async () => {
  try {
    await server.connect(transport);
    console.log("Server connected successfully");
  } catch (error) {
    console.error("Failed to set up the server:", error);
    throw error;
  }
};

// Start server
setupServer()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`MCP Streamable HTTP Server listening on port ${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
  });

// Handle server shutdown
process.on("SIGINT", async () => {
  console.log("Shutting down server...");
  try {
    console.log(`Closing transport`);
    await transport.close();
  } catch (error) {
    console.error(`Error closing transport:`, error);
  }

  try {
    await server.close();
    console.log("Server shutdown complete");
  } catch (error) {
    console.error("Error closing server:", error);
  }
  process.exit(0);
});