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
 * - audio.open_ringtone_editor - Opens the ringtone editor widget (same UI, ringtone-specific format options)
 * - audio.convert_from_url - Converts audio from a public URL to different formats (MP3, WAV, FLAC, OGG, M4A, M4R)
 * - audio.trim_start_of_audio - Trims first 30 seconds with fade in/out
 * - audio.trim_end_of_audio - Trims last 30 seconds with fade in/out
 * - audio.separate_voice_from_music - Separates vocals and music into two tracks
 * - audio.remove_vocals - Removes vocals, returns instrumental only
 * - audio.extract_vocals - Extracts vocals, returns vocal track only
 * - audio.detect_bpm_and_key - Detects BPM and musical key
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
const projectRoot = process.env.VERCEL ? process.cwd() : path.resolve(__dirname, "..");
dotenv.config({ path: path.join(projectRoot, ".env") });
const apiBaseUrl = process.env.BASE_URL;

console.log("process.env.BASE_URL", process.env.BASE_URL);

/* ----------------------------- IMPORTS ----------------------------- */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import fs from "node:fs";

import {
  convertRemoteAudioToFormat,
  trimFirst30Seconds,
  trimLast30Seconds,
  separateVoiceFromMusic,
  detectBPMAndKey,
  AUDIO_EXPORT_FORMATS,
  type AudioExportFormat,
} from "./services/audio.js";
import { trackMCPTool } from "./services/analytics.js";

/* ----------------------------- CONSTANTS ----------------------------- */
const ASSETS_DIR = path.resolve(projectRoot, "dist", "widgets");

/* ----------------------------- HELPER FUNCTIONS ----------------------------- */
// Creates user-friendly error messages
function createUserFriendlyError(error: unknown, context: string): Error {
  const errorMessage = error instanceof Error ? error.message : String(error);
  
  // Map common technical errors to user-friendly messages
  const errorMappings: Record<string, string> = {
    "Failed to download audio": "Couldn't download the audio file. Please check the URL is accessible and try again.",
    "HTTP status 404": "The audio file wasn't found at that URL. Please check the link and try again.",
    "HTTP status 403": "Access to the audio file was denied. The file may be private or require authentication.",
    "Invalid audio format": `This audio format isn't supported. Please use MP3, WAV, M4A, AAC, OGG, or WebM.`,
    "LALALAI_KEY": "Voice separation service is temporarily unavailable. Please try again later.",
    "S3 configuration": "Audio storage is not configured. Please contact support.",
  };
  
  // Check for partial matches
  for (const [key, message] of Object.entries(errorMappings)) {
    if (errorMessage.toLowerCase().includes(key.toLowerCase())) {
      return new Error(message);
    }
  }
  
  // Default: return original error but make it more conversational
  return new Error(`${context} ${errorMessage}`);
}

// Creates follow-up suggestions based on tool and context
function getFollowUpSuggestions(toolName: string, hasAudio: boolean): string[] {
  const suggestions: Record<string, string[]> = {
    "audio.open_audio_editor": [
      "Try adjusting the trim points to select a different section",
      "Add fade in/out effects for smoother transitions",
      "Export in a different format (MP3, WAV, FLAC, OGG, M4A, M4R)",
      "Separate vocals from background audio",
    ],
    "audio.open_ringtone_editor": [
      "Trim to a shorter section (ringtones work best at 30 seconds or less)",
      "Adjust fade effects for a smooth start and end",
      "Export as M4R for iPhone or OGG for Android",
      "Separate vocals from music",
    ],
    "audio.convert_from_url": [
      "Try converting to a different format (MP3, WAV, FLAC, OGG, M4A, M4R)",
      "Open the audio editor for more editing options",
    ],
    "audio.trim_start_of_audio": [
      "Try trimming the end instead",
      "Open the audio editor for custom trim points",
      "Convert to a different format (MP3, WAV, FLAC, OGG, M4A, M4R)",
    ],
    "audio.trim_end_of_audio": [
      "Try trimming the start instead",
      "Open the audio editor for custom trim points",
      "Convert to a different format (MP3, WAV, FLAC, OGG, M4A, M4R)",
    ],
    "audio.separate_voice_from_music": [
      "Open the audio editor to edit the separated tracks",
      "Try removing vocals or extracting vocals separately",
      "Convert to a different format (MP3, WAV, FLAC, OGG, M4A, M4R)",
    ],
    "audio.remove_vocals": [
      "Open the audio editor to edit the instrumental track",
      "Try extracting vocals instead",
      "Convert to a different format (MP3, WAV, FLAC, OGG, M4A, M4R)",
    ],
    "audio.extract_vocals": [
      "Open the audio editor to edit the vocal track",
      "Try removing vocals instead",
      "Convert to a different format (MP3, WAV, FLAC, OGG, M4A, M4R)",
    ],
    "audio.detect_bpm_and_key": [
      "Open the audio editor to edit this track",
      "Try separating vocals from music",
      "Convert to a different format (MP3, WAV, FLAC, OGG, M4A, M4R)",
    ],
  };
  
  return suggestions[toolName] || [];
}

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

  // Inject API base URL, DEBUG flag, and Google Analytics ID from environment variables (for production)
  const debugFlag = process.env.DEBUG ?? "true"; // Default to true (logging enabled)
  const googleAnalyticsId = process.env.GOOGLE_ANALYTICS_ID ?? null;
  
  const html = `
<div id="${componentName}-root"></div>
${css ? `<style>${css}</style>` : ""}
<script>window.__API_BASE_URL__ = ${JSON.stringify(apiBaseUrl)};</script>
<script>window.__DEBUG__ = ${JSON.stringify(debugFlag)};</script>
${googleAnalyticsId ? `<script>window.__GOOGLE_ANALYTICS_ID__ = ${JSON.stringify(googleAnalyticsId)};</script>` : ""}
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
  
  // Build S3 domain patterns - CSP doesn't support wildcards in the middle (e.g., *.s3.*.amazonaws.com)
  // So we need to construct specific patterns based on bucket name and region
  const s3Bucket = process.env.S3_BUCKET;
  const s3Region = process.env.AWS_REGION;
  const s3Domains: string[] = [];
  
  if (s3Bucket && s3Region) {
    // Virtual-hosted style: bucket.s3.region.amazonaws.com
    const virtualHostedDomain = `https://${s3Bucket}.s3.${s3Region}.amazonaws.com`;
    s3Domains.push(virtualHostedDomain);
    // Path-style: s3.region.amazonaws.com
    const pathStyleDomain = `https://s3.${s3Region}.amazonaws.com`;
    s3Domains.push(pathStyleDomain);
    console.log("[CSP] S3 domains configured:", { virtualHostedDomain, pathStyleDomain });
  } else {
    console.warn("[CSP] S3_BUCKET or AWS_REGION not set, using fallback S3 domain");
  }
  // Fallback patterns (less specific but work for any S3 bucket)
  s3Domains.push("https://*.s3.amazonaws.com");
  
  const cspMeta = {
    connect_domains: [
      "https://*.oaiusercontent.com",
      "https://chatgpt.com",
      "https://*.oaistatic.com",
      "https://files.openai.com",
      "https://cdn.openai.com",
      "https://chatgpt-com.web-sandbox.oaiusercontent.com",
      "https://*.blob.core.windows.net",
      "https://www.googletagmanager.com", // GA4 script loading and API calls
      "https://www.google-analytics.com",
      ...s3Domains,
      process.env.CONNECT_DOMAIN,
    ].filter(Boolean),
    resource_domains: [
      "https://*.oaiusercontent.com",
      "https://*.oaistatic.com",
      "https://files.openai.com",
      "https://cdn.openai.com",
      "https://chatgpt-com.web-sandbox.oaiusercontent.com",
      "https://chatgpt.com",
      "https://*.blob.core.windows.net",
      "https://www.googletagmanager.com", // GA4 script loading
      "https://www.google-analytics.com",
      ...s3Domains,
      process.env.CONNECT_DOMAIN,
    ].filter(Boolean),
  };
  
  console.log("[CSP] Final CSP configuration:", JSON.stringify(cspMeta, null, 2));

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
        "Use this when the user wants to edit audio interactively with trimming, fading, and format conversion. Supports MP3, WAV, FLAC, OGG, M4A, M4R formats. Use this for custom trim points, fade adjustments, or when the user wants visual waveform editing. Do not use for simple format conversion without editing - use audio.convert_from_url instead. Do not use for ringtones - use audio.open_ringtone_editor instead.",
      inputSchema: {
        audioFile: z
          .object({
            download_url: z.string().url(),
            file_id: z.string(),
          })
          .optional()
          .describe("Optional audio file uploaded by the user in the chat. Use this when the user attaches an audio file."),
        audioUrl: z
          .string()
          .url()
          .optional()
          .describe("Optional public HTTPS URL to an audio file. Use this when the user provides a direct link to an audio file."),
      },
      _meta: {
        "openai/outputTemplate": audioEditorUri,
        "openai/toolInvocation/invoking": "Opening audio editor",
        "openai/toolInvocation/invoked": "Audio editor displayed",
        "openai/fileParams": ["audioFile"],
      },
      annotations: { readOnlyHint: true },
    },
    async (rawParams) => {
      const { audioFile, audioUrl: providedAudioUrl } = z
        .object({
          audioFile: z
            .object({
              download_url: z.string().url(),
              file_id: z.string(),
            })
            .optional(),
          audioUrl: z
            .string()
            .url()
            .optional()
            .describe("Optional public HTTPS URL to an audio file."),
        })
        .parse(rawParams);

      // Priority: provided audioUrl > audioFile download_url
      const audioUrl = providedAudioUrl ?? audioFile?.download_url ?? null;

      const followUps = getFollowUpSuggestions("audio.open_audio_editor", !!audioUrl);
      const followUpText = followUps.length > 0 
        ? `\n\nYou can:\n${followUps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
        : "";

      return {
        content: [
          {
            type: "text",
            text: audioUrl
              ? `Audio editor is ready with your audio file! Trim sections, tweak fades, and export to your favorite format.${followUpText}`
              : `Audio editor is ready! Upload an audio file or provide a URL to get started.${followUpText}`,
          },
        ],
        structuredContent: {
          audioUrl,
          message: "Audio editor ready",
          defaultFormat: "mp3",
          formats: AUDIO_EXPORT_FORMATS,
          followUpSuggestions: followUps,
        },
        _meta: {
          hasAudioUrl: !!audioUrl,
        },
      };
    },
  );

  /* Ringtone Editor */
  server.registerTool(
    "audio.open_ringtone_editor",
    {
      title: "Open Ringtone Editor",
      description:
        "Use this when the user wants to create or edit a ringtone. Optimized for ringtone creation with format options for iPhone (M4R) and Android (OGG). Use this specifically for ringtones. Do not use for general audio editing - use audio.open_audio_editor instead.",
      inputSchema: {
        audioFile: z
          .object({
            download_url: z.string().url(),
            file_id: z.string(),
          })
          .optional()
          .describe("Optional audio file uploaded by the user in the chat. Use this when the user attaches an audio file."),
        audioUrl: z
          .string()
          .url()
          .optional()
          .describe("Optional public HTTPS URL to an audio file. Use this when the user provides a direct link to an audio file."),
      },
      _meta: {
        "openai/outputTemplate": audioEditorUri,
        "openai/toolInvocation/invoking": "Opening ringtone editor",
        "openai/toolInvocation/invoked": "Ringtone editor displayed",
        "openai/fileParams": ["audioFile"],
      },
      annotations: { readOnlyHint: true },
    },
    async (rawParams) => {
      const { audioFile, audioUrl: providedAudioUrl } = z
        .object({
          audioFile: z
            .object({
              download_url: z.string().url(),
              file_id: z.string(),
            })
            .optional(),
          audioUrl: z
            .string()
            .url()
            .optional()
            .describe("Optional public HTTPS URL to an audio file."),
        })
        .parse(rawParams);

      // Priority: provided audioUrl > audioFile download_url
      const audioUrl = providedAudioUrl ?? audioFile?.download_url ?? null;

      await trackMCPTool("audio.open_ringtone_editor", {
        has_audio_file: !!audioFile,
        has_audio_url: !!audioUrl,
        mode: "ringtone",
      });

      const followUps = getFollowUpSuggestions("audio.open_ringtone_editor", !!audioUrl);
      const followUpText = followUps.length > 0 
        ? `\n\nYou can:\n${followUps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
        : "";

      return {
        content: [
          {
            type: "text",
            text: audioUrl
              ? `Ringtone editor is ready with your audio file! Trim your audio and export it as a ringtone.${followUpText}`
              : `Ringtone editor is ready! Upload an audio file or provide a URL to get started.${followUpText}`,
          },
        ],
        structuredContent: {
          audioUrl,
          message: "Ringtone editor ready",
          defaultFormat: "m4r",
          formats: AUDIO_EXPORT_FORMATS,
          mode: "ringtone",
          followUpSuggestions: followUps,
        },
        _meta: {
          hasAudioUrl: !!audioUrl,
        },
      };
    },
  );

  /* Notify Download Link Tools */
  /* Audio Conversion Tool - Consolidated */
  server.registerTool(
    "audio.convert_from_url",
    {
      title: "Convert Audio Format",
      description:
        "Use this when the user wants to convert an audio file from a public URL to a different format without editing. Supported formats: MP3, WAV, FLAC, OGG, M4A, M4R. Use this for simple format conversion only. Do not use if the user wants to trim, fade, or edit the audio - use audio.open_audio_editor instead. Do not use for unsupported formats. If user didn't specify, process the most recent available audio.",
      inputSchema: {
        audioUrl: z
          .string()
          .url("Provide a valid HTTPS URL to the source audio file.")
          .describe(
            "Public HTTPS URL of the audio to convert. Example: https://cdn.example.com/audio/song.wav",
          ),
        format: z
          .enum([...AUDIO_EXPORT_FORMATS] as [AudioExportFormat, ...AudioExportFormat[]])
          .describe(`Target format: ${AUDIO_EXPORT_FORMATS.join(", ")}`),
        trackName: z
          .string()
          .max(80, "Track name must be 80 characters or fewer.")
          .optional()
          .describe("Optional display name for the exported file. Example: Session_Mix"),
      },
      _meta: {
        "openai/toolInvocation/invoking": "Converting audio format",
        "openai/toolInvocation/invoked": "Audio converted",
      },
      annotations: { readOnlyHint: true },
    },
    async (rawParams) => {
      const { audioUrl, format, trackName } = z
        .object({
          audioUrl: z
            .string()
            .url("Provide a valid HTTPS URL to the source audio file.")
            .describe(
              "Public HTTPS URL of the audio to convert. Example: https://cdn.example.com/audio/song.wav",
            ),
          format: z
            .enum([...AUDIO_EXPORT_FORMATS] as [AudioExportFormat, ...AudioExportFormat[]])
            .describe(`Target format: ${AUDIO_EXPORT_FORMATS.join(", ")}`),
          trackName: z
            .string()
            .max(80, "Track name must be 80 characters or fewer.")
            .optional()
            .describe("Optional display name for the exported file. Example: Session_Mix"),
        })
        .parse(rawParams);
      
      const startTime = Date.now();
      let result;

      try {
        result = await convertRemoteAudioToFormat({
          audioUrl,
          format,
          suggestedTrackName: trackName ?? null,
        });

        console.log("[Audio Export] Converted via MCP tool", {
          format: result.format,
          fileName: result.fileName,
          audioUrl,
        });

        await trackMCPTool(
          "audio.convert_from_url",
          {
            has_audio_url: !!audioUrl,
            has_track_name: !!trackName,
            format,
          },
          {
            success: true,
            result_format: result.format,
            file_name: result.fileName,
            processing_time_ms: Date.now() - startTime,
          }
        );

        await server.server.sendLoggingMessage({
          level: "info",
          data: `🎧 Audio export ready: ${result.trackName} (.${result.format.toUpperCase()})${result.downloadUrl ? ` (${result.downloadUrl})` : ""}`,
        });
      } catch (err) {
        const userFriendlyError = createUserFriendlyError(err, "Failed to convert audio:");
        await trackMCPTool(
          "audio.convert_from_url",
          {
            has_audio_url: !!audioUrl,
            has_track_name: !!trackName,
            format,
          },
          {
            success: false,
            error: userFriendlyError.message,
          }
        );
        throw userFriendlyError;
      }

      const followUps = getFollowUpSuggestions("audio.convert_from_url", true);
      const followUpText = followUps.length > 0 
        ? `\n\nYou can:\n${followUps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
        : "";

      return {
        content: [
          {
            type: "text" as const,
            text: `Audio converted to .${result.format.toUpperCase()}: ${result.fileName}\nDownload: ${result.downloadUrl}${followUpText}`,
          },
        ],
        structuredContent: {
          type: "audioDownload" as const,
          downloadUrl: result.downloadUrl,
          fileName: result.fileName,
          format: result.format,
          followUpSuggestions: followUps,
        },
      };
    },
  );

  /* Trim Tools */
  server.registerTool(
    "audio.trim_start_of_audio",
    {
      title: "Trim Start of Audio",
      description:
        "Use this when the user wants to extract exactly the first 30 seconds of an audio file with automatic fade in/out effects. Use this for quick intro extraction. Do not use if the user wants custom trim points, different duration, or manual fade control - use audio.open_audio_editor instead. Requires audio to be at least 30 seconds long. If user didn't specify, process the most recent available audio.",
      inputSchema: {
        audioUrl: z
          .string()
          .url("Provide a valid HTTPS URL to the source audio file.")
          .describe(
            "Public HTTPS URL of the audio file. Example: https://cdn.example.com/audio/song.mp3",
          ),
        format: z
          .enum([...AUDIO_EXPORT_FORMATS] as [AudioExportFormat, ...AudioExportFormat[]])
          .optional()
          .describe(`Target audio format. Supported options: ${AUDIO_EXPORT_FORMATS.join(", ")}. Defaults to mp3.`),
        trackName: z
          .string()
          .max(80, "Track name must be 80 characters or fewer.")
          .optional()
          .describe("Optional display name for the exported file. Example: Intro_30s"),
      },
      _meta: {
        "openai/toolInvocation/invoking": "Trimming first 30 seconds",
        "openai/toolInvocation/invoked": "First 30 seconds trimmed and ready",
      },
      annotations: { readOnlyHint: true },
    },
    async (rawParams) => {
      const { audioUrl, format, trackName } = z
        .object({
          audioUrl: z
            .string()
            .url("Provide a valid HTTPS URL to the source audio file.")
            .describe(
              "Public HTTPS URL of the audio file. Example: https://cdn.example.com/audio/song.mp3",
            ),
          format: z
            .enum([...AUDIO_EXPORT_FORMATS] as [AudioExportFormat, ...AudioExportFormat[]])
            .optional()
            .describe(`Target audio format. Supported options: ${AUDIO_EXPORT_FORMATS.join(", ")}. Defaults to mp3.`),
          trackName: z
            .string()
            .max(80, "Track name must be 80 characters or fewer.")
            .optional()
            .describe("Optional display name for the exported file. Example: Intro_30s"),
        })
        .parse(rawParams);

      const startTime = Date.now();
      let result;
      let error: string | undefined;

      try {
        result = await trimFirst30Seconds({
          audioUrl,
          format: format ?? "mp3",
          suggestedTrackName: trackName ?? null,
        });

        console.log("[Audio Trim] Trimmed first 30 seconds via MCP tool", {
          format: result.format,
          fileName: result.fileName,
          audioUrl,
        });

        await trackMCPTool(
          "audio.trim_start_of_audio",
          {
            has_audio_url: !!audioUrl,
            has_track_name: !!trackName,
            format: format ?? "mp3",
          },
          {
            success: true,
            result_format: result.format,
            file_name: result.fileName,
            processing_time_ms: Date.now() - startTime,
          }
        );

        await server.server.sendLoggingMessage({
          level: "info",
          data: `🎧 First 30 seconds trimmed: ${result.trackName} (.${result.format.toUpperCase()})${result.downloadUrl ? ` (${result.downloadUrl})` : ""}`,
        });
      } catch (err) {
        const userFriendlyError = createUserFriendlyError(err, "Failed to trim audio:");
        await trackMCPTool(
          "audio.trim_start_of_audio",
          {
            has_audio_url: !!audioUrl,
            has_track_name: !!trackName,
            format: format ?? "mp3",
          },
          {
            success: false,
            error: userFriendlyError.message,
          }
        );
        throw userFriendlyError;
      }

      const followUps = getFollowUpSuggestions("audio.trim_start_of_audio", true);
      const followUpText = followUps.length > 0 
        ? `\n\nYou can:\n${followUps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
        : "";

      return {
        content: [
          {
            type: "text" as const,
            text: `First 30 seconds trimmed (.${result.format}): ${result.fileName}\nDownload: ${result.downloadUrl}${followUpText}`,
          },
        ],
        structuredContent: {
          type: "audioDownload" as const,
          downloadUrl: result.downloadUrl,
          fileName: result.fileName,
          format: result.format,
          followUpSuggestions: followUps,
        },
      };
    },
  );

  server.registerTool(
    "audio.trim_end_of_audio",
    {
      title: "Trim End of Audio",
      description:
        "Use this when the user wants to extract exactly the last 30 seconds of an audio file with automatic fade in/out effects. Use this for quick outro extraction. Do not use if the user wants custom trim points, different duration, or manual fade control - use audio.open_audio_editor instead. Requires audio to be at least 30 seconds long. If user didn't specify, process the most recent available audio.",
      inputSchema: {
        audioUrl: z
          .string()
          .url("Provide a valid HTTPS URL to the source audio file.")
          .describe(
            "Public HTTPS URL of the audio file. Example: https://cdn.example.com/audio/song.mp3",
          ),
        format: z
          .enum([...AUDIO_EXPORT_FORMATS] as [AudioExportFormat, ...AudioExportFormat[]])
          .optional()
          .describe(`Target audio format. Supported options: ${AUDIO_EXPORT_FORMATS.join(", ")}. Defaults to mp3.`),
        trackName: z
          .string()
          .max(80, "Track name must be 80 characters or fewer.")
          .optional()
          .describe("Optional display name for the exported file. Example: Outro_30s"),
      },
      _meta: {
        "openai/toolInvocation/invoking": "Trimming last 30 seconds",
        "openai/toolInvocation/invoked": "Last 30 seconds trimmed and ready",
      },
      annotations: { readOnlyHint: true },
    },
    async (rawParams) => {
      const { audioUrl, format, trackName } = z
        .object({
          audioUrl: z
            .string()
            .url("Provide a valid HTTPS URL to the source audio file.")
            .describe(
              "Public HTTPS URL of the audio file. Example: https://cdn.example.com/audio/song.mp3",
            ),
          format: z
            .enum([...AUDIO_EXPORT_FORMATS] as [AudioExportFormat, ...AudioExportFormat[]])
            .optional()
            .describe(`Target audio format. Supported options: ${AUDIO_EXPORT_FORMATS.join(", ")}. Defaults to mp3.`),
          trackName: z
            .string()
            .max(80, "Track name must be 80 characters or fewer.")
            .optional()
            .describe("Optional display name for the exported file. Example: Outro_30s"),
        })
        .parse(rawParams);

      const startTime = Date.now();
      let result;
      let error: string | undefined;

      try {
        result = await trimLast30Seconds({
          audioUrl,
          format: format ?? "mp3",
          suggestedTrackName: trackName ?? null,
        });

        console.log("[Audio Trim] Trimmed last 30 seconds via MCP tool", {
          format: result.format,
          fileName: result.fileName,
          audioUrl,
        });

        await trackMCPTool(
          "audio.trim_end_of_audio",
          {
            has_audio_url: !!audioUrl,
            has_track_name: !!trackName,
            format: format ?? "mp3",
          },
          {
            success: true,
            result_format: result.format,
            file_name: result.fileName,
            processing_time_ms: Date.now() - startTime,
          }
        );

        await server.server.sendLoggingMessage({
          level: "info",
          data: `🎧 Last 30 seconds trimmed: ${result.trackName} (.${result.format.toUpperCase()})${result.downloadUrl ? ` (${result.downloadUrl})` : ""}`,
        });
      } catch (err) {
        const userFriendlyError = createUserFriendlyError(err, "Failed to trim audio:");
        await trackMCPTool(
          "audio.trim_end_of_audio",
          {
            has_audio_url: !!audioUrl,
            has_track_name: !!trackName,
            format: format ?? "mp3",
          },
          {
            success: false,
            error: userFriendlyError.message,
          }
        );
        throw userFriendlyError;
      }

      const followUps = getFollowUpSuggestions("audio.trim_end_of_audio", true);
      const followUpText = followUps.length > 0 
        ? `\n\nYou can:\n${followUps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
        : "";

      return {
        content: [
          {
            type: "text" as const,
            text: `Last 30 seconds trimmed (.${result.format}): ${result.fileName}\nDownload: ${result.downloadUrl}${followUpText}`,
          },
        ],
        structuredContent: {
          type: "audioDownload" as const,
          downloadUrl: result.downloadUrl,
          fileName: result.fileName,
          format: result.format,
          followUpSuggestions: followUps,
        },
      };
    },
  );

  /* Voice/Music Separation Tool */
  server.registerTool(
    "audio.separate_voice_from_music",
    {
      title: "Separate Voice from Music",
      description:
        "Use this when the user wants to separate vocals from music and get both tracks (vocals and instrumental). Use this when the user explicitly wants both separated tracks. Do not use if the user only wants vocals (use audio.extract_vocals) or only wants instrumental (use audio.remove_vocals). Works best with music that has clear vocal and instrumental separation. If user didn't specify, process the most recent available audio.",
      inputSchema: {
        audioFile: z
          .object({
            download_url: z.string().url(),
            file_id: z.string(),
          })
          .optional()
          .describe("Optional audio file uploaded by the user in the chat. Use this when the user attaches an audio file."),
        audioUrl: z
          .string()
          .url("Provide a valid HTTPS URL to the source audio file.")
          .optional()
          .describe(
            "Optional public HTTPS URL of the audio file to separate. Example: https://cdn.example.com/audio/song.mp3",
          ),
        trackName: z
          .string()
          .max(80, "Track name must be 80 characters or fewer.")
          .optional()
          .describe("Optional display name for the output files. Example: My_Song"),
      },
      _meta: {
        "openai/toolInvocation/invoking": "Separating vocals from music",
        "openai/toolInvocation/invoked": "Voice and music tracks separated",
        "openai/fileParams": ["audioFile"],
      },
      annotations: { readOnlyHint: true },
    },
    async (rawParams) => {
      const { audioFile, audioUrl: providedAudioUrl, trackName } = z
        .object({
          audioFile: z
            .object({
              download_url: z.string().url(),
              file_id: z.string(),
            })
            .optional(),
          audioUrl: z
            .string()
            .url("Provide a valid HTTPS URL to the source audio file.")
            .optional()
            .describe(
              "Optional public HTTPS URL of the audio file to separate. Example: https://cdn.example.com/audio/song.mp3",
            ),
          trackName: z
            .string()
            .max(80, "Track name must be 80 characters or fewer.")
            .optional()
            .describe("Optional display name for the output files. Example: My_Song"),
        })
        .parse(rawParams);

      // Priority: audioFile.download_url > providedAudioUrl
      const audioUrl = audioFile?.download_url ?? providedAudioUrl;
      if (!audioUrl) {
        throw new Error("Either audioFile or audioUrl must be provided");
      }

      const startTime = Date.now();
      let result;
      let error: string | undefined;

      try {
        result = await separateVoiceFromMusic({
          audioUrl,
          suggestedTrackName: trackName ?? null,
        });

        console.log("[Voice Separation] Separated via MCP tool", {
          trackName: result.trackName,
          vocalsFileName: result.vocalsFileName,
          musicFileName: result.musicFileName,
          audioUrl,
        });

        await trackMCPTool(
          "audio.separate_voice_from_music",
          {
            has_audio_file: !!audioFile,
            has_audio_url: !!audioUrl,
            has_track_name: !!trackName,
          },
          {
            success: true,
            vocals_file_name: result.vocalsFileName,
            music_file_name: result.musicFileName,
            processing_time_ms: Date.now() - startTime,
          }
        );

        await server.server.sendLoggingMessage({
          level: "info",
          data: `🎤 Voice separation complete: ${result.trackName}\nVocals: ${result.vocalsFileName}\nMusic: ${result.musicFileName}`,
        });
      } catch (err) {
        const userFriendlyError = createUserFriendlyError(err, "Failed to separate vocals:");
        await trackMCPTool(
          "audio.separate_voice_from_music",
          {
            has_audio_file: !!audioFile,
            has_audio_url: !!audioUrl,
            has_track_name: !!trackName,
          },
          {
            success: false,
            error: userFriendlyError.message,
          }
        );
        throw userFriendlyError;
      }

      const followUps = getFollowUpSuggestions("audio.separate_voice_from_music", true);
      const followUpText = followUps.length > 0 
        ? `\n\nYou can:\n${followUps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
        : "";

      return {
        content: [
          {
            type: "text" as const,
            text: `Voice and music separated successfully!\n\nVocals: ${result.vocalsFileName}\nDownload: ${result.vocalsUrl}\n\nMusic: ${result.musicFileName}\nDownload: ${result.musicUrl}${followUpText}`,
          },
        ],
        structuredContent: {
          type: "audioSeparation" as const,
          vocals: {
            downloadUrl: result.vocalsUrl,
            fileName: result.vocalsFileName,
          },
          music: {
            downloadUrl: result.musicUrl,
            fileName: result.musicFileName,
          },
          trackName: result.trackName,
          followUpSuggestions: followUps,
        },
      };
    },
  );

  /* Remove Vocals Tool */
  server.registerTool(
    "audio.remove_vocals",
    {
      title: "Remove Vocals",
      description:
        "Use this when the user wants to remove vocals from audio and get only the instrumental/background music track. Use this when the user explicitly wants instrumental only. Do not use if the user wants both tracks (use audio.separate_voice_from_music) or only vocals (use audio.extract_vocals). Works best with music that has clear vocal and instrumental separation. If user didn't specify, process the most recent available audio.",
      inputSchema: {
        audioFile: z
          .object({
            download_url: z.string().url(),
            file_id: z.string(),
          })
          .optional()
          .describe("Optional audio file uploaded by the user in the chat. Use this when the user attaches an audio file."),
        audioUrl: z
          .string()
          .url("Provide a valid HTTPS URL to the source audio file.")
          .optional()
          .describe(
            "Optional public HTTPS URL of the audio file to remove vocals from. Example: https://cdn.example.com/audio/song.mp3",
          ),
        trackName: z
          .string()
          .max(80, "Track name must be 80 characters or fewer.")
          .optional()
          .describe("Optional display name for the output file. Example: My_Song_Instrumental"),
      },
      _meta: {
        "openai/toolInvocation/invoking": "Removing vocals from audio",
        "openai/toolInvocation/invoked": "Vocals removed, instrumental track ready",
        "openai/fileParams": ["audioFile"],
      },
      annotations: { readOnlyHint: true },
    },
    async (rawParams) => {
      const { audioFile, audioUrl: providedAudioUrl, trackName } = z
        .object({
          audioFile: z
            .object({
              download_url: z.string().url(),
              file_id: z.string(),
            })
            .optional(),
          audioUrl: z
            .string()
            .url("Provide a valid HTTPS URL to the source audio file.")
            .optional()
            .describe(
              "Optional public HTTPS URL of the audio file to remove vocals from. Example: https://cdn.example.com/audio/song.mp3",
            ),
          trackName: z
            .string()
            .max(80, "Track name must be 80 characters or fewer.")
            .optional()
            .describe("Optional display name for the output file. Example: My_Song_Instrumental"),
        })
        .parse(rawParams);

      // Priority: audioFile.download_url > providedAudioUrl
      const audioUrl = audioFile?.download_url ?? providedAudioUrl;
      if (!audioUrl) {
        throw new Error("Either audioFile or audioUrl must be provided");
      }

      const startTime = Date.now();
      let result;
      let error: string | undefined;

      try {
        result = await separateVoiceFromMusic({
          audioUrl,
          suggestedTrackName: trackName ?? null,
        });

        console.log("[Remove Vocals] Removed vocals via MCP tool", {
          trackName: result.trackName,
          musicFileName: result.musicFileName,
          audioUrl,
        });

        await trackMCPTool(
          "audio.remove_vocals",
          {
            has_audio_file: !!audioFile,
            has_audio_url: !!audioUrl,
            has_track_name: !!trackName,
          },
          {
            success: true,
            music_file_name: result.musicFileName,
            processing_time_ms: Date.now() - startTime,
          }
        );

        await server.server.sendLoggingMessage({
          level: "info",
          data: `🎵 Vocals removed: ${result.trackName}\nInstrumental: ${result.musicFileName}`,
        });
      } catch (err) {
        const userFriendlyError = createUserFriendlyError(err, "Failed to remove vocals:");
        await trackMCPTool(
          "audio.remove_vocals",
          {
            has_audio_file: !!audioFile,
            has_audio_url: !!audioUrl,
            has_track_name: !!trackName,
          },
          {
            success: false,
            error: userFriendlyError.message,
          }
        );
        throw userFriendlyError;
      }

      const followUps = getFollowUpSuggestions("audio.remove_vocals", true);
      const followUpText = followUps.length > 0 
        ? `\n\nYou can:\n${followUps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
        : "";

      return {
        content: [
          {
            type: "text" as const,
            text: `Vocals removed successfully!\n\nInstrumental track: ${result.musicFileName}\nDownload: ${result.musicUrl}${followUpText}`,
          },
        ],
        structuredContent: {
          type: "audioDownload" as const,
          downloadUrl: result.musicUrl,
          fileName: result.musicFileName,
          format: "instrumental",
          followUpSuggestions: followUps,
        },
      };
    },
  );

  /* Extract Vocals Tool */
  server.registerTool(
    "audio.extract_vocals",
    {
      title: "Extract Vocals",
      description:
        "Use this when the user wants to extract vocals from audio and get only the vocal track without music. Use this when the user explicitly wants vocals only. Do not use if the user wants both tracks (use audio.separate_voice_from_music) or only instrumental (use audio.remove_vocals). Works best with music that has clear vocal and instrumental separation. If user didn't specify, process the most recent available audio.",
      inputSchema: {
        audioFile: z
          .object({
            download_url: z.string().url(),
            file_id: z.string(),
          })
          .optional()
          .describe("Optional audio file uploaded by the user in the chat. Use this when the user attaches an audio file."),
        audioUrl: z
          .string()
          .url("Provide a valid HTTPS URL to the source audio file.")
          .optional()
          .describe(
            "Optional public HTTPS URL of the audio file to extract vocals from. Example: https://cdn.example.com/audio/song.mp3",
          ),
        trackName: z
          .string()
          .max(80, "Track name must be 80 characters or fewer.")
          .optional()
          .describe("Optional display name for the output file. Example: My_Song_Vocals"),
      },
      _meta: {
        "openai/toolInvocation/invoking": "Extracting vocals from audio",
        "openai/toolInvocation/invoked": "Vocals extracted, vocal track ready",
        "openai/fileParams": ["audioFile"],
      },
      annotations: { readOnlyHint: true },
    },
    async (rawParams) => {
      const { audioFile, audioUrl: providedAudioUrl, trackName } = z
        .object({
          audioFile: z
            .object({
              download_url: z.string().url(),
              file_id: z.string(),
            })
            .optional(),
          audioUrl: z
            .string()
            .url("Provide a valid HTTPS URL to the source audio file.")
            .optional()
            .describe(
              "Optional public HTTPS URL of the audio file to extract vocals from. Example: https://cdn.example.com/audio/song.mp3",
            ),
          trackName: z
            .string()
            .max(80, "Track name must be 80 characters or fewer.")
            .optional()
            .describe("Optional display name for the output file. Example: My_Song_Vocals"),
        })
        .parse(rawParams);

      // Priority: audioFile.download_url > providedAudioUrl
      const audioUrl = audioFile?.download_url ?? providedAudioUrl;
      if (!audioUrl) {
        throw new Error("Either audioFile or audioUrl must be provided");
      }

      const startTime = Date.now();
      let result;
      let error: string | undefined;

      try {
        result = await separateVoiceFromMusic({
          audioUrl,
          suggestedTrackName: trackName ?? null,
        });

        console.log("[Extract Vocals] Extracted vocals via MCP tool", {
          trackName: result.trackName,
          vocalsFileName: result.vocalsFileName,
          audioUrl,
        });

        await trackMCPTool(
          "audio.extract_vocals",
          {
            has_audio_file: !!audioFile,
            has_audio_url: !!audioUrl,
            has_track_name: !!trackName,
          },
          {
            success: true,
            vocals_file_name: result.vocalsFileName,
            processing_time_ms: Date.now() - startTime,
          }
        );

        await server.server.sendLoggingMessage({
          level: "info",
          data: `🎤 Vocals extracted: ${result.trackName}\nVocals: ${result.vocalsFileName}`,
        });
      } catch (err) {
        const userFriendlyError = createUserFriendlyError(err, "Failed to extract vocals:");
        await trackMCPTool(
          "audio.extract_vocals",
          {
            has_audio_file: !!audioFile,
            has_audio_url: !!audioUrl,
            has_track_name: !!trackName,
          },
          {
            success: false,
            error: userFriendlyError.message,
          }
        );
        throw userFriendlyError;
      }

      const followUps = getFollowUpSuggestions("audio.extract_vocals", true);
      const followUpText = followUps.length > 0 
        ? `\n\nYou can:\n${followUps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
        : "";

      return {
        content: [
          {
            type: "text" as const,
            text: `Vocals extracted successfully!\n\nVocal track: ${result.vocalsFileName}\nDownload: ${result.vocalsUrl}${followUpText}`,
          },
        ],
        structuredContent: {
          type: "audioDownload" as const,
          downloadUrl: result.vocalsUrl,
          fileName: result.vocalsFileName,
          format: "vocals",
          followUpSuggestions: followUps,
        },
      };
    },
  );

  /* BPM and Key Detection Tool */
  server.registerTool(
    "audio.detect_bpm_and_key",
    {
      title: "Detect BPM and Key",
      description:
        "Use this when the user wants to analyze audio to detect BPM (beats per minute/tempo) and musical key. Use this for music analysis, DJ mixing, or music production purposes. Do not use for editing, conversion, or separation - this tool only provides analysis information. Works best with music tracks that have clear rhythm and harmonic content. If user didn't specify, process the most recent available audio.",
      inputSchema: {
        audioFile: z
          .object({
            download_url: z.string().url(),
            file_id: z.string(),
          })
          .optional()
          .describe("Optional audio file uploaded by the user in the chat. Use this when the user attaches an audio file."),
        audioUrl: z
          .string()
          .url("Provide a valid HTTPS URL to the source audio file.")
          .optional()
          .describe(
            "Optional public HTTPS URL of the audio file to analyze. Example: https://cdn.example.com/audio/song.mp3",
          ),
      },
      _meta: {
        "openai/toolInvocation/invoking": "Analyzing audio for BPM and key",
        "openai/toolInvocation/invoked": "BPM and key detected",
        "openai/fileParams": ["audioFile"],
      },
      annotations: { readOnlyHint: true },
    },
    async (rawParams) => {
      const { audioFile, audioUrl: providedAudioUrl } = z
        .object({
          audioFile: z
            .object({
              download_url: z.string().url(),
              file_id: z.string(),
            })
            .optional(),
          audioUrl: z
            .string()
            .url("Provide a valid HTTPS URL to the source audio file.")
            .optional()
            .describe(
              "Optional public HTTPS URL of the audio file to analyze. Example: https://cdn.example.com/audio/song.mp3",
            ),
        })
        .parse(rawParams);

      // Priority: audioFile.download_url > providedAudioUrl
      const audioUrl = audioFile?.download_url ?? providedAudioUrl;
      if (!audioUrl) {
        throw new Error("Either audioFile or audioUrl must be provided");
      }

      const startTime = Date.now();
      let result;
      let error: string | undefined;

      try {
        result = await detectBPMAndKey({
          audioUrl,
        });

        console.log("[BPM/Key Detection] Detected via MCP tool", {
          bpm: result.bpm,
          key: result.key,
          audioUrl,
        });

        await trackMCPTool(
          "audio.detect_bpm_and_key",
          {
            has_audio_file: !!audioFile,
            has_audio_url: !!audioUrl,
          },
          {
            success: true,
            bpm: result.bpm ?? null,
            key: result.key ?? null,
            processing_time_ms: Date.now() - startTime,
          }
        );

        const bpmText = result.bpm ? `${result.bpm} BPM` : "BPM detection failed";
        const keyText = result.key ? result.key : "Key detection failed";

        await server.server.sendLoggingMessage({
          level: "info",
          data: `🎵 Audio analysis complete:\nBPM: ${bpmText}\nKey: ${keyText}`,
        });

        const followUps = getFollowUpSuggestions("audio.detect_bpm_and_key", true);
        const followUpText = followUps.length > 0 
          ? `\n\nYou can:\n${followUps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
          : "";

        return {
          content: [
            {
              type: "text" as const,
              text: `Audio analysis complete!\n\nBPM: ${bpmText}\nKey: ${keyText}${followUpText}`,
            },
          ],
          structuredContent: {
            type: "audioAnalysis" as const,
            bpm: result.bpm,
            key: result.key,
            followUpSuggestions: followUps,
          },
        };
      } catch (err) {
        const userFriendlyError = createUserFriendlyError(err, "Failed to analyze audio:");
        await trackMCPTool(
          "audio.detect_bpm_and_key",
          {
            has_audio_file: !!audioFile,
            has_audio_url: !!audioUrl,
          },
          {
            success: false,
            error: userFriendlyError.message,
          }
        );
        throw userFriendlyError;
      }
    },
  );

  server.registerTool(
    "audio.notify_download_link_ready",
    {
      title: "Share Generated Audio Link",
      description:
        "Use this when a generated audio file has finished uploading to a public URL and needs to be shared with the user for download. Use this only after the file upload is complete. Do not use before the export has finished uploading. This tool is typically called by the widget after processing completes.",
      inputSchema: {
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
        format: z
          .enum([...AUDIO_EXPORT_FORMATS] as [AudioExportFormat, ...AudioExportFormat[]])
          .optional()
          .describe(`Target audio format. Supported options: ${AUDIO_EXPORT_FORMATS.join(", ")}. Example: mp3`),
      },
      _meta: {
        "openai/toolInvocation/invoking": "Sharing audio download link",
        "openai/toolInvocation/invoked": "Audio download link shared",
        "openai/widgetAccessible": true
      },
      annotations: { readOnlyHint: true },
    },
    async (rawParams: any) => {
      const { downloadUrl, fileName, format } = rawParams;
      const safeFileName = fileName ?? "audio";
      const label = format ? `${format.toUpperCase()} audio` : "audio";
      const structuredContent = {
        type: "audioDownload",
        downloadUrl,
        fileName: safeFileName,
        format: format ?? null,
      };

      await trackMCPTool("audio.notify_download_link_ready", {
        has_download_url: !!downloadUrl,
        has_file_name: !!fileName,
        format: format ?? null,
      });

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

  console.log("MCP server registered");
  return { server };
};
