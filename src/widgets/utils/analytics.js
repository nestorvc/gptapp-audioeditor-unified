/**
 * ANALYTICS.JS - Server-Side Google Analytics 4 (GA4) Event Tracking
 * 
 * Provides utilities for tracking user interactions and events in the audio editor widget.
 * Events are sent to the server which forwards them to GA4 via Measurement Protocol.
 * 
 * Privacy: No PII (Personally Identifiable Information) is tracked.
 * Only metadata and user actions are logged.
 */

// API base URL (injected by server via window.__API_BASE_URL__)
const API_BASE_URL = typeof window !== 'undefined' && window.__API_BASE_URL__ 
  ? window.__API_BASE_URL__.replace(/\/$/, '') // Remove trailing slash
  : '';

// Session ID storage key
const SESSION_STORAGE_KEY = 'ga4_chatgpt_session_id';

/**
 * Get or create a session ID for the current ChatGPT conversation
 * Uses sessionStorage to persist across widget instances in the same conversation
 * @returns {string} Session ID
 */
export function getSessionId() {
  if (typeof window === 'undefined' || !window.sessionStorage) {
    // Fallback if sessionStorage is not available
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  let sessionId = sessionStorage.getItem(SESSION_STORAGE_KEY);
  
  if (!sessionId) {
    // Generate new session ID
    const timestamp = Date.now();
    const random = Math.random().toString(36).substr(2, 9);
    sessionId = `chatgpt_session_${timestamp}_${random}`;
    sessionStorage.setItem(SESSION_STORAGE_KEY, sessionId);
  }

  return sessionId;
}

/**
 * Track a custom event to GA4 via server
 * @param {string} eventName - Event name (snake_case recommended)
 * @param {Object} parameters - Event parameters
 */
export function trackEvent(eventName, parameters = {}) {
  if (!eventName || typeof eventName !== 'string') {
    console.warn('[Analytics] Invalid event name:', eventName);
    return;
  }

  if (!API_BASE_URL) {
    console.warn('[Analytics] API_BASE_URL not set. Event not tracked:', eventName);
    return;
  }

  // Add common parameters to all events
  const eventParams = {
    ...parameters,
    session_id: getSessionId(),
    timestamp: new Date().toISOString(),
  };

  // Send event to server
  fetch(`${API_BASE_URL}/api/analytics/track`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      eventName,
      parameters: eventParams,
      sessionId: getSessionId(),
    }),
  }).catch((error) => {
    console.warn('[Analytics] Error sending event to server:', error);
  });

  console.log('[Analytics] Event tracked:', eventName, eventParams);
}

/**
 * Track widget opened event
 * @param {Object} options - Widget options
 * @param {string} options.mode - Widget mode (ringtone/audio)
 * @param {string} options.platform - Platform (ios/android/desktop)
 */
export function trackWidgetOpened({ mode, platform }) {
  trackEvent('widget_opened', {
    mode: mode || 'audio',
    platform: platform || 'desktop',
  });
}

/**
 * Track audio loaded event
 * @param {Object} metadata - Audio metadata
 * @param {string} metadata.source - Source (manual/chatgpt_url/drag_drop)
 * @param {number} metadata.duration - Duration in seconds
 * @param {string} metadata.format - Audio format (mp3, wav, etc.)
 * @param {number} metadata.sample_rate - Sample rate in Hz
 * @param {number} metadata.channels - Number of channels
 * @param {number} metadata.file_size - File size in bytes
 */
export function trackAudioLoaded({ source, duration, format, sample_rate, channels, file_size }) {
  trackEvent('audio_loaded', {
    source: source || 'unknown',
    duration: duration || 0,
    format: format || 'unknown',
    sample_rate: sample_rate || 0,
    channels: channels || 0,
    file_size: file_size || 0,
  });
}

/**
 * Track file uploaded event
 * @param {Object} fileInfo - File information
 * @param {string} fileInfo.upload_method - Upload method (button/drag_drop)
 * @param {string} fileInfo.file_type - File MIME type
 * @param {number} fileInfo.file_size - File size in bytes
 * @param {string} fileInfo.file_name - Sanitized file name (no extension, no PII)
 */
export function trackFileUploaded({ upload_method, file_type, file_size, file_name }) {
  trackEvent('file_uploaded', {
    upload_method: upload_method || 'button',
    file_type: file_type || 'unknown',
    file_size: file_size || 0,
    file_name: file_name || 'unknown',
  });
}

/**
 * Track audio exported event
 * @param {Object} exportParams - Export parameters
 * @param {string} exportParams.format - Export format (mp3, wav, flac, etc.)
 * @param {number} exportParams.duration - Exported duration in seconds
 * @param {number} exportParams.start_trim - Start trim position (0-1)
 * @param {number} exportParams.end_trim - End trim position (0-1)
 * @param {boolean} exportParams.fade_in_enabled - Fade in enabled
 * @param {boolean} exportParams.fade_out_enabled - Fade out enabled
 * @param {number} exportParams.fade_in_duration - Fade in duration in seconds
 * @param {number} exportParams.fade_out_duration - Fade out duration in seconds
 * @param {string} exportParams.source - Audio source (manual/chatgpt_url)
 */
export function trackAudioExported({
  format,
  duration,
  start_trim,
  end_trim,
  fade_in_enabled,
  fade_out_enabled,
  fade_in_duration,
  fade_out_duration,
  source,
}) {
  trackEvent('audio_exported', {
    format: format || 'unknown',
    duration: duration || 0,
    start_trim: start_trim || 0,
    end_trim: end_trim || 1,
    fade_in_enabled: fade_in_enabled || false,
    fade_out_enabled: fade_out_enabled || false,
    fade_in_duration: fade_in_duration || 0,
    fade_out_duration: fade_out_duration || 0,
    source: source || 'unknown',
  });
}

/**
 * Track fade toggle event
 * @param {Object} fadeInfo - Fade information
 * @param {string} fadeInfo.fade_type - Fade type (in/out)
 * @param {boolean} fadeInfo.enabled - Whether fade is enabled
 * @param {number} fadeInfo.duration - Fade duration in seconds (if enabled)
 */
export function trackFadeToggled({ fade_type, enabled, duration }) {
  trackEvent('fade_toggled', {
    fade_type: fade_type || 'unknown',
    enabled: enabled || false,
    duration: enabled ? (duration || 0) : 0,
  });
}

/**
 * Track playback event
 * @param {Object} playbackInfo - Playback information
 * @param {string} playbackInfo.action - Action (played/paused)
 * @param {number} playbackInfo.position - Playback position in seconds
 * @param {number} playbackInfo.duration - Total duration in seconds (for played action)
 */
export function trackPlayback({ action, position, duration }) {
  trackEvent(`audio_${action}`, {
    position: position || 0,
    ...(duration !== undefined && { duration }),
  });
}

/**
 * Track audio seek event
 * @param {Object} seekInfo - Seek information
 * @param {number} seekInfo.from_position - Previous position in seconds
 * @param {number} seekInfo.to_position - New position in seconds
 */
export function trackAudioSeeked({ from_position, to_position }) {
  trackEvent('audio_seeked', {
    from_position: from_position || 0,
    to_position: to_position || 0,
  });
}

/**
 * Track format changed event
 * @param {Object} formatInfo - Format information
 * @param {string} formatInfo.old_format - Previous format
 * @param {string} formatInfo.new_format - New format
 * @param {string} formatInfo.mode - Widget mode (ringtone/audio)
 */
export function trackFormatChanged({ old_format, new_format, mode }) {
  trackEvent('format_changed', {
    old_format: old_format || 'unknown',
    new_format: new_format || 'unknown',
    mode: mode || 'audio',
  });
}

/**
 * Track error event
 * @param {Object} errorInfo - Error information
 * @param {string} errorInfo.error_type - Error type (upload/export/load)
 * @param {string} errorInfo.error_message - Error message (sanitized, no PII)
 * @param {Object} errorInfo.context - Additional context (optional)
 */
export function trackError({ error_type, error_message, context }) {
  trackEvent('widget_error', {
    error_type: error_type || 'unknown',
    error_message: error_message || 'Unknown error',
    ...(context && { context: JSON.stringify(context) }),
  });
}

/**
 * Track vocal extraction started event
 * @param {Object} options - Extraction options
 * @param {string} options.source - Source (manual/chatgpt_url)
 */
export function trackVocalExtractionStarted({ source }) {
  trackEvent('vocal_extraction_started', {
    source: source || 'unknown',
  });
}

/**
 * Track BPM detection started event
 * @param {Object} options - Detection options
 * @param {string} options.source - Source (manual/chatgpt_url)
 */
export function trackBPMDetectionStarted({ source }) {
  trackEvent('bpm_detection_started', {
    source: source || 'unknown',
  });
}

/**
 * Track dual track exported event
 * @param {Object} exportParams - Export parameters
 * @param {string} exportParams.format - Export format
 * @param {number} exportParams.duration - Exported duration in seconds
 * @param {boolean} exportParams.vocals_enabled - Vocals track enabled
 * @param {boolean} exportParams.music_enabled - Music track enabled
 */
export function trackDualTrackExported({
  format,
  duration,
  vocals_enabled,
  music_enabled,
}) {
  trackEvent('dual_track_exported', {
    format: format || 'unknown',
    duration: duration || 0,
    vocals_enabled: vocals_enabled !== undefined ? vocals_enabled : true,
    music_enabled: music_enabled !== undefined ? music_enabled : true,
  });
}
