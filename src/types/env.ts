/**
 * Minimal structural Cloudflare Worker binding types for `sports-ops-desk`. Avoids global `///
 * <reference types="@cloudflare/workers-types" />` augmentation so the shared Node/Bun Express
 * server and Vite client share standard Fetch `Request`/`Response` and `NodeJS.ProcessEnv`
 * definitions while staying 100% assignable from Wrangler's generated `worker-configuration.d.ts`.
 */

export interface WorkerR2ObjectLike {
  readonly key: string
  readonly size: number
  readonly etag: string
  readonly uploaded?: Date | undefined
}

export interface WorkerR2PutOptionsLike {
  readonly onlyIf?: {
    readonly etagMatches?: string | undefined
  }
  readonly httpMetadata?: {
    readonly contentType?: string | undefined
  }
}

export interface WorkerR2BucketLike {
  head(key: string): Promise<WorkerR2ObjectLike | null>
  put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | ReadableStream | Blob | null,
    options?: WorkerR2PutOptionsLike,
  ): Promise<WorkerR2ObjectLike | null>
}

export interface WorkerDurableObjectIdLike {
  toString(): string
}

export interface WorkerDurableObjectStubLike {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}

export interface WorkerDurableObjectNamespaceLike {
  idFromName(name: string): WorkerDurableObjectIdLike
  get(id: WorkerDurableObjectIdLike): WorkerDurableObjectStubLike
}

export interface WorkerExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void
  passThroughOnException(): void
}

/**
 * Runtime environment contract for the `sports-ops-desk` Cloudflare Worker. Mirrors native R2
 * bindings, `MCP_LIMITER` Durable Object binding, and `secrets.required` declared in
 * `wrangler.jsonc` / `worker-configuration.d.ts`.
 */
export interface SportsOpsDeskEnv {
  // Native R2 bucket bindings
  readonly DESK_ARCHIVE: WorkerR2BucketLike
  readonly OPS_REPORTS: WorkerR2BucketLike
  readonly BETS_BUCKET: WorkerR2BucketLike
  readonly LEDGER_RECEIPTS: WorkerR2BucketLike

  // Durable Object bindings
  readonly MCP_LIMITER: WorkerDurableObjectNamespaceLike

  // Required secrets (wrangler.jsonc -> secrets.required)
  readonly DATABASE_URL: string
  readonly DESK_ADMIN_TOKEN: string
  readonly TELEGRAM_BOT_TOKEN: string
  readonly TELEGRAM_ALLOWED_CHATS: string
  readonly WORKSPACE_VAULT_KEY: string

  // Optional allowlist overrides (comma-separated hostnames)
  readonly MCP_ALLOWED_HOSTS?: string | undefined
  readonly MCP_ALLOWED_ORIGINS?: string | undefined
}
