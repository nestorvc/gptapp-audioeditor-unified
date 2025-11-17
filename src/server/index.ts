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
import express, { type Express, type Request, type Response } from "express";
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
    fileSize: 100 * 1024 * 1024, // 100MB
  },
});

// handleAudioExport - Handles the audio export request
async function handleAudioExport(req: Request, res: Response): Promise<void> {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "Missing audio file" });
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
    res.status(500).json({ error: "Failed to export audio" });
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
const app: Express = express();

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

const { server } = createServer();

// Server setup - initialize connection (lazy for Vercel, eager for local)
let serverSetupPromise: Promise<void> | null = null;

const setupServer = async () => {
  if (serverSetupPromise) {
    return serverSetupPromise;
  }
  
  serverSetupPromise = (async () => {
    try {
      await server.connect(transport);
      console.log("Server connected successfully");
    } catch (error) {
      console.error("Failed to set up the server:", error);
      serverSetupPromise = null; // Reset on error so it can retry
      throw error;
    }
  })();
  
  return serverSetupPromise;
};

// MCP endpoint - ensure server is initialized before handling requests
app.post("/mcp", async (req: Request, res: Response) => {
  try {
    await setupServer();
  } catch (error) {
    console.error("Failed to initialize server:", error);
    if (!res.headersSent) {
      res.status(503).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Server initialization failed",
        },
        id: null,
      });
    }
    return;
  }
  
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

// Handle server shutdown (only for local development)
if (!process.env.VERCEL) {
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

  // Start server for local development
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
}

// Export for Vercel serverless
export default app;