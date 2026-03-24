# Steel Orchestrator

Open-source multi-session orchestrator for [Steel Browser](https://github.com/steel-dev/steel-browser), powered by [Orb Cloud](https://orbcloud.dev).

**Steel Browser OSS is limited to one session per container.** This orchestrator removes that limitation by giving each session its own isolated Orb Cloud VM — with authentication, session persistence, and auto-scaling built in.

## What This Solves

| Problem | Steel OSS Today | With Orchestrator |
|---------|----------------|-------------------|
| Concurrent sessions | **1 per container** ([#263](https://github.com/steel-dev/steel-browser/issues/263)) | Unlimited (1 VM per session) |
| Authentication | **None** ([#235](https://github.com/steel-dev/steel-browser/issues/235)) | API key auth on all endpoints |
| Scaling | **Manual** ([#144](https://github.com/steel-dev/steel-browser/issues/144)) | Auto-scaling via Orb Cloud |
| Session persistence | **Cloud-only** | Save/restore cookies & localStorage |
| Chrome memory leaks | **Your problem** | Auto-recycle VMs after 1 hour |
| Cost at 50 sessions | **~$3,500/mo** (K8s) | **~$200/mo** (Orb) |

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/nextbysam/steel-browser.git
cd steel-browser/orchestrator
npm install

# 2. Configure
cp .env.example .env
# Edit .env: set ORB_API_KEY and API_KEYS

# 3. Start
npm run dev
```

## Usage

The orchestrator exposes the **same API as Steel Browser**. Existing SDKs work with zero code changes — just swap `baseUrl`.

### With Steel Node SDK

```typescript
import Steel from "steel-sdk";

const steel = new Steel({
  baseUrl: "http://localhost:3000",  // ← orchestrator URL
  steelAPIKey: "your_api_key",
});

// Create a session (gets its own isolated VM)
const session = await steel.sessions.create();

// Use it with Playwright
const browser = await chromium.connectOverCDP(session.websocketUrl);
const page = await browser.newPage();
await page.goto("https://example.com");

// Release (context saved automatically)
await steel.sessions.release(session.id);
```

### With Puppeteer

```typescript
import puppeteer from "puppeteer-core";

// Create session via REST
const res = await fetch("http://localhost:3000/v1/sessions", {
  method: "POST",
  headers: {
    "Authorization": "Bearer your_api_key",
    "Content-Type": "application/json",
  },
});
const session = await res.json();

// Connect via CDP
const browser = await puppeteer.connect({
  browserWSEndpoint: session.websocketUrl,
});
```

### Session Persistence

Save a session's browser state and restore it later:

```typescript
// Session A: login to a site
const sessionA = await steel.sessions.create();
// ... navigate, login, set cookies ...
await steel.sessions.release(sessionA.id);  // context saved automatically

// Session B: restore Session A's state (cookies, localStorage)
const sessionB = await steel.sessions.create({
  restoreSessionId: sessionA.id,  // ← new field
});
// ... still logged in!
```

### Concurrent Sessions

Run as many sessions as you want — each is isolated:

```typescript
// Create 10 sessions in parallel
const sessions = await Promise.all(
  Array.from({ length: 10 }, () => steel.sessions.create())
);

// Each session has its own Chrome, own VM, own network
// No cross-contamination, no shared state
```

## API Reference

### Standard Steel Endpoints (proxied to VMs)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/sessions` | Create session (provisions Orb VM) |
| `GET` | `/v1/sessions` | List your sessions |
| `GET` | `/v1/sessions/:id` | Session details |
| `GET` | `/v1/sessions/:id/context` | Browser context (cookies, localStorage) |
| `POST` | `/v1/sessions/:id/release` | Release session (saves context, destroys VM) |
| `POST` | `/v1/sessions/release` | Release all your sessions |
| `POST` | `/v1/scrape` | Scrape a URL |
| `POST` | `/v1/screenshot` | Screenshot a URL |
| `POST` | `/v1/pdf` | PDF a URL |
| `POST` | `/v1/search` | Brave search |
| `WS` | `/cdp/:sessionId` | CDP WebSocket (Puppeteer/Playwright) |

### New Orchestrator Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/orchestrator/health` | Sessions, warm pool, uptime stats |
| `GET` | `/v1/orchestrator/contexts` | List saved session contexts |

### New Session Create Fields

| Field | Type | Description |
|-------|------|-------------|
| `restoreSessionId` | `string` | Restore cookies/localStorage from a previous session |

## Configuration

All via environment variables (see `.env.example`):

| Variable | Default | Description |
|----------|---------|-------------|
| `ORB_API_KEY` | **required** | Orb Cloud API key |
| `ORB_API_URL` | `https://api.orbcloud.dev` | Orb Cloud API URL |
| `PORT` | `3000` | Orchestrator port |
| `API_KEYS` | *(empty = no auth)* | Comma-separated valid API keys |
| `MAX_SESSIONS_PER_KEY` | `0` (unlimited) | Max concurrent sessions per key |
| `SESSION_TIMEOUT_MS` | `1800000` (30 min) | Inactivity timeout |
| `WARM_POOL_MIN` | `2` | Minimum idle VMs |
| `WARM_POOL_MAX` | `10` | Maximum idle VMs |
| `MAX_VM_AGE_MS` | `3600000` (1 hour) | Recycle VMs after this age |
| `CONTEXT_STORE_PATH` | `./data/contexts` | Where to save session contexts |

## Architecture

```
User (Steel SDK / Playwright / Puppeteer)
    │
    ▼
┌──────────────────────────────────────┐
│  Steel Orchestrator                   │
│  ├── Auth (API key validation)       │
│  ├── SessionRouter (session→VM map)  │
│  ├── WarmPool (pre-provisioned VMs)  │
│  ├── ContextStore (save/restore)     │
│  └── CDP WebSocket Proxy             │
└──────────┬───────────┬───────────────┘
           │           │
    ┌──────▼───┐ ┌─────▼────┐
    │ Orb VM   │ │ Orb VM   │ ... N VMs
    │ Chrome   │ │ Chrome   │
    │ Steel API│ │ Steel API│
    │ Isolated │ │ Isolated │
    └──────────┘ └──────────┘
```

## Why Not Just Use Kubernetes?

Steel maintainers told users to "build an orchestrator" ([#144](https://github.com/steel-dev/steel-browser/issues/144)). Here's why this is better:

| K8s DIY | Steel Orchestrator |
|---------|-------------------|
| Need K8s expertise | `npm start` |
| Build session routing yourself | Built-in |
| Build auth yourself | Built-in |
| Build persistence yourself | Built-in |
| ~$3,500/mo for 50 sessions | ~$200/mo on Orb |
| Weeks to set up | 5 minutes |

## License

Apache 2.0 (same as Steel Browser)
