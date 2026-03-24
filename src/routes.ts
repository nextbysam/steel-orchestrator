/**
 * Orchestrator routes.
 *
 * Exposes the same API as Steel Browser so existing SDKs work with
 * zero code changes — just swap `baseUrl`. Each request is routed
 * to the correct Orb VM based on session ID.
 *
 * New endpoints (not in Steel):
 * - POST /v1/sessions with `restoreSessionId` — restore saved context
 * - GET /v1/orchestrator/health — orchestrator-specific stats
 * - GET /v1/orchestrator/contexts — list saved session contexts
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { WebSocket } from "ws";
import { validateApiKey, type AuthConfig } from "./auth.js";
import {
  SessionRouter,
  SessionNotFoundError,
  SessionLimitError,
} from "./session-router.js";
import { WarmPool } from "./warm-pool.js";
import { ContextStore } from "./context-store.js";

interface RouteContext {
  sessionRouter: SessionRouter;
  warmPool: WarmPool;
  contextStore: ContextStore;
  authConfig: AuthConfig;
}

export function registerRoutes(
  app: FastifyInstance,
  ctx: RouteContext
): void {
  const { sessionRouter, warmPool, contextStore, authConfig } = ctx;

  // Helper: auth + get API key
  function auth(req: FastifyRequest, reply: FastifyReply): string | null {
    return validateApiKey(req, reply, authConfig);
  }

  // Helper: proxy a request to a session's VM
  async function proxyToSession(
    req: FastifyRequest,
    reply: FastifyReply,
    sessionId: string,
    path: string,
    method: string = "GET"
  ): Promise<void> {
    const entry = sessionRouter.route(sessionId);
    if (!entry) {
      reply.status(404).send({ error: "Session not found", sessionId });
      return;
    }

    const url = `${entry.vmUrl}${path}`;
    const fetchOpts: RequestInit = {
      method,
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30_000),
    };

    if (method === "POST" && req.body) {
      fetchOpts.body = JSON.stringify(req.body);
    }

    try {
      const res = await fetch(url, fetchOpts);
      const contentType = res.headers.get("content-type") || "";

      if (contentType.includes("application/json")) {
        reply.status(res.status).send(await res.json());
      } else {
        const buffer = Buffer.from(await res.arrayBuffer());
        reply
          .status(res.status)
          .header("content-type", contentType)
          .send(buffer);
      }
    } catch (err) {
      reply.status(502).send({
        error: "Bad Gateway",
        message: `Failed to reach session VM: ${(err as Error).message}`,
      });
    }
  }

  // ─── POST /v1/sessions ─────────────────────────────────────────
  // Create a new session on a new Orb VM.
  // This is the key route that solves issue #263 (multi-session).
  app.post("/v1/sessions", async (req, reply) => {
    const apiKey = auth(req, reply);
    if (!apiKey) return;

    const body = (req.body as Record<string, unknown>) || {};

    try {
      const { session, steelResponse } = await sessionRouter.createSession({
        sessionId: body.sessionId as string | undefined,
        apiKey,
        restoreSessionId: body.restoreSessionId as string | undefined,
        steelOptions: body,
      });

      const gatewayHost = req.headers.host || "localhost:3000";
      const protocol = req.protocol || "http";
      const wsProtocol = protocol === "https" ? "wss" : "ws";

      // Rewrite URLs to point through the orchestrator
      const response = {
        ...(steelResponse as Record<string, unknown>),
        id: session.sessionId,
        websocketUrl: `${wsProtocol}://${gatewayHost}/cdp/${session.sessionId}`,
        debugUrl: `${protocol}://${gatewayHost}/v1/sessions/${session.sessionId}/debug`,
        _orchestrator: {
          vmId: session.vmId,
          vmUrl: session.vmUrl,
        },
      };

      reply.status(201).send(response);
    } catch (err) {
      if (err instanceof SessionLimitError) {
        reply.status(429).send({ error: "Too Many Sessions", message: err.message });
      } else {
        app.log.error(err, "Failed to create session");
        reply.status(500).send({ error: "Failed to create session" });
      }
    }
  });

  // ─── GET /v1/sessions ──────────────────────────────────────────
  // List sessions for the authenticated API key.
  app.get("/v1/sessions", async (req, reply) => {
    const apiKey = auth(req, reply);
    if (!apiKey) return;

    const sessions = sessionRouter.listByApiKey(apiKey).map((s) => ({
      id: s.sessionId,
      status: s.status,
      createdAt: s.createdAt.toISOString(),
      lastActivity: s.lastActivity.toISOString(),
      vmId: s.vmId,
    }));

    reply.send({ sessions });
  });

  // ─── GET /v1/sessions/:sessionId ───────────────────────────────
  // Get session details — proxy to VM.
  app.get("/v1/sessions/:sessionId", async (req, reply) => {
    const apiKey = auth(req, reply);
    if (!apiKey) return;
    const { sessionId } = req.params as { sessionId: string };
    await proxyToSession(req, reply, sessionId, `/v1/sessions/${sessionId}`);
  });

  // ─── GET /v1/sessions/:sessionId/context ───────────────────────
  // Get browser context (cookies, localStorage, etc).
  app.get("/v1/sessions/:sessionId/context", async (req, reply) => {
    const apiKey = auth(req, reply);
    if (!apiKey) return;
    const { sessionId } = req.params as { sessionId: string };
    await proxyToSession(
      req,
      reply,
      sessionId,
      `/v1/sessions/${sessionId}/context`
    );
  });

  // ─── POST /v1/sessions/:sessionId/release ──────────────────────
  // Release session: save context → forward release → destroy VM.
  app.post("/v1/sessions/:sessionId/release", async (req, reply) => {
    const apiKey = auth(req, reply);
    if (!apiKey) return;
    const { sessionId } = req.params as { sessionId: string };

    try {
      await sessionRouter.releaseSession(sessionId);
      reply.send({ released: true, sessionId });
    } catch (err) {
      if (err instanceof SessionNotFoundError) {
        reply.status(404).send({ error: "Session not found", sessionId });
      } else {
        app.log.error(err, "Failed to release session");
        reply.status(500).send({ error: "Failed to release session" });
      }
    }
  });

  // ─── POST /v1/sessions/release ─────────────────────────────────
  // Release all sessions for the authenticated API key.
  app.post("/v1/sessions/release", async (req, reply) => {
    const apiKey = auth(req, reply);
    if (!apiKey) return;

    const sessions = sessionRouter.listByApiKey(apiKey);
    const results = await Promise.allSettled(
      sessions.map((s) => sessionRouter.releaseSession(s.sessionId))
    );

    const released = results.filter((r) => r.status === "fulfilled").length;
    reply.send({ released, total: sessions.length });
  });

  // ─── Stateless quick actions ───────────────────────────────────
  // /v1/scrape, /v1/screenshot, /v1/pdf, /v1/search
  // These use a temporary VM (from pool or cold), run the action, then release.
  for (const action of ["scrape", "screenshot", "pdf", "search"] as const) {
    app.post(`/v1/${action}`, async (req, reply) => {
      const apiKey = auth(req, reply);
      if (!apiKey) return;

      // Get a VM for this one-shot action
      let vm = warmPool.take();
      let coldProvisioned = false;
      if (!vm) {
        const orbClient = (sessionRouter as any).orbClient as import("./orb-client.js").OrbClient;
        vm = await orbClient.createVM();
        await orbClient.waitForReady(vm);
        coldProvisioned = true;
      }

      try {
        const res = await fetch(`${vm.url}/v1/${action}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(req.body),
          signal: AbortSignal.timeout(60_000),
        });

        const contentType = res.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          reply.status(res.status).send(await res.json());
        } else {
          const buffer = Buffer.from(await res.arrayBuffer());
          reply
            .status(res.status)
            .header("content-type", contentType)
            .send(buffer);
        }
      } finally {
        // Return to pool or destroy
        if (coldProvisioned) {
          const orbClient = (sessionRouter as any).orbClient as import("./orb-client.js").OrbClient;
          await orbClient.destroyVM(vm.id).catch(() => {});
        }
        // Warm pool VMs get recycled by maintenance
      }
    });
  }

  // ─── Files ─────────────────────────────────────────────────────
  // Proxy file operations to the session's VM.
  app.post("/v1/sessions/:sessionId/files", async (req, reply) => {
    const apiKey = auth(req, reply);
    if (!apiKey) return;
    const { sessionId } = req.params as { sessionId: string };
    await proxyToSession(
      req, reply, sessionId,
      `/v1/sessions/${sessionId}/files`, "POST"
    );
  });

  app.get("/v1/sessions/:sessionId/files", async (req, reply) => {
    const apiKey = auth(req, reply);
    if (!apiKey) return;
    const { sessionId } = req.params as { sessionId: string };
    await proxyToSession(req, reply, sessionId, `/v1/sessions/${sessionId}/files`);
  });

  // ─── Health ────────────────────────────────────────────────────
  app.get("/v1/health", async (_req, reply) => {
    reply.send({ status: "ok" });
  });

  // ─── Orchestrator Health (extended) ────────────────────────────
  app.get("/v1/orchestrator/health", async (_req, reply) => {
    reply.send({
      status: "ok",
      sessions: sessionRouter.stats(),
      warmPool: warmPool.stats(),
      uptime: process.uptime(),
    });
  });

  // ─── Saved Contexts ────────────────────────────────────────────
  app.get("/v1/orchestrator/contexts", async (req, reply) => {
    const apiKey = auth(req, reply);
    if (!apiKey) return;

    const saved = await contextStore.listSaved();
    reply.send({ contexts: saved });
  });

  // ─── CDP WebSocket Proxy ───────────────────────────────────────
  // Route: /cdp/:sessionId
  // Proxies CDP WebSocket to the session's VM Chrome.
  // This is what makes Puppeteer/Playwright work through the orchestrator.
  app.register(async (fastify) => {
    fastify.get(
      "/cdp/:sessionId",
      { websocket: true },
      (socket, req) => {
        const { sessionId } = req.params as { sessionId: string };
        const entry = sessionRouter.route(sessionId);

        if (!entry) {
          socket.close(4004, "Session not found");
          return;
        }

        // Connect to Steel's CDP WebSocket on the VM
        const targetWsUrl = entry.vmUrl.replace(/^http/, "ws");
        const upstream = new WebSocket(targetWsUrl);

        upstream.on("open", () => {
          // Forward client → upstream
          socket.on("message", (data: Buffer) => {
            if (upstream.readyState === WebSocket.OPEN) {
              upstream.send(data);
            }
          });
        });

        // Forward upstream → client
        upstream.on("message", (data: Buffer) => {
          if (socket.readyState === 1) {
            socket.send(data);
          }
        });

        upstream.on("close", () => socket.close());
        socket.on("close", () => upstream.close());

        upstream.on("error", (err) => {
          app.log.error(
            `CDP proxy error for session ${sessionId}: ${err.message}`
          );
          socket.close(4500, "Upstream error");
        });
      }
    );
  });
}
