/**
 * WarmPool — pre-provisioned Orb VMs ready for instant session starts.
 *
 * Without a warm pool, each session create has to wait for VM provisioning
 * (could be 5-30 seconds). The warm pool keeps N idle VMs running Steel
 * Browser, ready to be claimed instantly.
 *
 * VMs are recycled after maxAge to prevent Chrome memory leak accumulation.
 */

import { OrbClient, type OrbVM } from "./orb-client";

interface PoolEntry {
  vm: OrbVM;
  addedAt: Date;
}

export interface WarmPoolConfig {
  minIdle: number;
  maxIdle: number;
  maxAgeMs: number;
}

export class WarmPool {
  private pool: PoolEntry[] = [];
  private provisioning = 0;
  private orbClient: OrbClient;
  private config: WarmPoolConfig;
  private maintainInterval: ReturnType<typeof setInterval> | null = null;

  constructor(orbClient: OrbClient, config: WarmPoolConfig) {
    this.orbClient = orbClient;
    this.config = config;
  }

  /**
   * Fill the pool to minIdle on startup.
   */
  async initialize(): Promise<void> {
    console.log(
      `[warm-pool] Initializing (min=${this.config.minIdle}, max=${this.config.maxIdle})`
    );

    const promises = Array.from({ length: this.config.minIdle }, () =>
      this.addToPool()
    );
    const results = await Promise.allSettled(promises);
    const succeeded = results.filter((r) => r.status === "fulfilled").length;

    console.log(`[warm-pool] Ready: ${succeeded}/${this.config.minIdle} VMs`);
  }

  /**
   * Start periodic maintenance (health checks, recycling, refilling).
   */
  startMaintenance(intervalMs: number = 60_000): void {
    this.maintainInterval = setInterval(() => this.maintain(), intervalMs);
  }

  /**
   * Stop maintenance.
   */
  stopMaintenance(): void {
    if (this.maintainInterval) clearInterval(this.maintainInterval);
  }

  /**
   * Take a VM from the pool. Returns null if empty.
   * Triggers background refill if pool drops below minimum.
   */
  take(): OrbVM | null {
    const entry = this.pool.shift();

    // Refill in background
    if (this.pool.length + this.provisioning < this.config.minIdle) {
      this.addToPool().catch((err) =>
        console.error("[warm-pool] Background refill failed:", err)
      );
    }

    return entry?.vm ?? null;
  }

  /**
   * Periodic maintenance:
   * 1. Remove VMs older than maxAge (Chrome memory leaks)
   * 2. Health check remaining VMs
   * 3. Trim if over maxIdle
   * 4. Refill if under minIdle
   */
  async maintain(): Promise<void> {
    const now = Date.now();

    // 1. Remove stale VMs
    const stale = this.pool.filter(
      (e) => now - e.addedAt.getTime() > this.config.maxAgeMs
    );
    for (const entry of stale) {
      this.pool = this.pool.filter((e) => e !== entry);
      await this.orbClient.destroyVM(entry.vm.id).catch(() => {});
      console.log(`[warm-pool] Recycled stale VM ${entry.vm.id}`);
    }

    // 2. Health check remaining
    for (const entry of [...this.pool]) {
      const healthy = await this.orbClient.isHealthy(entry.vm.url);
      if (!healthy) {
        this.pool = this.pool.filter((e) => e !== entry);
        await this.orbClient.destroyVM(entry.vm.id).catch(() => {});
        console.log(`[warm-pool] Removed unhealthy VM ${entry.vm.id}`);
      }
    }

    // 3. Trim excess
    while (this.pool.length > this.config.maxIdle) {
      const entry = this.pool.pop()!;
      await this.orbClient.destroyVM(entry.vm.id).catch(() => {});
    }

    // 4. Refill
    while (this.pool.length + this.provisioning < this.config.minIdle) {
      this.addToPool().catch((err) =>
        console.error("[warm-pool] Refill failed:", err)
      );
    }
  }

  /**
   * Destroy all pool VMs. Used during shutdown.
   */
  async destroyAll(): Promise<void> {
    const promises = this.pool.map((e) =>
      this.orbClient.destroyVM(e.vm.id).catch(() => {})
    );
    await Promise.allSettled(promises);
    this.pool = [];
  }

  /**
   * Pool stats for health endpoint.
   */
  stats(): { idle: number; provisioning: number } {
    return { idle: this.pool.length, provisioning: this.provisioning };
  }

  /**
   * Provision a new VM and add to the idle pool.
   */
  private async addToPool(): Promise<void> {
    this.provisioning++;
    try {
      const vm = await this.orbClient.createVM();
      await this.orbClient.waitForReady(vm);
      this.pool.push({ vm, addedAt: new Date() });
      console.log(`[warm-pool] Added VM ${vm.id} (pool size: ${this.pool.length})`);
    } catch (err) {
      console.error("[warm-pool] Failed to provision VM:", err);
      throw err;
    } finally {
      this.provisioning--;
    }
  }
}
