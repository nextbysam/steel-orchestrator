/**
 * Orchestrator configuration — all from environment variables.
 */

export interface OrchestratorConfig {
  /** Port the orchestrator listens on */
  port: number;

  /** Orb Cloud API URL */
  orbApiUrl: string;

  /** Orb Cloud API key */
  orbApiKey: string;

  /** Orb template name for Steel Browser VMs */
  orbTemplate: string;

  /** Comma-separated API keys for authenticating orchestrator users */
  apiKeys: string[];

  /** Max concurrent sessions per API key (0 = unlimited) */
  maxSessionsPerKey: number;

  /** Session inactivity timeout in ms (default: 30 min) */
  sessionTimeoutMs: number;

  /** Warm pool: minimum idle VMs to keep ready */
  warmPoolMin: number;

  /** Warm pool: maximum idle VMs */
  warmPoolMax: number;

  /** Max VM age before recycling (Chrome memory leaks) — ms */
  maxVmAgeMs: number;

  /** Health check interval for active VMs — ms */
  healthCheckIntervalMs: number;

  /** Directory to save session context for persistence */
  contextStorePath: string;
}

export function loadConfig(): OrchestratorConfig {
  const required = (key: string): string => {
    const val = process.env[key];
    if (!val) throw new Error(`Missing required env var: ${key}`);
    return val;
  };

  const optional = (key: string, fallback: string): string =>
    process.env[key] || fallback;

  const optionalInt = (key: string, fallback: number): number => {
    const val = process.env[key];
    return val ? parseInt(val, 10) : fallback;
  };

  return {
    port: optionalInt("PORT", 3000),
    orbApiUrl: optional("ORB_API_URL", "https://api.orbcloud.dev"),
    orbApiKey: optional("ORB_API_KEY", ""),
    orbTemplate: optional("ORB_TEMPLATE", "steel-browser"),
    apiKeys: optional("API_KEYS", "")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean),
    maxSessionsPerKey: optionalInt("MAX_SESSIONS_PER_KEY", 0),
    sessionTimeoutMs: optionalInt("SESSION_TIMEOUT_MS", 30 * 60 * 1000),
    warmPoolMin: optionalInt("WARM_POOL_MIN", 2),
    warmPoolMax: optionalInt("WARM_POOL_MAX", 10),
    maxVmAgeMs: optionalInt("MAX_VM_AGE_MS", 60 * 60 * 1000),
    healthCheckIntervalMs: optionalInt("HEALTH_CHECK_INTERVAL_MS", 30 * 1000),
    contextStorePath: optional("CONTEXT_STORE_PATH", "./data/contexts"),
  };
}
