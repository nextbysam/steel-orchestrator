/**
 * Steel Orchestrator — multi-session orchestration for Steel Browser.
 *
 * Solves three problems nobody else is solving for Steel's community:
 * 1. Multi-session (issue #263) — unlimited concurrent sessions via Orb VMs
 * 2. Auth (issue #235) — API key authentication on all endpoints
 * 3. Session persistence — save/restore browser context across sessions
 *
 * Drop-in compatible with the Steel SDK — just swap `baseUrl`.
 */

import Fastify from "fastify";
import websocket from "@fastify/websocket";
import cors from "@fastify/cors";
import { loadConfig } from "./config";
import { OrbClient } from "./orb-client";
import { SessionRouter } from "./session-router";
import { WarmPool } from "./warm-pool";
import { ContextStore } from "./context-store";
import { registerRoutes } from "./routes";

async function main() {
  const config = loadConfig();

  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  Steel Orchestrator                          ║");
  console.log("║  Multi-session · Auth · Persistence          ║");
  console.log("║  Powered by Orb Cloud                        ║");
  console.log("╚══════════════════════════════════════════════╝");
  console.log();
  console.log(`Port:            ${config.port}`);
  console.log(`Orb API:         ${config.orbApiUrl}`);
  console.log(`Template:        ${config.orbTemplate}`);
  console.log(`Auth:            ${config.apiKeys.length > 0 ? `${config.apiKeys.length} API keys` : "DISABLED (dev mode)"}`);
  console.log(`Session timeout: ${config.sessionTimeoutMs / 1000}s`);
  console.log(`Warm pool:       ${config.warmPoolMin}-${config.warmPoolMax} VMs`);
  console.log(`Context store:   ${config.contextStorePath}`);
  console.log();

  // Initialize components
  const orbClient = new OrbClient({
    apiUrl: config.orbApiUrl,
    apiKey: config.orbApiKey,
  });

  const warmPool = new WarmPool(orbClient, {
    minIdle: config.warmPoolMin,
    maxIdle: config.warmPoolMax,
    maxAgeMs: config.maxVmAgeMs,
  });

  const contextStore = new ContextStore(config.contextStorePath);
  try {
    await contextStore.initialize();
  } catch (err) {
    console.warn("⚠ Could not initialize context store:", (err as Error).message);
    console.warn("  Session persistence will not work until the directory is writable.");
  }

  const sessionRouter = new SessionRouter(
    orbClient,
    warmPool,
    contextStore,
    config
  );

  // Initialize warm pool (only if Orb API key is configured)
  if (config.orbApiKey) {
    await warmPool.initialize();
    warmPool.startMaintenance();
  } else {
    console.log("⚠ No ORB_API_KEY — warm pool disabled. Sessions will fail until key is set.");
  }

  // Start session router background tasks
  sessionRouter.start();

  // Create Fastify app
  const app = Fastify({
    logger: true,
  });

  await app.register(cors);
  await app.register(websocket);

  // Register all routes
  registerRoutes(app, {
    sessionRouter,
    warmPool,
    contextStore,
    authConfig: { apiKeys: config.apiKeys },
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[shutdown] Received ${signal}, cleaning up...`);

    // Stop background tasks
    sessionRouter.stop();
    warmPool.stopMaintenance();

    // Release all sessions (save contexts, destroy VMs)
    console.log("[shutdown] Releasing all sessions...");
    await sessionRouter.destroyAll();

    // Destroy warm pool VMs
    console.log("[shutdown] Destroying warm pool...");
    await warmPool.destroyAll();

    console.log("[shutdown] Done. Goodbye.");
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Start listening
  await app.listen({ port: config.port, host: "0.0.0.0" });
  console.log(`\n✓ Steel Orchestrator listening on :${config.port}`);
  console.log(
    `  Create a session: curl -X POST http://localhost:${config.port}/v1/sessions -H "Authorization: Bearer <key>"`
  );
}

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION:", err);
});

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
