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
 * Get device and browser information
 * @returns {Object} Device and browser metadata
 */
function getDeviceInfo() {
  const deviceInfo = {
    // Device category from ChatGPT's userAgent
    device_category: window.openai?.userAgent?.device?.type || 'unknown',
    
    // Screen resolution
    screen_width: window.screen?.width || 0,
    screen_height: window.screen?.height || 0,
    
    // Language
    language: window.openai?.locale || navigator.language || 'en',
    
    // Browser and OS from navigator.userAgent
    browser: 'unknown',
    browser_version: 'unknown',
    os: 'unknown',
    os_version: 'unknown',
  };

  // Parse user agent for browser and OS info
  const ua = navigator.userAgent;
  
  // Browser detection
  if (ua.includes('Chrome') && !ua.includes('Edg')) {
    deviceInfo.browser = 'Chrome';
    const match = ua.match(/Chrome\/(\d+)/);
    if (match) deviceInfo.browser_version = match[1];
  } else if (ua.includes('Firefox')) {
    deviceInfo.browser = 'Firefox';
    const match = ua.match(/Firefox\/(\d+)/);
    if (match) deviceInfo.browser_version = match[1];
  } else if (ua.includes('Safari') && !ua.includes('Chrome')) {
    deviceInfo.browser = 'Safari';
    const match = ua.match(/Version\/(\d+)/);
    if (match) deviceInfo.browser_version = match[1];
  } else if (ua.includes('Edg')) {
    deviceInfo.browser = 'Edge';
    const match = ua.match(/Edg\/(\d+)/);
    if (match) deviceInfo.browser_version = match[1];
  }

  // OS detection
  if (ua.includes('Windows')) {
    deviceInfo.os = 'Windows';
    const match = ua.match(/Windows NT (\d+\.\d+)/);
    if (match) {
      const version = match[1];
      deviceInfo.os_version = version === '10.0' ? '10' : version === '6.3' ? '8.1' : version;
    }
  } else if (ua.includes('Mac OS X') || ua.includes('Macintosh')) {
    deviceInfo.os = 'macOS';
    const match = ua.match(/Mac OS X (\d+[._]\d+)/);
    if (match) deviceInfo.os_version = match[1].replace('_', '.');
  } else if (ua.includes('Linux')) {
    deviceInfo.os = 'Linux';
  } else if (ua.includes('Android')) {
    deviceInfo.os = 'Android';
    const match = ua.match(/Android (\d+\.\d+)/);
    if (match) deviceInfo.os_version = match[1];
  } else if (ua.includes('iPhone') || ua.includes('iPad') || ua.includes('iPod')) {
    deviceInfo.os = 'iOS';
    const match = ua.match(/OS (\d+[._]\d+)/);
    if (match) deviceInfo.os_version = match[1].replace('_', '.');
  }

  return deviceInfo;
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

  // Get device info once per event
  const deviceInfo = getDeviceInfo();

  // Add common parameters to all events
  const eventParams = {
    ...parameters,
    ...deviceInfo, // Include device/browser/OS info
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
  trackEvent('fe_widget_opened', {
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
  trackEvent('fe_audio_loaded', {
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
  trackEvent('fe_file_uploaded', {
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
  trackEvent('fe_audio_exported', {
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
  trackEvent('fe_fade_toggled', {
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
  trackEvent(`fe_audio_${action}`, {
    position: position || 0,
    ...(duration !== undefined && { duration }),
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
  trackEvent('fe_format_changed', {
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
  trackEvent('fe_widget_error', {
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
  trackEvent('fe_vocal_extraction_started', {
    source: source || 'unknown',
  });
}

/**
 * Track BPM detection started event
 * @param {Object} options - Detection options
 * @param {string} options.source - Source (manual/chatgpt_url)
 */
export function trackBPMDetectionStarted({ source }) {
  trackEvent('fe_bpm_detection_started', {
    source: source || 'unknown',
  });
}

/**
 * Track dual track exported event
 * Tracks different events based on which tracks are enabled:
 * - fe_dual_track_exported: Both vocals and music enabled
 * - fe_only_vocal_track_exported: Only vocals enabled
 * - fe_only_music_track_exported: Only music enabled
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
  const vocalsEnabled = vocals_enabled !== undefined ? vocals_enabled : true;
  const musicEnabled = music_enabled !== undefined ? music_enabled : true;

  if (vocalsEnabled && musicEnabled) {
    // Both tracks enabled
    trackEvent('fe_dual_track_exported', {
      format: format || 'unknown',
      duration: duration || 0,
      vocals_enabled: true,
      music_enabled: true,
    });
  } else if (vocalsEnabled && !musicEnabled) {
    // Only vocals enabled
    trackEvent('fe_only_vocal_track_exported', {
      format: format || 'unknown',
      duration: duration || 0,
    });
  } else if (!vocalsEnabled && musicEnabled) {
    // Only music enabled
    trackEvent('fe_only_music_track_exported', {
      format: format || 'unknown',
      duration: duration || 0,
    });
  }
}
