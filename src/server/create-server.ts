/**
 * CREATE-SERVER.TS - MCP Server Factory for Audio Editor Widget
 * 
 * This file creates and configures an MCP (Model Context Protocol) server that provides
 * an interactive widget for audio editing within ChatGPT.
 * 
 * Key Features:
 * - Creates and configures an MCP server instance
 * - Registers widget resource (audio-editor) that loads React component
 * - Registers tools for opening editor, converting audio formats, and notifying download links
 * - Loads and inlines widget assets (JS, CSS) into self-contained HTML
 * - Injects API base URL from environment variables for production use
 * - Sends structured logging messages to MCP client for monitoring
 * 
 * Widgets:
 * - Audio Editor: General-purpose editor for trimming, enhancing, and exporting audio
 * 
 * MCP Resources:
 * - audio-editor-widget (ui://widget/audio-editor.html) - Audio editor widget
 * 
 * MCP Tools:
 * - audio.open_audio_editor - Opens the audio editor widget
 * - audio.convert_to_mp3 - Converts remote audio URL to MP3 format
 * - audio.convert_to_wav - Converts remote audio URL to WAV format
 * - audio.convert_to_flac - Converts remote audio URL to FLAC format
 * - audio.convert_to_ogg - Converts remote audio URL to OGG (Opus) format
 * - audio.convert_to_m4a - Converts remote audio URL to M4A (AAC) format
 * - audio.notify_download_link_ready - Notifies ChatGPT about audio download links
 * 
 * The widgets are loaded from the build/widgets directory and inlined as self-contained HTML
 * with embedded CSS and JavaScript for use within ChatGPT's Skybridge framework.
 */

/* ----------------------------- ENV VARS ----------------------------- */
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = process.env.VERCEL ? process.cwd() : path.resolve(__dirname, "../..");
dotenv.config({ path: path.join(projectRoot, ".env") });
const apiBaseUrl = process.env.BASE_URL;

/* ----------------------------- IMPORTS ----------------------------- */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import fs from "node:fs";

import {
  convertRemoteAudioToFormat,
  AUDIO_EXPORT_FORMATS,
  type AudioExportFormat,
} from "./services/audio.js";

/* ----------------------------- CONSTANTS ----------------------------- */
const ASSETS_DIR = path.resolve(projectRoot, "dist", "widgets");

/* ----------------------------- HELPER FUNCTIONS ----------------------------- */
// Loads and inlines React widget assets (JS, CSS) into self-contained HTML
function loadWidgetHtml(componentName: string): string {
  if (!fs.existsSync(ASSETS_DIR)) {
    throw new Error(
      `Widget assets not found. Expected directory ${ASSETS_DIR}. Build assets before starting the server.`,
    );
  }

  const jsPath = path.join(ASSETS_DIR, `${componentName}.js`);
  if (!fs.existsSync(jsPath)) {
    throw new Error(
      `Widget JS for "${componentName}" not found at ${jsPath}. Build assets first.`,
    );
  }
  const js = fs.readFileSync(jsPath, "utf8");

  const cssPath = path.join(ASSETS_DIR, `${componentName}.css`);
  const css = (() => {
    try {
      return fs.readFileSync(cssPath, "utf8");
    } catch {
      return "";
    }
  })();

  // Inject API base URL from environment variable (for production)
  
  const html = `
<div id="${componentName}-root"></div>
${css ? `<style>${css}</style>` : ""}
<script>window.__API_BASE_URL__ = ${JSON.stringify(apiBaseUrl)};</script>
<script type="module">${js}</script>
  `.trim();

  return html;
}

/* ----------------------------- MAIN MCP SERVER FUNCTION ----------------------------- */
export const createServer = () => {
  console.log("Registering MCP server");

  // Create server instance
  const server = new McpServer({
    name: "audio-editor-server",
    version: "1.0.0",
  });

  const audioEditorUri = "ui://widget/audio-editor.html";
  const cspMeta = {
    connect_domains: [
      "https://chatgpt.com",
      "https://*.oaistatic.com",
      "https://files.openai.com",
      "https://cdn.openai.com",
      process.env.CONNECT_DOMAIN,
    ],
    resource_domains: [
      "https://*.oaistatic.com",
      "https://files.openai.com",
      "https://cdn.openai.com",
      "https://chatgpt.com",
    ],
  };

  /* ----------------------------- MCP RESOURCES ----------------------------- */
  /* Audio Editor */
  server.registerResource(
    "audio-editor-widget",
    audioEditorUri,
    {},
    async () => ({
      contents: [
        {
          uri: audioEditorUri,
          mimeType: "text/html+skybridge",
          text: loadWidgetHtml("audio-editor"),
          _meta: {
            "openai/widgetDescription":
              "An audio editor for trimming, sweetening, and exporting tracks in multiple formats.",
            "openai/widgetPrefersBorder": true,
            "openai/widgetDomain": "https://chatgpt.com",
            "openai/widgetCSP": cspMeta,
          },
        },
      ],
    }),
  );

  /* ----------------------------- MCP TOOLS ----------------------------- */
  /* Audio Editor */
  server.registerTool(
    "audio.open_audio_editor",
    {
      title: "Open Audio Editor",
      description:
        "Use this when the user wants to trim, cut, fade, preview, or enhance an audio clip and export it to formats like MP3, WAV, FLAC, OGG, or M4A.",
      inputSchema: {},
      _meta: {
        "openai/outputTemplate": audioEditorUri,
        "openai/toolInvocation/invoking": "Opening audio editor",
        "openai/toolInvocation/invoked": "Audio editor displayed",
      },
      annotations: { readOnlyHint: true },
    },
    async () => ({
      content: [
        {
          type: "text",
          text: "Audio editor is ready! Trim sections, tweak fades, and export to your favorite format.",
        },
      ],
      structuredContent: {
        audioUrl: null,
        message: "Audio editor ready",
        defaultFormat: "mp3",
        formats: AUDIO_EXPORT_FORMATS,
      },
      _meta: {
        hasAudioUrl: false,
      },
    }),
  );

  /* Notify Download Link Tools */
  const registerNotifyDownloadLinkTool = ({
    toolName,
    title,
    description,
    invoking,
    invoked,
    defaultFileName,
    extraField,
  }: {
    toolName: string;
    title: string;
    description: string;
    invoking: string;
    invoked: string;
    defaultFileName: string;
    extraField?: {
      name: "format";
      schema: z.ZodTypeAny;
      describe: string;
    };
  }) => {
    const baseSchema = {
      downloadUrl: z
        .string()
        .url("Provide a valid HTTPS URL for the audio download.")
        .describe(
          "Public HTTPS URL where the generated audio can be downloaded. Example: https://downloads.example.com/audio/final.mp3",
        ),
      fileName: z
        .string()
        .max(120, "File name must be 120 characters or fewer.")
        .optional()
        .describe("Suggested file name shown to the user. Example: Final.mp3"),
    };

    const inputSchema = extraField
      ? { ...baseSchema, [extraField.name]: extraField.schema.optional().describe(extraField.describe) }
      : baseSchema;

    server.registerTool(
      toolName,
      {
        title,
        description,
        inputSchema,
        _meta: {
          "openai/toolInvocation/invoking": invoking,
          "openai/toolInvocation/invoked": invoked,
        },
        annotations: { readOnlyHint: true },
      },
      async (rawParams: any) => {
        const { downloadUrl, fileName, ...extra } = rawParams;
        const safeFileName = fileName ?? defaultFileName;

        const format = extra.format;
        const label = format ? `${format.toUpperCase()} audio` : "audio";
        const structuredContent = {
          type: "audioDownload",
          downloadUrl,
          fileName: safeFileName,
          format: format ?? null,
        };

        console.log(`[MCP NOTIFIER] Notified ChatGPT about audio download URL.`);
        return {
          content: [
            {
              type: "text" as const,
              text: `Here is the generated ${label}: ${safeFileName}`,
            },
          ],
          structuredContent,
        };
      },
    );
  };

  /* Audio Conversion Tools */
  const registerAudioConversionTool = ({
    format,
    toolName,
    title,
    description,
    invoking,
    invoked,
  }: {
    format: AudioExportFormat;
    toolName: string;
    title: string;
    description: string;
    invoking: string;
    invoked: string;
  }) => {
    server.registerTool(
      toolName,
      {
        title,
        description,
        inputSchema: {
          audioUrl: z
            .string()
            .url("Provide a valid HTTPS URL to the source audio file.")
            .describe(
              "Public HTTPS URL of the audio to convert into the selected export format. Example: https://cdn.example.com/audio/song.wav",
            ),
          trackName: z
            .string()
            .max(80, "Track name must be 80 characters or fewer.")
            .optional()
            .describe("Optional display name for the exported file. Example: Session_Mix"),
        },
        _meta: {
          "openai/toolInvocation/invoking": invoking,
          "openai/toolInvocation/invoked": invoked,
        },
        annotations: { readOnlyHint: true },
      },
      async (rawParams) => {
        const { audioUrl, trackName } = z
          .object({
            audioUrl: z
              .string()
              .url("Provide a valid HTTPS URL to the source audio file.")
              .describe(
                "Public HTTPS URL of the audio to convert into the selected export format. Example: https://cdn.example.com/audio/song.wav",
              ),
            trackName: z
              .string()
              .max(80, "Track name must be 80 characters or fewer.")
              .optional()
              .describe("Optional display name for the exported file. Example: Session_Mix"),
          })
          .describe("Request parameters for generating a hosted audio download in the selected format.")
          .parse(rawParams);
        const result = await convertRemoteAudioToFormat({
          audioUrl,
          format,
          suggestedTrackName: trackName ?? null,
        });

        console.log("[Audio Export] Converted via MCP tool", {
          format: result.format,
          fileName: result.fileName,
          audioUrl,
        });

        await server.server.sendLoggingMessage({
          level: "info",
          data: `🎧 Audio export ready: ${result.trackName} (.${result.format.toUpperCase()})${result.downloadUrl ? ` (${result.downloadUrl})` : ""}`,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `Audio export ready (.${result.format}): ${result.fileName}\nDownload: ${result.downloadUrl}`,
            },
          ],
          structuredContent: {
            type: "audioDownload" as const,
            downloadUrl: result.downloadUrl,
            fileName: result.fileName,
            format: result.format,
          },
        };
      },
    );
  };

  registerAudioConversionTool({
    format: "mp3",
    toolName: "audio.convert_to_mp3",
    title: "Convert Audio to MP3 (.mp3)",
    description:
      "Use this when a user provides a remote audio URL that should become a downloadable MP3 file. Do not use for ringtone-specific exports.",
    invoking: "Converting audio to MP3",
    invoked: "MP3 download ready",
  });

  registerAudioConversionTool({
    format: "wav",
    toolName: "audio.convert_to_wav",
    title: "Convert Audio to WAV (.wav)",
    description:
      "Use this when a user provides a remote audio URL that should become a downloadable uncompressed WAV file. Do not use for ringtone-specific exports.",
    invoking: "Converting audio to WAV",
    invoked: "WAV download ready",
  });

  registerAudioConversionTool({
    format: "flac",
    toolName: "audio.convert_to_flac",
    title: "Convert Audio to FLAC (.flac)",
    description:
      "Use this when a user provides a remote audio URL that should become a downloadable lossless FLAC file. Do not use for ringtone-specific exports.",
    invoking: "Converting audio to FLAC",
    invoked: "FLAC download ready",
  });

  registerAudioConversionTool({
    format: "ogg",
    toolName: "audio.convert_to_ogg",
    title: "Convert Audio to OGG (.ogg)",
    description:
      "Use this when a user provides a remote audio URL that should become a downloadable OGG (Opus) file. Do not use for ringtone-specific exports.",
    invoking: "Converting audio to OGG",
    invoked: "OGG download ready",
  });

  registerAudioConversionTool({
    format: "m4a",
    toolName: "audio.convert_to_m4a",
    title: "Convert Audio to M4A (.m4a)",
    description:
      "Use this when a user provides a remote audio URL that should become a downloadable M4A (AAC) file. Do not use for ringtone-specific exports.",
    invoking: "Converting audio to M4A",
    invoked: "M4A download ready",
  });

  registerNotifyDownloadLinkTool({
    toolName: "audio.notify_download_link_ready",
    title: "Share Generated Audio Link",
    description:
      "Use this when the final audio file is hosted at a public URL and needs to be shared with the user for download. Do not use before the export has finished uploading.",
    invoking: "Sharing audio download link",
    invoked: "Audio download link shared",
    defaultFileName: "audio",
    extraField: {
      name: "format",
      schema: z.enum([...AUDIO_EXPORT_FORMATS] as [AudioExportFormat, ...AudioExportFormat[]]),
      describe: `Target audio format. Supported options: ${AUDIO_EXPORT_FORMATS.join(", ")}. Example: mp3`,
    },
  });

  console.log("MCP server registered");
  return { server };
};
