/**
 * ContextStore — saves and restores browser session context.
 *
 * This solves the session persistence gap in Steel OSS.
 * When a session is released, we extract cookies, localStorage,
 * sessionStorage, and indexedDB via Steel's context API, then save
 * to disk. On next session create, the context can be restored.
 *
 * This means: login to a site → release session → restore session →
 * still logged in. Cloud-only in Steel, now open-source.
 */

import { mkdir, readFile, writeFile, unlink, readdir } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";

export interface SessionContext {
  cookies?: unknown[];
  localStorage?: Record<string, Record<string, unknown>>;
  sessionStorage?: Record<string, Record<string, unknown>>;
  indexedDB?: unknown;
  savedAt?: string;
}

export class ContextStore {
  private storePath: string;

  constructor(storePath: string) {
    this.storePath = storePath;
  }

  /**
   * Ensure the store directory exists.
   */
  async initialize(): Promise<void> {
    if (!existsSync(this.storePath)) {
      await mkdir(this.storePath, { recursive: true });
    }
    console.log(`[context-store] Initialized at ${this.storePath}`);
  }

  /**
   * Save a session's context to disk.
   */
  async save(sessionId: string, context: SessionContext): Promise<void> {
    const filePath = this.filePath(sessionId);
    const data: SessionContext = {
      ...context,
      savedAt: new Date().toISOString(),
    };

    await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
    console.log(`[context-store] Saved context for session ${sessionId}`);
  }

  /**
   * Load a saved context. Returns null if not found.
   */
  async load(sessionId: string): Promise<SessionContext | null> {
    const filePath = this.filePath(sessionId);
    try {
      const raw = await readFile(filePath, "utf-8");
      const context = JSON.parse(raw) as SessionContext;
      console.log(`[context-store] Loaded context for session ${sessionId}`);
      return context;
    } catch {
      return null;
    }
  }

  /**
   * Delete a saved context.
   */
  async delete(sessionId: string): Promise<void> {
    try {
      await unlink(this.filePath(sessionId));
    } catch {
      // already gone
    }
  }

  /**
   * List all saved session IDs.
   */
  async listSaved(): Promise<string[]> {
    try {
      const files = await readdir(this.storePath);
      return files
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(".json", ""));
    } catch {
      return [];
    }
  }

  private filePath(sessionId: string): string {
    // Sanitize session ID to prevent path traversal
    const safe = sessionId.replace(/[^a-zA-Z0-9-_]/g, "");
    return join(this.storePath, `${safe}.json`);
  }
}
