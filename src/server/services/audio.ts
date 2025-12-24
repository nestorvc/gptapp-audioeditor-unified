/**
 * AUDIO.TS - General Audio Format Conversion Service
 * 
 * This service handles general audio format conversions.
 * It provides functions to convert audio files to various formats (MP3, WAV, FLAC, OGG, M4A)
 * and upload them to S3 for public download.
 * 
 * Key Functions:
 * - convertRemoteAudioToFormat() - Downloads remote audio URL, converts to target format, uploads to S3
 * - finalizeLocalAudioExport() - Converts local audio file to target format and uploads to S3
 * - transcodeLocalAudioFormat() - Converts audio file to specified format using ffmpeg
 * - normalizeAudioExportFormat() - Validates and normalizes format strings
 * 
 * Supported Formats:
 * - MP3: libmp3lame codec, 192kbps
 * - WAV: PCM 16-bit, uncompressed
 * - FLAC: Lossless compression
 * - OGG: Opus codec, 160kbps
 * - M4A: AAC codec, 192kbps
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

console.log("process.env.AWS_REGION", process.env.AWS_REGION);

/* ----------------------------- IMPORTS ----------------------------- */
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import ffmpeg from "fluent-ffmpeg";
import { PutObjectCommand, type PutObjectCommandInput, S3Client, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import * as EssentiaModule from "essentia.js";

/* ----------------------------- FFMPEG CONFIGURATION ----------------------------- */
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// Configure ffprobe path - handle serverless environments (Vercel/Lambda)
// On Vercel, skip @ffprobe-installer/ffprobe wrapper and use linux-x64 directly
let ffprobePath: string | undefined;
if (process.env.VERCEL) {
  // Vercel runs on Linux, so use linux-x64 directly to avoid module resolution issues
  try {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    ffprobePath = require.resolve("@ffprobe-installer/linux-x64/ffprobe");
    console.log("[FFmpeg] Using linux-x64 ffprobe on Vercel:", ffprobePath);
  } catch (requireError) {
    // Fallback to file system path resolution for Vercel
    const searchPaths = [
      path.resolve(projectRoot, "node_modules/@ffprobe-installer/linux-x64/ffprobe"),
      path.resolve(projectRoot, "node_modules/.pnpm/@ffprobe-installer+linux-x64@5.2.0/node_modules/@ffprobe-installer/linux-x64/ffprobe"),
      ...(() => {
        const pnpmDir = path.resolve(projectRoot, "node_modules/.pnpm");
        if (fs.existsSync(pnpmDir)) {
          try {
            const entries = fs.readdirSync(pnpmDir);
            const linuxX64Dirs = entries.filter(e => e.startsWith("@ffprobe-installer+linux-x64@"));
            return linuxX64Dirs.map(dir => 
              path.resolve(pnpmDir, dir, "node_modules/@ffprobe-installer/linux-x64/ffprobe")
            );
          } catch {
            return [];
          }
        }
        return [];
      })(),
    ];

    let found = false;
    for (const searchPath of searchPaths) {
      if (fs.existsSync(searchPath)) {
        ffprobePath = searchPath;
        console.log("[FFmpeg] Using linux-x64 ffprobe from filesystem on Vercel:", ffprobePath);
        found = true;
        break;
      }
    }

    if (!found) {
      throw new Error(`Could not find ffprobe binary on Vercel. Searched: ${searchPaths.join(", ")}`);
    }
  }
} else {
  // Local development: try @ffprobe-installer/ffprobe first, then fallback
  try {
    const ffprobeInstaller = await import("@ffprobe-installer/ffprobe");
    ffprobePath = (ffprobeInstaller.default || ffprobeInstaller).path;
    console.log("[FFmpeg] Using ffprobe from @ffprobe-installer/ffprobe:", ffprobePath);
  } catch (error) {
    // Fallback for serverless environments: try to resolve linux-x64 directly
    console.warn("[FFmpeg] Failed to load @ffprobe-installer/ffprobe, trying linux-x64 fallback:", error instanceof Error ? error.message : String(error));
    try {
      const { createRequire } = await import("node:module");
      const require = createRequire(import.meta.url);
      try {
        ffprobePath = require.resolve("@ffprobe-installer/linux-x64/ffprobe");
        console.log("[FFmpeg] Using linux-x64 ffprobe via require.resolve:", ffprobePath);
      } catch (requireError) {
        // Fallback to file system path resolution - search common locations
        const searchPaths = [
          path.resolve(projectRoot, "node_modules/@ffprobe-installer/linux-x64/ffprobe"),
          path.resolve(projectRoot, "node_modules/.pnpm/@ffprobe-installer+linux-x64@5.2.0/node_modules/@ffprobe-installer/linux-x64/ffprobe"),
          ...(() => {
            const pnpmDir = path.resolve(projectRoot, "node_modules/.pnpm");
            if (fs.existsSync(pnpmDir)) {
              try {
                const entries = fs.readdirSync(pnpmDir);
                const linuxX64Dirs = entries.filter(e => e.startsWith("@ffprobe-installer+linux-x64@"));
                return linuxX64Dirs.map(dir => 
                  path.resolve(pnpmDir, dir, "node_modules/@ffprobe-installer/linux-x64/ffprobe")
                );
              } catch {
                return [];
              }
            }
            return [];
          })(),
        ];

        let found = false;
        for (const searchPath of searchPaths) {
          if (fs.existsSync(searchPath)) {
            ffprobePath = searchPath;
            console.log("[FFmpeg] Using linux-x64 ffprobe from filesystem:", ffprobePath);
            found = true;
            break;
          }
        }

        if (!found) {
          throw new Error(`Could not find ffprobe binary. Searched: ${searchPaths.join(", ")}`);
        }
      }
    } catch (fallbackError) {
      console.error("[FFmpeg] Fallback also failed:", fallbackError);
      throw new Error(`Failed to configure ffprobe: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

if (!ffprobePath) {
  throw new Error("Failed to configure ffprobe: path was not resolved");
}
ffmpeg.setFfprobePath(ffprobePath);

/* ----------------------------- CONSTANTS ----------------------------- */
const DEFAULT_TMP_PREFIX = "audio";
const TEMP_DIR = process.env.VERCEL ? "/tmp" : path.join(projectRoot, "tmp");
const s3Region = process.env.AWS_REGION;
const s3Bucket = process.env.S3_BUCKET;
const s3ExportsFolder = process.env.S3_EXPORTS_FOLDER;
const s3UploadsFolder = process.env.S3_UPLOADS_FOLDER;
const s3PublicBaseUrl = process.env.S3_PUBLIC_BASE_URL ?? "";
const s3ObjectAcl = process.env.S3_OBJECT_ACL ?? undefined;
export const AUDIO_EXPORT_FORMATS = ["mp3", "wav", "flac", "ogg", "m4a", "m4r"] as const;

/* ----------------------------- TYPES ----------------------------- */
type FfmpegCommand = ReturnType<typeof ffmpeg>;
type AudioFormatConfig = {
  extension: string;
  mimeType: string;
  apply: (command: FfmpegCommand) => FfmpegCommand;
};
type S3UploadConfig = {
  client: S3Client | null;
  bucket?: string;
  region?: string;
  keyPrefix?: string | null;
  publicBaseUrl?: string;
  objectAcl?: string;
};
export type AudioExportFormat = (typeof AUDIO_EXPORT_FORMATS)[number];
export type AudioExportResult = {
  downloadUrl: string;
  fileName: string;
  trackName: string;
  format: AudioExportFormat;
  extension: string;
};

/* ----------------------------- S3 CONFIG ----------------------------- */
const s3Client = new S3Client({
  region: s3Region,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});
const s3UploadConfig: S3UploadConfig = {
  client: s3Client,
  bucket: s3Bucket,
  region: s3Region,
  keyPrefix: s3ExportsFolder,
  publicBaseUrl: s3PublicBaseUrl,
  objectAcl: s3ObjectAcl,
};

/* -----------------------------HELPER FUNCTIONS ----------------------------- */
// AUDIO_FORMAT_CONFIG - Configuration for the audio formats
const AUDIO_FORMAT_CONFIG: Record<AudioExportFormat, AudioFormatConfig> = {
  mp3: {
    extension: ".mp3",
    mimeType: "audio/mpeg",
    apply: (command) => command.audioCodec("libmp3lame").audioBitrate("192k").format("mp3").outputOptions("-vn"),
  },
  wav: {
    extension: ".wav",
    mimeType: "audio/wav",
    apply: (command) => command.audioCodec("pcm_s16le").format("wav").outputOptions("-vn"),
  },
  flac: {
    extension: ".flac",
    mimeType: "audio/flac",
    apply: (command) => command.audioCodec("flac").format("flac").outputOptions("-vn"),
  },
  ogg: {
    extension: ".ogg",
    mimeType: "audio/ogg",
    apply: (command) => command.audioCodec("libopus").audioBitrate("160k").format("ogg").outputOptions("-vn"),
  },
  m4a: {
    extension: ".m4a",
    mimeType: "audio/m4a",
    apply: (command) =>
      command
        .audioCodec("aac")
        .audioBitrate("192k")
        .format("mp4")
        .outputOptions(["-movflags", "+faststart", "-vn"]),
  },
  m4r: {
    extension: ".m4r",
    mimeType: "audio/m4r",
    apply: (command) =>
      command
        .audioCodec("aac")
        .audioBitrate("192k")
        .format("m4a")
        .outputOptions(["-movflags", "+faststart", "-vn"]),
  },
};

// generateAudioTitleAndFilename - Generates title and filename with brand text
function generateAudioTitleAndFilename(actionTitle: string, baseName?: string | null): { title: string; filename: string } {
  const brandText = " (Generated_by_AudioConsole.app)";
  const title = `${actionTitle}${brandText}`;
  // Filename should align with title: use baseName if provided, otherwise use actionTitle
  // Convert spaces to underscores and append brand text without parentheses
  const filenameBase = baseName ? sanitizeFileName(baseName.replace(/\.[^/.]+$/, ""), DEFAULT_TMP_PREFIX) : actionTitle.replace(/\s+/g, "_");
  const filename = `${filenameBase}_Generated_by_AudioConsole_app`;
  return { title, filename };
}

// sanitizeFileName - Sanitizes the file name
function sanitizeFileName(rawName: string | undefined | null, fallback = DEFAULT_TMP_PREFIX) {
  if (!rawName) return fallback;
  const sanitized = rawName
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .trim()
    .replace(/\s+/g, "-");
  return sanitized.length > 0 ? sanitized : fallback;
};

// isAudioExportFormat - Validates if the value is a valid audio export format
function isAudioExportFormat(value: unknown): value is AudioExportFormat {
  if (typeof value !== "string") {
    return false;
  }
  return (AUDIO_EXPORT_FORMATS as readonly string[]).includes(value.toLowerCase());
};

// configureCommand - Configures the ffmpeg command for the given format
function configureCommand(command: FfmpegCommand, format: AudioExportFormat) {
    return AUDIO_FORMAT_CONFIG[format].apply(command);
  }
  
// convertAudioToFormat - Converts audio file to specified format using ffmpeg
async function convertAudioToFormat(inputPath: string, outputPath: string, format: AudioExportFormat) {
  // For m4r format, use .m4a extension during processing (ffmpeg doesn't recognize .m4r)
  // Then rename to .m4r after processing
  const isM4R = format === "m4r";
  const processingPath = isM4R ? outputPath.replace(/\.m4r$/, ".m4a") : outputPath;

  return new Promise<void>((resolve, reject) => {
    const command = configureCommand(ffmpeg(inputPath), format);
    command.on("error", (error: unknown) => reject(error));
    command.on("end", async () => {
      // Rename .m4a to .m4r if needed
      if (isM4R && processingPath !== outputPath) {
        try {
          await fs.promises.rename(processingPath, outputPath);
        } catch (renameError) {
          reject(new Error(`Failed to rename m4a to m4r: ${renameError instanceof Error ? renameError.message : String(renameError)}`));
          return;
        }
      }
      resolve();
    });
    command.save(processingPath);
  });
}

// trimAudioWithFade - Trims audio and applies fade in/out effects
async function trimAudioWithFade({
  inputPath,
  outputPath,
  startTime,
  duration,
  fadeInDuration = 1.5,
  fadeOutDuration = 1.5,
  format,
}: {
  inputPath: string;
  outputPath: string;
  startTime: number;
  duration: number;
  fadeInDuration?: number;
  fadeOutDuration?: number;
  format: AudioExportFormat;
}) {
  // For m4r format, use .m4a extension during processing (ffmpeg doesn't recognize .m4r)
  // Then rename to .m4r after processing
  const isM4R = format === "m4r";
  const processingPath = isM4R ? outputPath.replace(/\.m4r$/, ".m4a") : outputPath;

  return new Promise<void>((resolve, reject) => {
    // Ensure fade durations don't exceed the audio duration
    const safeFadeIn = Math.min(fadeInDuration, duration / 2);
    const safeFadeOut = Math.min(fadeOutDuration, duration / 2);
    const fadeOutStart = Math.max(0, duration - safeFadeOut);

    const filters = [];
    if (safeFadeIn > 0) {
      filters.push(`afade=t=in:st=0:d=${safeFadeIn}`);
    }
    if (safeFadeOut > 0 && fadeOutStart > safeFadeIn) {
      filters.push(`afade=t=out:st=${fadeOutStart}:d=${safeFadeOut}`);
    }

    let command = ffmpeg(inputPath)
      .setStartTime(startTime)
      .setDuration(duration);

    if (filters.length > 0) {
      command = command.audioFilters(filters);
    }

    command = configureCommand(command, format);
    command.on("error", (error: unknown) => reject(error));
    command.on("end", async () => {
      // Rename .m4a to .m4r if needed
      if (isM4R && processingPath !== outputPath) {
        try {
          await fs.promises.rename(processingPath, outputPath);
        } catch (renameError) {
          reject(new Error(`Failed to rename m4a to m4r: ${renameError instanceof Error ? renameError.message : String(renameError)}`));
          return;
        }
      }
      resolve();
    });
    command.save(processingPath);
  });
}
  
// downloadAudioToTempFile - Downloads audio file to temporary directory
async function downloadAudioToTempFile(audioUrl: string) {
    const response = await fetch(audioUrl);
    if (!response.ok || !response.body) {
    throw new Error(`Failed to download audio. HTTP status ${response.status}`);
    }

    const contentDisposition = response.headers.get("content-disposition") ?? undefined;
    const fileNameFromHeader = contentDisposition?.match(/filename="?([^"]+)"?/i)?.[1];
    const urlPath = (() => {
    try {
        const url = new URL(audioUrl);
        return url.pathname;
    } catch {
        return "";
    }
    })();
    const urlFileName = urlPath ? path.basename(urlPath) : undefined;
    const rawFileName = fileNameFromHeader || urlFileName || `${DEFAULT_TMP_PREFIX}.tmp`;

    const tempName = `${Date.now()}-${randomUUID()}-${sanitizeFileName(rawFileName, DEFAULT_TMP_PREFIX)}`;
    const downloadPath = path.join(TEMP_DIR, tempName);

    const readable = Readable.fromWeb(response.body as any);
    await pipeline(readable, fs.createWriteStream(downloadPath));

    return {
    filePath: downloadPath,
    originalFileName: rawFileName,
    };
}

// normalizeAudioExportFormat - Validates and normalizes format strings
export function normalizeAudioExportFormat(value: string | undefined | null): AudioExportFormat {
  if (!value) {
    return "mp3";
  }
  const lower = value.toLowerCase();
  if (isAudioExportFormat(lower)) {
    return lower;
  }
  return "mp3";
};

// transcodeLocalAudioFormat - Converts audio file to specified format using ffmpeg
async function transcodeLocalAudioFormat({
  inputPath,
  format,
}: {
  inputPath: string;
  format: AudioExportFormat;
}) {
  const { extension, mimeType } = AUDIO_FORMAT_CONFIG[format];
  const outputPath = path.join(TEMP_DIR, `${Date.now()}-${randomUUID()}${extension}`);
  await convertAudioToFormat(inputPath, outputPath, format);
  return {
    outputPath,
    extension,
    mimeType,
  };
}

// resolveS3ObjectKey - Resolves the S3 object key
function resolveS3ObjectKey(config: S3UploadConfig, extension: string) {
  const keyPrefixNormalized = config.keyPrefix
    ? config.keyPrefix.replace(/^\/*/, "").replace(/\/*$/, "")
    : "";
  const objectKey = `${keyPrefixNormalized ? `${keyPrefixNormalized}/` : ""}${Date.now()}-${randomUUID()}${extension}`;
  return objectKey;
}

function buildPublicUrl(config: S3UploadConfig, objectKey: string) {
  if (config.publicBaseUrl && config.publicBaseUrl.length > 0) {
    return `${config.publicBaseUrl.replace(/\/+$/, "")}/${objectKey}`;
  }

  if (config.bucket && config.region) {
    return `https://${config.bucket}.s3.${config.region}.amazonaws.com/${objectKey}`;
  }

  throw new Error("Cannot build public URL without either publicBaseUrl or bucket/region.");
}

// uploadAudioToS3 - Uploads audio file to S3
async function uploadAudioToS3({
  filePath,
  mimeType,
  downloadName,
  extension,
  config,
}: {
  filePath: string;
  mimeType: string;
  downloadName: string;
  extension: string;
  config: S3UploadConfig;
}) {
  if (!config.client || !config.bucket) {
    throw new Error("S3 configuration is missing on the server.");
  }

  const fileBuffer = await fs.promises.readFile(filePath);
  const objectKey = resolveS3ObjectKey(config, extension);

  const putObjectInput: PutObjectCommandInput = {
    Bucket: config.bucket,
    Key: objectKey,
    Body: fileBuffer,
    ContentType: mimeType,
    ContentDisposition: `attachment; filename="${downloadName}${extension}"`,
  };

  if (config.objectAcl && config.objectAcl.length > 0) {
    putObjectInput.ACL = config.objectAcl as PutObjectCommandInput["ACL"];
  }

  await config.client.send(new PutObjectCommand(putObjectInput));
  const downloadUrl = buildPublicUrl(config, objectKey);

  return {
    downloadUrl,
    fileName: `${downloadName}${extension}`,
  };
}

// deleteFromS3 - Deletes a file from S3 by URL
async function deleteFromS3(audioUrl: string): Promise<void> {
  if (!s3Client || !s3Bucket) {
    throw new Error("S3 configuration is missing on the server.");
  }

  try {
    // Parse the S3 URL to extract the object key
    const urlObj = new URL(audioUrl);
    let objectKey = urlObj.pathname.replace(/^\//, ""); // Remove leading slash
    
    // Handle custom domain (S3_PUBLIC_BASE_URL) - object key is in pathname
    // Handle S3 domain - object key is in pathname
    // Only delete if it's from our bucket and in the uploads folder
    const isOurBucket = 
      urlObj.hostname.includes(s3Bucket) || 
      urlObj.hostname === `${s3Bucket}.s3.${s3Region}.amazonaws.com` ||
      urlObj.hostname === `s3.${s3Region}.amazonaws.com` ||
      (s3PublicBaseUrl && urlObj.hostname === new URL(s3PublicBaseUrl).hostname);
    
    const isUploadsFolder = objectKey.startsWith("uploads/");
    
    if (isOurBucket && isUploadsFolder) {
      await s3Client.send(new DeleteObjectCommand({
        Bucket: s3Bucket,
        Key: objectKey,
      }));
      console.log("[S3 Cleanup] Deleted temporary upload file:", objectKey);
    } else {
      console.log("[S3 Cleanup] Skipping deletion - not from our uploads folder:", {
        audioUrl,
        objectKey,
        isOurBucket,
        isUploadsFolder,
      });
    }
  } catch (error) {
    // Log but don't throw - cleanup failures shouldn't break the main flow
    console.warn("[S3 Cleanup] Failed to delete temporary file:", audioUrl, error);
  }
}

/* ----------------------------- MAIN FUNCTIONS ----------------------------- */
// finalizeLocalAudioExport - Converts local audio file to target format and uploads to S3
export async function finalizeLocalAudioExport({
  sourcePath,
  format,
  trackName,
}: {
  sourcePath: string;
  format: AudioExportFormat;
  trackName: string;
}): Promise<AudioExportResult> {
  let convertedPath: string | null = null;
  let metadataPath: string | null = null;

  try {
    const { outputPath, extension, mimeType } = await transcodeLocalAudioFormat({
      inputPath: sourcePath,
      format: normalizeAudioExportFormat(format),
    });
    convertedPath = outputPath;
    
    const downloadBaseName = sanitizeFileName(
      trackName.replace(/\.[^/.]+$/, ""),
      DEFAULT_TMP_PREFIX
    );

    // Add metadata with branded title
    const { title, filename } = generateAudioTitleAndFilename("Exported Audio", downloadBaseName);
    metadataPath = path.join(TEMP_DIR, `${Date.now()}-${randomUUID()}${extension}`);
    await addMetadataToAudio(convertedPath, metadataPath, title);

    const { downloadUrl, fileName } = await uploadAudioToS3({
      filePath: metadataPath,
      mimeType,
      downloadName: filename,
      extension,
      config: s3UploadConfig,
    });

    return {
      downloadUrl,
      fileName,
      trackName: filename,
      format,
      extension,
    };
  } finally {
    await Promise.all(
      [convertedPath, metadataPath].map(async (filePath) => {
        if (filePath) {
          try {
            await fs.promises.unlink(filePath);
          } catch {
            // ignore cleanup errors
          }
        }
      })
    );
  }
}

// convertRemoteAudioToFormat - Converts remote audio file to specified format and uploads to S3
export async function convertRemoteAudioToFormat({
  audioUrl,
  format,
  suggestedTrackName,
}: {
  audioUrl: string;
  format: AudioExportFormat;
  suggestedTrackName?: string | null;
}): Promise<AudioExportResult> {
  let downloadedFilePath: string | null = null;
  let convertedFilePath: string | null = null;
  let metadataPath: string | null = null;

  try {
    const { filePath, originalFileName } = await downloadAudioToTempFile(audioUrl);
    downloadedFilePath = filePath;

    const trackNameBase = sanitizeFileName(
      (suggestedTrackName ?? originalFileName ?? DEFAULT_TMP_PREFIX).replace(/\.[^/.]+$/, ""),
      DEFAULT_TMP_PREFIX
    );

    const { outputPath, extension } = await transcodeLocalAudioFormat({
      inputPath: downloadedFilePath,
      format,
    });
    convertedFilePath = outputPath;

    // Add metadata with branded title
    const { title, filename } = generateAudioTitleAndFilename("Converted Audio", trackNameBase);
    metadataPath = path.join(TEMP_DIR, `${Date.now()}-${randomUUID()}${extension}`);
    await addMetadataToAudio(convertedFilePath, metadataPath, title);

    const { downloadUrl, fileName } = await uploadAudioToS3({
      filePath: metadataPath,
      mimeType: AUDIO_FORMAT_CONFIG[format].mimeType,
      downloadName: filename,
      extension,
      config: s3UploadConfig,
    });

    return {
      downloadUrl,
      fileName,
      format,
      trackName: filename,
      extension,
    };
  } finally {
    await Promise.all(
      [downloadedFilePath, convertedFilePath, metadataPath].map(async (filePath) => {
        if (filePath) {
          try {
            await fs.promises.unlink(filePath);
          } catch {
            // ignore cleanup errors
          }
        }
      })
    );
  }
}

// trimFirst30Seconds - Trims first 30 seconds with fade in/out
export async function trimFirst30Seconds({
  audioUrl,
  format,
  suggestedTrackName,
  fadeDuration = 1.5,
}: {
  audioUrl: string;
  format: AudioExportFormat;
  suggestedTrackName?: string | null;
  fadeDuration?: number;
}): Promise<AudioExportResult> {
  let downloadedFilePath: string | null = null;
  let trimmedFilePath: string | null = null;
  let metadataPath: string | null = null;

  try {
    const { filePath, originalFileName } = await downloadAudioToTempFile(audioUrl);
    downloadedFilePath = filePath;

    const trackNameBase = sanitizeFileName(
      (suggestedTrackName ?? originalFileName ?? DEFAULT_TMP_PREFIX).replace(/\.[^/.]+$/, ""),
      DEFAULT_TMP_PREFIX
    );

    const { extension, mimeType } = AUDIO_FORMAT_CONFIG[format];
    trimmedFilePath = path.join(TEMP_DIR, `${Date.now()}-${randomUUID()}${extension}`);

    await trimAudioWithFade({
      inputPath: downloadedFilePath,
      outputPath: trimmedFilePath,
      startTime: 0,
      duration: 30,
      fadeInDuration: fadeDuration,
      fadeOutDuration: fadeDuration,
      format,
    });

    // Add metadata with branded title
    const { title, filename } = generateAudioTitleAndFilename("Trimmed Audio (First 30s)", trackNameBase);
    metadataPath = path.join(TEMP_DIR, `${Date.now()}-${randomUUID()}${extension}`);
    await addMetadataToAudio(trimmedFilePath, metadataPath, title);

    const { downloadUrl, fileName } = await uploadAudioToS3({
      filePath: metadataPath,
      mimeType,
      downloadName: filename,
      extension,
      config: s3UploadConfig,
    });

    return {
      downloadUrl,
      fileName,
      format,
      trackName: filename,
      extension,
    };
  } finally {
    await Promise.all(
      [downloadedFilePath, trimmedFilePath, metadataPath].map(async (filePath) => {
        if (filePath) {
          try {
            await fs.promises.unlink(filePath);
          } catch {
            // ignore cleanup errors
          }
        }
      })
    );
  }
}

// trimLast30Seconds - Trims last 30 seconds with fade in/out
export async function trimLast30Seconds({
  audioUrl,
  format,
  suggestedTrackName,
  fadeDuration = 1.5,
}: {
  audioUrl: string;
  format: AudioExportFormat;
  suggestedTrackName?: string | null;
  fadeDuration?: number;
}): Promise<AudioExportResult> {
  let downloadedFilePath: string | null = null;
  let trimmedFilePath: string | null = null;
  let metadataPath: string | null = null;

  try {
    const { filePath, originalFileName } = await downloadAudioToTempFile(audioUrl);
    downloadedFilePath = filePath;

    // Get audio duration to calculate start time
    const duration = await new Promise<number>((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) reject(err);
        else resolve(metadata.format.duration || 0);
      });
    });

    if (duration < 30) {
      throw new Error(`Audio is only ${duration.toFixed(1)} seconds long. Need at least 30 seconds to trim the last 30 seconds.`);
    }

    const trackNameBase = sanitizeFileName(
      (suggestedTrackName ?? originalFileName ?? DEFAULT_TMP_PREFIX).replace(/\.[^/.]+$/, ""),
      DEFAULT_TMP_PREFIX
    );

    const { extension, mimeType } = AUDIO_FORMAT_CONFIG[format];
    trimmedFilePath = path.join(TEMP_DIR, `${Date.now()}-${randomUUID()}${extension}`);

    const startTime = duration - 30;

    await trimAudioWithFade({
      inputPath: downloadedFilePath,
      outputPath: trimmedFilePath,
      startTime,
      duration: 30,
      fadeInDuration: fadeDuration,
      fadeOutDuration: fadeDuration,
      format,
    });

    // Add metadata with branded title
    const { title, filename } = generateAudioTitleAndFilename("Trimmed Audio (Last 30s)", trackNameBase);
    metadataPath = path.join(TEMP_DIR, `${Date.now()}-${randomUUID()}${extension}`);
    await addMetadataToAudio(trimmedFilePath, metadataPath, title);

    const { downloadUrl, fileName } = await uploadAudioToS3({
      filePath: metadataPath,
      mimeType,
      downloadName: filename,
      extension,
      config: s3UploadConfig,
    });

    return {
      downloadUrl,
      fileName,
      format,
      trackName: filename,
      extension,
    };
  } finally {
    await Promise.all(
      [downloadedFilePath, trimmedFilePath, metadataPath].map(async (filePath) => {
        if (filePath) {
          try {
            await fs.promises.unlink(filePath);
          } catch {
            // ignore cleanup errors
          }
        }
      })
    );
  }
}

// processAudioFromUrl - Processes audio from URL with custom trim and fade parameters
export async function processAudioFromUrl({
  audioUrl,
  format,
  trackName,
  startTime,
  duration,
  fadeInEnabled = false,
  fadeInDuration = 0,
  fadeOutEnabled = false,
  fadeOutDuration = 0,
}: {
  audioUrl: string;
  format: AudioExportFormat;
  trackName: string;
  startTime: number;
  duration: number;
  fadeInEnabled?: boolean;
  fadeInDuration?: number;
  fadeOutEnabled?: boolean;
  fadeOutDuration?: number;
}): Promise<AudioExportResult> {
  let downloadedFilePath: string | null = null;
  let processedFilePath: string | null = null;
  let metadataPath: string | null = null;

  try {
    const { filePath, originalFileName } = await downloadAudioToTempFile(audioUrl);
    downloadedFilePath = filePath;

    const trackNameBase = sanitizeFileName(
      (trackName || originalFileName || DEFAULT_TMP_PREFIX).replace(/\.[^/.]+$/, ""),
      DEFAULT_TMP_PREFIX
    );

    const { extension, mimeType } = AUDIO_FORMAT_CONFIG[format];
    processedFilePath = path.join(TEMP_DIR, `${Date.now()}-${randomUUID()}${extension}`);

    await trimAudioWithFade({
      inputPath: downloadedFilePath,
      outputPath: processedFilePath,
      startTime,
      duration,
      fadeInDuration: fadeInEnabled ? fadeInDuration : 0,
      fadeOutDuration: fadeOutEnabled ? fadeOutDuration : 0,
      format,
    });

    // Add metadata with branded title
    const { title, filename } = generateAudioTitleAndFilename("Trimmed Audio", trackNameBase);
    metadataPath = path.join(TEMP_DIR, `${Date.now()}-${randomUUID()}${extension}`);
    await addMetadataToAudio(processedFilePath, metadataPath, title);

    const { downloadUrl, fileName } = await uploadAudioToS3({
      filePath: metadataPath,
      mimeType,
      downloadName: filename,
      extension,
      config: s3UploadConfig,
    });

    // Delete the temporary uploaded file from /uploads folder if it's from our S3 bucket
    await deleteFromS3(audioUrl);

    return {
      downloadUrl,
      fileName,
      format,
      trackName: filename,
      extension,
    };
  } finally {
    await Promise.all(
      [downloadedFilePath, processedFilePath, metadataPath].map(async (filePath) => {
        if (filePath) {
          try {
            await fs.promises.unlink(filePath);
          } catch {
            // ignore cleanup errors
          }
        }
      })
    );
  }
}

// generatePresignedUploadUrl - Generates a presigned URL for direct S3 upload
export async function generatePresignedUploadUrl(fileName: string, contentType: string): Promise<{ uploadUrl: string; fileKey: string; publicUrl: string }> {
  if (!s3Client || !s3Bucket) {
    throw new Error("S3 configuration is missing on the server.");
  }

  const keyPrefixNormalized = s3UploadsFolder
    ? s3UploadsFolder.replace(/^\/*/, "").replace(/\/*$/, "")
    : "";
  const fileExtension = path.extname(fileName) || ".tmp";
  const sanitizedFileName = sanitizeFileName(fileName.replace(/\.[^/.]+$/, ""), DEFAULT_TMP_PREFIX);
  const fileKey = `${keyPrefixNormalized ? `${keyPrefixNormalized}/` : ""}${Date.now()}-${randomUUID()}-${sanitizedFileName}${fileExtension}`;

  const putObjectInput: PutObjectCommandInput = {
    Bucket: s3Bucket,
    Key: fileKey,
    ContentType: contentType,
  };

  // Add ACL if configured (same as regular uploads)
  if (s3ObjectAcl && s3ObjectAcl.length > 0) {
    putObjectInput.ACL = s3ObjectAcl as PutObjectCommandInput["ACL"];
  }

  const command = new PutObjectCommand(putObjectInput);

  const uploadUrl = await getSignedUrl(s3Client as any, command as any, { expiresIn: 3600 }); // 1 hour expiry

  const publicUrl = s3PublicBaseUrl && s3PublicBaseUrl.length > 0
    ? `${s3PublicBaseUrl.replace(/\/+$/, "")}/${fileKey}`
    : `https://${s3Bucket}.s3.${s3Region}.amazonaws.com/${fileKey}`;

  return {
    uploadUrl,
    fileKey,
    publicUrl,
  };
}

// processAudioFromFile - Processes uploaded audio file with custom trim and fade parameters
export async function processAudioFromFile({
  filePath,
  format,
  trackName,
  startTime,
  duration,
  fadeInEnabled = false,
  fadeInDuration = 0,
  fadeOutEnabled = false,
  fadeOutDuration = 0,
}: {
  filePath: string;
  format: AudioExportFormat;
  trackName: string;
  startTime: number;
  duration: number;
  fadeInEnabled?: boolean;
  fadeInDuration?: number;
  fadeOutEnabled?: boolean;
  fadeOutDuration?: number;
}): Promise<AudioExportResult> {
  let processedFilePath: string | null = null;
  let metadataPath: string | null = null;

  try {
    const trackNameBase = sanitizeFileName(
      trackName.replace(/\.[^/.]+$/, ""),
      DEFAULT_TMP_PREFIX
    );

    const { extension, mimeType } = AUDIO_FORMAT_CONFIG[format];
    processedFilePath = path.join(TEMP_DIR, `${Date.now()}-${randomUUID()}${extension}`);

    await trimAudioWithFade({
      inputPath: filePath,
      outputPath: processedFilePath,
      startTime,
      duration,
      fadeInDuration: fadeInEnabled ? fadeInDuration : 0,
      fadeOutDuration: fadeOutEnabled ? fadeOutDuration : 0,
      format,
    });

    // Add metadata with branded title
    const { title, filename } = generateAudioTitleAndFilename("Trimmed Audio", trackNameBase);
    metadataPath = path.join(TEMP_DIR, `${Date.now()}-${randomUUID()}${extension}`);
    await addMetadataToAudio(processedFilePath, metadataPath, title);

    // Use S3_EXPORTS_FOLDER for exported files
    const { downloadUrl, fileName } = await uploadAudioToS3({
      filePath: metadataPath,
      mimeType,
      downloadName: filename,
      extension,
      config: s3UploadConfig,
    });

    return {
      downloadUrl,
      fileName,
      format,
      trackName: filename,
      extension,
    };
  } finally {
    await Promise.all(
      [processedFilePath, metadataPath].map(async (filePath) => {
        if (filePath) {
          try {
            await fs.promises.unlink(filePath);
          } catch {
            // ignore cleanup errors
          }
        }
      })
    );
  }
}

// processDualTrackAudio - Processes dual track audio (vocals + music) with trim, fade, and format conversion
export async function processDualTrackAudio({
  vocalsUrl,
  musicUrl,
  format,
  trackName,
  startTime,
  duration,
  vocalsEnabled = true,
  musicEnabled = true,
  fadeInEnabled = false,
  fadeInDuration = 0,
  fadeOutEnabled = false,
  fadeOutDuration = 0,
}: {
  vocalsUrl: string;
  musicUrl: string;
  format: AudioExportFormat;
  trackName: string;
  startTime: number;
  duration: number;
  vocalsEnabled?: boolean;
  musicEnabled?: boolean;
  fadeInEnabled?: boolean;
  fadeInDuration?: number;
  fadeOutEnabled?: boolean;
  fadeOutDuration?: number;
}): Promise<AudioExportResult> {
  let vocalsFilePath: string | null = null;
  let musicFilePath: string | null = null;
  let vocalsTrimmedPath: string | null = null;
  let musicTrimmedPath: string | null = null;
  let processedFilePath: string | null = null;
  let metadataPath: string | null = null;

  try {
    const trackNameBase = sanitizeFileName(
      trackName.replace(/\.[^/.]+$/, ""),
      DEFAULT_TMP_PREFIX
    );

    const { extension, mimeType } = AUDIO_FORMAT_CONFIG[format];

    // Download both tracks
    const [vocalsResponse, musicResponse] = await Promise.all([
      fetch(vocalsUrl),
      fetch(musicUrl),
    ]);

    if (!vocalsResponse.ok || !musicResponse.ok) {
      throw new Error("Failed to download audio tracks");
    }

    vocalsFilePath = path.join(TEMP_DIR, `${Date.now()}-${randomUUID()}-vocals.mp3`);
    musicFilePath = path.join(TEMP_DIR, `${Date.now()}-${randomUUID()}-music.mp3`);

    await Promise.all([
      pipeline(Readable.fromWeb(vocalsResponse.body as any), fs.createWriteStream(vocalsFilePath)),
      pipeline(Readable.fromWeb(musicResponse.body as any), fs.createWriteStream(musicFilePath)),
    ]);

    // For m4r format, use .m4a extension during processing (ffmpeg doesn't recognize .m4r)
    const isM4R = format === "m4r";
    const processingExtension = isM4R ? ".m4a" : extension;
    processedFilePath = path.join(TEMP_DIR, `${Date.now()}-${randomUUID()}${extension}`);

    if (vocalsEnabled && musicEnabled) {
      // Trim both tracks first
      vocalsTrimmedPath = path.join(TEMP_DIR, `${Date.now()}-${randomUUID()}-vocals-trimmed.wav`);
      musicTrimmedPath = path.join(TEMP_DIR, `${Date.now()}-${randomUUID()}-music-trimmed.wav`);

      if (!vocalsFilePath || !musicFilePath || !vocalsTrimmedPath || !musicTrimmedPath) {
        throw new Error("Failed to create temporary file paths");
      }

      await Promise.all([
        trimAudioWithFade({
          inputPath: vocalsFilePath,
          outputPath: vocalsTrimmedPath,
          startTime,
          duration,
          fadeInDuration: 0,
          fadeOutDuration: 0,
          format: "wav",
        }),
        trimAudioWithFade({
          inputPath: musicFilePath,
          outputPath: musicTrimmedPath,
          startTime,
          duration,
          fadeInDuration: 0,
          fadeOutDuration: 0,
          format: "wav",
        }),
      ]);

      // Combine tracks using ffmpeg
      if (!processedFilePath || !vocalsTrimmedPath || !musicTrimmedPath) {
        throw new Error("Failed to create processed file path");
      }
      const finalVocalsPath = vocalsTrimmedPath;
      const finalMusicPath = musicTrimmedPath;
      const finalProcessedPath = isM4R ? processedFilePath.replace(/\.m4r$/, ".m4a") : processedFilePath;
      await new Promise<void>((resolve, reject) => {
        let command = ffmpeg()
          .input(finalVocalsPath)
          .input(finalMusicPath)
          .complexFilter([
            "[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=2[a]",
          ])
          .outputOptions(["-map", "[a]"]);

        // Apply fade in/out
        if (fadeInEnabled && fadeInDuration > 0) {
          command = command.audioFilters(`afade=t=in:st=0:d=${fadeInDuration}`);
        }
        if (fadeOutEnabled && fadeOutDuration > 0) {
          const fadeOutStart = duration - fadeOutDuration;
          command = command.audioFilters(`afade=t=out:st=${fadeOutStart}:d=${fadeOutDuration}`);
        }

        // Apply format conversion
        const formatConfig = AUDIO_FORMAT_CONFIG[format];
        command = formatConfig.apply(command);

        command
          .output(finalProcessedPath)
          .on("end", async () => {
            // Rename .m4a to .m4r if needed
            if (isM4R && processedFilePath && finalProcessedPath !== processedFilePath) {
              try {
                await fs.promises.rename(finalProcessedPath, processedFilePath);
              } catch (renameError) {
                reject(new Error(`Failed to rename m4a to m4r: ${renameError instanceof Error ? renameError.message : String(renameError)}`));
                return;
              }
            }
            resolve();
          })
          .on("error", (err) => reject(err))
          .run();
      });
    } else if (vocalsEnabled) {
      // Only vocals
      if (!vocalsFilePath || !processedFilePath) {
        throw new Error("Failed to create temporary file paths");
      }
      await trimAudioWithFade({
        inputPath: vocalsFilePath,
        outputPath: processedFilePath,
        startTime,
        duration,
        fadeInDuration: fadeInEnabled ? fadeInDuration : 0,
        fadeOutDuration: fadeOutEnabled ? fadeOutDuration : 0,
        format,
      });
    } else if (musicEnabled) {
      // Only music
      if (!musicFilePath || !processedFilePath) {
        throw new Error("Failed to create temporary file paths");
      }
      await trimAudioWithFade({
        inputPath: musicFilePath,
        outputPath: processedFilePath,
        startTime,
        duration,
        fadeInDuration: fadeInEnabled ? fadeInDuration : 0,
        fadeOutDuration: fadeOutEnabled ? fadeOutDuration : 0,
        format,
      });
    } else {
      throw new Error("At least one track must be enabled");
    }

    // Determine title based on which tracks are enabled
    let actionTitle: string;
    if (vocalsEnabled && musicEnabled) {
      actionTitle = "Mixed Audio";
    } else if (vocalsEnabled) {
      actionTitle = "Vocals Only";
    } else {
      actionTitle = "Music Only";
    }

    // Add metadata with branded title
    const { title, filename } = generateAudioTitleAndFilename(actionTitle, trackNameBase);
    metadataPath = path.join(TEMP_DIR, `${Date.now()}-${randomUUID()}${extension}`);
    await addMetadataToAudio(processedFilePath!, metadataPath, title);

    // Upload to S3 exports folder
    const { downloadUrl, fileName } = await uploadAudioToS3({
      filePath: metadataPath,
      mimeType,
      downloadName: filename,
      extension,
      config: s3UploadConfig,
    });

    return {
      downloadUrl,
      fileName,
      format,
      trackName: filename,
      extension,
    };
  } finally {
    // Clean up temp files
    await Promise.all(
      [vocalsFilePath, musicFilePath, vocalsTrimmedPath, musicTrimmedPath, processedFilePath, metadataPath].map(async (filePath) => {
        if (filePath) {
          try {
            await fs.promises.unlink(filePath);
          } catch {
            // ignore cleanup errors
          }
        }
      })
    );
  }
}

// separateVoiceFromMusic - Separates vocals from music using LALAL.AI API
export async function separateVoiceFromMusic({
  audioUrl,
  suggestedTrackName,
}: {
  audioUrl: string;
  suggestedTrackName?: string | null;
}): Promise<{
  vocalsUrl: string;
  vocalsFileName: string;
  musicUrl: string;
  musicFileName: string;
  trackName: string;
}> {
  const lalalaiKey = process.env.LALALAI_KEY;
  if (!lalalaiKey) {
    throw new Error("LALALAI_KEY environment variable is not set.");
  }

  let downloadedFilePath: string | null = null;
  let vocalsFilePath: string | null = null;
  let musicFilePath: string | null = null;
  let vocalsWithMetadata: string | null = null;
  let musicWithMetadata: string | null = null;

  try {
    // Download audio file
    const { filePath, originalFileName } = await downloadAudioToTempFile(audioUrl);
    downloadedFilePath = filePath;

    const trackNameBase = sanitizeFileName(
      (suggestedTrackName ?? originalFileName ?? DEFAULT_TMP_PREFIX).replace(/\.[^/.]+$/, ""),
      DEFAULT_TMP_PREFIX
    );

    // Extract file extension from original filename
    const originalExtension = originalFileName.match(/\.[^.]+$/)?.[0] || ".mp3";
    const fileName = path.basename(filePath);

    // Upload to LALAL.AI
    const uploadResponse = await fetch("https://www.lalal.ai/api/upload/", {
      method: "POST",
      headers: {
        "Authorization": `license ${lalalaiKey}`,
        "Content-Disposition": `attachment; filename="${fileName}"`,
      },
      body: await fs.promises.readFile(filePath),
    });

    if (!uploadResponse.ok) {
      const errorData = await uploadResponse.json().catch(() => ({}));
      throw new Error(`LALAL.AI upload failed: ${errorData.error || uploadResponse.statusText}`);
    }

    const uploadData = await uploadResponse.json();
    if (uploadData.status !== "success") {
      throw new Error(`LALAL.AI upload failed: ${uploadData.error || "Unknown error"}`);
    }

    const fileId = uploadData.id;

    // Submit split request
    const splitResponse = await fetch("https://www.lalal.ai/api/split/", {
      method: "POST",
      headers: {
        "Authorization": `license ${lalalaiKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        params: JSON.stringify([{
          id: fileId,
          stem: "vocals",
        }]),
      }),
    });

    if (!splitResponse.ok) {
      const errorData = await splitResponse.json().catch(() => ({}));
      throw new Error(`LALAL.AI split request failed: ${errorData.error || splitResponse.statusText}`);
    }

    const splitData = await splitResponse.json();
    if (splitData.status !== "success") {
      throw new Error(`LALAL.AI split request failed: ${splitData.error || "Unknown error"}`);
    }

    // Poll for completion
    const maxAttempts = 100;
    const pollInterval = 3000; // 3 seconds
    let attempts = 0;
    let checkData: any = null;

    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));

      const checkResponse = await fetch("https://www.lalal.ai/api/check/", {
        method: "POST",
        headers: {
          "Authorization": `license ${lalalaiKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          id: fileId,
        }),
      });

      if (!checkResponse.ok) {
        throw new Error(`LALAL.AI check request failed: ${checkResponse.statusText}`);
      }

      checkData = await checkResponse.json();
      if (checkData.status !== "success") {
        throw new Error(`LALAL.AI check request failed: ${checkData.error || "Unknown error"}`);
      }

      const fileResult = checkData.result[fileId];
      if (!fileResult) {
        throw new Error("LALAL.AI: File result not found in check response");
      }

      if (fileResult.status === "error") {
        throw new Error(`LALAL.AI processing error: ${fileResult.error || "Unknown error"}`);
      }

      const task = fileResult.task;
      if (task?.state === "success" && fileResult.split) {
        // Processing complete
        break;
      } else if (task?.state === "error") {
        throw new Error(`LALAL.AI processing error: ${task.error || "Unknown error"}`);
      } else if (task?.state === "cancelled") {
        throw new Error("LALAL.AI processing was cancelled");
      }

      attempts++;
    }

    if (attempts >= maxAttempts) {
      throw new Error("LALAL.AI processing timed out after 5 minutes");
    }

    const fileResult = checkData.result[fileId];
    const splitResult = fileResult.split;

    if (!splitResult || !splitResult.stem_track || !splitResult.back_track) {
      throw new Error("LALAL.AI: Split result missing required tracks");
    }

    // Download both tracks
    const vocalsResponse = await fetch(splitResult.stem_track);
    if (!vocalsResponse.ok || !vocalsResponse.body) {
      throw new Error(`Failed to download vocals track. HTTP status ${vocalsResponse.status}`);
    }

    const musicResponse = await fetch(splitResult.back_track);
    if (!musicResponse.ok || !musicResponse.body) {
      throw new Error(`Failed to download music track. HTTP status ${musicResponse.status}`);
    }

    vocalsFilePath = path.join(TEMP_DIR, `${Date.now()}-${randomUUID()}-vocals${originalExtension}`);
    musicFilePath = path.join(TEMP_DIR, `${Date.now()}-${randomUUID()}-music${originalExtension}`);

    const vocalsReadable = Readable.fromWeb(vocalsResponse.body as any);
    await pipeline(vocalsReadable, fs.createWriteStream(vocalsFilePath));

    const musicReadable = Readable.fromWeb(musicResponse.body as any);
    await pipeline(musicReadable, fs.createWriteStream(musicFilePath));

    // Determine MIME type from extension
    const getMimeType = (ext: string): string => {
      const mimeMap: Record<string, string> = {
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".flac": "audio/flac",
        ".ogg": "audio/ogg",
        ".m4a": "audio/m4a",
        ".m4r": "audio/m4r",
      };
      return mimeMap[ext.toLowerCase()] || "audio/mpeg";
    };

    const mimeType = getMimeType(originalExtension);

    // Generate titles and filenames with brand text
    const { title: vocalsTitle, filename: vocalsFilename } = generateAudioTitleAndFilename("Vocals Only", `${trackNameBase}_vocals`);
    const { title: musicTitle, filename: musicFilename } = generateAudioTitleAndFilename("Music Only", `${trackNameBase}_music`);

    // Add metadata to audio files before uploading
    vocalsWithMetadata = path.join(TEMP_DIR, `${Date.now()}-${randomUUID()}-vocals-metadata${originalExtension}`);
    musicWithMetadata = path.join(TEMP_DIR, `${Date.now()}-${randomUUID()}-music-metadata${originalExtension}`);

    await Promise.all([
      addMetadataToAudio(vocalsFilePath, vocalsWithMetadata, vocalsTitle),
      addMetadataToAudio(musicFilePath, musicWithMetadata, musicTitle),
    ]);

    // Update file paths to use metadata-enhanced versions
    const finalVocalsPath = vocalsWithMetadata;
    const finalMusicPath = musicWithMetadata;

    const [vocalsUpload, musicUpload] = await Promise.all([
      uploadAudioToS3({
        filePath: finalVocalsPath,
        mimeType,
        downloadName: vocalsFilename,
        extension: originalExtension,
        config: s3UploadConfig,
      }),
      uploadAudioToS3({
        filePath: finalMusicPath,
        mimeType,
        downloadName: musicFilename,
        extension: originalExtension,
        config: s3UploadConfig,
      }),
    ]);

    return {
      vocalsUrl: vocalsUpload.downloadUrl,
      vocalsFileName: vocalsUpload.fileName,
      musicUrl: musicUpload.downloadUrl,
      musicFileName: musicUpload.fileName,
      trackName: trackNameBase,
    };
  } finally {
    // Clean up temp files (including metadata-enhanced versions)
    await Promise.all(
      [downloadedFilePath, vocalsFilePath, musicFilePath, vocalsWithMetadata, musicWithMetadata].map(async (filePath) => {
        if (filePath) {
          try {
            await fs.promises.unlink(filePath);
          } catch {
            // ignore cleanup errors
          }
        }
      })
    );
  }
}

// addMetadataToAudio - Adds title metadata to audio file using ffmpeg
async function addMetadataToAudio(
  inputPath: string,
  outputPath: string,
  title: string
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Escape quotes in title and wrap in quotes for ffmpeg metadata
    // Replace double quotes with single quotes to avoid conflicts
    const safeTitle = title.replace(/"/g, "'");
    
    // Use codec copy to preserve quality (no re-encoding)
    // Quote the metadata value to handle spaces and special characters (parentheses, etc.)
    ffmpeg(inputPath)
      .addOption("-metadata", `title="${safeTitle}"`)
      .addOption("-codec", "copy") // Copy codec to avoid re-encoding (preserves quality)
      .on("error", (error: unknown) => reject(error))
      .on("end", () => resolve())
      .save(outputPath);
  });
}

// decodeAudioToWav - Converts audio file to WAV format for analysis
async function decodeAudioToWav(inputPath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const outputPath = path.join(TEMP_DIR, `${Date.now()}-${randomUUID()}.wav`);
    ffmpeg(inputPath)
      .audioChannels(1) // Mono for analysis
      .audioFrequency(44100) // Standard sample rate
      .audioCodec("pcm_s16le")
      .format("wav")
      .on("error", (err: unknown) => reject(err))
      .on("end", () => resolve(outputPath))
      .save(outputPath);
  });
}

// parseWavFile - Parses WAV file and returns audio samples
function parseWavFile(wavPath: string): Promise<{ samples: Float32Array; sampleRate: number }> {
  return new Promise((resolve, reject) => {
    fs.readFile(wavPath, (err, buffer) => {
      if (err) {
        reject(err);
        return;
      }

      // WAV file header parsing
      const sampleRate = buffer.readUInt32LE(24);
      const numChannels = buffer.readUInt16LE(22);
      const bitsPerSample = buffer.readUInt16LE(34);
      const dataOffset = 44; // Standard WAV header size
      const dataLength = buffer.length - dataOffset;

      if (bitsPerSample !== 16) {
        reject(new Error(`Unsupported bits per sample: ${bitsPerSample}`));
        return;
      }

      // Calculate samples per channel (accounting for interleaved channels)
      const samplesPerChannel = dataLength / (2 * numChannels);
      const samples = new Float32Array(samplesPerChannel);

      if (numChannels === 1) {
        // Mono: simple conversion
        for (let i = 0; i < samples.length; i++) {
          const sample = buffer.readInt16LE(dataOffset + i * 2);
          samples[i] = sample / 32768.0;
        }
      } else {
        // Stereo (or multi-channel): average channels to mono
        // Stereo WAV files store interleaved samples: L, R, L, R, ...
        for (let i = 0; i < samples.length; i++) {
          const leftIdx = dataOffset + (i * numChannels * 2);
          const rightIdx = leftIdx + 2;
          
          const leftSample = buffer.readInt16LE(leftIdx) / 32768.0;
          const rightSample = buffer.readInt16LE(rightIdx) / 32768.0;
          
          // Average both channels to create mono signal
          samples[i] = (leftSample + rightSample) / 2;
        }
      }

      resolve({ samples, sampleRate });
    });
  });
}

// initializeEssentia - Lazy initialization of Essentia.js
let essentiaInstance: InstanceType<typeof EssentiaModule.Essentia> | null = null;
async function initializeEssentia(): Promise<InstanceType<typeof EssentiaModule.Essentia>> {
  if (!essentiaInstance) {
    // EssentiaWASM is already the module object in UMD build, pass it directly to Essentia constructor
    essentiaInstance = new EssentiaModule.Essentia(EssentiaModule.EssentiaWASM);
  }
  return essentiaInstance;
}

// detectBPMWithEssentia - Uses Essentia.js RhythmExtractor2013 for BPM detection
async function detectBPMWithEssentia(samples: Float32Array, sampleRate: number): Promise<number | null> {
  try {
    const essentia = await initializeEssentia();
    
    // Convert Float32Array to Essentia VectorFloat
    const audioVector = essentia.arrayToVector(samples);
    
    // Use RhythmExtractor2013 for accurate BPM detection
    // Default tempo range: 40-208 BPM (can be adjusted if needed)
    const result = essentia.RhythmExtractor2013(audioVector, 208, "multifeature", 40);
    
    const bpm = result.bpm;
    
    // Validate BPM result
    if (bpm && bpm > 0 && bpm < 300) {
      return Math.round(bpm);
    }
    
    return null;
  } catch (error) {
    console.warn("[BPM Detection] Essentia.js failed:", error);
    return null;
  }
}

// detectKeyWithEssentia - Uses Essentia.js KeyExtractor for key detection
async function detectKeyWithEssentia(samples: Float32Array, sampleRate: number): Promise<{ key: string; scale?: string } | null> {
  try {
    const essentia = await initializeEssentia();
    
    // Convert Float32Array to Essentia VectorFloat
    const audioVector = essentia.arrayToVector(samples);
    
    // Use KeyExtractor for accurate key detection
    // Uses HPCP (Harmonic Pitch Class Profile) and key estimation algorithms
    const result = essentia.KeyExtractor(
      audioVector,
      true, // averageDetuningCorrection
      4096, // frameSize
      4096, // hopSize
      12, // hpcpSize
      3500, // maxFrequency
      60, // maximumSpectralPeaks
      25, // minFrequency
      0.2, // pcpThreshold
      "bgate", // profileType (bgate = Bello & Goto profile)
      sampleRate, // sampleRate
      0.0001, // spectralPeaksThreshold
      440, // tuningFrequency
      "cosine", // weightType
      "hann" // windowType
    );
    
    const key = result.key;
    const scale = result.scale;
    
    // Validate key result
    if (key && key.length > 0) {
      return {
        key: key,
        scale: scale || undefined,
      };
    }
    
    return null;
  } catch (error) {
    console.warn("[Key Detection] Essentia.js failed:", error);
    return null;
  }
}

// detectBPMAndKey - Detects BPM and musical key from audio file using Essentia.js
export async function detectBPMAndKey({
  audioUrl,
}: {
  audioUrl: string;
}): Promise<{
  bpm: number | null;
  key: string | null;
}> {
  let downloadedFilePath: string | null = null;
  let wavFilePath: string | null = null;

  try {
    // Download audio file
    const { filePath } = await downloadAudioToTempFile(audioUrl);
    downloadedFilePath = filePath;

    // Convert to WAV for analysis (no downsampling - preserves quality)
    wavFilePath = await decodeAudioToWav(downloadedFilePath);

    // Parse WAV file
    const { samples, sampleRate } = await parseWavFile(wavFilePath);

    // Use Essentia.js for BPM and key detection
    const [bpm, keyResult] = await Promise.all([
      detectBPMWithEssentia(samples, sampleRate),
      detectKeyWithEssentia(samples, sampleRate),
    ]);

    // Combine key and scale into a single string like "C Major" or "A Minor"
    const scaleCapitalized = keyResult?.scale 
      ? keyResult.scale.charAt(0).toUpperCase() + keyResult.scale.slice(1)
      : "Major";
    const key = keyResult ? `${keyResult.key} ${scaleCapitalized}` : null;

    console.log("[BPM/Key Detection] Essentia.js Results:", {
      bpm,
      key,
      keyResult: keyResult ? { key: keyResult.key, scale: keyResult.scale } : null,
    });

    return {
      bpm,
      key,
    };
  } catch (error) {
    console.error("[BPM/Key Detection] Error:", error);
    throw new Error(
      `Failed to detect BPM and key: ${error instanceof Error ? error.message : "Unknown error"}`
    );
  } finally {
    // Clean up temp files
    await Promise.all(
      [downloadedFilePath, wavFilePath].map(async (filePath) => {
        if (filePath) {
          try {
            await fs.promises.unlink(filePath);
          } catch {
            // ignore cleanup errors
          }
        }
      })
    );
  }
}

// cleanupOldS3Files - Deletes files from S3 uploads and exports folders older than 24 hours
export async function cleanupOldS3Files(): Promise<{
  deletedCount: number;
  errors: number;
}> {
  if (!s3Client || !s3Bucket) {
    throw new Error("S3 configuration is missing on the server.");
  }

  const now = Date.now();
  const twentyFourHoursAgo = now - 24 * 60 * 60 * 1000; // 24 hours in milliseconds
  let deletedCount = 0;
  let errors = 0;

  const foldersToClean = [s3UploadsFolder, s3ExportsFolder].filter((f): f is string => Boolean(f));

  if (foldersToClean.length === 0) {
    console.log("[S3 Cleanup] No folders configured for cleanup (S3_UPLOADS_FOLDER and S3_EXPORTS_FOLDER)");
    return { deletedCount: 0, errors: 0 };
  }

  for (const folder of foldersToClean) {
    const keyPrefixNormalized = folder.replace(/^\/*/, "").replace(/\/*$/, "");
    const prefix = keyPrefixNormalized ? `${keyPrefixNormalized}/` : "";

    try {
      let continuationToken: string | undefined;
      
      do {
        const listCommand = new ListObjectsV2Command({
          Bucket: s3Bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        });

        const listResponse = await s3Client.send(listCommand);
        const objectsToDelete: Array<{ Key: string }> = [];

        if (listResponse.Contents) {
          for (const object of listResponse.Contents) {
            if (object.Key && object.LastModified) {
              const lastModified = object.LastModified.getTime();
              if (lastModified < twentyFourHoursAgo) {
                objectsToDelete.push({ Key: object.Key });
              }
            }
          }
        }

        if (objectsToDelete.length > 0) {
          // Delete in batches of 1000 (S3 limit)
          for (let i = 0; i < objectsToDelete.length; i += 1000) {
            const batch = objectsToDelete.slice(i, i + 1000);
            try {
              const deleteCommand = new DeleteObjectsCommand({
                Bucket: s3Bucket,
                Delete: {
                  Objects: batch,
                  Quiet: true,
                },
              });
              await s3Client.send(deleteCommand);
              deletedCount += batch.length;
              console.log(`[S3 Cleanup] Deleted ${batch.length} files from ${folder}`);
            } catch (error) {
              console.warn(`[S3 Cleanup] Failed to delete batch from ${folder}:`, error);
              errors += batch.length;
            }
          }
        }

        continuationToken = listResponse.NextContinuationToken;
      } while (continuationToken);
    } catch (error) {
      console.error(`[S3 Cleanup] Error listing objects in ${folder}:`, error);
      errors++;
    }
  }

  console.log(`[S3 Cleanup] Completed: ${deletedCount} files deleted, ${errors} errors`);
  return { deletedCount, errors };
}