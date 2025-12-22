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
import { PutObjectCommand, type PutObjectCommandInput, S3Client, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";

/* ----------------------------- FFMPEG CONFIGURATION ----------------------------- */
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

/* ----------------------------- CONSTANTS ----------------------------- */
const DEFAULT_TMP_PREFIX = "audio";
const TEMP_DIR = process.env.VERCEL ? "/tmp" : path.join(projectRoot, "tmp");
const s3Region = process.env.AWS_REGION;
const s3Bucket = process.env.S3_BUCKET;
const s3RingtonesFolder = process.env.S3_RINGTONES_FOLDER;
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
  keyPrefix: s3RingtonesFolder,
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
        .format("mp4")
        .outputOptions(["-movflags", "+faststart", "-vn"]),
  },
};

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
await new Promise<void>((resolve, reject) => {
    const command = configureCommand(ffmpeg(inputPath), format);
    command.on("error", (error: unknown) => reject(error));
    command.on("end", () => resolve());
    command.save(outputPath);
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
    command.on("end", () => resolve());
    command.save(outputPath);
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

    const { downloadUrl, fileName } = await uploadAudioToS3({
      filePath: convertedPath,
      mimeType,
      downloadName: downloadBaseName,
      extension,
      config: s3UploadConfig,
    });

    return {
      downloadUrl,
      fileName,
      trackName: downloadBaseName,
      format,
      extension,
    };
  } finally {
    if (convertedPath) {
      try {
        await fs.promises.unlink(convertedPath);
      } catch {
        // ignore cleanup errors
      }
    }
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

    const { downloadUrl, fileName } = await uploadAudioToS3({
      filePath: convertedFilePath,
      mimeType: AUDIO_FORMAT_CONFIG[format].mimeType,
      downloadName: trackNameBase,
      extension,
      config: s3UploadConfig,
    });

    return {
      downloadUrl,
      fileName,
      format,
      trackName: trackNameBase,
      extension,
    };
  } finally {
    await Promise.all(
      [downloadedFilePath, convertedFilePath].map(async (filePath) => {
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

    const { downloadUrl, fileName } = await uploadAudioToS3({
      filePath: trimmedFilePath,
      mimeType,
      downloadName: trackNameBase,
      extension,
      config: s3UploadConfig,
    });

    return {
      downloadUrl,
      fileName,
      format,
      trackName: trackNameBase,
      extension,
    };
  } finally {
    await Promise.all(
      [downloadedFilePath, trimmedFilePath].map(async (filePath) => {
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

    const { downloadUrl, fileName } = await uploadAudioToS3({
      filePath: trimmedFilePath,
      mimeType,
      downloadName: trackNameBase,
      extension,
      config: s3UploadConfig,
    });

    return {
      downloadUrl,
      fileName,
      format,
      trackName: trackNameBase,
      extension,
    };
  } finally {
    await Promise.all(
      [downloadedFilePath, trimmedFilePath].map(async (filePath) => {
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

    const { downloadUrl, fileName } = await uploadAudioToS3({
      filePath: processedFilePath,
      mimeType,
      downloadName: trackNameBase,
      extension,
      config: s3UploadConfig,
    });

    // Delete the temporary uploaded file from /uploads folder if it's from our S3 bucket
    await deleteFromS3(audioUrl);

    return {
      downloadUrl,
      fileName,
      format,
      trackName: trackNameBase,
      extension,
    };
  } finally {
    await Promise.all(
      [downloadedFilePath, processedFilePath].map(async (filePath) => {
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

    // Use S3_UPLOADS_FOLDER for uploaded files
    const uploadsConfig: S3UploadConfig = {
      ...s3UploadConfig,
      keyPrefix: s3UploadsFolder,
    };

    const { downloadUrl, fileName } = await uploadAudioToS3({
      filePath: processedFilePath,
      mimeType,
      downloadName: trackNameBase,
      extension,
      config: uploadsConfig,
    });

    return {
      downloadUrl,
      fileName,
      format,
      trackName: trackNameBase,
      extension,
    };
  } finally {
    if (processedFilePath) {
      try {
        await fs.promises.unlink(processedFilePath);
      } catch {
        // ignore cleanup errors
      }
    }
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

    // Upload both tracks to S3
    const vocalsBaseName = `${trackNameBase}_vocals`;
    const musicBaseName = `${trackNameBase}_music`;

    const [vocalsUpload, musicUpload] = await Promise.all([
      uploadAudioToS3({
        filePath: vocalsFilePath,
        mimeType,
        downloadName: vocalsBaseName,
        extension: originalExtension,
        config: s3UploadConfig,
      }),
      uploadAudioToS3({
        filePath: musicFilePath,
        mimeType,
        downloadName: musicBaseName,
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
    // Clean up temp files
    await Promise.all(
      [downloadedFilePath, vocalsFilePath, musicFilePath].map(async (filePath) => {
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

// detectBPMFromSamples - Simple BPM detection using autocorrelation
function detectBPMFromSamples(samples: Float32Array, sampleRate: number): number | null {
  // Analyze first 30 seconds for performance
  const maxDuration = 30; // seconds
  const maxSamples = Math.min(samples.length, sampleRate * maxDuration);
  const analysisSamples = samples.slice(0, maxSamples);

  // Simple autocorrelation-based BPM detection
  const minBPM = 60;
  const maxBPM = 200;
  const minPeriod = Math.floor((60 / maxBPM) * sampleRate);
  const maxPeriod = Math.floor((60 / minBPM) * sampleRate);

  let maxCorrelation = 0;
  let bestPeriod = 0;

  for (let period = minPeriod; period <= maxPeriod; period++) {
    let correlation = 0;
    const correlationLength = Math.min(analysisSamples.length - period, sampleRate * 2);

    for (let i = 0; i < correlationLength; i++) {
      correlation += Math.abs(analysisSamples[i] * analysisSamples[i + period]);
    }

    correlation /= correlationLength;

    if (correlation > maxCorrelation) {
      maxCorrelation = correlation;
      bestPeriod = period;
    }
  }

  if (bestPeriod === 0) {
    return null;
  }

  const bpm = (60 * sampleRate) / bestPeriod;
  return Math.round(bpm);
}

// detectKeyFromSamples - Simple key detection using pitch analysis
function detectKeyFromSamples(samples: Float32Array, sampleRate: number): { key: string; scale?: string } | null {
  // Analyze first 30 seconds
  const maxDuration = 30;
  const maxSamples = Math.min(samples.length, sampleRate * maxDuration);
  const analysisSamples = samples.slice(0, maxSamples);

  // Simple pitch detection using autocorrelation
  const minFreq = 80; // Hz (low E)
  const maxFreq = 1000; // Hz
  const minPeriod = Math.floor(sampleRate / maxFreq);
  const maxPeriod = Math.floor(sampleRate / minFreq);

  let maxCorrelation = 0;
  let bestPeriod = 0;

  for (let period = minPeriod; period <= maxPeriod; period++) {
    let correlation = 0;
    const correlationLength = Math.min(analysisSamples.length - period, sampleRate);

    for (let i = 0; i < correlationLength; i++) {
      correlation += Math.abs(analysisSamples[i] * analysisSamples[i + period]);
    }

    correlation /= correlationLength;

    if (correlation > maxCorrelation) {
      maxCorrelation = correlation;
      bestPeriod = period;
    }
  }

  if (bestPeriod === 0) {
    return null;
  }

  const frequency = sampleRate / bestPeriod;

  // Convert frequency to musical note
  const A4 = 440; // Standard tuning
  const C0 = A4 * Math.pow(2, -4.75);
  const h = Math.round(12 * Math.log2(frequency / C0));
  const note = h % 12;
  const octave = Math.floor(h / 12) - 1;

  const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const detectedNote = noteNames[note];

  // Return the detected note even if correlation is low - better to show something than nothing
  // The correlation threshold was too strict and prevented key detection for many audio files
  return {
    key: detectedNote,
    scale: "major", // Simplified - real detection would analyze harmonic content
  };
}

// detectBPMAndKey - Detects BPM and musical key from audio file
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

    // Convert to WAV for analysis
    wavFilePath = await decodeAudioToWav(downloadedFilePath);

    // Parse WAV file
    const { samples, sampleRate } = await parseWavFile(wavFilePath);

    // Detect BPM
    const bpm = detectBPMFromSamples(samples, sampleRate);

    // Detect key
    const keyResult = detectKeyFromSamples(samples, sampleRate);
    // Combine key and scale into a single string like "C Major" or "A Minor"
    const key = keyResult ? `${keyResult.key} ${keyResult.scale || "Major"}` : null;

    console.log("[BPM/Key Detection] Results:", {
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