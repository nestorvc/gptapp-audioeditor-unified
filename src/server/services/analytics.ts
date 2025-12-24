/**
 * ANALYTICS.TS - Google Analytics 4 (GA4) Measurement Protocol Service
 * 
 * Server-side GA4 event tracking using Google's Measurement Protocol API.
 * Sends events from both widget frontend and MCP tool invocations to GA4.
 * 
 * Privacy: No PII (Personally Identifiable Information) is tracked.
 * Only metadata and user actions are logged.
 */

import { randomUUID, createHash } from "node:crypto";

const GA4_MEASUREMENT_ID = process.env.GOOGLE_ANALYTICS_ID;
const GA4_API_SECRET = process.env.GOOGLE_ANALYTICS_API_SECRET; // Optional, for enhanced measurement
const GA4_ENDPOINT = "https://www.google-analytics.com/mp/collect";

// Log GA4 configuration at startup
if (GA4_MEASUREMENT_ID) {
  console.log("[Analytics] GA4 configured:", {
    measurementId: GA4_MEASUREMENT_ID,
    hasApiSecret: !!GA4_API_SECRET,
    endpoint: GA4_ENDPOINT,
  });
  if (!GA4_API_SECRET) {
    console.warn("[Analytics] GOOGLE_ANALYTICS_API_SECRET not set. Consider setting it for enhanced measurement.");
  }
} else {
  console.warn("[Analytics] GOOGLE_ANALYTICS_ID not set. Analytics tracking disabled.");
}

// In-memory client ID storage (for server-side tracking)
// Cache is used for performance, but client IDs are deterministic based on sessionId
const clientIdCache = new Map<string, string>();

/**
 * Generate a random client ID for GA4
 * Format: {timestamp}.{random}
 * Used when no sessionId is available
 */
function generateClientId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 15);
  return `${timestamp}.${random}`;
}

/**
 * Generate a stable client ID from sessionId
 * This ensures the same sessionId always gets the same clientId,
 * even after server restarts, improving unique user tracking accuracy.
 * Format: {timestamp}.{hash}
 */
function generateStableClientId(sessionId: string): string {
  // Extract timestamp from sessionId if available (for better GA4 compatibility)
  // Session IDs typically have format:
  // - chatgpt_session_{timestamp}_{random} (ChatGPT)
  // - mcp_session_{timestamp}_{random} (other MCP clients)
  // - openai/widgetSessionId (which is a UUID from ChatGPT)
  const timestampMatch = sessionId.match(/\d{10,13}/);
  const baseTimestamp = timestampMatch ? timestampMatch[0].substring(0, 13) : Date.now().toString();
  
  // Create a deterministic hash from sessionId
  const hash = createHash('sha256').update(sessionId).digest('hex');
  // Use first 10 characters of hash for uniqueness
  const hashSuffix = hash.substring(0, 10);
  
  // Format: {timestamp}.{hash} - matches GA4 client_id format
  return `${baseTimestamp}.${hashSuffix}`;
}

/**
 * Get or generate a client ID for a session
 * Uses stable client ID generation to ensure same sessionId = same clientId
 * even after server restarts, improving unique user tracking accuracy.
 */
function getClientId(sessionId: string): string {
  if (!sessionId) {
    return generateClientId();
  }
  
  // Check cache first (for performance)
  if (!clientIdCache.has(sessionId)) {
    // Generate stable client ID that persists across server restarts
    clientIdCache.set(sessionId, generateStableClientId(sessionId));
  }
  
  return clientIdCache.get(sessionId)!;
}

/**
 * Send an event to GA4 using Measurement Protocol
 */
async function sendGA4Event(
  eventName: string,
  parameters: Record<string, any> = {},
  clientId: string,
  sessionId?: string
): Promise<void> {
  if (!GA4_MEASUREMENT_ID) {
    console.warn("[Analytics] GA4_MEASUREMENT_ID not set. Event not tracked:", eventName);
    console.warn("[Analytics] Set GOOGLE_ANALYTICS_ID environment variable to enable tracking.");
    return;
  }

  if (!eventName || typeof eventName !== "string") {
    console.warn("[Analytics] Invalid event name:", eventName);
    return;
  }

  // Build GA4 event payload
  // GA4 Measurement Protocol format: https://developers.google.com/analytics/devguides/collection/protocol/ga4
  const payload: any = {
    client_id: clientId,
    events: [
      {
        name: eventName,
        params: {
          ...parameters,
          ...(sessionId && { session_id: sessionId }),
          // GA4 expects timestamp_micros as a string representing microseconds since Unix epoch
          timestamp_micros: String(Date.now() * 1000),
        },
      },
    ],
  };

  // Build URL with measurement ID
  // Note: API secret is optional but recommended for server-side tracking
  const url = `${GA4_ENDPOINT}?measurement_id=${GA4_MEASUREMENT_ID}${GA4_API_SECRET ? `&api_secret=${GA4_API_SECRET}` : ""}`;

  try {
    console.log("[Analytics] Sending event to GA4:", {
      eventName,
      measurementId: GA4_MEASUREMENT_ID,
      hasApiSecret: !!GA4_API_SECRET,
      url: url.replace(GA4_API_SECRET || "", "[REDACTED]"),
      clientId,
      sessionId,
    });

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const responseText = await response.text();

    if (!response.ok) {
      console.error(`[Analytics] GA4 API error (${response.status}):`, responseText);
      console.error("[Analytics] Request payload:", JSON.stringify(payload, null, 2));
    } else {
      console.log(`[Analytics] Event sent successfully: ${eventName} (Status: ${response.status})`);
      if (responseText) {
        console.log("[Analytics] GA4 response:", responseText);
      }
    }
  } catch (error) {
    console.error("[Analytics] Error sending event to GA4:", error);
    if (error instanceof Error) {
      console.error("[Analytics] Error details:", error.message, error.stack);
    }
  }
}

/**
 * Track a widget event from the frontend
 */
export async function trackWidgetEvent(
  eventName: string,
  parameters: Record<string, any> = {},
  sessionId?: string
): Promise<void> {
  if (!GA4_MEASUREMENT_ID) {
    return;
  }

  const clientId = sessionId ? getClientId(sessionId) : generateClientId();
  await sendGA4Event(eventName, parameters, clientId, sessionId);
}

/**
 * Get MCP-specific event name for tools that don't use UI templates
 */
function getMCPSpecificEventName(toolName: string): string | null {
  // Tools that use UI templates don't get specific events
  if (toolName === "audio.open_audio_editor" || toolName === "audio.open_ringtone_editor") {
    return null;
  }

  // Map tool names to specific MCP events
  if (toolName === "audio.detect_bpm_and_key") {
    return "mcp_bpm_detection_started";
  }
  if (toolName === "audio.separate_voice_from_music" || 
      toolName === "audio.remove_vocals" || 
      toolName === "audio.extract_vocals") {
    return "mcp_vocal_extraction_started";
  }
  if (toolName === "audio.convert" || toolName.startsWith("audio.convert_to_")) {
    return "mcp_audio_conversion_started";
  }
  if (toolName === "audio.trim_start_of_audio" || toolName === "audio.trim_end_of_audio") {
    return "mcp_audio_trim_started";
  }
  if (toolName === "audio.notify_download_link_ready") {
    return "mcp_download_notification_sent";
  }

  return null;
}

/**
 * Track an MCP tool invocation
 */
export async function trackMCPTool(
  toolName: string,
  params: Record<string, any> = {},
  result?: { success: boolean; error?: string; [key: string]: any }
): Promise<void> {
  if (!GA4_MEASUREMENT_ID) {
    return;
  }

  const clientId = generateClientId();
  const sessionId = params.session_id || `mcp_${Date.now()}_${randomUUID()}`;

  // Track tool invocation (always)
  await sendGA4Event(
    "mcp_tool_invoked",
    {
      tool_name: toolName,
      ...params,
    },
    clientId,
    sessionId
  );

  // Track MCP-specific event for tools that don't use UI templates
  const mcpSpecificEvent = getMCPSpecificEventName(toolName);
  if (mcpSpecificEvent) {
    await sendGA4Event(
      mcpSpecificEvent,
      {
        tool_name: toolName,
        ...params,
      },
      clientId,
      sessionId
    );
  }

  // Track success/failure if result provided
  if (result) {
    // Explicitly check for boolean true to avoid falsy value issues
    if (result.success === true) {
      await sendGA4Event(
        "mcp_tool_success",
        {
          tool_name: toolName,
          ...Object.fromEntries(
            Object.entries(result).filter(([key]) => key !== "success" && key !== "error")
          ),
        },
        clientId,
        sessionId
      );
    } else if (result.success === false) {
      await sendGA4Event(
        "mcp_tool_error",
        {
          tool_name: toolName,
          error_type: result.error || "unknown",
          error_message: result.error || "Unknown error",
        },
        clientId,
        sessionId
      );
    } else {
      // Log warning if success is not explicitly true or false
      console.warn("[Analytics] trackMCPTool called with invalid result.success value:", {
        toolName,
        success: result.success,
        resultType: typeof result.success,
      });
    }
  }
}

/**
 * Track a custom event (for server-side use)
 */
export async function trackEvent(
  eventName: string,
  parameters: Record<string, any> = {},
  sessionId?: string
): Promise<void> {
  await trackWidgetEvent(eventName, parameters, sessionId);
}

