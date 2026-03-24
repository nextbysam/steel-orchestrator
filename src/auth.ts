/**
 * Auth middleware — solves Steel OSS issue #235 (no auth at all).
 *
 * Self-hosted Steel has zero authentication. Anyone who can reach the port
 * controls your browser. This middleware adds API key auth on all routes.
 */

import type { FastifyRequest, FastifyReply } from "fastify";

export interface AuthConfig {
  /** Valid API keys. Empty array = auth disabled (development mode). */
  apiKeys: string[];
}

/**
 * Extract and validate API key from request.
 * Returns the key if valid, null if auth is disabled, or throws.
 */
export function validateApiKey(
  request: FastifyRequest,
  reply: FastifyReply,
  config: AuthConfig
): string | null {
  // If no API keys configured, auth is disabled (dev mode)
  if (config.apiKeys.length === 0) {
    return "anonymous";
  }

  const auth = request.headers.authorization;

  // Also check query param (for WebSocket connections)
  const queryKey =
    (request.query as Record<string, string | undefined>)?.apiKey ??
    (request.query as Record<string, string | undefined>)?.steelAPIKey;

  const key = auth?.startsWith("Bearer ") ? auth.slice(7) : queryKey;

  if (!key) {
    reply.status(401).send({
      error: "Unauthorized",
      message: "Missing API key. Use Authorization: Bearer <key> header.",
    });
    return null;
  }

  if (!config.apiKeys.includes(key)) {
    reply.status(401).send({
      error: "Unauthorized",
      message: "Invalid API key.",
    });
    return null;
  }

  return key;
}
