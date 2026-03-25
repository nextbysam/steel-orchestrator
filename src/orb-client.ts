/**
 * Client for the Orb Cloud API.
 * Manages the full VM lifecycle: create → config → build → deploy → health.
 *
 * Each VM runs Steel Browser with Google Chrome, accessible via
 * https://{short_id}.orbcloud.dev
 */

export interface OrbVM {
  id: string;
  shortId: string;
  url: string;
  status: "creating" | "building" | "running" | "stopped" | "error";
}

export interface OrbClientConfig {
  apiUrl: string;
  apiKey: string;
}

/** The orb.toml config for Steel Browser VMs */
const STEEL_ORB_CONFIG = `[agent]
name = "steel-browser"
lang = "node"
entry = "api/build/index.js"

[source]
git = "https://github.com/steel-dev/steel-browser.git"
branch = "main"

[build]
steps = [
  "cd /tmp && curl -sL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o chrome.deb && apt-get update && apt-get install -y ./chrome.deb xvfb fonts-liberation dbus dbus-x11 nginx procps",
  "npm pkg set scripts.prepare='echo noop'",
  "npm ci --workspace=api",
  "npm run build --workspace=api"
]
working_dir = "/agent/code"

[agent.env]
CHROME_EXECUTABLE_PATH = "/usr/bin/google-chrome"
CHROME_HEADLESS = "true"
DISABLE_CHROME_SANDBOX = "true"
HOST = "0.0.0.0"
PORT = "3000"

[backend]
provider = "custom"

[ports]
expose = [3000, 9223]
`;

export class OrbClient {
  private apiUrl: string;
  private apiKey: string;

  constructor(config: OrbClientConfig) {
    this.apiUrl = config.apiUrl;
    this.apiKey = config.apiKey;
  }

  /**
   * Provision a complete Steel Browser VM.
   * Creates computer → uploads config → builds → deploys → waits for health.
   *
   * This takes 3-5 minutes for a cold build. Use the warm pool to avoid
   * making users wait.
   */
  async createVM(): Promise<OrbVM> {
    // 1. Create computer
    const createRes = await this.api("POST", "/v1/computers", {
      name: `steel-session-${Date.now()}`,
      runtime_mb: 2048,
      disk_mb: 8192,
    });
    const computerId = createRes.id as string;
    const shortId = computerId.slice(0, 8);
    console.log(`[orb] Created computer ${shortId}`);

    try {
      // 2. Upload config
      const configRes = await fetch(
        `${this.apiUrl}/v1/computers/${computerId}/config`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/toml",
          },
          body: STEEL_ORB_CONFIG,
        }
      );
      if (!configRes.ok) {
        throw new Error(`Config upload failed: ${await configRes.text()}`);
      }
      console.log(`[orb] Config uploaded for ${shortId}`);

      // 3. Build (this takes 3-5 minutes)
      console.log(`[orb] Building ${shortId} (Chrome + Steel)...`);
      const buildRes = await fetch(
        `${this.apiUrl}/v1/computers/${computerId}/build`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}` },
          signal: AbortSignal.timeout(900_000), // 15 min timeout
        }
      );
      const buildData = await buildRes.json() as Record<string, unknown>;
      if (!buildData.success) {
        const steps = (buildData.steps as Array<{ step: string; exit_code: number }>) || [];
        const failed = steps.find((s) => s.exit_code !== 0);
        throw new Error(
          `Build failed at step: ${failed?.step || "unknown"}`
        );
      }
      console.log(`[orb] Build complete for ${shortId}`);

      // 4. Deploy
      const deployRes = await this.api(
        "POST",
        `/v1/computers/${computerId}/agents`,
        {}
      );
      const agents = (deployRes.agents as Array<{ pid: number; port: number }>) || [];
      if (agents.length === 0) {
        throw new Error("Deploy returned no agents");
      }
      console.log(`[orb] Deployed ${shortId} (PID: ${agents[0].pid})`);

      // 5. Wait for Steel health
      const vm: OrbVM = {
        id: computerId,
        shortId,
        url: `https://${shortId}.orbcloud.dev`,
        status: "running",
      };
      await this.waitForReady(vm, 60_000);
      console.log(`[orb] Steel Browser ready at ${vm.url}`);

      return vm;
    } catch (err) {
      // Clean up on failure
      await this.destroyVM(computerId).catch(() => {});
      throw err;
    }
  }

  /**
   * Destroy an Orb VM. Idempotent — 404 is not an error.
   */
  async destroyVM(vmId: string): Promise<void> {
    const res = await fetch(`${this.apiUrl}/v1/computers/${vmId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`destroyVM failed (${res.status}): ${vmId}`);
    }
    console.log(`[orb] Destroyed VM ${vmId.slice(0, 8)}`);
  }

  /**
   * Get VM details. Returns null if not found.
   */
  async getVM(vmId: string): Promise<OrbVM | null> {
    const res = await fetch(`${this.apiUrl}/v1/computers/${vmId}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`getVM failed (${res.status})`);

    const data = (await res.json()) as Record<string, unknown>;
    return {
      id: vmId,
      shortId: vmId.slice(0, 8),
      url: `https://${vmId.slice(0, 8)}.orbcloud.dev`,
      status: (data.status as OrbVM["status"]) || "running",
    };
  }

  /**
   * Wait for Steel's health endpoint to respond 200.
   */
  async waitForReady(vm: OrbVM, timeoutMs: number = 60_000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch(`${vm.url}/v1/health`, {
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) return;
      } catch {
        // not ready yet
      }
      await sleep(2000);
    }
    throw new Error(`VM ${vm.shortId} health check timed out after ${timeoutMs}ms`);
  }

  /**
   * Check if a VM's Steel instance is healthy.
   */
  async isHealthy(vmUrl: string): Promise<boolean> {
    try {
      const res = await fetch(`${vmUrl}/v1/health`, {
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Generic API call helper.
   */
  private async api(
    method: string,
    path: string,
    body?: unknown
  ): Promise<Record<string, unknown>> {
    const opts: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
    };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(`${this.apiUrl}${path}`, opts);
    if (!res.ok) {
      throw new Error(`Orb API ${method} ${path} failed (${res.status}): ${await res.text()}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
