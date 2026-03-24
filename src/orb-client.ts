/**
 * Client for the Orb Cloud API.
 * Manages VM (computer) lifecycle: create, destroy, health check.
 *
 * Each VM runs a Steel Browser container with Chrome, Fastify API on :3000,
 * and CDP on :9223. Gets a public URL like https://{id}.orbcloud.dev
 */

export interface OrbVM {
  id: string;
  url: string;
  status: "creating" | "building" | "running" | "stopped" | "error";
  createdAt: string;
}

export interface OrbClientConfig {
  apiUrl: string;
  apiKey: string;
  template: string;
}

export class OrbClient {
  private apiUrl: string;
  private apiKey: string;
  private template: string;

  constructor(config: OrbClientConfig) {
    this.apiUrl = config.apiUrl;
    this.apiKey = config.apiKey;
    this.template = config.template;
  }

  /**
   * Create a new Orb VM running the Steel Browser template.
   */
  async createVM(): Promise<OrbVM> {
    const res = await fetch(`${this.apiUrl}/v1/computers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        template: this.template,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Orb API createVM failed (${res.status}): ${body}`);
    }

    return (await res.json()) as OrbVM;
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
      throw new Error(`Orb API destroyVM failed (${res.status}): ${vmId}`);
    }
  }

  /**
   * Get VM details. Returns null if VM doesn't exist.
   */
  async getVM(vmId: string): Promise<OrbVM | null> {
    const res = await fetch(`${this.apiUrl}/v1/computers/${vmId}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Orb API getVM failed (${res.status})`);

    return (await res.json()) as OrbVM;
  }

  /**
   * Wait for a VM to be ready by polling Steel's health endpoint.
   * Steel exposes GET /v1/health on port 3000.
   */
  async waitForReady(
    vm: OrbVM,
    timeoutMs: number = 60_000
  ): Promise<void> {
    const start = Date.now();
    const healthUrl = `${vm.url}/v1/health`;

    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch(healthUrl, {
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) return;
      } catch {
        // VM not ready yet — keep polling
      }
      await sleep(2000);
    }

    throw new Error(
      `VM ${vm.id} did not become ready within ${timeoutMs}ms`
    );
  }

  /**
   * Check if a VM's Steel instance is healthy.
   * Returns true if /v1/health responds 200 within 5 seconds.
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
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
