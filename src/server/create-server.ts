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
 * - audio.convert_to_mp3 - Converts remote audio URL to MP3 format
 * - audio.convert_to_wav - Converts remote audio URL to WAV format
 * - audio.convert_to_flac - Converts remote audio URL to FLAC format
 * - audio.convert_to_ogg - Converts remote audio URL to OGG (Opus) format
 * - audio.convert_to_m4a - Converts remote audio URL to M4A (AAC) format
 * - audio.convert_to_m4r - Converts remote audio URL to M4R (iOS ringtone) format
 * - audio.trim_first_30_seconds - Trims first 30 seconds with fade in/out
 * - audio.trim_last_30_seconds - Trims last 30 seconds with fade in/out
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
        "Use this when the user wants to trim, cut, fade, preview, or enhance an audio file and export it to formats like MP3, WAV, FLAC, OGG, or M4A.",
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

      return {
        content: [
          {
            type: "text",
            text: audioUrl
              ? "Audio editor is ready with your audio file! Trim sections, tweak fades, and export to your favorite format."
              : "Audio editor is ready! Trim sections, tweak fades, and export to your favorite format.",
          },
        ],
        structuredContent: {
          audioUrl,
          message: "Audio editor ready",
          defaultFormat: "mp3",
          formats: AUDIO_EXPORT_FORMATS,
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
        "Use this when the user wants to create or edit a ringtone by trimming an audio file, adjusting fades, and exporting it.",
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

      return {
        content: [
          {
            type: "text",
            text: audioUrl
              ? "Ringtone editor is ready with your audio file! Trim your audio and export it as a ringtone."
              : "Ringtone editor is ready! Trim your audio and export it as a ringtone.",
          },
        ],
        structuredContent: {
          audioUrl,
          message: "Ringtone editor ready",
          defaultFormat: "m4r",
          formats: AUDIO_EXPORT_FORMATS,
          mode: "ringtone",
        },
        _meta: {
          hasAudioUrl: !!audioUrl,
        },
      };
    },
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

        await trackMCPTool(toolName, {
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
        
        const startTime = Date.now();
        let result;
        let error: string | undefined;

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
            toolName,
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
          error = err instanceof Error ? err.message : "Unknown error";
          await trackMCPTool(
            toolName,
            {
              has_audio_url: !!audioUrl,
              has_track_name: !!trackName,
              format,
            },
            {
              success: false,
              error,
            }
          );
          throw err;
        }

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
      "Use this when a user provides a remote audio URL that should become a downloadable MP3 file.",
    invoking: "Converting audio to MP3",
    invoked: "MP3 download ready",
  });

  registerAudioConversionTool({
    format: "wav",
    toolName: "audio.convert_to_wav",
    title: "Convert Audio to WAV (.wav)",
    description:
      "Use this when a user provides a remote audio URL that should become a downloadable uncompressed WAV file.",
    invoking: "Converting audio to WAV",
    invoked: "WAV download ready",
  });

  registerAudioConversionTool({
    format: "flac",
    toolName: "audio.convert_to_flac",
    title: "Convert Audio to FLAC (.flac)",
    description:
      "Use this when a user provides a remote audio URL that should become a downloadable lossless FLAC file.",
    invoking: "Converting audio to FLAC",
    invoked: "FLAC download ready",
  });

  registerAudioConversionTool({
    format: "ogg",
    toolName: "audio.convert_to_ogg",
    title: "Convert Audio to OGG (.ogg)",
    description:
      "Use this when a user provides a remote audio URL that should become a downloadable OGG (Opus) file.",
    invoking: "Converting audio to OGG",
    invoked: "OGG download ready",
  });

  registerAudioConversionTool({
    format: "m4a",
    toolName: "audio.convert_to_m4a",
    title: "Convert Audio to M4A (.m4a)",
    description:
      "Use this when a user provides a remote audio URL that should become a downloadable M4A (AAC) file.",
    invoking: "Converting audio to M4A",
    invoked: "M4A download ready",
  });

  registerAudioConversionTool({
    format: "m4r",
    toolName: "audio.convert_to_m4r",
    title: "Convert Audio to M4R (.m4r)",
    description:
      "Use this when a user provides a remote audio URL that should become a downloadable M4R (iOS ringtone) file.",
    invoking: "Converting audio to M4R",
    invoked: "M4R download ready",
  });

  /* Trim Tools */
  server.registerTool(
    "audio.trim_start_of_audio",
    {
      title: "Trim Start of Audio",
      description:
        "Use this when a user wants to extract the start of an audio file. Automatically applies fade in and fade out effects.",
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
        error = err instanceof Error ? err.message : "Unknown error";
        await trackMCPTool(
          "audio.trim_start_of_audio",
          {
            has_audio_url: !!audioUrl,
            has_track_name: !!trackName,
            format: format ?? "mp3",
          },
          {
            success: false,
            error,
          }
        );
        throw err;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `First 30 seconds trimmed (.${result.format}): ${result.fileName}\nDownload: ${result.downloadUrl}`,
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

  server.registerTool(
    "audio.trim_end_of_audio",
    {
      title: "Trim End of Audio",
      description:
        "Use this when a user wants to extract the end of an audio file. Automatically applies fade in and fade out effects.",
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
        error = err instanceof Error ? err.message : "Unknown error";
        await trackMCPTool(
          "audio.trim_end_of_audio",
          {
            has_audio_url: !!audioUrl,
            has_track_name: !!trackName,
            format: format ?? "mp3",
          },
          {
            success: false,
            error,
          }
        );
        throw err;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Last 30 seconds trimmed (.${result.format}): ${result.fileName}\nDownload: ${result.downloadUrl}`,
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

  /* Voice/Music Separation Tool */
  server.registerTool(
    "audio.separate_voice_from_music",
    {
      title: "Separate Voice from Music",
      description:
        "Separates vocals from music in an audio file, returning two separate tracks: one with vocals and one with instrumental music.",
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
        error = err instanceof Error ? err.message : "Unknown error";
        await trackMCPTool(
          "audio.separate_voice_from_music",
          {
            has_audio_file: !!audioFile,
            has_audio_url: !!audioUrl,
            has_track_name: !!trackName,
          },
          {
            success: false,
            error,
          }
        );
        throw err;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Voice and music separated successfully!\n\nVocals: ${result.vocalsFileName}\nDownload: ${result.vocalsUrl}\n\nMusic: ${result.musicFileName}\nDownload: ${result.musicUrl}`,
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
        "Removes vocals from an audio file, returning only the instrumental music track without vocals.",
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
        error = err instanceof Error ? err.message : "Unknown error";
        await trackMCPTool(
          "audio.remove_vocals",
          {
            has_audio_file: !!audioFile,
            has_audio_url: !!audioUrl,
            has_track_name: !!trackName,
          },
          {
            success: false,
            error,
          }
        );
        throw err;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Vocals removed successfully!\n\nInstrumental track: ${result.musicFileName}\nDownload: ${result.musicUrl}`,
          },
        ],
        structuredContent: {
          type: "audioDownload" as const,
          downloadUrl: result.musicUrl,
          fileName: result.musicFileName,
          format: "instrumental",
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
        "Extracts vocals from an audio file, returning only the vocal track without the instrumental music.",
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
        error = err instanceof Error ? err.message : "Unknown error";
        await trackMCPTool(
          "audio.extract_vocals",
          {
            has_audio_file: !!audioFile,
            has_audio_url: !!audioUrl,
            has_track_name: !!trackName,
          },
          {
            success: false,
            error,
          }
        );
        throw err;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Vocals extracted successfully!\n\nVocal track: ${result.vocalsFileName}\nDownload: ${result.vocalsUrl}`,
          },
        ],
        structuredContent: {
          type: "audioDownload" as const,
          downloadUrl: result.vocalsUrl,
          fileName: result.vocalsFileName,
          format: "vocals",
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
        "Analyzes an audio file to detect its BPM (beats per minute/tempo) and musical key.",
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

        return {
          content: [
            {
              type: "text" as const,
              text: `Audio analysis complete!\n\nBPM: ${bpmText}\nKey: ${keyText}`,
            },
          ],
          structuredContent: {
            type: "audioAnalysis" as const,
            bpm: result.bpm,
            key: result.key,
          },
        };
      } catch (err) {
        error = err instanceof Error ? err.message : "Unknown error";
        await trackMCPTool(
          "audio.detect_bpm_and_key",
          {
            has_audio_file: !!audioFile,
            has_audio_url: !!audioUrl,
          },
          {
            success: false,
            error,
          }
        );
        throw err;
      }
    },
  );

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
