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
import { finalizeLocalAudioExport } from "./services/audio.js";

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