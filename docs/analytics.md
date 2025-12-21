# Google Analytics 4 (GA4) Event Tracking Documentation

## Overview

This document describes the Google Analytics 4 (GA4) event tracking implementation for the Audio Editor widget. All user interactions and events are tracked to provide insights into user behavior, feature usage, and potential issues.

## Privacy & Compliance

- **No PII Tracking**: No Personally Identifiable Information (PII) is tracked. File names are sanitized to remove extensions and any potentially identifying information.
- **No Audio Content**: Only metadata (duration, format, sample rate, etc.) is tracked. No actual audio content is transmitted.
- **Anonymous Users**: Users are tracked anonymously using GA4's default client ID mechanism.
- **Session-Based**: Sessions are tracked per ChatGPT conversation using sessionStorage.

## Configuration

### Environment Variable

Set the `GOOGLE_ANALYTICS_ID` environment variable with your GA4 Measurement ID (format: `G-XXXXXXXXXX`).

```bash
GOOGLE_ANALYTICS_ID=G-XXXXXXXXXX
```

The GA4 ID is injected into the widget HTML by the server and automatically initialized when the widget loads.

## Session Tracking

### Session ID Generation

- Sessions are tracked per ChatGPT conversation (not per widget instance)
- Session ID format: `chatgpt_session_{timestamp}_{random}`
- Stored in `sessionStorage` with key: `ga4_chatgpt_session_id`
- Persists across multiple widget instances in the same conversation
- Automatically included in all events

### Session Lifecycle

1. **First Widget Open**: New session ID is generated and stored
2. **Subsequent Widget Opens**: Same session ID is reused from sessionStorage
3. **New Conversation**: New session ID is generated (sessionStorage is cleared)

## Event Catalog

### Lifecycle Events

#### `widget_opened`

Triggered when the widget is first opened/mounted.

**Parameters:**
- `mode` (string): Widget mode - `"ringtone"` or `"audio"`
- `platform` (string): Platform detection - `"ios"`, `"android"`, or `"desktop"`

**Example:**
```javascript
{
  mode: "ringtone",
  platform: "ios",
  session_id: "chatgpt_session_1234567890_abc123",
  timestamp: "2024-01-01T12:00:00.000Z"
}
```

#### `audio_loaded`

Triggered when audio is successfully loaded and decoded.

**Parameters:**
- `source` (string): Audio source - `"manual"`, `"drag_drop"`, or `"chatgpt_url"`
- `duration` (number): Audio duration in seconds
- `format` (string): Audio format (e.g., `"mp3"`, `"wav"`, `"m4a"`)
- `sample_rate` (number): Sample rate in Hz
- `channels` (number): Number of audio channels (1 = mono, 2 = stereo)
- `file_size` (number): File size in bytes

**Example:**
```javascript
{
  source: "chatgpt_url",
  duration: 245.3,
  format: "mp3",
  sample_rate: 48000,
  channels: 2,
  file_size: 5888973,
  session_id: "chatgpt_session_1234567890_abc123",
  timestamp: "2024-01-01T12:00:00.000Z"
}
```

#### `widget_error`

Triggered when an error occurs during widget operation.

**Parameters:**
- `error_type` (string): Error category - `"upload"`, `"export"`, or `"load"`
- `error_message` (string): Sanitized error message (no PII)
- `context` (string, optional): JSON stringified additional context

**Example:**
```javascript
{
  error_type: "export",
  error_message: "Server failed to export audio",
  context: '{"format":"mp3","has_audio":true}',
  session_id: "chatgpt_session_1234567890_abc123",
  timestamp: "2024-01-01T12:00:00.000Z"
}
```

### Upload Events

#### `file_uploaded`

Triggered when a file is successfully uploaded (via button or drag-drop).

**Parameters:**
- `upload_method` (string): Upload method - `"button"` or `"drag_drop"`
- `file_type` (string): File MIME type or extension
- `file_size` (number): File size in bytes
- `file_name` (string): Sanitized file name (no extension, no PII)

**Example:**
```javascript
{
  upload_method: "drag_drop",
  file_type: "audio/mpeg",
  file_size: 5888973,
  file_name: "audio-file",
  session_id: "chatgpt_session_1234567890_abc123",
  timestamp: "2024-01-01T12:00:00.000Z"
}
```

**Note:** ChatGPT URL uploads are tracked via `audio_loaded` event with `source: "chatgpt_url"`, not `file_uploaded`.

### Export Events

#### `audio_exported`

Triggered when audio is successfully exported/processed.

**Parameters:**
- `format` (string): Export format - `"mp3"`, `"wav"`, `"flac"`, `"ogg"`, `"m4a"`, `"m4r"`
- `duration` (number): Exported duration in seconds
- `start_trim` (number): Start trim position (0-1 normalized)
- `end_trim` (number): End trim position (0-1 normalized)
- `fade_in_enabled` (boolean): Whether fade in is enabled
- `fade_out_enabled` (boolean): Whether fade out is enabled
- `fade_in_duration` (number): Fade in duration in seconds (0 if disabled)
- `fade_out_duration` (number): Fade out duration in seconds (0 if disabled)
- `source` (string): Audio source - `"manual"` or `"chatgpt_url"`

**Example:**
```javascript
{
  format: "mp3",
  duration: 147.18,
  start_trim: 0.1,
  end_trim: 0.7,
  fade_in_enabled: true,
  fade_out_enabled: true,
  fade_in_duration: 1.5,
  fade_out_duration: 1.5,
  source: "chatgpt_url",
  session_id: "chatgpt_session_1234567890_abc123",
  timestamp: "2024-01-01T12:00:00.000Z"
}
```

### Fade Events

#### `fade_toggled`

Triggered when fade in/out is enabled or disabled.

**Parameters:**
- `fade_type` (string): Fade type - `"in"` or `"out"`
- `enabled` (boolean): Whether fade is enabled
- `duration` (number): Fade duration in seconds (0 if disabled)

**Example:**
```javascript
{
  fade_type: "in",
  enabled: true,
  duration: 1.5,
  session_id: "chatgpt_session_1234567890_abc123",
  timestamp: "2024-01-01T12:00:00.000Z"
}
```

### Playback Events

#### `audio_played`

Triggered when audio playback starts.

**Parameters:**
- `position` (number): Playback start position in seconds
- `duration` (number): Duration of playback segment in seconds

**Example:**
```javascript
{
  position: 24.53,
  duration: 147.18,
  session_id: "chatgpt_session_1234567890_abc123",
  timestamp: "2024-01-01T12:00:00.000Z"
}
```

#### `audio_paused`

Triggered when audio playback is paused.

**Parameters:**
- `position` (number): Current playback position in seconds

**Example:**
```javascript
{
  position: 45.2,
  session_id: "chatgpt_session_1234567890_abc123",
  timestamp: "2024-01-01T12:00:00.000Z"
}
```

#### `audio_seeked`

Triggered when user seeks to a different position in the audio (via waveform click).

**Parameters:**
- `from_position` (number): Previous position in seconds
- `to_position` (number): New position in seconds

**Example:**
```javascript
{
  from_position: 30.0,
  to_position: 60.0,
  session_id: "chatgpt_session_1234567890_abc123",
  timestamp: "2024-01-01T12:00:00.000Z"
}
```

### Format Events

#### `format_changed`

Triggered when the export format is changed.

**Parameters:**
- `old_format` (string): Previous format
- `new_format` (string): New format
- `mode` (string): Widget mode - `"ringtone"` or `"audio"`

**Example:**
```javascript
{
  old_format: "mp3",
  new_format: "wav",
  mode: "audio",
  session_id: "chatgpt_session_1234567890_abc123",
  timestamp: "2024-01-01T12:00:00.000Z"
}
```

## Common Event Parameters

All events automatically include these common parameters:

- `session_id` (string): ChatGPT conversation session ID
- `timestamp` (string): ISO 8601 timestamp of the event

## Implementation Details

### Analytics Utility

The analytics functionality is implemented in `src/widgets/utils/analytics.js`:

- **`initGA4(measurementId)`**: Initializes GA4 with gtag.js
- **`getSessionId()`**: Gets or creates session ID
- **`trackEvent(eventName, parameters)`**: Generic event tracking wrapper
- **Event-specific helpers**: Convenience functions for each event type

### Integration Points

Tracking calls are integrated at key points in `src/widgets/components/audio-editor/audio-editor.jsx`:

1. **Component mount**: `trackWidgetOpened()`
2. **Audio loaded**: `trackAudioLoaded()` after successful decode
3. **File upload**: `trackFileUploaded()` in `processFile()`
4. **Export**: `trackAudioExported()` after successful export
5. **Fade toggles**: `trackFadeToggled()` in fade toggle handlers
6. **Playback**: `trackPlayback()` in play/pause handlers
7. **Format change**: `trackFormatChanged()` in format selector
8. **Errors**: `trackError()` in catch blocks

## Testing & Debugging

### Development Testing

1. **Check GA4 ID Injection**: Verify `window.__GOOGLE_ANALYTICS_ID__` is set in browser console
2. **Check GA4 Initialization**: Look for `[Analytics] GA4 initialized` in console
3. **Check Event Firing**: Use GA4 DebugView or browser Network tab to see events
4. **Check Session ID**: Verify session ID in `sessionStorage.getItem('ga4_chatgpt_session_id')`

### GA4 DebugView

Enable GA4 DebugView in your GA4 property:
1. Go to Admin → DebugView
2. Add your test device/IP
3. Events will appear in real-time

### Browser Console

All analytics operations log to console (when DEBUG is enabled):
- `[Analytics] GA4 initialized with ID: G-XXXXXXXXXX`
- `[Analytics] GA4 ID not found. Analytics disabled.`
- `[Analytics] Error tracking event: ...` (on errors)

### Graceful Degradation

If GA4 ID is not provided or initialization fails:
- Widget continues to function normally
- No errors are thrown
- Events are silently skipped
- Console warnings are logged (when DEBUG is enabled)

## GA4 Dashboard Setup

### Recommended Custom Dimensions

Create custom dimensions in GA4 for better analysis:

1. **Session ID** (Event-scoped): `session_id`
2. **Widget Mode** (Event-scoped): `mode`
3. **Platform** (Event-scoped): `platform`
4. **Audio Format** (Event-scoped): `format`
5. **Audio Source** (Event-scoped): `source`

### Recommended Reports

1. **User Journey**: Track `widget_opened` → `audio_loaded` → `audio_exported`
2. **Format Usage**: Analyze `format_changed` and `audio_exported` events
3. **Error Analysis**: Monitor `widget_error` events by `error_type`
4. **Feature Usage**: Track `fade_toggled`, `audio_played`, `audio_seeked`
5. **Upload Methods**: Compare `file_uploaded` by `upload_method`

### Event Naming Convention

All events use snake_case naming:
- `widget_opened`
- `audio_loaded`
- `file_uploaded`
- `audio_exported`
- `fade_toggled`
- `audio_played`
- `audio_paused`
- `audio_seeked`
- `format_changed`
- `widget_error`

## Troubleshooting

### Events Not Appearing in GA4

1. **Check GA4 ID**: Verify `GOOGLE_ANALYTICS_ID` environment variable is set
2. **Check Network**: Ensure `www.googletagmanager.com` is accessible
3. **Check CSP**: Verify CSP allows `www.googletagmanager.com` (should be handled by ChatGPT)
4. **Check Console**: Look for analytics initialization errors
5. **Check DebugView**: Enable GA4 DebugView to see events in real-time

### Session ID Issues

1. **Check sessionStorage**: Verify sessionStorage is available (required for session tracking)
2. **Check Session Key**: Session ID is stored under `ga4_chatgpt_session_id`
3. **Check Persistence**: Session ID should persist across widget instances in same conversation

### Event Parameter Issues

1. **Check Parameter Types**: Ensure parameters match expected types (string, number, boolean)
2. **Check Required Parameters**: Verify all required parameters are provided
3. **Check Sanitization**: File names are sanitized - verify no PII is included

## Future Enhancements

Potential future enhancements:

1. **User Properties**: Track user preferences (default format, fade settings)
2. **Performance Metrics**: Track audio load time, export time
3. **A/B Testing**: Track feature flag variations
4. **Conversion Funnels**: Define conversion events (e.g., successful export)
5. **Cohort Analysis**: Group users by behavior patterns

## Support

For issues or questions about analytics implementation:

1. Check browser console for errors
2. Verify GA4 ID is correctly configured
3. Test in GA4 DebugView
4. Review this documentation for event definitions

