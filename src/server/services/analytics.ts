/**
 * ANALYTICS.TS - Google Analytics 4 (GA4) Measurement Protocol Service
 * 
 * Server-side GA4 event tracking using Google's Measurement Protocol API.
 * Sends events from both widget frontend and MCP tool invocations to GA4.
 * 
 * Privacy: No PII (Personally Identifiable Information) is tracked.
 * Only metadata and user actions are logged.
 */

import { randomUUID } from "node:crypto";

const GA4_MEASUREMENT_ID = process.env.GOOGLE_ANALYTICS_ID;
const GA4_API_SECRET = process.env.GOOGLE_ANALYTICS_API_SECRET; // Optional, for enhanced measurement
const GA4_ENDPOINT = "https://www.google-analytics.com/mp/collect";

// In-memory client ID storage (for server-side tracking)
// In production, consider using Redis or a database for persistence
const clientIdCache = new Map<string, string>();

/**
 * Generate a persistent client ID for GA4
 * Format: {timestamp}.{random}
 */
function generateClientId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 15);
  return `${timestamp}.${random}`;
}

/**
 * Get or generate a client ID for a session
 */
function getClientId(sessionId: string): string {
  if (!sessionId) {
    return generateClientId();
  }
  
  if (!clientIdCache.has(sessionId)) {
    clientIdCache.set(sessionId, generateClientId());
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
    return;
  }

  if (!eventName || typeof eventName !== "string") {
    console.warn("[Analytics] Invalid event name:", eventName);
    return;
  }

  // Build GA4 event payload
  const payload: any = {
    client_id: clientId,
    events: [
      {
        name: eventName,
        params: {
          ...parameters,
          ...(sessionId && { session_id: sessionId }),
          timestamp_micros: Date.now() * 1000, // GA4 expects microseconds
        },
      },
    ],
  };

  // Build URL with measurement ID
  const url = `${GA4_ENDPOINT}?measurement_id=${GA4_MEASUREMENT_ID}${GA4_API_SECRET ? `&api_secret=${GA4_API_SECRET}` : ""}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.warn(`[Analytics] GA4 API error (${response.status}):`, errorText);
    }
  } catch (error) {
    console.warn("[Analytics] Error sending event to GA4:", error);
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

  // Track tool invocation
  await sendGA4Event(
    "mcp_tool_invoked",
    {
      tool_name: toolName,
      ...params,
    },
    clientId,
    sessionId
  );

  // Track success/failure if result provided
  if (result) {
    if (result.success) {
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
    } else {
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

