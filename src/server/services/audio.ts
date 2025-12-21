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
import { PutObjectCommand, type PutObjectCommandInput, S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
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
function normalizeAudioExportFormat(value: string | undefined | null): AudioExportFormat {
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

  const command = new PutObjectCommand({
    Bucket: s3Bucket,
    Key: fileKey,
    ContentType: contentType,
  });

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