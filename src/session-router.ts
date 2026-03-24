/**
 * SessionRouter — the core of the orchestrator.
 *
 * Maps session IDs to Orb VMs. Each session gets its own VM with its own
 * Chrome instance. This is what Steel OSS is missing (issue #263).
 *
 * Responsibilities:
 * - Create sessions (provision VM or take from warm pool)
 * - Route requests to the correct VM
 * - Release sessions (save context, destroy VM)
 * - Track sessions per API key
 * - Enforce per-key session limits
 * - Auto-cleanup timed-out sessions
 */

import { OrbClient, type OrbVM } from "./orb-client";
import { WarmPool } from "./warm-pool";
import { ContextStore } from "./context-store";
import type { OrchestratorConfig } from "./config";

export interface SessionEntry {
  sessionId: string;
  apiKey: string;
  vmId: string;
  vmUrl: string;
  createdAt: Date;
  lastActivity: Date;
  status: "provisioning" | "active" | "releasing" | "dead";
}

export interface CreateSessionOptions {
  sessionId?: string;
  apiKey: string;
  /** Restore context from a previously saved session */
  restoreSessionId?: string;
  /** Raw Steel session create body (proxy, fingerprint, etc.) */
  steelOptions?: Record<string, unknown>;
}

export interface SessionStats {
  totalActive: number;
  totalProvisioning: number;
  totalReleasing: number;
  byApiKey: Record<string, number>;
}

export class SessionRouter {
  private sessions = new Map<string, SessionEntry>();
  private orbClient: OrbClient;
  private warmPool: WarmPool;
  private contextStore: ContextStore;
  private config: OrchestratorConfig;
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private healthInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    orbClient: OrbClient,
    warmPool: WarmPool,
    contextStore: ContextStore,
    config: OrchestratorConfig
  ) {
    this.orbClient = orbClient;
    this.warmPool = warmPool;
    this.contextStore = contextStore;
    this.config = config;
  }

  /**
   * Start background tasks: session cleanup and VM health checks.
   */
  start(): void {
    this.cleanupInterval = setInterval(
      () => this.cleanupExpiredSessions(),
      30_000
    );
    this.healthInterval = setInterval(
      () => this.healthCheckActiveSessions(),
      this.config.healthCheckIntervalMs
    );
  }

  /**
   * Stop background tasks.
   */
  stop(): void {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    if (this.healthInterval) clearInterval(this.healthInterval);
  }

  /**
   * Create a new session. Provisions an Orb VM (or takes from warm pool),
   * forwards the session create to Steel, stores the mapping.
   */
  async createSession(
    options: CreateSessionOptions
  ): Promise<{ session: SessionEntry; steelResponse: unknown }> {
    const { apiKey, steelOptions = {} } = options;

    // Enforce per-key session limit
    if (this.config.maxSessionsPerKey > 0) {
      const count = this.countByApiKey(apiKey);
      if (count >= this.config.maxSessionsPerKey) {
        throw new SessionLimitError(
          `API key has ${count} active sessions (limit: ${this.config.maxSessionsPerKey})`
        );
      }
    }

    const sessionId = options.sessionId || crypto.randomUUID();

    // Register early as "provisioning"
    const entry: SessionEntry = {
      sessionId,
      apiKey,
      vmId: "",
      vmUrl: "",
      createdAt: new Date(),
      lastActivity: new Date(),
      status: "provisioning",
    };
    this.sessions.set(sessionId, entry);

    try {
      // Get a VM — warm pool first, then cold provision
      let vm: OrbVM;
      const poolVm = this.warmPool.take();
      if (poolVm) {
        vm = poolVm;
      } else {
        vm = await this.orbClient.createVM();
        await this.orbClient.waitForReady(vm);
      }

      entry.vmId = vm.id;
      entry.vmUrl = vm.url;

      // Build Steel session create body
      const steelBody: Record<string, unknown> = {
        ...steelOptions,
        sessionId,
      };

      // If restoring a previous session, load and inject context
      if (options.restoreSessionId) {
        const savedContext = await this.contextStore.load(
          options.restoreSessionId
        );
        if (savedContext) {
          steelBody.sessionContext = savedContext;
        }
      }

      // Forward session create to Steel inside the VM
      const steelRes = await fetch(`${vm.url}/v1/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(steelBody),
      });

      if (!steelRes.ok) {
        const errBody = await steelRes.text();
        throw new Error(`Steel session create failed (${steelRes.status}): ${errBody}`);
      }

      const steelData = await steelRes.json();
      entry.status = "active";
      entry.lastActivity = new Date();

      return { session: entry, steelResponse: steelData };
    } catch (err) {
      // Clean up on failure
      this.sessions.delete(sessionId);
      if (entry.vmId) {
        await this.orbClient.destroyVM(entry.vmId).catch(() => {});
      }
      throw err;
    }
  }

  /**
   * Get the VM URL for a session. Updates last activity.
   * Returns null if session doesn't exist.
   */
  route(sessionId: string): SessionEntry | null {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.status === "releasing" || entry.status === "dead") {
      return null;
    }
    entry.lastActivity = new Date();
    return entry;
  }

  /**
   * Release a session. Saves context, forwards release to Steel,
   * destroys the VM, removes the mapping.
   */
  async releaseSession(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new SessionNotFoundError(sessionId);

    entry.status = "releasing";

    // Save context before destroying
    try {
      const contextRes = await fetch(
        `${entry.vmUrl}/v1/sessions/${sessionId}/context`,
        { signal: AbortSignal.timeout(10_000) }
      );
      if (contextRes.ok) {
        const context = await contextRes.json();
        await this.contextStore.save(sessionId, context);
      }
    } catch {
      // Context save is best-effort — don't block release
    }

    // Forward release to Steel
    try {
      await fetch(`${entry.vmUrl}/v1/sessions/${sessionId}/release`, {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // VM might already be dead — that's fine
    }

    // Destroy the Orb VM
    await this.orbClient.destroyVM(entry.vmId).catch(() => {});

    // Clean up mapping
    this.sessions.delete(sessionId);
  }

  /**
   * List all sessions for a given API key.
   */
  listByApiKey(apiKey: string): SessionEntry[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.apiKey === apiKey
    );
  }

  /**
   * Get session stats for health endpoint.
   */
  stats(): SessionStats {
    const byApiKey: Record<string, number> = {};
    let totalActive = 0;
    let totalProvisioning = 0;
    let totalReleasing = 0;

    for (const entry of this.sessions.values()) {
      switch (entry.status) {
        case "active":
          totalActive++;
          break;
        case "provisioning":
          totalProvisioning++;
          break;
        case "releasing":
          totalReleasing++;
          break;
      }

      if (entry.status === "active" || entry.status === "provisioning") {
        byApiKey[entry.apiKey] = (byApiKey[entry.apiKey] || 0) + 1;
      }
    }

    return { totalActive, totalProvisioning, totalReleasing, byApiKey };
  }

  /**
   * Count active sessions for an API key.
   */
  private countByApiKey(apiKey: string): number {
    let count = 0;
    for (const entry of this.sessions.values()) {
      if (
        entry.apiKey === apiKey &&
        (entry.status === "active" || entry.status === "provisioning")
      ) {
        count++;
      }
    }
    return count;
  }

  /**
   * Clean up sessions that have exceeded the inactivity timeout.
   */
  private async cleanupExpiredSessions(): Promise<void> {
    const now = Date.now();

    for (const [sessionId, entry] of this.sessions) {
      if (entry.status !== "active") continue;

      const inactive = now - entry.lastActivity.getTime();
      if (inactive > this.config.sessionTimeoutMs) {
        console.log(
          `[cleanup] Session ${sessionId} timed out after ${Math.round(inactive / 1000)}s`
        );
        await this.releaseSession(sessionId).catch((err) =>
          console.error(`[cleanup] Failed to release ${sessionId}:`, err)
        );
      }
    }
  }

  /**
   * Health check all active sessions. Mark dead ones for cleanup.
   */
  private async healthCheckActiveSessions(): Promise<void> {
    for (const [sessionId, entry] of this.sessions) {
      if (entry.status !== "active") continue;

      const healthy = await this.orbClient.isHealthy(entry.vmUrl);
      if (!healthy) {
        console.warn(
          `[health] Session ${sessionId} VM ${entry.vmId} is unhealthy`
        );
        entry.status = "dead";
        // Clean up dead session
        await this.orbClient.destroyVM(entry.vmId).catch(() => {});
        this.sessions.delete(sessionId);
      }
    }
  }

  /**
   * Force-destroy all sessions. Used during shutdown.
   */
  async destroyAll(): Promise<void> {
    const promises = Array.from(this.sessions.keys()).map((id) =>
      this.releaseSession(id).catch(() => {})
    );
    await Promise.allSettled(promises);
  }
}

// Custom error types
export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`);
    this.name = "SessionNotFoundError";
  }
}

export class SessionLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionLimitError";
  }
}
