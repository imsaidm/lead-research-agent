/** Static limits and defaults. Everything security-relevant lives here. */
export const TOOL_NAME = 'LeadResearchAgent';
export const TOOL_VERSION = '0.1.0';

export const FETCH_LIMITS = Object.freeze({
  timeoutMs: 8_000,
  maxBytes: 1_500_000,
  maxRedirects: 3,
  robotsMaxBytes: 500_000,
  probeMaxBytes: 64_000,
  websiteConcurrency: 2,
  allowedPorts: Object.freeze([80, 443]) as readonly number[],
});

export const OSM_LIMITS = Object.freeze({
  nominatimUrl: 'https://nominatim.openstreetmap.org/search',
  overpassUrl: 'https://overpass-api.de/api/interpreter',
  nominatimMinIntervalMs: 1_000,
  overpassTimeoutSec: 25,
  httpTimeoutMs: 40_000,
  maxResponseBytes: 10_000_000,
  /** City bounding boxes larger than this (degrees) fall back to a radius search. */
  maxBboxSpanDeg: 1.0,
  fallbackRadiusM: 20_000,
});

export const AGENT_DEFAULTS = Object.freeze({
  model: 'claude-haiku-4-5-20251001',
  maxSteps: 20,
  budgetUsd: 0.5,
  maxDrafts: 5,
  limit: 15,
  agentMaxTokens: 2_048,
  draftMaxTokens: 1_024,
});

export const OSM_ATTRIBUTION =
  'Business data © OpenStreetMap contributors, available under the Open Database License (ODbL): https://www.openstreetmap.org/copyright';

export function userAgent(contact: string | null): string {
  return `${TOOL_NAME}/${TOOL_VERSION} (lead research tool; ${contact ? `contact: ${contact}` : 'contact not configured'})`;
}
