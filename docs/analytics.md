# Google Analytics 4 (GA4) Event Tracking Documentation

## Overview

This document describes the Google Analytics 4 (GA4) event tracking implementation for the Audio Editor widget. All user interactions and events are tracked using **server-side tracking** via Google's Measurement Protocol API, which bypasses OpenAI's iframe restrictions that block client-side analytics scripts.

## Architecture

- **Frontend Events**: Widget events are sent from the browser to `/api/analytics/track` endpoint
- **Server-Side Processing**: Events are forwarded to GA4 using Measurement Protocol API
- **MCP Tool Events**: MCP tool invocations are tracked directly from the server

## Privacy & Compliance

- **No PII Tracking**: No Personally Identifiable Information (PII) is tracked. File names are sanitized to remove extensions and any potentially identifying information.
- **No Audio Content**: Only metadata (duration, format, sample rate, etc.) is tracked. No actual audio content is transmitted.
- **Anonymous Users**: Users are tracked anonymously using GA4's client ID mechanism.
- **Session-Based**: Sessions are tracked per ChatGPT conversation using sessionStorage.

## Configuration

### Environment Variables

Set the following environment variables:

```bash
GOOGLE_ANALYTICS_ID=G-XXXXXXXXXX
GOOGLE_ANALYTICS_API_SECRET=your_api_secret  # Optional but recommended
```

The GA4 Measurement ID is required. The API secret is optional but recommended for enhanced measurement and better data quality.

## Event Naming Convention

All events follow a consistent naming convention with prefixes:

- **`fe_`** prefix: Frontend events (widget interactions, user actions in the browser)
- **`mcp_`** prefix: MCP tool events (server-side tool invocations)

### Examples:
- `fe_widget_opened` - Widget opened in browser
- `fe_audio_exported` - Audio exported from widget
- `mcp_tool_invoked` - MCP tool called
- `mcp_tool_success` - MCP tool completed successfully

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

## Common Event Parameters

All events automatically include these common parameters:

- `session_id` (string): ChatGPT conversation session ID
- `timestamp` (string): ISO 8601 timestamp of the event
- `device_category` (string): Device type - `"mobile"`, `"tablet"`, `"desktop"`, or `"unknown"`
- `screen_width` (number): Screen width in pixels
- `screen_height` (number): Screen height in pixels
- `language` (string): Browser/OS language (e.g., `"en"`, `"es"`, `"fr"`)
- `browser` (string): Browser name - `"Chrome"`, `"Firefox"`, `"Safari"`, `"Edge"`, or `"unknown"`
- `browser_version` (string): Browser version number
- `os` (string): Operating system - `"Windows"`, `"macOS"`, `"Linux"`, `"Android"`, `"iOS"`, or `"unknown"`
- `os_version` (string): Operating system version

## Event Catalog

### Frontend Events (fe_)

#### `fe_widget_opened`

Triggered when the widget is first opened/mounted.

**Parameters:**
- `mode` (string): Widget mode - `"ringtone"` or `"audio"`
- `platform` (string): Platform detection - `"ios"`, `"android"`, or `"desktop"`

**Example:**
```javascript
{
  mode: "ringtone",
  platform: "ios",
  device_category: "mobile",
  browser: "Safari",
  os: "iOS",
  session_id: "chatgpt_session_1234567890_abc123",
  timestamp: "2024-01-01T12:00:00.000Z"
}
```

#### `fe_audio_loaded`

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
  device_category: "desktop",
  browser: "Chrome",
  os: "Windows",
  session_id: "chatgpt_session_1234567890_abc123",
  timestamp: "2024-01-01T12:00:00.000Z"
}
```

#### `fe_file_uploaded`

Triggered when a file is successfully uploaded (via button or drag-drop).

**Parameters:**
- `upload_method` (string): Upload method - `"button"` or `"drag_drop"`
- `file_type` (string): File MIME type or extension
- `file_size` (number): File size in bytes
- `file_name` (string): Sanitized file name (no extension, no PII)

**Note:** ChatGPT URL uploads are tracked via `fe_audio_loaded` event with `source: "chatgpt_url"`, not `fe_file_uploaded`.

#### `fe_audio_exported`

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

#### `fe_fade_toggled`

Triggered when fade in/out is enabled or disabled.

**Parameters:**
- `fade_type` (string): Fade type - `"in"` or `"out"`
- `enabled` (boolean): Whether fade is enabled
- `duration` (number): Fade duration in seconds (0 if disabled)

#### `fe_audio_played` / `fe_audio_paused`

Triggered when audio playback starts or pauses.

**Parameters:**
- `position` (number): Playback position in seconds
- `duration` (number): Duration of playback segment in seconds (for played action)

#### `fe_format_changed`

Triggered when the export format is changed.

**Parameters:**
- `old_format` (string): Previous format
- `new_format` (string): New format
- `mode` (string): Widget mode - `"ringtone"` or `"audio"`

#### `fe_widget_error`

Triggered when an error occurs during widget operation.

**Parameters:**
- `error_type` (string): Error category - `"upload"`, `"export"`, or `"load"`
- `error_message` (string): Sanitized error message (no PII)
- `context` (string, optional): JSON stringified additional context

#### `fe_vocal_extraction_started`

Triggered when vocal extraction is initiated from the widget.

**Parameters:**
- `source` (string): Source - `"manual"` or `"chatgpt_url"`

#### `fe_bpm_detection_started`

Triggered when BPM detection is initiated from the widget.

**Parameters:**
- `source` (string): Source - `"manual"` or `"chatgpt_url"`

#### `fe_dual_track_exported`

Triggered when dual track audio is exported with both vocals and music enabled.

**Parameters:**
- `format` (string): Export format
- `duration` (number): Exported duration in seconds
- `vocals_enabled` (boolean): Always `true` for this event
- `music_enabled` (boolean): Always `true` for this event
- `fade_in_enabled` (boolean): Whether fade in is enabled
- `fade_out_enabled` (boolean): Whether fade out is enabled
- `processing_time_ms` (number): Processing time in milliseconds
- `source` (string): Source - `"api"` for server-side processing

#### `fe_only_vocal_track_exported`

Triggered when only the vocal track is exported (music disabled).

**Parameters:**
- `format` (string): Export format
- `duration` (number): Exported duration in seconds
- `fade_in_enabled` (boolean): Whether fade in is enabled
- `fade_out_enabled` (boolean): Whether fade out is enabled
- `processing_time_ms` (number): Processing time in milliseconds
- `source` (string): Source - `"api"` for server-side processing

#### `fe_only_music_track_exported`

Triggered when only the music track is exported (vocals disabled).

**Parameters:**
- `format` (string): Export format
- `duration` (number): Exported duration in seconds
- `fade_in_enabled` (boolean): Whether fade in is enabled
- `fade_out_enabled` (boolean): Whether fade out is enabled
- `processing_time_ms` (number): Processing time in milliseconds
- `source` (string): Source - `"api"` for server-side processing

#### `fe_vocal_extraction_completed`

Triggered when vocal extraction completes successfully (server-side API).

**Parameters:**
- `vocals_file_name` (string): Vocals file name
- `music_file_name` (string): Music file name
- `processing_time_ms` (number): Processing time in milliseconds
- `source` (string): Source - `"api"`

#### `fe_vocal_extraction_error`

Triggered when vocal extraction fails (server-side API).

**Parameters:**
- `error_type` (string): Error type - `"extraction_failed"`
- `error_message` (string): Error message
- `source` (string): Source - `"api"`

#### `fe_bpm_detection_completed`

Triggered when BPM detection completes successfully (server-side API).

**Parameters:**
- `bpm` (number|null): Detected BPM
- `key` (string|null): Detected musical key
- `processing_time_ms` (number): Processing time in milliseconds
- `source` (string): Source - `"api"`

#### `fe_bpm_detection_error`

Triggered when BPM detection fails (server-side API).

**Parameters:**
- `error_type` (string): Error type - `"detection_failed"`
- `error_message` (string): Error message
- `processing_time_ms` (number): Processing time in milliseconds
- `source` (string): Source - `"api"`

### MCP Tool Events (mcp_)

#### `mcp_tool_invoked`

Triggered when any MCP tool is invoked (both UI and non-UI tools).

**Parameters:**
- `tool_name` (string): Name of the MCP tool (e.g., `"audio.open_audio_editor"`, `"audio.convert_to_mp3"`)
- Additional tool-specific parameters

**Example:**
```javascript
{
  tool_name: "audio.convert_to_mp3",
  has_audio_url: true,
  has_track_name: false,
  format: "mp3",
  device_category: "desktop",
  browser: "Chrome",
  os: "Windows",
  session_id: "mcp_1234567890_abc123",
  timestamp: "2024-01-01T12:00:00.000Z"
}
```

#### `mcp_tool_success`

Triggered when an MCP tool completes successfully.

**Parameters:**
- `tool_name` (string): Name of the MCP tool
- `result_format` (string): Result format (if applicable)
- `file_name` (string): Result file name (if applicable)
- `processing_time_ms` (number): Processing time in milliseconds
- Additional result-specific parameters

#### `mcp_tool_error`

Triggered when an MCP tool fails.

**Parameters:**
- `tool_name` (string): Name of the MCP tool
- `error_type` (string): Error type
- `error_message` (string): Error message

### MCP-Specific Events (for tools without UI templates)

These events are triggered for MCP tools that **don't use UI templates** (direct operations without opening the widget). Tools with UI templates (`audio.open_audio_editor`, `audio.open_ringtone_editor`) only trigger `mcp_tool_invoked` but not these specific events.

#### `mcp_bpm_detection_started`

Triggered when BPM detection is initiated via MCP tool (no UI).

**Parameters:**
- `tool_name` (string): Always `"audio.detect_bpm_and_key"`
- `has_audio_file` (boolean): Whether audio file was provided
- `has_audio_url` (boolean): Whether audio URL was provided

#### `mcp_vocal_extraction_started`

Triggered when vocal extraction/separation is initiated via MCP tool (no UI).

**Parameters:**
- `tool_name` (string): One of `"audio.separate_voice_from_music"`, `"audio.remove_vocals"`, or `"audio.extract_vocals"`
- `has_audio_file` (boolean): Whether audio file was provided
- `has_audio_url` (boolean): Whether audio URL was provided
- `has_track_name` (boolean): Whether track name was provided

#### `mcp_audio_conversion_started`

Triggered when audio format conversion is initiated via MCP tool (no UI).

**Parameters:**
- `tool_name` (string): One of `"audio.convert_to_mp3"`, `"audio.convert_to_wav"`, `"audio.convert_to_flac"`, `"audio.convert_to_ogg"`, `"audio.convert_to_m4a"`, or `"audio.convert_to_m4r"`
- `has_audio_url` (boolean): Whether audio URL was provided
- `has_track_name` (boolean): Whether track name was provided
- `format` (string): Target format

#### `mcp_audio_trim_started`

Triggered when audio trimming is initiated via MCP tool (no UI).

**Parameters:**
- `tool_name` (string): One of `"audio.trim_start_of_audio"` or `"audio.trim_end_of_audio"`
- `has_audio_url` (boolean): Whether audio URL was provided
- `has_track_name` (boolean): Whether track name was provided
- `format` (string): Target format

#### `mcp_download_notification_sent`

Triggered when download link notification is sent via MCP tool.

**Parameters:**
- `tool_name` (string): Always `"audio.notify_download_link_ready"`
- `has_download_url` (boolean): Whether download URL was provided
- `has_file_name` (boolean): Whether file name was provided
- `format` (string|null): Export format (if provided)

### MCP Tools Tracked

The following MCP tools are tracked:

**Tools with UI Templates** (only trigger `mcp_tool_invoked`):
- `audio.open_audio_editor` - Opens audio editor widget
- `audio.open_ringtone_editor` - Opens ringtone editor widget

**Tools without UI Templates** (trigger both `mcp_tool_invoked` and specific MCP events):
- `audio.convert_to_mp3` - Converts audio to MP3 → triggers `mcp_audio_conversion_started`
- `audio.convert_to_wav` - Converts audio to WAV → triggers `mcp_audio_conversion_started`
- `audio.convert_to_flac` - Converts audio to FLAC → triggers `mcp_audio_conversion_started`
- `audio.convert_to_ogg` - Converts audio to OGG → triggers `mcp_audio_conversion_started`
- `audio.convert_to_m4a` - Converts audio to M4A → triggers `mcp_audio_conversion_started`
- `audio.convert_to_m4r` - Converts audio to M4R → triggers `mcp_audio_conversion_started`
- `audio.trim_start_of_audio` - Trims first 30 seconds → triggers `mcp_audio_trim_started`
- `audio.trim_end_of_audio` - Trims last 30 seconds → triggers `mcp_audio_trim_started`
- `audio.separate_voice_from_music` - Separates vocals from music → triggers `mcp_vocal_extraction_started`
- `audio.remove_vocals` - Removes vocals → triggers `mcp_vocal_extraction_started`
- `audio.extract_vocals` - Extracts vocals → triggers `mcp_vocal_extraction_started`
- `audio.detect_bpm_and_key` - Detects BPM and key → triggers `mcp_bpm_detection_started`
- `audio.notify_download_link_ready` - Notifies download link → triggers `mcp_download_notification_sent`

## Implementation Details

### Server-Side Tracking

Events are sent to GA4 using Google's Measurement Protocol API (`https://www.google-analytics.com/mp/collect`). This bypasses OpenAI's iframe restrictions that block client-side analytics scripts.

**Flow:**
1. Frontend widget calls `trackEvent()` → sends to `/api/analytics/track`
2. Server receives event → forwards to GA4 Measurement Protocol API
3. GA4 processes event → appears in reports

### Analytics Utility

The analytics functionality is implemented in:

- **`src/widgets/utils/analytics.js`**: Frontend event tracking
  - `getDeviceInfo()`: Collects device/browser/OS information
  - `getSessionId()`: Gets or creates session ID
  - `trackEvent(eventName, parameters)`: Generic event tracking wrapper
  - Event-specific helpers: Convenience functions for each event type

- **`src/server/services/analytics.ts`**: Server-side GA4 service
  - `trackWidgetEvent()`: Tracks frontend events
  - `trackMCPTool()`: Tracks MCP tool invocations
  - `sendGA4Event()`: Core GA4 Measurement Protocol implementation

- **`src/server/index.ts`**: Analytics API endpoint
  - `POST /api/analytics/track`: Accepts events from frontend

### Integration Points

Tracking calls are integrated at key points:

**Frontend (`src/widgets/components/audio-editor/audio-editor.jsx`):**
1. Component mount: `trackWidgetOpened()`
2. Audio loaded: `trackAudioLoaded()` after successful decode
3. File upload: `trackFileUploaded()` in `processFile()`
4. Export: `trackAudioExported()` after successful export
5. Fade toggles: `trackFadeToggled()` in fade toggle handlers
6. Playback: `trackPlayback()` in play/pause handlers
7. Format change: `trackFormatChanged()` in format selector
8. Errors: `trackError()` in catch blocks
9. Vocal extraction: `trackVocalExtractionStarted()`
10. BPM detection: `trackBPMDetectionStarted()`
11. Dual track export: `trackDualTrackExported()` (tracks `fe_dual_track_exported`, `fe_only_vocal_track_exported`, or `fe_only_music_track_exported` based on enabled tracks)

**Note:** `fe_audio_seeked` event has been removed due to high frequency (triggered on every waveform click).

**Server (`src/server/create-server.ts`):**
- All MCP tool handlers include `trackMCPTool()` calls

**API Endpoints (`src/server/index.ts`):**
- `/api/detect-bpm-key`: Tracks `fe_bpm_detection_completed` / `fe_bpm_detection_error`
- `/api/extract-vocals`: Tracks `fe_vocal_extraction_completed` / `fe_vocal_extraction_error`
- `/api/audio-process`: Tracks `fe_dual_track_exported`

## Testing & Debugging

### Development Testing

1. **Check Server Logs**: Look for `[Analytics]` log messages
2. **Check GA4 ID**: Verify `GOOGLE_ANALYTICS_ID` environment variable is set
3. **Check Event Firing**: Use GA4 DebugView or check server logs
4. **Check Session ID**: Verify session ID in `sessionStorage.getItem('ga4_chatgpt_session_id')`

### GA4 DebugView

Enable GA4 DebugView in your GA4 property:
1. Go to Admin → DebugView
2. Add your test device/IP
3. Events will appear in real-time

### Server Logs

All analytics operations log to server console:
- `[Analytics] GA4 configured:` - Shows GA4 configuration at startup
- `[Analytics] Received event from frontend:` - Shows events received from widget
- `[Analytics] Sending event to GA4:` - Shows events being sent to GA4
- `[Analytics] Event sent successfully:` - Confirms successful GA4 API calls
- `[Analytics] GA4 API error:` - Shows GA4 API errors

### Graceful Degradation

If GA4 ID is not provided or initialization fails:
- Widget continues to function normally
- No errors are thrown
- Events are silently skipped
- Console warnings are logged

## GA4 Dashboard Setup

### Recommended Custom Dimensions

Create custom dimensions in GA4 for better analysis:

1. **Session ID** (Event-scoped): `session_id`
2. **Widget Mode** (Event-scoped): `mode`
3. **Platform** (Event-scoped): `platform`
4. **Audio Format** (Event-scoped): `format`
5. **Audio Source** (Event-scoped): `source`
6. **Device Category** (Event-scoped): `device_category`
7. **Browser** (Event-scoped): `browser`
8. **OS** (Event-scoped): `os`
9. **Language** (Event-scoped): `language`
10. **Tool Name** (Event-scoped): `tool_name` (for MCP events)

### Recommended Reports

1. **User Journey**: Track `fe_widget_opened` → `fe_audio_loaded` → `fe_audio_exported`
2. **Format Usage**: Analyze `fe_format_changed` and `fe_audio_exported` events
3. **Error Analysis**: Monitor `fe_widget_error` events by `error_type`
4. **Feature Usage**: Track `fe_fade_toggled`, `fe_audio_played` events
5. **Upload Methods**: Compare `fe_file_uploaded` by `upload_method`
6. **MCP Tool Usage**: Analyze `mcp_tool_invoked` and `mcp_tool_success` events
7. **MCP-Specific Operations**: Track `mcp_bpm_detection_started`, `mcp_vocal_extraction_started`, `mcp_audio_conversion_started`, etc.
8. **Dual Track Usage**: Compare `fe_dual_track_exported`, `fe_only_vocal_track_exported`, and `fe_only_music_track_exported`
9. **Device Analytics**: Analyze usage by `device_category`, `browser`, `os`
10. **Performance**: Track `processing_time_ms` for server-side operations

## Troubleshooting

### Events Not Appearing in GA4

1. **Check GA4 ID**: Verify `GOOGLE_ANALYTICS_ID` environment variable is set
2. **Check API Secret**: Verify `GOOGLE_ANALYTICS_API_SECRET` is set (optional but recommended)
3. **Check Server Logs**: Look for `[Analytics]` messages in server logs
4. **Check GA4 API**: Verify events are being sent (check server logs for GA4 API responses)
5. **Check DebugView**: Enable GA4 DebugView to see events in real-time
6. **Check Event Names**: Verify event names match expected format (`fe_` or `mcp_` prefix)

### Session ID Issues

1. **Check sessionStorage**: Verify sessionStorage is available (required for session tracking)
2. **Check Session Key**: Session ID is stored under `ga4_chatgpt_session_id`
3. **Check Persistence**: Session ID should persist across widget instances in same conversation

### Event Parameter Issues

1. **Check Parameter Types**: Ensure parameters match expected types (string, number, boolean)
2. **Check Required Parameters**: Verify all required parameters are provided
3. **Check Sanitization**: File names are sanitized - verify no PII is included
4. **Check Device Info**: Verify device/browser/OS info is being captured (check event parameters)

## Future Enhancements

Potential future enhancements:

1. **User Properties**: Track user preferences (default format, fade settings)
2. **Performance Metrics**: Track audio load time, export time
3. **A/B Testing**: Track feature flag variations
4. **Conversion Funnels**: Define conversion events (e.g., successful export)
5. **Cohort Analysis**: Group users by behavior patterns
6. **Geographic Data**: Add country/region tracking (requires IP geolocation service)

## Support

For issues or questions about analytics implementation:

1. Check server logs for `[Analytics]` messages
2. Verify GA4 ID is correctly configured
3. Test in GA4 DebugView
4. Review this documentation for event definitions
5. Check event naming convention (`fe_` vs `mcp_` prefixes)
