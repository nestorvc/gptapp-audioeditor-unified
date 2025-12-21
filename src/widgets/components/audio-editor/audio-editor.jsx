/**
 * AUDIO-EDITOR.JSX - Audio Editor Component
 * 
 * Main component for editing and exporting audio files in various formats (MP3, WAV, FLAC, OGG, M4A).
 * Provides waveform visualization, trim controls, fade effects, and format selection.
 * Integrates with ChatGPT via the OpenAI widget API to receive audio URLs and send
 * download links back to the conversation.
 */

import React, { useState, useRef, useEffect, useCallback } from "react";
import "./audio-editor.css";
import { useToolOutput, useSendFollowUpMessage, useOpenAIGlobals } from "../../hooks/useOpenAI";

// Debug utility - only logs if DEBUG is not 'false'
// Checks: window.__DEBUG__, import.meta.env.DEBUG, or import.meta.env.VITE_DEBUG
const DEBUG = (() => {
  if (typeof window !== 'undefined' && window.__DEBUG__ === 'false') {
    return false;
  }
  if (import.meta.env?.DEBUG === 'false' || import.meta.env?.VITE_DEBUG === 'false') {
    return false;
  }
  return true; // Default to logging enabled
})();
const debugLog = (...args) => {
  if (DEBUG) {
    console.log(...args);
  }
};

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const sanitizeFileName = (rawName, fallback = "audio") => {
  if (!rawName || typeof rawName !== "string") {
    return fallback;
  }

  const sanitized = rawName
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .trim()
    .replace(/\s+/g, "-");

  return sanitized.length > 0 ? sanitized : fallback;
};

const DEFAULT_FADE_DURATION = 1.5;

const prepareTrimmedAudioData = (audioBuffer, startTime, endTime, options) => {
  const {
    fadeInEnabled = false,
    fadeOutEnabled = false,
    fadeInDuration = 0,
    fadeOutDuration = 0,
  } = options ?? {};

  if (!audioBuffer) {
    throw new Error("Audio buffer is not available.");
  }

  const sampleRate = audioBuffer.sampleRate;
  const totalSamples = audioBuffer.length;

  const startSample = clamp(Math.floor(startTime * sampleRate), 0, Math.max(totalSamples - 1, 0));
  const endSample = clamp(
    Math.floor(endTime * sampleRate),
    Math.min(startSample + 1, totalSamples),
    totalSamples
  );

  const frameCount = endSample - startSample;

  if (frameCount <= 0) {
    throw new Error("Selected trim duration is too short. Try widening the selection.");
  }

  const numberOfChannels = audioBuffer.numberOfChannels;
  const channelData = [];

  for (let channel = 0; channel < numberOfChannels; channel += 1) {
    const sourceChannel = audioBuffer.getChannelData(channel);
    const slice = sourceChannel.subarray(startSample, endSample);
    const copied = new Float32Array(slice.length);
    copied.set(slice);
    channelData.push(copied);
  }

  const fadeInSamples = fadeInEnabled
    ? Math.min(Math.floor(fadeInDuration * sampleRate), frameCount)
    : 0;
  const fadeOutSamples = fadeOutEnabled
    ? Math.min(Math.floor(fadeOutDuration * sampleRate), frameCount)
    : 0;

  if (fadeInSamples > 0) {
    for (let channel = 0; channel < numberOfChannels; channel += 1) {
      const data = channelData[channel];
      for (let i = 0; i < fadeInSamples; i += 1) {
        const gain = (i + 1) / fadeInSamples;
        data[i] *= gain;
      }
    }
  }

  if (fadeOutSamples > 0) {
    for (let channel = 0; channel < numberOfChannels; channel += 1) {
      const data = channelData[channel];
      for (let i = 0; i < fadeOutSamples; i += 1) {
        const sampleIndex = data.length - fadeOutSamples + i;
        if (sampleIndex >= 0 && sampleIndex < data.length) {
          const gain = (fadeOutSamples - i) / fadeOutSamples;
          data[sampleIndex] *= clamp(gain, 0, 1);
        }
      }
    }
  }

  return {
    channelData,
    sampleRate,
    frameCount,
    numberOfChannels,
  };
};

// Downsample audio data to reduce file size for upload
// Target: keep files under 4MB to stay within Vercel's 4.5MB limit
const downsampleAudio = (channelData, originalSampleRate, targetSampleRate) => {
  if (originalSampleRate <= targetSampleRate) {
    return { channelData, sampleRate: originalSampleRate };
  }

  const ratio = originalSampleRate / targetSampleRate;
  const numChannels = channelData.length;
  const originalFrameCount = channelData[0]?.length ?? 0;
  const newFrameCount = Math.floor(originalFrameCount / ratio);
  
  const downsampledChannels = [];
  
  for (let channel = 0; channel < numChannels; channel += 1) {
    const originalData = channelData[channel];
    const downsampled = new Float32Array(newFrameCount);
    
    for (let i = 0; i < newFrameCount; i += 1) {
      const sourceIndex = Math.floor(i * ratio);
      downsampled[i] = originalData[sourceIndex];
    }
    
    downsampledChannels.push(downsampled);
  }
  
  return {
    channelData: downsampledChannels,
    sampleRate: targetSampleRate,
  };
};

// Calculate safe sample rate to keep file under size limit
const calculateSafeSampleRate = (duration, numChannels, maxSizeMB = 4) => {
  // Safety check
  if (duration <= 0 || numChannels <= 0) {
    return 44100; // Default fallback
  }
  
  const maxSizeBytes = maxSizeMB * 1024 * 1024;
  const bytesPerSample = 2; // 16-bit
  const maxSamples = maxSizeBytes / (numChannels * bytesPerSample);
  const maxSampleRate = Math.floor(maxSamples / duration);
  
  // Handle edge cases (Infinity, NaN, or invalid values)
  if (!isFinite(maxSampleRate) || maxSampleRate <= 0) {
    return 44100; // Default fallback
  }
  
  // Round down to common sample rates
  if (maxSampleRate >= 44100) return 44100;
  if (maxSampleRate >= 32000) return 32000;
  if (maxSampleRate >= 22050) return 22050;
  if (maxSampleRate >= 16000) return 16000;
  return 8000;
};

const encodeChannelDataToWav = (channelData, sampleRate) => {
  if (!channelData || channelData.length === 0) {
    throw new Error("No audio data to encode.");
  }

  const numChannels = channelData.length;
  const frameCount = channelData[0]?.length ?? 0;

  if (frameCount === 0) {
    throw new Error("Audio data is empty.");
  }

  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = frameCount * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  let offset = 0;
  const writeString = (value) => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
    offset += value.length;
  };
  const writeUint32 = (value) => {
    view.setUint32(offset, value, true);
    offset += 4;
  };
  const writeUint16 = (value) => {
    view.setUint16(offset, value, true);
    offset += 2;
  };

  writeString("RIFF");
  writeUint32(36 + dataSize);
  writeString("WAVE");
  writeString("fmt ");
  writeUint32(16);
  writeUint16(1);
  writeUint16(numChannels);
  writeUint32(sampleRate);
  writeUint32(byteRate);
  writeUint16(blockAlign);
  writeUint16(16);
  writeString("data");
  writeUint32(dataSize);

  let dataOffset = 44;

  for (let i = 0; i < frameCount; i += 1) {
    for (let channel = 0; channel < numChannels; channel += 1) {
      const sample = channelData[channel][i];
      const clamped = clamp(sample, -1, 1);
      const intSample = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      view.setInt16(dataOffset, intSample, true);
      dataOffset += 2;
    }
  }

  return buffer;
};

const OUTPUT_FORMAT_OPTIONS = [
  { value: "mp3", label: "MP3" },
  { value: "wav", label: "WAV" },
  { value: "flac", label: "FLAC" },
  { value: "ogg", label: "OGG (Opus)" },
  { value: "m4a", label: "M4A (AAC)" },
  { value: "m4r", label: "M4R (iOS Ringtone)" },
];

const RINGTONE_FORMAT_OPTIONS = [
  { value: "m4r", label: "iPhone (.m4r)" },
  { value: "ogg", label: "Android (.ogg)" },
];

const SUPPORTED_OUTPUT_FORMATS = OUTPUT_FORMAT_OPTIONS.map((option) => option.value);

// Platform detection function
const detectPlatform = (userAgentInfo) => {
  const deviceType = userAgentInfo?.device?.type;
  
  // Check if mobile/tablet device
  if (deviceType === 'mobile' || deviceType === 'tablet') {
    const ua = navigator.userAgent.toLowerCase();
    if (/iphone|ipad|ipod/.test(ua)) {
      return 'ios';
    }
    if (/android/.test(ua)) {
      return 'android';
    }
  }
  
  return 'unknown';
};

// Get default format based on platform
const getDefaultFormatForPlatform = (userAgentInfo) => {
  const platform = detectPlatform(userAgentInfo);
  if (platform === 'ios') {
    return 'm4r';
  }
  if (platform === 'android') {
    return 'ogg';
  }
  return 'mp3';
};

// Default format will be set in component using openAIGlobals
const DEFAULT_OUTPUT_FORMAT = "mp3"; // Fallback default

const normalizeOutputFormat = (value) => {
  if (!value || typeof value !== "string") {
    return DEFAULT_OUTPUT_FORMAT;
  }
  const normalized = value.toLowerCase();
  return SUPPORTED_OUTPUT_FORMATS.includes(normalized) ? normalized : DEFAULT_OUTPUT_FORMAT;
};

export function AudioEditor() {
  // Get audio URL from ChatGPT tool output (if user uploaded a file)
  const toolOutput = useToolOutput();
  const openAIGlobals = useOpenAIGlobals();
  const isRingtoneMode = toolOutput?.mode === "ringtone";
  const platform = detectPlatform(openAIGlobals.userAgent);
  const [isPlaying, setIsPlaying] = useState(false);
  const [outputFormat, setOutputFormat] = useState(() => {
    // Initialize with platform-specific default
    if (isRingtoneMode) {
      return platform === 'ios' ? 'm4r' : 'ogg';
    }
    return getDefaultFormatForPlatform(openAIGlobals.userAgent);
  });
  const [trackName, setTrackName] = useState("");
  const [fadeInEnabled, setFadeInEnabled] = useState(false);
  const [fadeOutEnabled, setFadeOutEnabled] = useState(false);
  const [fadeInTime, setFadeInTime] = useState(0);
  const [fadeOutTime, setFadeOutTime] = useState(0);
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [showFormatDropdown, setShowFormatDropdown] = useState(false);
  const [waveformData, setWaveformData] = useState([]);
  const [totalDuration, setTotalDuration] = useState(0);
  const [audioChannels, setAudioChannels] = useState(0);
  const [audioSampleRate, setAudioSampleRate] = useState(0);
  const [fileSize, setFileSize] = useState(0);
  const [audioFormat, setAudioFormat] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [startTrim, setStartTrim] = useState(0.2);
  const [endTrim, setEndTrim] = useState(0.6);
  const [trimmerPosition, setTrimmerPosition] = useState(0.25);
  const [isDraggingStart, setIsDraggingStart] = useState(false);
  const [isDraggingEnd, setIsDraggingEnd] = useState(false);
  const [isDraggingTrimmer, setIsDraggingTrimmer] = useState(false);
  const waveformRef = useRef(null);
  const waveformSectionRef = useRef(null);
  const audioContextRef = useRef(null);
  const sourceNodeRef = useRef(null);
  const gainNodeRef = useRef(null);
  const animationFrameRef = useRef(null);
  const playbackStartTimeRef = useRef(null);
  const marqueeContentRef = useRef(null);
  const [duplicatedText, setDuplicatedText] = useState("");
  // File upload state
  const [uploadedAudioUrl, setUploadedAudioUrl] = useState(null);
  const [uploadedFileName, setUploadedFileName] = useState(null);
  const [uploadedFile, setUploadedFile] = useState(null); // Store File object to avoid CSP issues
  const fileInputRef = useRef(null);
  const audioBufferRef = useRef(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationError, setGenerationError] = useState(null);
  const [generationSuccess, setGenerationSuccess] = useState("");
  const [downloadUrl, setDownloadUrl] = useState(null);
  const [uploadError, setUploadError] = useState(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const sendFollowUpMessage = useSendFollowUpMessage();

  useEffect(() => {
    setGenerationError(null);
    setGenerationSuccess("");
    setDownloadUrl(null);
  }, [outputFormat]);

  useEffect(() => {
    if (toolOutput?.defaultFormat) {
      setOutputFormat(normalizeOutputFormat(toolOutput.defaultFormat));
    } else {
      // If no default format from tool output, use platform-specific default
      if (isRingtoneMode) {
        setOutputFormat(platform === 'ios' ? 'm4r' : 'ogg');
      } else {
        setOutputFormat(getDefaultFormatForPlatform(openAIGlobals.userAgent));
      }
    }
  }, [toolOutput?.defaultFormat, toolOutput?.mode, openAIGlobals.userAgent, isRingtoneMode, platform]);

  useEffect(() => {
    // Log only serializable properties to avoid DataCloneError
    debugLog('🔍 [COMPONENT MOUNT] window.openai available:', {
      windowOpenai: window.openai,
      hasOpenai: !!window.openai,
      availableKeys: window.openai ? Object.keys(window.openai).filter(key => typeof window.openai[key] !== 'function') : [],
      hasToolOutput: !!window.openai?.toolOutput,
      hasToolInput: !!window.openai?.toolInput,
    });

  }, []);

  // Format duration as MM:SS
  const formatDuration = (seconds) => {
    if (!seconds || seconds <= 0) return "00:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  // Format channels as "Mono", "Stereo", or "X Channel"
  const formatChannels = (channels) => {
    if (channels === 1) return "Mono";
    if (channels === 2) return "Stereo";
    return `${channels} Channel${channels !== 1 ? 's' : ''}`;
  };

  // Format sample rate as "XX kHz"
  const formatSampleRate = (sampleRate) => {
    if (!sampleRate || sampleRate <= 0) return "0 kHz";
    const kHz = Math.round(sampleRate / 1000);
    return `${kHz} kHz`;
  };

  // Format file size as "XXX KB" or "X.X MB"
  const formatFileSize = (bytes) => {
    if (!bytes || bytes <= 0) return "0 KB";
    const kb = bytes / 1024;
    if (kb < 1024) {
      return `${Math.round(kb)} KB`;
    }
    const mb = kb / 1024;
    return `${mb.toFixed(1)} MB`;
  };

  // Detect audio format from URL or file
  const detectAudioFormat = (url, file) => {
    if (file && file.name) {
      const fileName = file.name;
      const lastDot = fileName.lastIndexOf('.');
      if (lastDot > 0 && lastDot < fileName.length - 1) {
        const ext = fileName.substring(lastDot + 1).toLowerCase();
        const formatMap = { mp3: 'MP3', wav: 'WAV', m4a: 'M4A', m4r: 'M4R', flac: 'FLAC', ogg: 'OGG', aac: 'AAC', webm: 'WebM' };
        return formatMap[ext] || ext.toUpperCase();
      }
    }
    if (url) {
      const urlWithoutQuery = url.split('?')[0];
      // Extract the pathname and get the last segment
      try {
        const urlObj = new URL(urlWithoutQuery);
        const pathname = urlObj.pathname;
        const fileName = pathname.split('/').pop() || '';
        const lastDot = fileName.lastIndexOf('.');
        if (lastDot > 0 && lastDot < fileName.length - 1) {
          const ext = fileName.substring(lastDot + 1).toLowerCase();
          // Only return if it's a valid audio extension (not too long, common audio formats)
          if (ext.length <= 5 && /^[a-z0-9]+$/i.test(ext)) {
            const formatMap = { mp3: 'MP3', wav: 'WAV', m4a: 'M4A', m4r: 'M4R', flac: 'FLAC', ogg: 'OGG', aac: 'AAC', webm: 'WebM' };
            return formatMap[ext] || ext.toUpperCase();
          }
        }
      } catch {
        // If URL parsing fails, try simple extraction
        const lastDot = urlWithoutQuery.lastIndexOf('.');
        if (lastDot > 0) {
          const afterDot = urlWithoutQuery.substring(lastDot + 1);
          // Check if it looks like a file extension (short, alphanumeric, before any query params)
          const ext = afterDot.split(/[?#]/)[0].toLowerCase();
          if (ext.length <= 5 && /^[a-z0-9]+$/i.test(ext)) {
            const formatMap = { mp3: 'MP3', wav: 'WAV', m4a: 'M4A', m4r: 'M4R', flac: 'FLAC', ogg: 'OGG', aac: 'AAC', webm: 'WebM' };
            return formatMap[ext] || ext.toUpperCase();
          }
        }
      }
    }
    return "";
  };

  // Format marquee text with audio metadata only (never include track name/file name)
  const formatMarqueeText = () => {
    const parts = [];
    
    // Only include technical metadata - never include trackName or file name
    if (audioSampleRate > 0) {
      parts.push(`Sample rate: ${formatSampleRate(audioSampleRate)}`);
    }
    
    if (fileSize > 0) {
      parts.push(`File size: ${formatFileSize(fileSize)}`);
    }
    
    if (audioChannels > 0) {
      parts.push(`Channels: ${formatChannels(audioChannels)}`);
    }
    
    if (totalDuration > 0) {
      parts.push(`Duration: ${formatDuration(totalDuration)}`);
    }
    
    if (audioFormat) {
      // Display format with dot prefix (e.g., ".mp3")
      const formatWithDot = audioFormat.startsWith('.') ? audioFormat : `.${audioFormat.toLowerCase()}`;
      parts.push(`Format: ${formatWithDot}`);
    }
    
    return parts.join(" • ");
  };

  // Update duplicated text when metadata changes
  useEffect(() => {
    const marqueeText = formatMarqueeText();
    if (marqueeContentRef.current) {
      const updateDuplicatedText = () => {
        const content = marqueeContentRef.current;
        if (content) {
          const container = content.parentElement;
          if (container) {
            // First render with original text to measure
            const tempSpan = document.createElement('span');
            tempSpan.textContent = marqueeText;
            tempSpan.style.position = 'absolute';
            tempSpan.style.visibility = 'hidden';
            tempSpan.style.whiteSpace = 'nowrap';
            document.body.appendChild(tempSpan);
            const textWidth = tempSpan.offsetWidth;
            document.body.removeChild(tempSpan);
            
            const containerWidth = container.offsetWidth;
            
            // If text is shorter than 2x container width, duplicate it
            if (textWidth < containerWidth * 2) {
              const repetitions = Math.ceil((containerWidth * 2) / textWidth) + 1;
              setDuplicatedText((marqueeText + " • ").repeat(repetitions));
            } else {
              // For long text, duplicate once to create seamless loop
              setDuplicatedText(marqueeText + " • " + marqueeText);
            }
          }
        }
      };
      
      // Wait for DOM to update
      setTimeout(updateDuplicatedText, 50);
      window.addEventListener('resize', updateDuplicatedText);
      return () => window.removeEventListener('resize', updateDuplicatedText);
    }
  }, [totalDuration, audioChannels, audioSampleRate, fileSize, audioFormat]);

  const selectedStart = startTrim * totalDuration;
  const selectedEnd = endTrim * totalDuration;

  // Shared function to calculate position in section coordinates from container percentage
  const calculateSectionPosition = (containerPercentage, options = {}) => {
    if (!waveformSectionRef.current || !waveformRef.current) {
      return containerPercentage * 100;
    }
    
    const sectionRect = waveformSectionRef.current.getBoundingClientRect();
    const containerRect = waveformRef.current.getBoundingClientRect();
    
    // Calculate the actual left offset of container within section
    // getBoundingClientRect() gives viewport coordinates, so this already accounts for padding
    const containerLeftOffset = containerRect.left - sectionRect.left;
    
    // Position inside container: containerPercentage * containerWidth
    const positionInContainer = containerPercentage * containerRect.width;
    
    // Absolute position from section's left edge (in pixels)
    const absolutePosition = containerLeftOffset + positionInContainer;
    
    // Convert to percentage of section's total width (including padding)
    let position = (absolutePosition / sectionRect.width) * 100;
    
    // Apply offset correction for pins to align with visual center
    // The offset accounts for the difference between calculated position and visual alignment
    // This is needed because the container's visual center doesn't perfectly match 
    // the calculated position due to padding, box-sizing, and subpixel rendering
    if (options.applyPinOffset) {
      // Calculate the padding ratio: how much the container is offset from section edge as percentage
      // This represents the section padding (10px) relative to section width
      const paddingRatioPercent = (containerLeftOffset / sectionRect.width) * 100;
      // Apply the offset correction - this compensates for visual misalignment
      // The correction is proportional to the padding ratio to maintain alignment across screen sizes
      position += paddingRatioPercent;
    }
    
    return position;
  };

  // Recalculate positions when trim values or window size changes
  const [trimmerLinePosition, setTrimmerLinePosition] = useState(0);
  const [startPinPosition, setStartPinPosition] = useState(0);
  const [endPinPosition, setEndPinPosition] = useState(0);

  useEffect(() => {
    const updatePositions = () => {
      // Use requestAnimationFrame to ensure layout has settled
      requestAnimationFrame(() => {
        if (waveformSectionRef.current && waveformRef.current) {
          setTrimmerLinePosition(calculateSectionPosition(trimmerPosition));
          // Pins need offset correction to align visually with trimmer line
          setStartPinPosition(calculateSectionPosition(startTrim, { applyPinOffset: true }));
          setEndPinPosition(calculateSectionPosition(endTrim, { applyPinOffset: true }));
        }
      });
    };

    updatePositions();

    // Update on window resize
    window.addEventListener('resize', updatePositions);
    return () => window.removeEventListener('resize', updatePositions);
  }, [trimmerPosition, startTrim, endTrim, isLoading, waveformData.length]);

  // Generate waveform from audio buffer
  // Uses 55 samples for mobile (<425px), 100 for tablet (425-1024px), 150 for desktop (1024px+)
  const generateWaveform = async (audioBuffer) => {
    const width = window.innerWidth;
    let samples;
    if (width < 425) {
      samples = 55;
    } else if (width >= 1024) {
      samples = 200;
    } else {
      samples = 100;
    }
    const rawData = audioBuffer.getChannelData(0); // Use first channel
    const blockSize = Math.max(1, Math.floor(rawData.length / samples));
    const filteredData = [];

    for (let i = 0; i < samples; i++) {
      const blockStart = blockSize * i;
      let sum = 0;
      let count = 0;
      // Ensure we don't go beyond the array bounds
      const blockEnd = Math.min(blockStart + blockSize, rawData.length);
      
      for (let j = blockStart; j < blockEnd; j++) {
        sum += Math.abs(rawData[j]);
        count++;
      }
      
      const average = count > 0 ? sum / count : 0;
      // Normalize to 0-1 range, with some minimum height
      filteredData.push(Math.max(0.1, average * 3.5));
    }

    return filteredData;
  };

  // Find the best 30-second segment for ringtone based on energy analysis
  const findBestRingtoneSegment = (audioBuffer, targetDuration = 30) => {
    const rawData = audioBuffer.getChannelData(0); // Use first channel
    const sampleRate = audioBuffer.sampleRate;
    const totalDuration = audioBuffer.duration;
    
    // If audio is shorter than target duration, use the whole thing
    if (totalDuration <= targetDuration) {
      return { start: 0, end: 1.0 }; // Normalized to 0-1
    }
    
    // Analyze energy in 1-second windows
    const windowSize = sampleRate; // 1 second of samples
    const windows = [];
    
    for (let i = 0; i < rawData.length - windowSize; i += Math.floor(windowSize / 4)) {
      let sumSquares = 0;
      for (let j = i; j < i + windowSize && j < rawData.length; j++) {
        sumSquares += rawData[j] * rawData[j];
      }
      const rms = Math.sqrt(sumSquares / windowSize);
      const time = i / sampleRate;
      windows.push({ time, rms });
    }
    
    // Find the best targetDuration-second window
    const targetWindows = Math.ceil(targetDuration);
    let bestStart = 0;
    let bestEnergy = 0;
    
    for (let i = 0; i <= windows.length - targetWindows; i++) {
      let sumEnergy = 0;
      for (let j = i; j < i + targetWindows && j < windows.length; j++) {
        sumEnergy += windows[j].rms;
      }
      const avgEnergy = sumEnergy / targetWindows;
      
      if (avgEnergy > bestEnergy) {
        bestEnergy = avgEnergy;
        bestStart = windows[i].time;
      }
    }
    
    // Convert to normalized positions (0-1)
    const startNormalized = bestStart / totalDuration;
    const endNormalized = Math.min((bestStart + targetDuration) / totalDuration, 1);
    
    return { start: startNormalized, end: endNormalized };
  };

  // Extract filename from audio file path
  const getFileName = (filePath) => {
    // Remove query parameters first (e.g., Azure Blob Storage URLs)
    const urlWithoutQuery = filePath.split('?')[0];
    const parts = urlWithoutQuery.split('/');
    let fileName = parts[parts.length - 1];
    // Remove file extension
    fileName = fileName.replace(/\.[^/.]+$/, "");
    
    // Check if filename looks meaningful (not a random ID or generic name)
    // Return "Audio File" if filename starts with "file-" (common in blob storage) or is empty/too short
    if (!fileName || fileName.length < 3 || fileName.startsWith('file-')) {
      return "Audio File";
    }
    
    return fileName;
  };

  const isChatConversationFileUrl = (value) =>
    typeof value === 'string' && value.includes('/mnt/data/');

  // Determine which audio source to use (priority: uploaded file > toolOutput > default)
  const getAudioSource = () => {
    if (uploadedAudioUrl) {
      return { url: uploadedAudioUrl, name: uploadedFileName, file: uploadedFile, isUploaded: true };
    }
    if (toolOutput?.audioUrl && !isChatConversationFileUrl(toolOutput.audioUrl)) {
      return { url: toolOutput.audioUrl, name: getFileName(toolOutput.audioUrl), file: null, isUploaded: false };
    }
    return null; // No audio source - show upload UI
  };

  useEffect(() => {
    if (toolOutput?.audioUrl && isChatConversationFileUrl(toolOutput.audioUrl)) {
      console.warn('⚠️ [FILE SOURCE] Detected unsupported ChatGPT conversation path. Prompting user to upload via widget.', {
        audioUrl: toolOutput.audioUrl,
      });
      setUploadError("Files added via the ChatGPT conversation aren’t accessible here. Please upload the audio using the Select File button below.");
      return;
    }
    if (toolOutput?.audioUrl) {
      setUploadError(null);
    }
  }, [toolOutput?.audioUrl]);

  // Process uploaded file (shared logic for both button click and drag & drop)
  const processFile = (file, source = 'button') => {
    debugLog(`📤 [FILE UPLOAD] File ${source} event triggered`, {
      timestamp: new Date().toISOString(),
      fileName: file.name,
      fileSize: file.size
    });

    setUploadError(null);

    if (!file) {
      console.warn('⚠️ [FILE UPLOAD] No file provided');
      return;
    }

    if (typeof file.path === 'string' && file.path.includes('/mnt/data/')) {
      console.warn('⚠️ [FILE UPLOAD] File path indicates ChatGPT conversation storage. Rejecting upload.', {
        filePath: file.path
      });
      setUploadError("Files attached in the ChatGPT chat can't be loaded. Please choose the audio file using this uploader.");
      return;
    }

    debugLog('📄 [FILE UPLOAD] File selected:', {
      name: file.name,
      size: file.size,
      sizeMB: (file.size / (1024 * 1024)).toFixed(2),
      type: file.type,
      lastModified: new Date(file.lastModified).toISOString()
    });

    // Validate file type
    const validAudioTypes = ['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/m4a', 'audio/x-m4a', 'audio/aac', 'audio/ogg', 'audio/webm'];
    const validExtensions = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.webm'];
    const fileExtension = '.' + file.name.split('.').pop().toLowerCase();
    
    debugLog('🔍 [FILE UPLOAD] Validating file:', {
      fileType: file.type,
      fileExtension,
      isValidType: validAudioTypes.includes(file.type),
      isValidExtension: validExtensions.includes(fileExtension)
    });
    
    if (!validAudioTypes.includes(file.type) && !validExtensions.includes(fileExtension)) {
      console.error('❌ [FILE UPLOAD] Invalid file type:', {
        fileType: file.type,
        fileExtension,
        validTypes: validAudioTypes,
        validExtensions
      });
      setUploadError('Please upload a valid audio file (MP3, WAV, M4A, AAC, OGG, or WebM)');
      return;
    }

    // Create object URL for the uploaded file
    debugLog('🔗 [FILE UPLOAD] Creating object URL...');
    const objectUrl = URL.createObjectURL(file);
    debugLog('✅ [FILE UPLOAD] Object URL created:', {
      objectUrl,
      fileName: file.name.replace(/\.[^/.]+$/, "")
    });

    setUploadedAudioUrl(objectUrl);
    setUploadedFileName(file.name.replace(/\.[^/.]+$/, "")); // Remove extension
    setUploadedFile(file); // Store File object to read directly (avoids CSP fetch issues)
    
    debugLog('💾 [FILE UPLOAD] State updated - file ready for processing');
    
    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  // Handle file upload from input button
  const handleFileUpload = (event) => {
    const inputPath = event?.target?.value ?? "";
    if (typeof inputPath === 'string' && inputPath.includes('/mnt/data/')) {
      console.warn('⚠️ [FILE UPLOAD] File selected from ChatGPT conversation path. Rejecting to keep upload screen.', {
        inputPath
      });
      setUploadError("Looks like that file was attached in the ChatGPT chat. Please upload the audio directly through this screen.");
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      return;
    }

    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    processFile(file, 'button');
  };

  // Handle drag and drop
  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);

    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      processFile(files[0], 'drag-drop');
    }
  };

  // Load and analyze audio
  useEffect(() => {
    const audioSource = getAudioSource();
    
    audioBufferRef.current = null;
    setGenerationError(null);
    setGenerationSuccess("");

    // If no audio source, don't try to load
    if (!audioSource) {
      setIsLoading(false);
      return;
    }

    // Note: window.openai is a Proxy object and cannot be cloned/logged directly
    // Log only available file-related properties if needed
    debugLog('🔍 [AUDIO LOAD] Checking for file access:', {
      hasOpenai: !!window.openai,
      hasFilesAPI: !!(window.openai && window.openai.files),
      audioSourceType: audioSource.isUploaded ? 'uploaded' : 'external',
    });

    debugLog('🎵 [AUDIO LOAD] Starting audio load process:', {
      timestamp: new Date().toISOString(),
      source: audioSource.name,
      url: audioSource.url,
      isUploaded: !!uploadedAudioUrl
    });

    const loadAudio = async () => {
      try {
        setIsLoading(true);
        debugLog('⏳ [AUDIO LOAD] Loading audio file...');
        
        let arrayBuffer;
        const startTime = performance.now();
        
        // Use FileReader for uploaded files to avoid CSP issues with blob URLs
        if (audioSource.isUploaded && audioSource.file) {
          debugLog('📖 [AUDIO LOAD] Using FileReader for uploaded file (avoiding CSP fetch issue)');
          // Set file size and format from uploaded file
          setFileSize(audioSource.file.size);
          setAudioFormat(detectAudioFormat(null, audioSource.file));
          
          const fileReaderStartTime = performance.now();
          arrayBuffer = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
              const fileReadTime = ((performance.now() - fileReaderStartTime) / 1000).toFixed(2);
              debugLog('📥 [AUDIO LOAD] File read via FileReader:', {
                sizeBytes: e.target.result.byteLength,
                sizeMB: (e.target.result.byteLength / (1024 * 1024)).toFixed(2),
                readTimeSeconds: fileReadTime
              });
              resolve(e.target.result);
            };
            reader.onerror = reject;
            reader.readAsArrayBuffer(audioSource.file);
          });
        } else {
          // Use fetch for external URLs (toolOutput)
          debugLog('🌐 [AUDIO LOAD] Using fetch for external URL');
          const fetchStartTime = performance.now();
          const response = await fetch(audioSource.url);
          const fetchTime = ((performance.now() - fetchStartTime) / 1000).toFixed(2);
          debugLog('📥 [AUDIO LOAD] File fetched:', {
            status: response.status,
            statusText: response.statusText,
            contentType: response.headers.get('content-type'),
            size: response.headers.get('content-length'),
            fetchTimeSeconds: fetchTime
          });

          const arrayBufferStartTime = performance.now();
          arrayBuffer = await response.arrayBuffer();
          const arrayBufferTime = ((performance.now() - arrayBufferStartTime) / 1000).toFixed(2);
          debugLog('💾 [AUDIO LOAD] ArrayBuffer created:', {
            sizeBytes: arrayBuffer.byteLength,
            sizeMB: (arrayBuffer.byteLength / (1024 * 1024)).toFixed(2),
            conversionTimeSeconds: arrayBufferTime
          });
          
          // Set file size and format from fetched response
          setFileSize(arrayBuffer.byteLength);
          
          // Try to detect format from Content-Type header first, then URL
          const contentType = response.headers.get('content-type');
          let detectedFormat = "";
          if (contentType) {
            const mimeToFormat = {
              'audio/mpeg': 'MP3',
              'audio/mp3': 'MP3',
              'audio/wav': 'WAV',
              'audio/wave': 'WAV',
              'audio/x-wav': 'WAV',
              'audio/m4a': 'M4A',
              'audio/x-m4a': 'M4A',
              'audio/mp4': 'M4A',
              'audio/m4r': 'M4R',
              'audio/flac': 'FLAC',
              'audio/x-flac': 'FLAC',
              'audio/ogg': 'OGG',
              'audio/opus': 'OGG',
              'audio/aac': 'AAC',
              'audio/webm': 'WebM',
            };
            const baseType = contentType.split(';')[0].toLowerCase();
            detectedFormat = mimeToFormat[baseType] || "";
          }
          
          // Fallback to URL-based detection if Content-Type didn't work
          if (!detectedFormat) {
            detectedFormat = detectAudioFormat(audioSource.url, null);
          }
          
          setAudioFormat(detectedFormat);
        }
        
        const audioContextStartTime = performance.now();
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
        const decodeTime = ((performance.now() - audioContextStartTime) / 1000).toFixed(2);
        
        debugLog('🎼 [AUDIO LOAD] Audio decoded:', {
          duration: audioBuffer.duration,
          durationFormatted: `${Math.floor(audioBuffer.duration / 60)}:${(audioBuffer.duration % 60).toFixed(2)}`,
          sampleRate: audioBuffer.sampleRate,
          numberOfChannels: audioBuffer.numberOfChannels,
          length: audioBuffer.length,
          decodeTimeSeconds: decodeTime
        });
        
        audioContextRef.current = audioContext;
        audioBufferRef.current = audioBuffer;
        setTotalDuration(audioBuffer.duration);
        setAudioChannels(audioBuffer.numberOfChannels);
        setAudioSampleRate(audioBuffer.sampleRate);
        
        const waveformStartTime = performance.now();
        const waveform = await generateWaveform(audioBuffer);
        const waveformTime = ((performance.now() - waveformStartTime) / 1000).toFixed(2);
        debugLog('📊 [AUDIO LOAD] Waveform generated:', {
          samples: waveform.length,
          waveformTimeSeconds: waveformTime
        });
        setWaveformData(waveform);
        
        // Try to extract metadata from audio file
        // Note: This may fail with CSP errors for blob URLs, but it's non-critical
        let title = null;
        try {
          debugLog('🔍 [AUDIO LOAD] Attempting to extract metadata...');
          const audioElement = document.createElement('audio');
          audioElement.src = audioSource.url;
          
          // Suppress CSP errors for blob URLs (they're non-critical)
          // Note: CSP errors for blob URLs are expected and non-critical
          
          await new Promise((resolve, reject) => {
            audioElement.addEventListener('loadedmetadata', () => {
              // Try to get title from metadata if available
              // Note: Browser support for metadata is limited
              title = audioElement.title || null;
              debugLog('📋 [AUDIO LOAD] Metadata extracted:', {
                title,
                duration: audioElement.duration,
                readyState: audioElement.readyState
              });
              resolve();
            });
            audioElement.addEventListener('error', (e) => {
              // Don't log as error - CSP restrictions are expected for blob URLs
              debugLog('ℹ️ [AUDIO LOAD] Metadata extraction skipped (CSP or browser limitation)');
              resolve(); // Resolve instead of reject - metadata is optional
            });
            // Fallback timeout
            setTimeout(() => {
              debugLog('⏱️ [AUDIO LOAD] Metadata extraction timeout');
              resolve();
            }, 100);
          });
        } catch (e) {
          // Silently fail - metadata extraction is optional
          debugLog('ℹ️ [AUDIO LOAD] Metadata extraction skipped:', e.message);
        }
        
        // Use metadata title if available, otherwise use filename from source, fallback to "Audio File"
        const displayName = title || audioSource.name || "Audio File";
        debugLog('✏️ [AUDIO LOAD] Setting track name:', {
          displayName,
          source: title ? 'metadata' : 'filename'
        });
        setTrackName(displayName);
        
        // Initialize trim positions based on actual duration and mode
        let finalStartTrim, finalEndTrim;
        if (isRingtoneMode && audioBuffer.duration > 30) {
          // Auto-select best 30-second segment for ringtones
          const bestSegment = findBestRingtoneSegment(audioBuffer, 30);
          finalStartTrim = bestSegment.start;
          finalEndTrim = bestSegment.end;
          setStartTrim(finalStartTrim);
          setEndTrim(finalEndTrim);
          setTrimmerPosition(finalStartTrim);
          // Enable fade in/out by default for ringtones
          setFadeInEnabled(true);
          setFadeOutEnabled(true);
          const fadeDuration = Math.min(1.5, (bestSegment.end - bestSegment.start) * audioBuffer.duration / 4);
          setFadeInTime(fadeDuration);
          setFadeOutTime(fadeDuration);
          const startSeconds = bestSegment.start * audioBuffer.duration;
          const endSeconds = bestSegment.end * audioBuffer.duration;
          const startMins = Math.floor(startSeconds / 60);
          const startSecs = (startSeconds % 60).toFixed(1);
          const endMins = Math.floor(endSeconds / 60);
          const endSecs = (endSeconds % 60).toFixed(1);
          debugLog('🎵 [RINGTONE] Auto-selected best 30-second segment:', {
            start: bestSegment.start,
            end: bestSegment.end,
            startTime: `${startMins}:${startSecs.padStart(4, "0")}`,
            endTime: `${endMins}:${endSecs.padStart(4, "0")}`,
            fadeDuration
          });
        } else {
          // Default trim positions for non-ringtone or short audio
          finalStartTrim = 0.1;
          finalEndTrim = isRingtoneMode && audioBuffer.duration <= 30 
            ? 1.0 
            : 0.7;
          setStartTrim(finalStartTrim);
          setEndTrim(finalEndTrim);
          setTrimmerPosition(finalStartTrim);
        }
        
        const totalTime = ((performance.now() - startTime) / 1000).toFixed(2);
        debugLog('✅ [AUDIO LOAD] Audio loaded successfully!', {
          trackName: displayName,
          duration: audioBuffer.duration,
          trimStart: finalStartTrim,
          trimEnd: finalEndTrim,
          totalLoadTimeSeconds: totalTime,
          loadMethod: audioSource.isUploaded ? 'FileReader' : 'fetch'
        });
        
        setIsLoading(false);
      } catch (error) {
        console.error("❌ [AUDIO LOAD] Error loading audio:", {
          error: error.message,
          stack: error.stack,
          name: error.name,
          audioSource: audioSource.name
        });
        audioBufferRef.current = null;
        // Fallback to filename if everything fails, or "Audio File" if name is empty
        const fallbackName = audioSource.name || "Audio File";
        debugLog('🔄 [AUDIO LOAD] Using fallback name:', fallbackName);
        setTrackName(fallbackName);
        setIsLoading(false);
      }
    };

    loadAudio();
  }, [uploadedAudioUrl, toolOutput?.audioUrl]);

  // Cleanup object URL on unmount or when changing files
  useEffect(() => {
    return () => {
      if (uploadedAudioUrl && uploadedAudioUrl.startsWith('blob:')) {
        URL.revokeObjectURL(uploadedAudioUrl);
      }
    };
  }, [uploadedAudioUrl]);

  // Audio playback management
  useEffect(() => {
    if (!audioContextRef.current || !isPlaying) {
      if (sourceNodeRef.current) {
        sourceNodeRef.current.stop();
        sourceNodeRef.current = null;
      }
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      return;
    }

    const playAudio = async () => {
      try {
        const audioContext = audioContextRef.current;
        if (audioContext.state === "suspended") {
          await audioContext.resume();
        }

        // Use dynamic audio URL (priority: uploaded > toolOutput > default)
        const audioSource = getAudioSource();
        if (!audioSource) {
          setIsPlaying(false);
          return;
        }
        
        let arrayBuffer;
        // Use FileReader for uploaded files to avoid CSP issues with blob URLs
        if (audioSource.isUploaded && audioSource.file) {
          arrayBuffer = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target.result);
            reader.onerror = reject;
            reader.readAsArrayBuffer(audioSource.file);
          });
        } else {
          // Use fetch for external URLs (toolOutput)
          const response = await fetch(audioSource.url);
          arrayBuffer = await response.arrayBuffer();
        }
        
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

        const source = audioContext.createBufferSource();
        const gainNode = audioContext.createGain();
        
        source.buffer = audioBuffer;
        source.connect(gainNode);
        gainNode.connect(audioContext.destination);

        sourceNodeRef.current = source;
        gainNodeRef.current = gainNode;

        const startTime = selectedStart;
        const endTime = selectedEnd;
        const duration = endTime - startTime;

        // Apply fade in/out if enabled
        if (fadeInEnabled && fadeInTime > 0) {
          gainNode.gain.setValueAtTime(0, audioContext.currentTime);
          gainNode.gain.linearRampToValueAtTime(1, audioContext.currentTime + fadeInTime);
        } else {
          gainNode.gain.setValueAtTime(1, audioContext.currentTime);
        }

        if (fadeOutEnabled && fadeOutTime > 0) {
          const fadeOutStart = audioContext.currentTime + duration - fadeOutTime;
          gainNode.gain.setValueAtTime(1, fadeOutStart);
          gainNode.gain.linearRampToValueAtTime(0, audioContext.currentTime + duration);
        }

        // Update trimmer position during playback
        const playbackStart = audioContext.currentTime;
        playbackStartTimeRef.current = playbackStart;
        
        const updatePosition = () => {
          if (!isPlaying || !sourceNodeRef.current) return;
          
          const elapsed = audioContext.currentTime - playbackStart;
          const progress = Math.min(elapsed / duration, 1);
          
          const currentPosition = startTrim + (endTrim - startTrim) * progress;
          setTrimmerPosition(currentPosition);
          
          if (progress >= 1) {
            setIsPlaying(false);
            setTrimmerPosition(endTrim);
            return;
          }
          
          animationFrameRef.current = requestAnimationFrame(updatePosition);
        };

        source.start(playbackStart, startTime);
        source.stop(playbackStart + duration);
        
        source.onended = () => {
          setIsPlaying(false);
          setTrimmerPosition(endTrim);
          sourceNodeRef.current = null;
          playbackStartTimeRef.current = null;
        };

        updatePosition();
      } catch (error) {
        console.error("Error playing audio:", error);
        setIsPlaying(false);
      }
    };

    playAudio();
  }, [isPlaying, selectedStart, selectedEnd, fadeInEnabled, fadeOutEnabled, fadeInTime, fadeOutTime, startTrim, endTrim, uploadedAudioUrl, toolOutput?.audioUrl]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (sourceNodeRef.current) {
        try {
          sourceNodeRef.current.stop();
        } catch (e) {}
        sourceNodeRef.current = null;
      }
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      if (audioContextRef.current) {
        audioContextRef.current.close();
      }
    };
  }, []);

  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = (seconds % 60).toFixed(1);
    return `${mins}:${secs.padStart(4, "0")}`;
  };

  const handlePlay = () => {
    if (isLoading) return;
    setIsPlaying(!isPlaying);
  };

  const handleExportAudio = async () => {
    if (isLoading || isGenerating || !rightsConfirmed) {
      return;
    }

    if (!audioBufferRef.current) {
      setGenerationError("Audio is not ready yet. Please wait for the waveform to finish loading.");
      return;
    }

    setIsGenerating(true);
    setGenerationError(null);
    setGenerationSuccess("");

    // Try to get API base URL from multiple sources (build-time env, runtime window global, or fallback)
    const runtimeApiUrl = typeof window !== 'undefined' && window.__API_BASE_URL__;
    const endpoint = `${runtimeApiUrl.replace(/\/$/, "")}/api/audio-process`;

    try {
      const audioSource = getAudioSource();
      if (!audioSource) {
        throw new Error("No audio source available");
      }

      const totalDuration = audioBufferRef.current.duration;
      // startTrim and endTrim are normalized (0-1), convert to seconds
      const startTime = startTrim * totalDuration;
      const duration = (endTrim - startTrim) * totalDuration;

      debugLog("📤 [AUDIO EXPORT] Preparing server-side processing:", {
        audioSource: audioSource.isUploaded ? "uploaded file" : "external URL",
        startTime: `${startTime.toFixed(2)}s`,
        duration: `${duration.toFixed(2)}s`,
        format: outputFormat,
        fadeInEnabled,
        fadeInDuration: fadeInTime,
        fadeOutEnabled,
        fadeOutDuration: fadeOutTime,
      });

      let response;

      if (audioSource.isUploaded && audioSource.file) {
        // Upload file directly to S3 first, then send S3 URL + processing parameters
        debugLog("📤 [AUDIO EXPORT] Uploading file to S3 first...");
        
        // Get presigned URL from server
        const presignedUrlResponse = await fetch(`${runtimeApiUrl.replace(/\/$/, "")}/api/s3-presigned-url`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            fileName: audioSource.file.name,
            contentType: audioSource.file.type || "audio/mpeg",
          }),
        });

        if (!presignedUrlResponse.ok) {
          throw new Error("Failed to get presigned upload URL");
        }

        const { uploadUrl, publicUrl } = await presignedUrlResponse.json();

        // Upload file directly to S3
        const s3UploadResponse = await fetch(uploadUrl, {
          method: "PUT",
          body: audioSource.file,
          headers: {
            "Content-Type": audioSource.file.type || "audio/mpeg",
          },
        });

        if (!s3UploadResponse.ok) {
          throw new Error("Failed to upload file to S3");
        }

        debugLog("✅ [AUDIO EXPORT] File uploaded to S3:", publicUrl);

        // Send S3 URL + processing parameters to server
        const params = new URLSearchParams();
        params.append("audioUrl", publicUrl);
        params.append("format", outputFormat);
        params.append("trackName", sanitizeFileName(trackName || uploadedFileName || "audio-track"));
        params.append("startTime", startTime.toString());
        params.append("duration", duration.toString());
        params.append("fadeInEnabled", String(fadeInEnabled));
        params.append("fadeInDuration", fadeInTime.toString());
        params.append("fadeOutEnabled", String(fadeOutEnabled));
        params.append("fadeOutDuration", fadeOutTime.toString());

        response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: params.toString(),
        });
      } else if (audioSource.url) {
        // Send processing parameters with audio URL (no file upload needed)
        const params = new URLSearchParams();
        params.append("audioUrl", audioSource.url);
        params.append("format", outputFormat);
        params.append("trackName", sanitizeFileName(trackName || audioSource.name || "audio-track"));
        params.append("startTime", startTime.toString());
        params.append("duration", duration.toString());
        params.append("fadeInEnabled", String(fadeInEnabled));
        params.append("fadeInDuration", fadeInTime.toString());
        params.append("fadeOutEnabled", String(fadeOutEnabled));
        params.append("fadeOutDuration", fadeOutTime.toString());

        response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: params.toString(),
        });
      } else {
        throw new Error("No valid audio source available");
      }

      if (!response.ok) {
        let errorMessage = "Server failed to export audio.";
        try {
          // Try to parse JSON error response
          const errorData = await response.json();
          if (errorData?.error) {
            errorMessage = errorData.error;
          }
        } catch {
          // If JSON parsing fails, try to get text
          try {
            const errorText = await response.text();
            if (errorText) {
              errorMessage = errorText;
            }
          } catch {
            // Fallback to status-based message
            if (response.status === 413) {
              errorMessage = "File too large. Maximum file size is 500MB. Please try trimming your audio or selecting a shorter segment.";
            } else if (response.status >= 500) {
              errorMessage = "Server error. Please try again later.";
            }
          }
        }
        throw new Error(errorMessage);
      }

      const responsePayload = await response.json();

      if (!responsePayload.downloadUrl) {
        throw new Error("Server response did not include a download URL.");
      }

      const resolvedDownloadUrl = responsePayload.downloadUrl;

      setDownloadUrl(resolvedDownloadUrl);
      setGenerationSuccess("Your audio download link is ready.");

      try {
        await sendFollowUpMessage(
          `Audio generated successfully! Download it here: ${resolvedDownloadUrl}`
        );
        debugLog("💬 [FOLLOW UP MESSAGE] Sent follow-up message with S3 download URL.");
      } catch (messageError) {
        console.warn("⚠️ [FOLLOW UP MESSAGE] Failed to send follow-up message:", messageError);
      }

      debugLog("🔗 [AUDIO DOWNLOAD] Resolved download URL:", resolvedDownloadUrl);
    } catch (error) {
      console.error("❌ [AUDIO GENERATE] Failed to export audio:", error);
      const message =
        error?.message && typeof error.message === "string"
          ? error.message
          : "Something went wrong while exporting the audio.";
      setGenerationError(message);
    } finally {
      setTimeout(() => {
        setIsGenerating(false);
      }, 5000);
    }
  };

  const handleTrimStartChange = (deltaSeconds) => {
    if (totalDuration === 0) return;
    // Convert delta in seconds to percentage of total duration
    const deltaPercentage = deltaSeconds / totalDuration;
    const newStart = Math.max(0, Math.min(startTrim + deltaPercentage, endTrim - 0.05));
    setStartTrim(newStart);
    // Update trimmer position to match new start
    setTrimmerPosition(newStart);
  };

  const handleTrimEndChange = (deltaSeconds) => {
    if (totalDuration === 0) return;
    // Convert delta in seconds to percentage of total duration
    const deltaPercentage = deltaSeconds / totalDuration;
    const newEnd = Math.max(startTrim + 0.05, Math.min(endTrim + deltaPercentage, 1));
    setEndTrim(newEnd);
    // Update trimmer position to match new end
    setTrimmerPosition(newEnd);
  };

  const handleFormatSelect = (format) => {
    setOutputFormat(normalizeOutputFormat(format));
    setShowFormatDropdown(false);
  };

  // Helper to get clientX from either mouse or touch event
  const getClientX = (e) => {
    if (e.touches && e.touches.length > 0) {
      return e.touches[0].clientX;
    }
    if (e.changedTouches && e.changedTouches.length > 0) {
      return e.changedTouches[0].clientX;
    }
    return e.clientX;
  };

  const handleWaveformStart = (e) => {
    if (!waveformRef.current) return;
    // Prevent default to avoid scrolling on touch devices
    e.preventDefault();
    // Stop playback if trying to trim while playing
    if (isPlaying) {
      setIsPlaying(false);
    }
    const rect = waveformRef.current.getBoundingClientRect();
    const x = getClientX(e) - rect.left;
    const percentage = Math.max(0, Math.min(1, x / rect.width));
    setTrimmerPosition(percentage);
    setIsDraggingTrimmer(true);
  };

  const handleMove = useCallback((e) => {
    if (!waveformRef.current) return;
    // Prevent default to avoid scrolling on touch devices
    e.preventDefault();
    const rect = waveformRef.current.getBoundingClientRect();
    const x = getClientX(e) - rect.left;
    const percentage = Math.max(0, Math.min(1, x / rect.width));

    if (isDraggingStart) {
      // Stop playback if trying to trim while playing
      if (isPlaying) {
        setIsPlaying(false);
      }
      const newStart = Math.min(percentage, endTrim - 0.05); // Ensure start is before end
      setStartTrim(newStart);
      setTrimmerPosition(newStart);
    } else if (isDraggingEnd) {
      // Stop playback if trying to trim while playing
      if (isPlaying) {
        setIsPlaying(false);
      }
      const newEnd = Math.max(percentage, startTrim + 0.05); // Ensure end is after start
      setEndTrim(newEnd);
      setTrimmerPosition(newEnd);
    } else if (isDraggingTrimmer) {
      setTrimmerPosition(percentage);
    }
  }, [isDraggingStart, isDraggingEnd, isDraggingTrimmer, isPlaying, endTrim, startTrim]);

  const handleEnd = useCallback((e) => {
    // Prevent default to avoid any unwanted behaviors
    if (e.type === 'touchend') {
      e.preventDefault();
    }
    setIsDraggingStart(false);
    setIsDraggingEnd(false);
    setIsDraggingTrimmer(false);
  }, []);

  // Handle trim pin start (both mouse and touch)
  const handleTrimPinStart = (type, e) => {
    e.preventDefault();
    e.stopPropagation();
    // Stop playback if trying to trim while playing
    if (isPlaying) {
      setIsPlaying(false);
    }
    if (type === 'start') {
      setIsDraggingStart(true);
    } else if (type === 'end') {
      setIsDraggingEnd(true);
    }
  };

  useEffect(() => {
    if (isDraggingStart || isDraggingEnd || isDraggingTrimmer) {
      // Mouse events
      document.addEventListener("mousemove", handleMove);
      document.addEventListener("mouseup", handleEnd);
      // Touch events
      document.addEventListener("touchmove", handleMove, { passive: false });
      document.addEventListener("touchend", handleEnd, { passive: false });
      document.addEventListener("touchcancel", handleEnd, { passive: false });
      
      return () => {
        document.removeEventListener("mousemove", handleMove);
        document.removeEventListener("mouseup", handleEnd);
        document.removeEventListener("touchmove", handleMove);
        document.removeEventListener("touchend", handleEnd);
        document.removeEventListener("touchcancel", handleEnd);
      };
    }
  }, [isDraggingStart, isDraggingEnd, isDraggingTrimmer]);

  const audioSource = getAudioSource();

  // Show upload UI if no audio source is available
  if (!audioSource) {
    return (
      <div className="ringtone-editor">
        <div className="upload-container">
          <input
            ref={fileInputRef}
            id="audio-file-input"
            type="file"
            accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.webm"
            onChange={handleFileUpload}
            style={{ display: 'none' }}
            aria-label="Upload audio file"
          />
          <div 
            className={`upload-area ${isDraggingOver ? 'drag-over' : ''}`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <svg className="upload-icon" width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="32" cy="32" r="30" stroke="currentColor" strokeWidth="2" fill="none" opacity="0.3"/>
              <path d="M32 20V44M20 32L32 20L44 32" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            <h2 className="upload-title">Upload Audio File</h2>
            <p className="upload-description">
              {isDraggingOver ? 'Drop your audio file here' : 'Drag and drop an audio file or choose one to edit and export'}
            </p>
            <label 
              htmlFor="audio-file-input" 
              className="upload-button"
              onClick={(e) => {
                // Programmatically trigger file input for better mobile app compatibility
                e.preventDefault();
                if (fileInputRef.current) {
                  fileInputRef.current.click();
                }
              }}
            >
              Select File
            </label>
            <p className="upload-hint">Supports MP3, WAV, M4A, AAC, OGG, and WebM</p>
            {uploadError && (
              <div className="upload-error" role="alert">
                {uploadError}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="ringtone-editor">
      {/* Header */}
      <div className="ringtone-header">
        <button
          onClick={handlePlay}
          disabled={isLoading}
          className={`play-button ${isPlaying ? "playing" : ""} ${isLoading ? "loading" : ""}`}
          aria-label={isPlaying ? "Pause" : "Play"}
        >
          {isLoading ? (
            <span className="loading-spinner">...</span>
          ) : isPlaying ? (
            <svg className="play-icon" width="35" height="35" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M0 10C0 4.47715 4.47715 0 10 0C15.5228 0 20 4.47715 20 10C20 15.5228 15.5228 20 10 20C4.47715 20 0 15.5228 0 10ZM6.25 7.25V12.75C6.25 13.5523 6.69772 13.75 7.25 13.75H8C8.55228 13.75 9 13.5523 9 12.75V7.25C9 6.69772 8.55228 6.25 8 6.25H7.25C6.69772 6.25 6.25 6.69772 6.25 7.25ZM12 6.25C11.4477 6.25 11 6.69772 11 7.25V12.75C11 13.5523 11.4477 13.75 12 13.75H12.75C13.3023 13.75 13.75 13.5523 13.75 12.75V7.25C13.75 6.69772 13.3023 6.25 12.75 6.25H12Z" fill="currentColor"/>
            </svg>
          ) : (
            <svg className="play-icon" width="35" height="35" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path fillRule="evenodd" clipRule="evenodd" d="M10 0C4.47715 0 0 4.47715 0 10C0 15.5228 4.47715 20 10 20C15.5228 20 20 15.5228 20 10C20 4.47715 15.5228 0 10 0ZM7 6.96328V13.0368C7 13.9372 7.99609 14.481 8.7535 13.9941L13.4773 10.9574C14.1742 10.5094 14.1742 9.49071 13.4773 9.04272L8.7535 6.00596C7.9961 5.51906 7 6.06288 7 6.96328Z" fill="currentColor"/>
            </svg>
          )}
        </button>

        <div className="track-name-marquee">
          <div 
            ref={marqueeContentRef}
            className="marquee-content"
          >
            <span>{duplicatedText || formatMarqueeText() || "Loading..."}</span>
          </div>
        </div>

        <div className="format-dropdown-container">
          <button
            className="format-dropdown"
            onClick={() => setShowFormatDropdown(!showFormatDropdown)}
          >
            <span>
              {isRingtoneMode 
                ? (outputFormat === 'm4r' ? 'For iPhone' : 'For Android')
                : `Export as .${outputFormat}`
              }
            </span>
            <svg width="14" height="8" viewBox="0 0 14 8" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M0.292892 0.292894C0.683416 -0.0976306 1.31658 -0.0976315 1.70711 0.292892L7.00002 5.58579L12.2929 0.292894C12.6834 -0.0976306 13.3166 -0.0976315 13.7071 0.292892C14.0976 0.683416 14.0976 1.31658 13.7071 1.70711L7.70713 7.70711C7.51959 7.89464 7.26524 8 7.00002 8C6.7348 8 6.48045 7.89464 6.29291 7.70711L0.292894 1.70711C-0.0976306 1.31658 -0.0976315 0.683419 0.292892 0.292894Z" fill="currentColor"/>
            </svg>
          </button>
          {showFormatDropdown && (
            <>
              <div
                className="dropdown-overlay"
                onClick={() => setShowFormatDropdown(false)}
              />
              <div className="format-dropdown-menu">
                {(isRingtoneMode ? RINGTONE_FORMAT_OPTIONS : OUTPUT_FORMAT_OPTIONS).map((option) => (
                  <button
                    key={option.value}
                    onClick={() => handleFormatSelect(option.value)}
                    className={outputFormat === option.value ? "active" : ""}
                  >
                    <span>{option.label}</span>
                    {outputFormat === option.value && (
                      <svg width="14" height="13" viewBox="0 0 14 13" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M13.5633 0.173869C14.0196 0.484992 14.1374 1.10712 13.8262 1.56343L6.32623 12.5634C6.15848 12.8095 5.88982 12.9679 5.59335 12.9957C5.29688 13.0235 5.00345 12.9178 4.79289 12.7072L0.292893 8.2072C-0.0976311 7.81668 -0.0976311 7.18351 0.292893 6.79299C0.683417 6.40247 1.31658 6.40247 1.70711 6.79299L5.35368 10.4396L12.1738 0.43676C12.4849 -0.0195528 13.107 -0.137253 13.5633 0.173869Z" fill="currentColor"/>
                      </svg>
                    )}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Waveform Section */}
      <div className="waveform-section" ref={waveformSectionRef}>
        {/* Time markers */}
        <div className="time-markers-container">
          {/* Time cue lines - every 10% */}
          <div className="time-cue-lines-container">
            {[...Array(11)].map((_, i) => (
              <div
                key={`cue-${i}`}
                className="time-cue-line"
                style={{ left: `${i * 10}%` }}
              />
            ))}
          </div>
          <div className="time-markers">
            <span>0:00.0</span>
            <span>{totalDuration > 0 ? formatTime(totalDuration / 2) : "0:00.0"}</span>
            <span>{totalDuration > 0 ? formatTime(totalDuration) : "0:00.0"}</span>
          </div>
        </div>

        {/* Trimmer line */}
        <div
            className="trimmer-line"
            style={{ left: `${trimmerLinePosition}%` }}
          />

        {/* Start pin - positioned at section level to align with trimmer line */}
        <svg
          className="trim-pin start-pin"
          style={{ left: `${startPinPosition}%` }}
          width="60"
          height="65"
          viewBox="0 0 60 65"
          onMouseDown={(e) => handleTrimPinStart('start', e)}
          onTouchStart={(e) => handleTrimPinStart('start', e)}
        >
          <path
            d="M 0 30 A 30 30 0 0 1 60 30 L 30 65 Z"
            fill="var(--blue)"
          />
        </svg>

        {/* End pin - positioned at section level to align with trimmer line */}
        <svg
          className="trim-pin end-pin"
          style={{ left: `${endPinPosition}%` }}
          width="60"
          height="65"
          viewBox="0 0 60 65"
          onMouseDown={(e) => handleTrimPinStart('end', e)}
          onTouchStart={(e) => handleTrimPinStart('end', e)}
        >
          <path
            d="M 30 0 L 0 35 A 30 30 0 0 0 60 35 Z"
            fill="var(--blue)"
          />
        </svg>

        {/* Waveform container */}
        <div
          className="waveform-container"
          ref={waveformRef}
          onMouseDown={handleWaveformStart}
          onTouchStart={handleWaveformStart}
        >
          {/* Background waveform */}
          {isLoading ? (
            <div className="waveform-loading">Loading audio...</div>
          ) : (
            <>
              <div className="waveform-background">
                {waveformData.map((height, index) => (
                  <div
                    key={index}
                    className="waveform-bar background-bar"
                    style={{ height: `${height * 100}%` }}
                  />
                ))}
              </div>

              {/* Selected segment overlay */}
              <div className="waveform-selected">
                {waveformData.map((height, index) => {
                  const position = index / waveformData.length;
                  const isInRange = position >= startTrim && position <= endTrim;
                  
                  if (!isInRange) return null;
                  
                  // Calculate exact position to align with background bars
                  // Use the same percentage distribution as flex (flex: 1 distributes evenly)
                  const totalBars = waveformData.length;
                  const barWidthPercent = 70 / totalBars;
                  const leftPercent = (index / totalBars) * 100;
                  
                  return (
                    <div
                      key={`selected-${index}`}
                      className="waveform-bar selected-bar"
                      style={{
                        height: `${height * 100}%`,
                        position: 'absolute',
                        left: `${leftPercent}%`,
                        width: `${barWidthPercent}%`,
                      }}
                    />
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* Trimmer label */}
        <div className="trimmer-label">TRIMMER</div>
      </div>

      {/* Trim and Fade Controls */}
      <div className="trim-controls">
        {/* Start Section - Trim Start + Fade In */}
        <div className="control-section start-section">
          {/* Trim Start */}
          <div className="trim-control">
            <div className="trim-time-controls">
              <button
                className="trim-button"
                onClick={() => handleTrimStartChange(-0.1)}
                disabled={startTrim <= 0}
              >
                <svg width="16" height="3" viewBox="0 0 12 2" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M0 1C0 0.447715 0.447715 0 1 0H11C11.5523 0 12 0.447715 12 1C12 1.55228 11.5523 2 11 2H1C0.447715 2 0 1.55228 0 1Z" fill="currentColor"/>
                </svg>
              </button>
              <span className="trim-time">{formatTime(selectedStart)}</span>
              <button
                className="trim-button"
                onClick={() => handleTrimStartChange(0.1)}
                disabled={startTrim >= endTrim - 0.05}
              >
                <svg width="16" height="16" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M6 0C6.55228 0 7 0.447715 7 1V5H11C11.5523 5 12 5.44772 12 6C12 6.55228 11.5523 7 11 7H7V11C7 11.5523 6.55228 12 6 12C5.44772 12 5 11.5523 5 11V7H1C0.447715 7 0 6.55228 0 6C0 5.44772 0.447715 5 1 5H5V1C5 0.447715 5.44772 0 6 0Z" fill="currentColor"/>
                </svg>
              </button>
            </div>
          </div>
          
          {/* Fade In */}
          <div className="fade-control">
            <div className="fade-toggle-container">
              <button
                className={`toggle-switch ${fadeInEnabled ? "enabled" : ""}`}
                onClick={() => {
                  setFadeInEnabled((current) => {
                    const next = !current;
                    if (next) {
                      const selectionDuration = selectedEnd - selectedStart;
                      setFadeInTime((prev) =>
                        prev > 0 ? Math.min(prev, selectionDuration) : Math.min(DEFAULT_FADE_DURATION, Math.max(selectionDuration, 0))
                      );
                    } else {
                      setFadeInTime(0);
                    }
                    return next;
                  });
                }}
              >
                <div className="toggle-slider" />
              </button>
              <span className="fade-label">Fade In</span>
            </div>
          </div>
        </div>

        {/* End Section - Trim End + Fade Out */}
        <div className="control-section end-section">
          {/* Trim End */}
          <div className="trim-control">
            <div className="trim-time-controls">
              <button
                className="trim-button"
                onClick={() => handleTrimEndChange(-0.1)}
                disabled={endTrim <= startTrim + 0.05}
              >
                <svg width="16" height="3" viewBox="0 0 12 2" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M0 1C0 0.447715 0.447715 0 1 0H11C11.5523 0 12 0.447715 12 1C12 1.55228 11.5523 2 11 2H1C0.447715 2 0 1.55228 0 1Z" fill="currentColor"/>
                </svg>
              </button>
              <span className="trim-time">{formatTime(selectedEnd)}</span>
              <button
                className="trim-button"
                onClick={() => handleTrimEndChange(0.1)}
                disabled={endTrim >= 1}
              >
                <svg width="16" height="16" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M6 0C6.55228 0 7 0.447715 7 1V5H11C11.5523 5 12 5.44772 12 6C12 6.55228 11.5523 7 11 7H7V11C7 11.5523 6.55228 12 6 12C5.44772 12 5 11.5523 5 11V7H1C0.447715 7 0 6.55228 0 6C0 5.44772 0.447715 5 1 5H5V1C5 0.447715 5.44772 0 6 0Z" fill="currentColor"/>
                </svg>
              </button>
            </div>
          </div>

          {/* Fade Out */}
          <div className="fade-control">
            <div className="fade-toggle-container">
            <span className="fade-label">Fade Out</span>
              <button
                className={`toggle-switch ${fadeOutEnabled ? "enabled" : ""}`}
                onClick={() => {
                  setFadeOutEnabled((current) => {
                    const next = !current;
                    if (next) {
                      const selectionDuration = selectedEnd - selectedStart;
                      setFadeOutTime((prev) =>
                        prev > 0 ? Math.min(prev, selectionDuration) : Math.min(DEFAULT_FADE_DURATION, Math.max(selectionDuration, 0))
                      );
                    } else {
                      setFadeOutTime(0);
                    }
                    return next;
                  });
                }}
              >
                <div className="toggle-slider" />
              </button>      
            </div>
          </div>
        </div>
      </div>

      {/* Submit Container */}
      <div className="submit-container"> 
        {/* Rights Confirmation */}
        <div className="rights-confirmation">
          <button
            className={`toggle-switch ${rightsConfirmed ? "enabled" : ""}`}
            onClick={() => setRightsConfirmed(!rightsConfirmed)}
          >
            <div className="toggle-slider" />
          </button>
          <span className="rights-text">I own the rights to use this audio.</span>
        </div>

        {/* Export Button */}
        <button
          className="generate-button"
          onClick={handleExportAudio}
          disabled={!rightsConfirmed || isLoading || isGenerating}
          >
          {isGenerating ? (
            <>
              <span className="spinner" aria-hidden="true" />
              Exporting...
            </>
          ) : (
            "Export audio"
          )}
        </button>

        {generationSuccess && (
          <div className="generation-status success">
            {downloadUrl ? (
              <>
                Your audio{" "}
                <a
                  href={downloadUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ textDecoration: "underline", color: "inherit" }}
                  onClick={(e) => {
                    e.preventDefault();
                    window.open(downloadUrl, "_blank", "noopener,noreferrer");
                  }}
                >
                  download link
                </a>{" "}
                is ready.
              </>
            ) : (
              generationSuccess
            )}
          </div>
        )}

        {generationError && (
          <div className="generation-status error" role="alert">
            {generationError}
          </div>
        )}
      </div>
    </div>
  );
}

export default AudioEditor;
