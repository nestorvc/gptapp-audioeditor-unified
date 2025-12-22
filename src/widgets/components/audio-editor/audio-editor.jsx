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
import {
  trackWidgetOpened,
  trackAudioLoaded,
  trackFileUploaded,
  trackAudioExported,
  trackFadeToggled,
  trackPlayback,
  trackAudioSeeked,
  trackFormatChanged,
  trackError,
} from "../../utils/analytics";

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
  const [bpm, setBpm] = useState(null);
  const [key, setKey] = useState(null);
  const [isDetectingBPMKey, setIsDetectingBPMKey] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [startTrim, setStartTrim] = useState(0.2);
  const [endTrim, setEndTrim] = useState(0.6);
  const [trimmerPosition, setTrimmerPosition] = useState(0.25);
  const [isDraggingStart, setIsDraggingStart] = useState(false);
  const [isDraggingEnd, setIsDraggingEnd] = useState(false);
  const [isDraggingTrimmer, setIsDraggingTrimmer] = useState(false);
  const wasPlayingBeforeDragRef = useRef(false);
  const waveformRef = useRef(null);
  const waveformSectionRef = useRef(null);
  const audioContextRef = useRef(null);
  const sourceNodeRef = useRef(null);
  const sourceNodesRef = useRef([]); // Store all source nodes for dual track mode
  const gainNodeRef = useRef(null);
  const animationFrameRef = useRef(null);
  const playbackStartTimeRef = useRef(null);
  const marqueeContentRef = useRef(null);
  const [duplicatedText, setDuplicatedText] = useState("");
  // File upload state
  const [uploadedAudioUrl, setUploadedAudioUrl] = useState(null);
  const [uploadedFileName, setUploadedFileName] = useState(null);
  const [uploadedFile, setUploadedFile] = useState(null); // Store File object to avoid CSP issues
  const [uploadedS3Url, setUploadedS3Url] = useState(null); // Store S3 URL from BPM detection to avoid re-uploading
  const fileInputRef = useRef(null);
  const audioBufferRef = useRef(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationError, setGenerationError] = useState(null);
  const [generationSuccess, setGenerationSuccess] = useState("");
  const [downloadUrl, setDownloadUrl] = useState(null);
  const [uploadError, setUploadError] = useState(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const sendFollowUpMessage = useSendFollowUpMessage();
  // Vocal extraction state
  const [isExtractingVocals, setIsExtractingVocals] = useState(false);
  const [isVocalsMode, setIsVocalsMode] = useState(false);
  const [vocalsAudioUrl, setVocalsAudioUrl] = useState(null);
  const [musicAudioUrl, setMusicAudioUrl] = useState(null);
  const [vocalsEnabled, setVocalsEnabled] = useState(true);
  const [musicEnabled, setMusicEnabled] = useState(true);
  const vocalsBufferRef = useRef(null);
  const musicBufferRef = useRef(null);
  const [vocalsWaveformData, setVocalsWaveformData] = useState([]);
  const [musicWaveformData, setMusicWaveformData] = useState([]);

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

    // Track widget opened event
    trackWidgetOpened({
      mode: isRingtoneMode ? 'ringtone' : 'audio',
      platform: platform || 'desktop',
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
  // Order: BPM • Key • Sample Rate
  const formatMarqueeText = () => {
    const parts = [];
    
    // BPM first
    if (bpm !== null && bpm > 0) {
      parts.push(`BPM: ${bpm}`);
    }
    
    // Key second
    if (key) {
      parts.push(`Key: ${key}`);
    }
    
    // Sample rate last
    if (audioSampleRate > 0) {
      parts.push(`Sample Rate: ${formatSampleRate(audioSampleRate)}`);
    }
    
    return parts.join(" • ");
  };

  // Update duplicated text when metadata changes (skip when loading)
  useEffect(() => {
    // Don't update duplicated text when loading - loading state is handled separately
    if (isDetectingBPMKey) {
      return;
    }
    
    const marqueeText = formatMarqueeText();
    
    // If no text, clear duplicated text
    if (!marqueeText || marqueeText.trim() === '') {
      setDuplicatedText('');
      return;
    }
    
    if (marqueeContentRef.current) {
      const updateDuplicatedText = () => {
        const content = marqueeContentRef.current;
        if (content) {
          const container = content.parentElement;
          if (container && container.offsetWidth > 0) {
            // Create a temporary element to measure the original text width
            const tempSpan = document.createElement('span');
            tempSpan.textContent = marqueeText;
            tempSpan.style.position = 'absolute';
            tempSpan.style.visibility = 'hidden';
            tempSpan.style.whiteSpace = 'nowrap';
            tempSpan.style.fontSize = window.getComputedStyle(content).fontSize;
            tempSpan.style.fontFamily = window.getComputedStyle(content).fontFamily;
            tempSpan.style.fontWeight = window.getComputedStyle(content).fontWeight;
            document.body.appendChild(tempSpan);
            const textWidth = tempSpan.offsetWidth;
            document.body.removeChild(tempSpan);
            
            const containerWidth = container.offsetWidth;
            
            // For seamless scrolling, we need at least 2 copies of the text
            // Calculate how many copies we need to fill 2x container width
            if (textWidth > 0) {
              const copiesNeeded = Math.max(2, Math.ceil((containerWidth * 2.5) / textWidth));
              const separator = " • ";
              setDuplicatedText((marqueeText + separator).repeat(copiesNeeded));
            } else {
              // Fallback: just duplicate once
              setDuplicatedText(marqueeText + " • " + marqueeText);
            }
          }
        }
      };
      
      // Use requestAnimationFrame for better timing
      const rafId = requestAnimationFrame(() => {
        setTimeout(updateDuplicatedText, 0);
      });
      
      window.addEventListener('resize', updateDuplicatedText);
      return () => {
        cancelAnimationFrame(rafId);
        window.removeEventListener('resize', updateDuplicatedText);
      };
    }
  }, [audioSampleRate, bpm, key, isDetectingBPMKey]);

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
          // Pins use same calculation as trimmer line, with small adjustment for alignment
          const pinAdjustment = 2; // +2% adjustment for both dual and single mode
          setStartPinPosition(calculateSectionPosition(startTrim) + pinAdjustment);
          setEndPinPosition(calculateSectionPosition(endTrim) + pinAdjustment);
        }
      });
    };

    updatePositions();

    // Update on window resize
    window.addEventListener('resize', updatePositions);
    return () => window.removeEventListener('resize', updatePositions);
  }, [trimmerPosition, startTrim, endTrim, isLoading, waveformData.length, isVocalsMode]);

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

    // Reset vocals mode when new audio is uploaded
    setIsVocalsMode(false);
    setVocalsAudioUrl(null);
    setMusicAudioUrl(null);
    setVocalsWaveformData([]);
    setMusicWaveformData([]);
    setVocalsEnabled(true);
    setMusicEnabled(true);
    vocalsBufferRef.current = null;
    musicBufferRef.current = null;

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
    setUploadedS3Url(null); // Clear previous S3 URL when new file is uploaded
    
    debugLog('💾 [FILE UPLOAD] State updated - file ready for processing');
    
    // Track file upload event
    const sanitizedFileName = sanitizeFileName(file.name.replace(/\.[^/.]+$/, ""), "audio-file");
    trackFileUploaded({
      upload_method: source,
      file_type: file.type || fileExtension,
      file_size: file.size,
      file_name: sanitizedFileName,
    });
    
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
      setIsDetectingBPMKey(false);
      setBpm(null);
      setKey(null);
      return;
    }

    // Reset BPM/Key detection state when loading new audio
    setIsDetectingBPMKey(false);
    setBpm(null);
    setKey(null);

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
        
        // Track audio loaded event
        const loadSource = audioSource.isUploaded 
          ? (uploadedAudioUrl ? 'manual' : 'drag_drop')
          : 'chatgpt_url';
        trackAudioLoaded({
          source: loadSource,
          duration: audioBuffer.duration,
          format: audioFormat || detectAudioFormat(audioSource.url, audioSource.file),
          sample_rate: audioBuffer.sampleRate,
          channels: audioBuffer.numberOfChannels,
          file_size: fileSize || arrayBuffer.byteLength,
        });
        
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
        
        // Detect BPM and Key after audio loads successfully
        detectBPMAndKey(audioSource);
      } catch (error) {
        console.error("❌ [AUDIO LOAD] Error loading audio:", {
          error: error.message,
          stack: error.stack,
          name: error.name,
          audioSource: audioSource.name
        });
        
        // Track error event
        trackError({
          error_type: 'load',
          error_message: error.message || 'Unknown error loading audio',
          context: {
            audio_source: audioSource.isUploaded ? 'uploaded' : 'external',
            has_url: !!audioSource.url,
          },
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

  // Detect BPM and Key from audio
  const detectBPMAndKey = async (audioSource) => {
    setIsDetectingBPMKey(true);
    try {
      const runtimeApiUrl = typeof window !== 'undefined' && window.__API_BASE_URL__;
      if (!runtimeApiUrl) {
        debugLog('⚠️ [BPM/KEY] API URL not available, skipping detection');
        setIsDetectingBPMKey(false);
        return;
      }

      let detectionUrl = audioSource.url;
      
      // For uploaded files, upload to S3 first to get a public URL
      if (audioSource.isUploaded && audioSource.file) {
        debugLog('📤 [BPM/KEY] Uploading file to S3 for detection...');
        
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
          debugLog('⚠️ [BPM/KEY] Failed to get presigned URL, skipping detection');
          setIsDetectingBPMKey(false);
          return;
        }

        const { uploadUrl, publicUrl } = await presignedUrlResponse.json();

        const s3UploadResponse = await fetch(uploadUrl, {
          method: "PUT",
          body: audioSource.file,
          headers: {
            "Content-Type": audioSource.file.type || "audio/mpeg",
          },
        });

        if (!s3UploadResponse.ok) {
          debugLog('⚠️ [BPM/KEY] Failed to upload to S3, skipping detection');
          setIsDetectingBPMKey(false);
          return;
        }

        detectionUrl = publicUrl;
        setUploadedS3Url(publicUrl); // Store S3 URL for reuse in vocal extraction
        debugLog('✅ [BPM/KEY] File uploaded to S3:', publicUrl);
      }

      // Call detection API
      debugLog('🔍 [BPM/KEY] Detecting BPM and Key...');
      const detectionResponse = await fetch(`${runtimeApiUrl.replace(/\/$/, "")}/api/detect-bpm-key`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          audioUrl: detectionUrl,
        }),
      });

      if (!detectionResponse.ok) {
        debugLog('⚠️ [BPM/KEY] Detection API failed:', detectionResponse.status);
        setIsDetectingBPMKey(false);
        return;
      }

      const result = await detectionResponse.json();
      debugLog('✅ [BPM/KEY] Detection complete:', result);

      if (result.bpm !== null && result.bpm !== undefined) {
        setBpm(result.bpm);
      }
      if (result.key) {
        setKey(result.key);
      }
      
      setIsDetectingBPMKey(false);
    } catch (error) {
      // Silently fail - BPM/Key detection is optional
      debugLog('⚠️ [BPM/KEY] Detection error (non-critical):', error.message);
      setIsDetectingBPMKey(false);
    }
  };

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
    // Cleanup function to stop any ongoing playback
    const cleanup = () => {
      // Stop all source nodes (for dual track mode)
      if (sourceNodesRef.current && sourceNodesRef.current.length > 0) {
        sourceNodesRef.current.forEach(source => {
          try {
            source.stop();
          } catch (e) {
            // Ignore errors if already stopped
          }
        });
        sourceNodesRef.current = [];
      }
      // Also handle single source node (for backward compatibility)
      if (sourceNodeRef.current) {
        try {
          sourceNodeRef.current.stop();
        } catch (e) {
          // Ignore errors if already stopped
        }
        sourceNodeRef.current = null;
      }
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      if (gainNodeRef.current) {
        gainNodeRef.current = null;
      }
      playbackStartTimeRef.current = null;
    };

    // If not playing or no audio context, cleanup and return
    if (!audioContextRef.current || !isPlaying) {
      cleanup();
      return cleanup;
    }

    // Cleanup previous playback before starting new one (handles trim changes during playback)
    cleanup();

    const playAudio = async () => {
      try {
        const audioContext = audioContextRef.current;
        if (audioContext.state === "suspended") {
          await audioContext.resume();
        }

        const startTime = selectedStart;
        const endTime = selectedEnd;
        const duration = endTime - startTime;

        if (isVocalsMode && vocalsBufferRef.current && musicBufferRef.current) {
          // Check if at least one track is enabled
          if (!vocalsEnabled && !musicEnabled) {
            setIsPlaying(false);
            return;
          }

          // Dual track playback - only create and start sources for enabled tracks
          const sources = [];
          const gainNodes = [];
          const merger = audioContext.createChannelMerger(2);

          // Setup vocals track if enabled
          if (vocalsEnabled) {
            const vocalsSource = audioContext.createBufferSource();
            const vocalsGain = audioContext.createGain();
            vocalsSource.buffer = vocalsBufferRef.current;
            vocalsSource.connect(vocalsGain);
            vocalsGain.connect(merger, 0, 0);
            sources.push(vocalsSource);
            gainNodes.push(vocalsGain);
          }

          // Setup music track if enabled
          if (musicEnabled) {
            const musicSource = audioContext.createBufferSource();
            const musicGain = audioContext.createGain();
            musicSource.buffer = musicBufferRef.current;
            musicSource.connect(musicGain);
            // Connect to right channel if vocals also enabled, otherwise left
            const outputChannel = vocalsEnabled ? 1 : 0;
            musicGain.connect(merger, 0, outputChannel);
            sources.push(musicSource);
            gainNodes.push(musicGain);
          }

          merger.connect(audioContext.destination);

          // Set initial gain values (all enabled tracks start at 1)
          gainNodes.forEach(gain => {
            gain.gain.setValueAtTime(1, audioContext.currentTime);
          });

          // Apply fade in/out if enabled
          if (fadeInEnabled && fadeInTime > 0) {
            gainNodes.forEach(gain => {
              gain.gain.setValueAtTime(0, audioContext.currentTime);
              gain.gain.linearRampToValueAtTime(1, audioContext.currentTime + fadeInTime);
            });
          }

          if (fadeOutEnabled && fadeOutTime > 0) {
            const fadeOutStart = audioContext.currentTime + duration - fadeOutTime;
            gainNodes.forEach(gain => {
              gain.gain.setValueAtTime(1, fadeOutStart);
              gain.gain.linearRampToValueAtTime(0, audioContext.currentTime + duration);
            });
          }

          // Store all sources for cleanup (so we can stop all tracks)
          sourceNodesRef.current = sources;
          sourceNodeRef.current = sources[0]; // Keep for backward compatibility
          gainNodeRef.current = gainNodes[0];

          const playbackStart = audioContext.currentTime;
          playbackStartTimeRef.current = playbackStart;

          const updatePosition = () => {
            if (!isPlaying) return;
            
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

          // Start only enabled sources
          sources.forEach(source => {
            source.start(playbackStart, startTime);
            source.stop(playbackStart + duration);
          });

          // Handle when any source ends
          let endedCount = 0;
          const handleEnded = () => {
            endedCount++;
            if (endedCount >= sources.length) {
              setIsPlaying(false);
              setTrimmerPosition(endTrim);
              sourceNodesRef.current = [];
              sourceNodeRef.current = null;
              playbackStartTimeRef.current = null;
            }
          };

          sources.forEach(source => {
            source.onended = handleEnded;
          });

          updatePosition();
        } else {
          // Single track playback (original behavior)
          const audioSource = getAudioSource();
          if (!audioSource) {
            setIsPlaying(false);
            return;
          }
          
          let arrayBuffer;
          if (audioSource.isUploaded && audioSource.file) {
            arrayBuffer = await new Promise((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = (e) => resolve(e.target.result);
              reader.onerror = reject;
              reader.readAsArrayBuffer(audioSource.file);
            });
          } else {
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
        }
      } catch (error) {
        console.error("Error playing audio:", error);
        setIsPlaying(false);
        cleanup();
      }
    };

    playAudio();

    // Return cleanup function to stop playback when effect re-runs (e.g., trim changes) or component unmounts
    return cleanup;
  }, [isPlaying, selectedStart, selectedEnd, fadeInEnabled, fadeOutEnabled, fadeInTime, fadeOutTime, startTrim, endTrim, uploadedAudioUrl, toolOutput?.audioUrl, isVocalsMode, vocalsEnabled, musicEnabled]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      // Stop all source nodes (for dual track mode)
      if (sourceNodesRef.current && sourceNodesRef.current.length > 0) {
        sourceNodesRef.current.forEach(source => {
          try {
            source.stop();
          } catch (e) {}
        });
        sourceNodesRef.current = [];
      }
      // Also handle single source node (for backward compatibility)
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
    const wasPlaying = isPlaying;
    setIsPlaying(!isPlaying);
    
    // Track playback event
    if (!wasPlaying) {
      trackPlayback({
        action: 'played',
        position: selectedStart,
        duration: selectedEnd - selectedStart,
      });
    } else {
      trackPlayback({
        action: 'paused',
        position: trimmerPosition,
      });
    }
  };

  const handleExtractVocals = async () => {
    if (isLoading || isExtractingVocals || isVocalsMode) {
      return;
    }

    setIsExtractingVocals(true);
    setGenerationError(null);
    setGenerationSuccess("");

    try {
      const audioSource = getAudioSource();
      if (!audioSource) {
        throw new Error("No audio source available");
      }

      const runtimeApiUrl = typeof window !== 'undefined' && window.__API_BASE_URL__;
      const endpoint = `${runtimeApiUrl.replace(/\/$/, "")}/api/extract-vocals`;

      debugLog("🎤 [EXTRACT VOCALS] Starting vocal extraction:", {
        audioSource: audioSource.isUploaded ? "uploaded file" : "external URL",
      });

      let response;

      if (audioSource.isUploaded && audioSource.file) {
        // Reuse S3 URL from BPM detection if available, otherwise upload
        let s3Url = uploadedS3Url;
        
        if (!s3Url) {
          debugLog("📤 [EXTRACT VOCALS] Uploading file to S3 first...");
          
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

          s3Url = publicUrl;
          setUploadedS3Url(s3Url); // Store for future use
          debugLog("✅ [EXTRACT VOCALS] File uploaded to S3:", s3Url);
        } else {
          debugLog("♻️ [EXTRACT VOCALS] Reusing S3 URL from BPM detection:", s3Url);
        }

        // Call extract vocals endpoint with S3 URL
        response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            audioUrl: s3Url,
            trackName: trackName || uploadedFileName || "audio-track",
          }),
        });
      } else if (audioSource.url) {
        // Call extract vocals endpoint with audio URL
        response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            audioUrl: audioSource.url,
            trackName: trackName || audioSource.name || "audio-track",
          }),
        });
      } else {
        throw new Error("No valid audio source available");
      }

      if (!response.ok) {
        let errorMessage = "Server failed to extract vocals.";
        try {
          const errorData = await response.json();
          if (errorData?.error) {
            errorMessage = errorData.error;
          }
        } catch {
          // Fallback to status-based message
          if (response.status >= 500) {
            errorMessage = "Server error. Please try again later.";
          }
        }
        throw new Error(errorMessage);
      }

      const result = await response.json();

      debugLog("✅ [EXTRACT VOCALS] Extraction complete:", {
        vocalsUrl: result.vocalsUrl,
        musicUrl: result.musicUrl,
      });

      // Load both audio buffers and generate waveforms
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();

      // Load vocals
      const vocalsResponse = await fetch(result.vocalsUrl);
      const vocalsArrayBuffer = await vocalsResponse.arrayBuffer();
      const vocalsBuffer = await audioContext.decodeAudioData(vocalsArrayBuffer);
      vocalsBufferRef.current = vocalsBuffer;

      // Load music
      const musicResponse = await fetch(result.musicUrl);
      const musicArrayBuffer = await musicResponse.arrayBuffer();
      const musicBuffer = await audioContext.decodeAudioData(musicArrayBuffer);
      musicBufferRef.current = musicBuffer;

      // Generate waveforms
      const vocalsWaveform = await generateWaveform(vocalsBuffer);
      const musicWaveform = await generateWaveform(musicBuffer);

      setVocalsWaveformData(vocalsWaveform);
      setMusicWaveformData(musicWaveform);
      setVocalsAudioUrl(result.vocalsUrl);
      setMusicAudioUrl(result.musicUrl);

      // Set vocals mode
      setIsVocalsMode(true);
      setVocalsEnabled(true);
      setMusicEnabled(true);

      // Update total duration to match vocals buffer (they should be the same)
      setTotalDuration(vocalsBuffer.duration);
      
      // Ensure loading state is cleared
      setIsLoading(false);

      debugLog("🎵 [EXTRACT VOCALS] Audio buffers loaded and waveforms generated", {
        vocalsWaveformLength: vocalsWaveform.length,
        musicWaveformLength: musicWaveform.length,
      });
    } catch (error) {
      console.error("❌ [EXTRACT VOCALS] Failed to extract vocals:", error);
      const message =
        error?.message && typeof error.message === "string"
          ? error.message
          : "Something went wrong while extracting vocals.";
      setGenerationError(message);
    } finally {
      setIsExtractingVocals(false);
    }
  };

  const handleExportAudio = async () => {
    if (isLoading || isGenerating || !rightsConfirmed) {
      return;
    }

    if (isVocalsMode) {
      if (!vocalsBufferRef.current || !musicBufferRef.current) {
        setGenerationError("Audio tracks are not ready yet. Please wait for the waveforms to finish loading.");
        return;
      }
    } else {
      if (!audioBufferRef.current) {
        setGenerationError("Audio is not ready yet. Please wait for the waveform to finish loading.");
        return;
      }
    }

    setIsGenerating(true);
    setGenerationError(null);
    setGenerationSuccess("");

    // Try to get API base URL from multiple sources (build-time env, runtime window global, or fallback)
    const runtimeApiUrl = typeof window !== 'undefined' && window.__API_BASE_URL__;
    const endpoint = `${runtimeApiUrl.replace(/\/$/, "")}/api/audio-process`;

    try {
      const totalDuration = isVocalsMode 
        ? (vocalsBufferRef.current?.duration || 0)
        : (audioBufferRef.current?.duration || 0);
      // startTrim and endTrim are normalized (0-1), convert to seconds
      const startTime = startTrim * totalDuration;
      const duration = (endTrim - startTrim) * totalDuration;

      debugLog("📤 [AUDIO EXPORT] Preparing server-side processing:", {
        mode: isVocalsMode ? "dual track" : "single track",
        startTime: `${startTime.toFixed(2)}s`,
        duration: `${duration.toFixed(2)}s`,
        format: outputFormat,
        fadeInEnabled,
        fadeInDuration: fadeInTime,
        fadeOutEnabled,
        fadeOutDuration: fadeOutTime,
      });

      let response;

      // If in dual mode with both tracks enabled, use original audio (same as single track)
      // Check explicitly for both tracks being enabled (true boolean values)
      const bothTracksEnabled = isVocalsMode && vocalsEnabled === true && musicEnabled === true;
      
      debugLog("📤 [AUDIO EXPORT] Export conditions:", {
        isVocalsMode,
        vocalsEnabled,
        musicEnabled,
        bothTracksEnabled,
        vocalsAudioUrl: !!vocalsAudioUrl,
        musicAudioUrl: !!musicAudioUrl,
      });
      
      if (bothTracksEnabled) {
        const audioSource = getAudioSource();
        if (!audioSource) {
          throw new Error("No audio source available");
        }

        if (audioSource.isUploaded && audioSource.file) {
          // Upload file directly to S3 first, then send S3 URL + processing parameters
          debugLog("📤 [AUDIO EXPORT] Uploading original file to S3 first (both tracks enabled)...");
          
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

          debugLog("✅ [AUDIO EXPORT] Original file uploaded to S3:", publicUrl);

          // Send S3 URL + processing parameters to server (single track processing)
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
        } else {
          // Use URL directly (from toolOutput) - single track processing
          const params = new URLSearchParams();
          params.append("audioUrl", audioSource.url);
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
        }
      } else if (isVocalsMode && vocalsAudioUrl && musicAudioUrl && !(vocalsEnabled === true && musicEnabled === true)) {
        // Dual track export - one or both tracks disabled, use separated tracks
        // IMPORTANT: Only use dual track processing if NOT both enabled (to avoid ffmpeg filter conflicts)
        debugLog("📤 [AUDIO EXPORT] Using dual track processing (one or both tracks disabled)");
        const params = new URLSearchParams();
        params.append("vocalsUrl", vocalsAudioUrl);
        params.append("musicUrl", musicAudioUrl);
        params.append("vocalsEnabled", String(vocalsEnabled));
        params.append("musicEnabled", String(musicEnabled));
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
      } else if (!isVocalsMode) {
        // Single track export (original behavior)
        const audioSource = getAudioSource();
        if (!audioSource) {
          throw new Error("No audio source available");
        }

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
      } else {
        throw new Error("Vocals mode is active but audio URLs are not available");
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

      // Track successful export event
      trackAudioExported({
        format: outputFormat,
        duration: duration,
        start_trim: startTrim,
        end_trim: endTrim,
        fade_in_enabled: fadeInEnabled,
        fade_out_enabled: fadeOutEnabled,
        fade_in_duration: fadeInTime,
        fade_out_duration: fadeOutTime,
        source: audioSource?.isUploaded ? 'manual' : 'chatgpt_url',
      });

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
      
      // Track export error event
      trackError({
        error_type: 'export',
        error_message: error?.message || 'Unknown error exporting audio',
        context: {
          format: outputFormat,
          has_audio: !!audioBufferRef.current,
        },
      });
      
      const message =
        error?.message && typeof error.message === "string"
          ? error.message
          : "Something went wrong while exporting the audio.";
      setGenerationError(message);
    } finally {
      setTimeout(() => {
        setIsGenerating(false);
      }, 200);
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
    const oldFormat = outputFormat;
    const newFormat = normalizeOutputFormat(format);
    setOutputFormat(newFormat);
    setShowFormatDropdown(false);
    
    // Track format change event
    trackFormatChanged({
      old_format: oldFormat,
      new_format: newFormat,
      mode: isRingtoneMode ? 'ringtone' : 'audio',
    });
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
    // Track if playback was active before starting drag
    if (isPlaying) {
      wasPlayingBeforeDragRef.current = true;
      setIsPlaying(false);
    } else {
      wasPlayingBeforeDragRef.current = false;
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
        wasPlayingBeforeDragRef.current = true;
        setIsPlaying(false);
      }
      const newStart = Math.min(percentage, endTrim - 0.05); // Ensure start is before end
      setStartTrim(newStart);
      setTrimmerPosition(newStart);
    } else if (isDraggingEnd) {
      // Stop playback if trying to trim while playing
      if (isPlaying) {
        wasPlayingBeforeDragRef.current = true;
        setIsPlaying(false);
      }
      const newEnd = Math.max(percentage, startTrim + 0.05); // Ensure end is after start
      setEndTrim(newEnd);
      setTrimmerPosition(newEnd);
    } else if (isDraggingTrimmer) {
      // Stop playback if trying to move trimmer while playing
      if (isPlaying) {
        wasPlayingBeforeDragRef.current = true;
        setIsPlaying(false);
      }
      setTrimmerPosition(percentage);
    }
  }, [isDraggingStart, isDraggingEnd, isDraggingTrimmer, isPlaying, endTrim, startTrim]);

  const handleEnd = useCallback((e) => {
    // Prevent default to avoid any unwanted behaviors
    if (e.type === 'touchend') {
      e.preventDefault();
    }
    const wasPlaying = wasPlayingBeforeDragRef.current;
    setIsDraggingStart(false);
    setIsDraggingEnd(false);
    setIsDraggingTrimmer(false);
    wasPlayingBeforeDragRef.current = false;
    // Restart playback if it was playing before drag started
    if (wasPlaying) {
      setTimeout(() => setIsPlaying(true), 100);
    }
  }, []);

  // Handle trim pin start (both mouse and touch)
  const handleTrimPinStart = (type, e) => {
    e.preventDefault();
    e.stopPropagation();
    // Track if playback was active before starting drag
    if (isPlaying) {
      wasPlayingBeforeDragRef.current = true;
      setIsPlaying(false);
    } else {
      wasPlayingBeforeDragRef.current = false;
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
        {/* Header */}
        <div className="ringtone-header">
          <div className="upload-title-container">            
            <svg className="upload-title-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M8 5C8.55228 5 9 5.44772 9 6V18C9 18.5523 8.55228 19 8 19C7.44772 19 7 18.5523 7 18V6C7 5.44772 7.44772 5 8 5ZM16 7C16.5523 7 17 7.44772 17 8V16C17 16.5523 16.5523 17 16 17C15.4477 17 15 16.5523 15 16V8C15 7.44772 15.4477 7 16 7ZM12 8.5C12.5523 8.5 13 8.94772 13 9.5V14.5C13 15.0523 12.5523 15.5 12 15.5C11.4477 15.5 11 15.0523 11 14.5V9.5C11 8.94772 11.4477 8.5 12 8.5ZM4 9.5C4.55228 9.5 5 9.94772 5 10.5V13.5C5 14.0523 4.55228 14.5 4 14.5C3.44772 14.5 3 14.0523 3 13.5V10.5C3 9.94772 3.44772 9.5 4 9.5ZM20 9.5C20.5523 9.5 21 9.94772 21 10.5V13.5C21 14.0523 20.5523 14.5 20 14.5C19.4477 14.5 19 14.0523 19 13.5V10.5C19 9.94772 19.4477 9.5 20 9.5Z" fill="currentColor"/>
            </svg>
            <h2 className="upload-title">Upload Audio File</h2>
          </div>
        </div>
        
        {/* Waveform Section - Upload UI */}
        <div className="waveform-container">
          <input
            ref={fileInputRef}
            id="audio-file-input"
            type="file"
            accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.webm"
            onChange={handleFileUpload}
            style={{ display: 'none' }}
            aria-label="Upload audio file or Drag-n-drop here"
          />
          <div 
            className={`upload-area ${isDraggingOver ? 'drag-over' : ''}`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={(e) => {
              e.preventDefault();
              if (fileInputRef.current) {
                fileInputRef.current.click();
              }
            }}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (fileInputRef.current) {
                  fileInputRef.current.click();
                }
              }
            }}
          >            
            <p className="upload-description">
              {isDraggingOver ? 'Drop your audio file here' : (
                <>
                  <b>Drag-n-drop</b> an audio file or <b>choose one</b> to edit
                </>
              )}
            </p>
            <p className="upload-hint">Supports MP3, WAV, M4A, AAC, OGG, and WebM</p>
            {uploadError && (
              <div className="upload-error" role="alert">
                {uploadError}
              </div>
            )}
          </div>
        </div>

        {/* Submit Container - Upload Button */}
        <div className="submit-container">
          <button 
            className="generate-button"
            onClick={(e) => {
              e.preventDefault();
              if (fileInputRef.current) {
                fileInputRef.current.click();
              }
            }}
          >
            Select File or Drag-n-drop
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="ringtone-editor">
      <input
        ref={fileInputRef}
        id="audio-file-input-replace"
        type="file"
        accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.webm"
        onChange={handleFileUpload}
        style={{ display: 'none' }}
        aria-label="Replace audio file"
      />
      {/* Header */}
      <div className="ringtone-header">
        <button
          onClick={handlePlay}
          disabled={isLoading || (isVocalsMode && !vocalsEnabled && !musicEnabled)}
          className={`play-button ${isPlaying ? "playing" : ""} ${isLoading ? "loading" : ""}`}
          aria-label={isPlaying ? "Pause" : "Play"}
          title={isVocalsMode && !vocalsEnabled && !musicEnabled ? "Enable at least one track to play" : undefined}
        >
          {isLoading ? (
            <span className="loading-spinner">...</span>
          ) : isPlaying ? (
            <svg className="play-icon" width="35" height="35" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6.5 7.75C6.5 7.05964 7.05964 6.5 7.75 6.5H9.25C9.94036 6.5 10.5 7.05964 10.5 7.75V16.25C10.5 16.9404 9.94036 17.5 9.25 17.5H7.75C7.05964 17.5 6.5 16.9404 6.5 16.25V7.75Z" fill="currentColor"/>
              <path d="M13.5 7.75C13.5 7.05964 14.0596 6.5 14.75 6.5H16.25C16.9404 6.5 17.5 7.05964 17.5 7.75V16.25C17.5 16.9404 16.9404 17.5 16.25 17.5H14.75C14.0596 17.5 13.5 16.9404 13.5 16.25V7.75Z" fill="currentColor"/>
            </svg>
          ) : (
            <svg className="play-icon" width="35" height="35" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 16.7229V7.27711C8 6.29075 9.08894 5.69298 9.9211 6.22254L17.3428 10.9454C18.1147 11.4366 18.1147 12.5634 17.3428 13.0546L9.92109 17.7775C9.08894 18.3071 8 17.7093 8 16.7229Z" fill="currentColor"/>
            </svg>
          )}
        </button>

        <div className={`track-name-marquee ${isDetectingBPMKey ? 'loading' : ''}`}>
          <div 
            ref={marqueeContentRef}
            className={`marquee-content ${isDetectingBPMKey ? 'loading' : ''}`}
          >
            {isDetectingBPMKey ? (
              <>
                <span className="spinner" aria-hidden="true" />
                <span>Loading attributes...</span>
              </>
            ) : (
              <span>{duplicatedText || formatMarqueeText()}</span>
            )}
          </div>
        </div>

        <button
          className="header-tools-button replace-audio-button"
          onClick={(e) => {
            e.preventDefault();
            if (fileInputRef.current) {
              fileInputRef.current.click();
            }
          }}
          aria-label="Replace audio file"
          title="Replace audio file"
        >
          <svg className="button-svg-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M18.032 5.024C17.75 5 17.377 5 16.8 5h-5.3c-.2 1-.401 1.911-.61 2.854-.131.596-.247 1.119-.523 1.56a2.998 2.998 0 0 1-.953.954c-.441.275-.964.39-1.56.522l-.125.028-2.512.558A1.003 1.003 0 0 1 5 11.5v5.3c0 .577 0 .949.024 1.232.022.272.06.372.085.422a1 1 0 0 0 .437.437c.05.025.15.063.422.085C6.25 19 6.623 19 7.2 19H10a1 1 0 1 1 0 2H7.161c-.527 0-.981 0-1.356-.03-.395-.033-.789-.104-1.167-.297a3 3 0 0 1-1.311-1.311c-.193-.378-.264-.772-.296-1.167A17.9 17.9 0 0 1 3 16.838V11c0-2.075 1.028-4.067 2.48-5.52C6.933 4.028 8.925 3 11 3h5.838c.528 0 .982 0 1.357.03.395.033.789.104 1.167.297a3 3 0 0 1 1.311 1.311c.193.378.264.772.296 1.167.031.375.031.83.031 1.356V10a1 1 0 1 1-2 0V7.2c0-.577 0-.949-.024-1.232-.022-.272-.06-.373-.085-.422a1 1 0 0 0-.437-.437c-.05-.025-.15-.063-.422-.085ZM5.28 9.414l2.015-.448c.794-.177.948-.225 1.059-.294a1 1 0 0 0 .318-.318c.069-.11.117-.265.294-1.059l.447-2.015c-.903.313-1.778.874-2.518 1.615-.741.74-1.302 1.615-1.615 2.518ZM17 15a1 1 0 1 1 2 0v2h2a1 1 0 1 1 0 2h-2v2a1 1 0 1 1-2 0v-2h-2a1 1 0 1 1 0-2h2v-2Z" fill="currentColor"/>
          </svg>
        </button>

        <button
          className="header-tools-button extract-vocals-button"
          onClick={(e) => {
            e.preventDefault();
            handleExtractVocals();
          }}
          disabled={isExtractingVocals || isVocalsMode || isLoading}
          aria-label="Extract vocals"
          title={isVocalsMode ? "Vocals already extracted" : isExtractingVocals ? "Extracting..." : "Extract vocals"}
        >
          {isExtractingVocals ? (
            <>
              <span className="spinner" aria-hidden="true" />
              <span className="extract-vocals-text">Extracting...</span>
            </>
          ) : (
            <>
              <svg className="button-svg-icon" width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18 2C18.5523 2 19 2.44772 19 3V15C19 15.5523 18.5523 16 18 16C17.4477 16 17 15.5523 17 15V3C17 2.44772 17.4477 2 18 2ZM11 3C11.5523 3 12 3.44772 12 4V5.5C12 6.05228 11.5523 6.5 11 6.5C10.4477 6.5 10 6.05228 10 5.5V4C10 3.44772 10.4477 3 11 3ZM14.5 5C15.0523 5 15.5 5.44772 15.5 6V12.25C15.5 12.8023 15.0523 13.25 14.5 13.25C13.9477 13.25 13.5 12.8023 13.5 12.25V6C13.5 5.44772 13.9477 5 14.5 5ZM21.5 7C22.0523 7 22.5 7.44772 22.5 8V10C22.5 10.5523 22.0523 11 21.5 11C20.9477 11 20.5 10.5523 20.5 10V8C20.5 7.44772 20.9477 7 21.5 7ZM8 10C7.17157 10 6.5 10.6716 6.5 11.5C6.5 12.3284 7.17157 13 8 13C8.82843 13 9.5 12.3284 9.5 11.5C9.5 10.6716 8.82843 10 8 10ZM4.5 11.5C4.5 9.567 6.067 8 8 8C9.933 8 11.5 9.567 11.5 11.5C11.5 13.433 9.933 15 8 15C6.067 15 4.5 13.433 4.5 11.5ZM5.14202 18.815C4.43814 19.3155 4 20.0257 4 21C4 21.5523 3.55228 22 3 22C2.44772 22 2 21.5523 2 21C2 19.3077 2.81186 18.0179 3.98298 17.1851C5.12436 16.3734 6.58924 16 8 16C9.41076 16 10.8756 16.3734 12.017 17.1851C13.1881 18.0178 14 19.3076 14 21C14 21.5523 13.5523 22 13 22C12.4477 22 12 21.5523 12 21C12 20.0257 11.5619 19.3155 10.858 18.815C10.1244 18.2933 9.08924 18 8 18C6.91076 18 5.87564 18.2933 5.14202 18.815Z" fill="currentColor"/>
              </svg>
              <span className="extract-vocals-text">Extract vocals</span>
            </>
          )}
        </button>

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

        {/* Waveform container(s) */}
        {isVocalsMode ? (
          <>
            {/* Start pin - positioned at top of first waveform (points down) */}
            <svg
              className="trim-pin start-pin vocals-mode-start-pin"
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

            {/* End pin - positioned at bottom of second waveform (points up) */}
            <svg
              className="trim-pin end-pin vocals-mode-end-pin"
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
          </>
        ) : (
          <>
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
          </>
        )}

        {/* Waveform container(s) */}
        {isVocalsMode ? (
          <div className="waveform-dual-container">
            {/* Vocals track */}
            <div className={`waveform-track ${!vocalsEnabled ? "track-disabled" : ""}`}>
              <div className="waveform-toggle-container">
                <button
                  className={`toggle-switch ${vocalsEnabled ? "enabled" : ""}`}
                  onClick={() => {
                    const wasPlaying = isPlaying;
                    if (wasPlaying) {
                      setIsPlaying(false);
                    }
                    setVocalsEnabled(!vocalsEnabled);
                    // Restart playback if it was playing and at least one track will be enabled
                    if (wasPlaying && (!vocalsEnabled || musicEnabled)) {
                      setTimeout(() => setIsPlaying(true), 100);
                    }
                  }}
                  aria-label="Toggle vocals track"
                >
                  <div className="toggle-slider" />
                </button>
                <span className="waveform-track-label">Vocals</span>
              </div>
              <div
                className="waveform-container"
                ref={waveformRef}
                onMouseDown={handleWaveformStart}
                onTouchStart={handleWaveformStart}
              >
                {isLoading || vocalsWaveformData.length === 0 ? (
                  <div className="waveform-loading">Loading audio...</div>
                ) : (
                  <>
                    <div className="waveform-background">
                      {vocalsWaveformData.map((height, index) => (
                        <div
                          key={index}
                          className="waveform-bar background-bar"
                          style={{ height: `${height * 100}%` }}
                        />
                      ))}
                    </div>
                    <div className="waveform-selected">
                      {vocalsWaveformData.map((height, index) => {
                        const position = index / vocalsWaveformData.length;
                        const isInRange = position >= startTrim && position <= endTrim;
                        if (!isInRange) return null;
                        const totalBars = vocalsWaveformData.length;
                        const barWidthPercent = 70 / totalBars;
                        const leftPercent = (index / totalBars) * 100;
                        return (
                          <div
                            key={`vocals-selected-${index}`}
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
            </div>

            {/* Music track */}
            <div className={`waveform-track music-track ${!musicEnabled ? "track-disabled" : ""}`}>
              <div className="waveform-toggle-container">
                <button
                  className={`toggle-switch ${musicEnabled ? "enabled" : ""}`}
                  onClick={() => {
                    const wasPlaying = isPlaying;
                    if (wasPlaying) {
                      setIsPlaying(false);
                    }
                    setMusicEnabled(!musicEnabled);
                    // Restart playback if it was playing and at least one track will be enabled
                    if (wasPlaying && (vocalsEnabled || !musicEnabled)) {
                      setTimeout(() => setIsPlaying(true), 100);
                    }
                  }}
                  aria-label="Toggle music track"
                >
                  <div className="toggle-slider" />
                </button>
                <span className="waveform-track-label">Music</span>
              </div>
              <div
                className="waveform-container"
                onMouseDown={handleWaveformStart}
                onTouchStart={handleWaveformStart}
              >
                {isLoading || musicWaveformData.length === 0 ? (
                  <div className="waveform-loading">Loading audio...</div>
                ) : (
                  <>
                    <div className="waveform-background">
                      {musicWaveformData.map((height, index) => (
                        <div
                          key={index}
                          className="waveform-bar background-bar"
                          style={{ height: `${height * 100}%` }}
                        />
                      ))}
                    </div>
                    <div className="waveform-selected">
                      {musicWaveformData.map((height, index) => {
                        const position = index / musicWaveformData.length;
                        const isInRange = position >= startTrim && position <= endTrim;
                        if (!isInRange) return null;
                        const totalBars = musicWaveformData.length;
                        const barWidthPercent = 70 / totalBars;
                        const leftPercent = (index / totalBars) * 100;
                        return (
                          <div
                            key={`music-selected-${index}`}
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
            </div>
          </div>
        ) : (
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
        )}

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
                      const fadeDuration = Math.min(DEFAULT_FADE_DURATION, Math.max(selectionDuration, 0));
                      setFadeInTime((prev) =>
                        prev > 0 ? Math.min(prev, selectionDuration) : fadeDuration
                      );
                      
                      // Track fade toggle event
                      trackFadeToggled({
                        fade_type: 'in',
                        enabled: true,
                        duration: fadeDuration,
                      });
                    } else {
                      setFadeInTime(0);
                      
                      // Track fade toggle event
                      trackFadeToggled({
                        fade_type: 'in',
                        enabled: false,
                        duration: 0,
                      });
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
                      const fadeDuration = Math.min(DEFAULT_FADE_DURATION, Math.max(selectionDuration, 0));
                      setFadeOutTime((prev) =>
                        prev > 0 ? Math.min(prev, selectionDuration) : fadeDuration
                      );
                      
                      // Track fade toggle event
                      trackFadeToggled({
                        fade_type: 'out',
                        enabled: true,
                        duration: fadeDuration,
                      });
                    } else {
                      setFadeOutTime(0);
                      
                      // Track fade toggle event
                      trackFadeToggled({
                        fade_type: 'out',
                        enabled: false,
                        duration: 0,
                      });
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
          disabled={(isVocalsMode && !vocalsEnabled && !musicEnabled) || !rightsConfirmed || isLoading || isGenerating}
          title={isVocalsMode && !vocalsEnabled && !musicEnabled ? "Enable at least one track to export" : undefined}
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
