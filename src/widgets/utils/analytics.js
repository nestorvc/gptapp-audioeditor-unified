/**
 * ANALYTICS.JS - Google Analytics 4 (GA4) Event Tracking
 * 
 * Provides utilities for tracking user interactions and events in the audio editor widget.
 * Handles GA4 initialization, session tracking, and event logging.
 * 
 * Privacy: No PII (Personally Identifiable Information) is tracked.
 * Only metadata and user actions are logged.
 */

// GA4 Measurement ID (injected by server via window.__GOOGLE_ANALYTICS_ID__)
let measurementId = null;
let isInitialized = false;
let gtagLoaded = false;

// Session ID storage key
const SESSION_STORAGE_KEY = 'ga4_chatgpt_session_id';

/**
 * Initialize GA4 with the provided measurement ID
 * @param {string} id - GA4 Measurement ID (G-XXXXXXXXXX)
 */
export function initGA4(id) {
  if (!id || typeof id !== 'string') {
    console.warn('[Analytics] No GA4 measurement ID provided. Analytics disabled.');
    return;
  }

  measurementId = id;

  // Load gtag.js script dynamically
  if (!gtagLoaded) {
    const script = document.createElement('script');
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${id}`;
    document.head.appendChild(script);

    // Initialize gtag
    window.dataLayer = window.dataLayer || [];
    function gtag() {
      window.dataLayer.push(arguments);
    }
    window.gtag = gtag;

    gtag('js', new Date());
    gtag('config', id, {
      send_page_view: false, // We're in an iframe, don't send page views
    });

    gtagLoaded = true;
    isInitialized = true;
    console.log('[Analytics] GA4 initialized with ID:', id);
  }
}

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
 * Track a custom event to GA4
 * @param {string} eventName - Event name (snake_case recommended)
 * @param {Object} parameters - Event parameters
 */
export function trackEvent(eventName, parameters = {}) {
  if (!isInitialized || !window.gtag) {
    // Silently fail if GA4 is not initialized (graceful degradation)
    return;
  }

  if (!eventName || typeof eventName !== 'string') {
    console.warn('[Analytics] Invalid event name:', eventName);
    return;
  }

  // Add common parameters to all events
  const eventParams = {
    ...parameters,
    session_id: getSessionId(),
    timestamp: new Date().toISOString(),
  };

  try {
    window.gtag('event', eventName, eventParams);
  } catch (error) {
    console.warn('[Analytics] Error tracking event:', error);
  }
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
 * Initialize analytics on module load if GA4 ID is available
 * This is called automatically when the module is imported
 */
export function initializeAnalytics() {
  // Check for GA4 ID from window global (injected by server)
  const gaId = typeof window !== 'undefined' && window.__GOOGLE_ANALYTICS_ID__;
  
  if (gaId) {
    initGA4(gaId);
  } else {
    console.log('[Analytics] GA4 ID not found. Analytics disabled.');
  }
}

// Auto-initialize when module loads
if (typeof window !== 'undefined') {
  // Wait for DOM to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeAnalytics);
  } else {
    initializeAnalytics();
  }
}

