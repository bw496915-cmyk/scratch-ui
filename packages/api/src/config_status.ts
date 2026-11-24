/**
 * Server-side Status & Configuration Registry powering `GET/POST/DELETE /api/config/status`.
 * Inventories all `.env.example` environment variables, build-time constants, and runtime
 * configuration variables, traces every entry to the exact UI, API, and server components that
 * consume it, and allows saving non-secret runtime configuration overrides safely. Security
 * boundary:
 *
 * - Secret keys (tokens, passwords, API keys, DB credentials, HMAC salts) are strictly read-only
 *   presence indicators (`configured: boolean`); their raw values are NEVER serialized into HTTP
 *   responses or `.env.example` exports, and `POST` rejects any attempt to submit or overwrite
 *   them.
 *
 * @file Packages/api/src/config_status.ts
 */

import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import type { BunRuntimeSurfaceAuditSnapshot } from "../../contracts/src/bun_runtime_surface.ts"
import type { WorkspaceYamlConfigSummary } from "../../contracts/src/bun_yaml.ts"
import type { RedactedNpmrcStatusSummary } from "../../contracts/src/npmrc.ts"
import { validateConfigHttpUrl } from "./api_base_validation.ts"
import { loadBunRuntimeSurfaceAudit } from "./bun_runtime_surface_loader.ts"
import { loadRedactedNpmrcStatusSummary } from "./npmrc_loader.ts"
import { loadWorkspaceYamlConfigSummary } from "./yaml_loader.ts"

export type ConfigItemKind = "env" | "constant" | "variable"

export type ConfigItemCategory =
  | "Server & Runtime"
  | "Security & Auth"
  | "Fantasy402 Gateway"
  | "Telemetry & Thresholds"
  | "UI & Desk Controls"
  | "Storage & R2"
  | "Integrations"

export type ConfigValueType = "string" | "number" | "boolean" | "url" | "list"

export interface ConfigComponentTrace {
  readonly component: string
  readonly layer: "ui" | "api" | "server" | "config"
  readonly usage: string
  readonly tabId?: string | undefined
}

export interface ConfigStatusItem {
  readonly key: string
  readonly label: string
  readonly kind: ConfigItemKind
  readonly category: ConfigItemCategory
  readonly valueType: ConfigValueType
  readonly description: string
  readonly sourceFile: string
  readonly sensitive: boolean
  readonly editable: boolean
  readonly configured: boolean
  readonly overridden: boolean
  readonly status: "configured" | "overridden" | "default" | "unset"
  /** Effective value for non-secret items; ALWAYS `null` for sensitive keys. */
  readonly value: string | null
  readonly defaultValue: string
  readonly envExampleLine?: string | undefined
  readonly consumers: readonly ConfigComponentTrace[]
}

export interface ComponentTraceSummary {
  readonly component: string
  readonly layer: "ui" | "api" | "server" | "config"
  readonly tabId?: string | undefined
  readonly itemCount: number
  readonly envCount: number
  readonly constantCount: number
  readonly variableCount: number
  readonly secretCount: number
  readonly items: readonly {
    readonly key: string
    readonly kind: ConfigItemKind
    readonly status: ConfigStatusItem["status"]
    readonly sensitive: boolean
    readonly usage: string
  }[]
}

export interface ConfigStatusSummary {
  readonly totalItems: number
  readonly envCount: number
  readonly constantCount: number
  readonly variableCount: number
  readonly configuredCount: number
  readonly overriddenCount: number
  readonly unsetCount: number
  readonly secretCount: number
  readonly secretConfiguredCount: number
  readonly componentCount: number
}

export interface ConfigStatusSnapshot {
  readonly items: readonly ConfigStatusItem[]
  readonly components: readonly ComponentTraceSummary[]
  readonly summary: ConfigStatusSummary
  readonly overrides: Readonly<Record<string, string>>
  readonly envExampleText: string
  readonly npmrc?: RedactedNpmrcStatusSummary | undefined
  readonly yamlConfig?: WorkspaceYamlConfigSummary | undefined
  readonly runtimeSurface?: BunRuntimeSurfaceAuditSnapshot | undefined
  readonly updatedAt: string
}

export interface SaveConfigOverridesResult {
  readonly ok: true
  readonly savedKeys: readonly string[]
  readonly snapshot: ConfigStatusSnapshot
}

export interface SaveConfigOverridesError {
  readonly ok: false
  readonly code:
    "SENSITIVE_KEY_READONLY" | "INVALID_CONFIG_KEY" | "INVALID_CONFIG_VALUE" | "EMPTY_PAYLOAD"
  readonly error: string
  readonly key?: string | undefined
}

export interface ConfigStatusStore {
  getSnapshot(): ConfigStatusSnapshot
  saveOverrides(
    rawOverrides: Readonly<Record<string, unknown>>,
  ): SaveConfigOverridesResult | SaveConfigOverridesError
  resetOverrides(keys?: readonly string[] | undefined): ConfigStatusSnapshot
}

interface ConfigItemSpec {
  readonly key: string
  readonly label: string
  readonly kind: ConfigItemKind
  readonly category: ConfigItemCategory
  readonly valueType: ConfigValueType
  readonly description: string
  readonly sourceFile: string
  readonly sensitive: boolean
  readonly editable: boolean
  readonly defaultValue: string
  readonly minNumber?: number | undefined
  readonly maxNumber?: number | undefined
  readonly consumers: readonly ConfigComponentTrace[]
}

export interface ParsedEnvExampleEntry {
  readonly key: string
  readonly defaultValue: string
  readonly comment: string
  readonly rawLine: string
}

const SENSITIVE_KEY_PATTERN =
  /(SECRET|TOKEN|PASSWORD|API_KEY|ACCESS_KEY|SALT|DATABASE_URL|VAULT_KEY|PRIVATE_KEY)/i

export function isSensitiveConfigKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key)
}

/** Parse `.env.example` into key/default/comment metadata while stripping outer quotes. */
export function parseEnvExample(rawText: string): readonly ParsedEnvExampleEntry[] {
  const results: ParsedEnvExampleEntry[] = []
  let pendingComment: string[] = []

  for (const rawLine of rawText.split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (trimmed === "") {
      pendingComment = []
      continue
    }
    if (trimmed.startsWith("#")) {
      const cleaned = trimmed.replace(/^#+\s*/, "").trim()
      if (cleaned) pendingComment.push(cleaned)
      continue
    }
    const eqIdx = trimmed.indexOf("=")
    if (eqIdx <= 0) {
      pendingComment = []
      continue
    }
    const key = trimmed.slice(0, eqIdx).trim()
    if (!/^[A-Z0-9_]+$/.test(key)) {
      pendingComment = []
      continue
    }
    let val = trimmed.slice(eqIdx + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    results.push({
      key,
      defaultValue: val,
      comment: pendingComment.join(" "),
      rawLine: trimmed,
    })
    pendingComment = []
  }

  return results
}

const ENV_SPEC_METADATA: Readonly<
  Record<
    string,
    {
      readonly label: string
      readonly category: ConfigItemCategory
      readonly valueType: ConfigValueType
      readonly description: string
      readonly sensitive?: boolean
      readonly minNumber?: number
      readonly maxNumber?: number
      readonly consumers: readonly ConfigComponentTrace[]
    }
  >
> = {
  PORT: {
    label: "HTTP Listen Port",
    category: "Server & Runtime",
    valueType: "number",
    minNumber: 1,
    maxNumber: 65535,
    description: "TCP port bound by the Express/Vite and Bun HTTP server.",
    consumers: [
      {
        component: "server.ts",
        layer: "server",
        usage: "Binds main HTTP + WebSocket listener (default 3000)",
      },
      {
        component: "packages/api/src/bun_server.ts",
        layer: "api",
        usage: "Default port for createDashboardBunServer()",
      },
      {
        component: "ApiUsageCard",
        layer: "ui",
        usage: "Displayed in Base URL Properties effectivePort readout",
        tabId: "surveillance",
      },
    ],
  },
  NODE_ENV: {
    label: "Node Environment",
    category: "Server & Runtime",
    valueType: "string",
    description:
      "Runtime mode (development, test, production) governing auth hardening and Vite middleware.",
    consumers: [
      {
        component: "server.ts",
        layer: "server",
        usage: "Switches between Vite dev middleware and dist/ static build",
      },
      {
        component: "packages/api/src/router.ts",
        layer: "api",
        usage: "Enforces fail-closed auth and adminGuard in production",
      },
      {
        component: "packages/backend/src/parsers.ts",
        layer: "server",
        usage: "Disables auth bypass unconditionally in production",
      },
    ],
  },
  SPORTSDESK_API_ORIGIN: {
    label: "Companion Daemon Origin",
    category: "Server & Runtime",
    valueType: "url",
    description: "Origin URL for the optional local SportsDesk companion daemon (port 4020).",
    consumers: [
      {
        component: "server.ts",
        layer: "server",
        usage: "Probes /api/daemon/status health endpoint",
      },
      {
        component: "packages/backend/src/r2_pipeline.ts",
        layer: "server",
        usage: "Checks companion daemon status during pipeline sweeps",
      },
      {
        component: "RiskOverviewPanel",
        layer: "ui",
        usage: "Displays daemon reachability and feed provenance",
        tabId: "risk-overview",
      },
    ],
  },
  SPORTSDESK_BRIDGE_STATE_PATH: {
    label: "Bridge Collector State Path",
    category: "Telemetry & Thresholds",
    valueType: "string",
    description: "Optional mounted collector receipt JSON file path for pipeline status.",
    consumers: [
      {
        component: "server/collector_status.ts",
        layer: "server",
        usage: "Reads collector bridge receipt freshness when configured",
      },
      {
        component: "R2PipelineTabPanel",
        layer: "ui",
        usage: "Displays bridge receipt status in pipeline view",
        tabId: "r2",
      },
    ],
  },
  SPORTSDESK_LIVE_WAGERS_JSON: {
    label: "Live Wagers JSON Path",
    category: "Telemetry & Thresholds",
    valueType: "string",
    description: "Optional local JSON file path overriding the live wager feed source.",
    consumers: [
      {
        component: "server.ts",
        layer: "server",
        usage: "Reads live wager tickets when configured",
      },
      {
        component: "LiveWagersTabPanel",
        layer: "ui",
        usage: "Renders incoming live wager tape",
        tabId: "wagers",
      },
    ],
  },
  SHADOW_PRICE_DB: {
    label: "Shadow Pricing SQLite Path",
    category: "Telemetry & Thresholds",
    valueType: "string",
    description: "Optional retained SQLite database path for read-only Shadow Pricing queries.",
    consumers: [
      {
        component: "server/shadow_pricing.ts",
        layer: "server",
        usage: "Queries retained counterfactual line-movement SQLite records",
      },
      {
        component: "ShadowPricingPanel",
        layer: "ui",
        usage: "Displays counterfactual reprice deltas",
        tabId: "shadow",
      },
    ],
  },
  SPORTSDESK_DASHBOARD_TOKEN: {
    label: "Dashboard Bearer Token",
    category: "Security & Auth",
    valueType: "string",
    sensitive: true,
    description: "Primary operator API token for authenticated dashboard sessions.",
    consumers: [
      {
        component: "server.ts",
        layer: "server",
        usage: "Verifies Authorization: Bearer and session login",
      },
      {
        component: "lib/http_auth.ts",
        layer: "server",
        usage: "Authenticates operator HTTP and WebSocket sessions",
      },
      {
        component: "packages/api/src/router.ts",
        layer: "api",
        usage: "Guards all protectedStaticRoutes and paramRoutes",
      },
    ],
  },
  SPORTSDESK_OPERATOR_PASSWORD: {
    label: "Operator Sign-In Passcode",
    category: "Security & Auth",
    valueType: "string",
    sensitive: true,
    description: "Shared operator login passcode verified server-side on POST /api/auth/login.",
    consumers: [
      {
        component: "lib/http_auth.ts",
        layer: "server",
        usage: "Validates POST /api/auth/login credentials",
      },
      {
        component: "App.tsx",
        layer: "ui",
        usage: "Operator sign-in dialog submits credentials to /api/auth/login",
      },
    ],
  },
  SPORTSDESK_ADMIN_TOKEN: {
    label: "Admin Elevation Token",
    category: "Security & Auth",
    valueType: "string",
    sensitive: true,
    description: "Independent admin credential required by adminGuard for privileged actions.",
    consumers: [
      {
        component: "packages/api/src/router.ts",
        layer: "api",
        usage: "Enforces adminGuard on POST /api/terminal/exec",
      },
      {
        component: "TerminalTabPanel",
        layer: "ui",
        usage: "Elevates PTY command execution via X-Admin-Token",
        tabId: "terminal",
      },
    ],
  },
  CSRF_SECRET: {
    label: "CSRF Signing Secret",
    category: "Security & Auth",
    valueType: "string",
    sensitive: true,
    description: "Optional server-owned Bun CSRF signing key (isolated from R2 S3 child scopes).",
    consumers: [
      {
        component: "src/s3/sealed_r2_handle.ts",
        layer: "server",
        usage: "Scrubbed from ambient S3 environment isolation checks",
      },
    ],
  },
  SPORTSDESK_FAST_SIGNIN_TOKEN: {
    label: "Fast Sign-In Token",
    category: "Security & Auth",
    valueType: "string",
    sensitive: true,
    description: "Optional pre-seeded temporary bookmark sign-in token (min 16 chars).",
    consumers: [
      {
        component: "lib/http_auth.ts",
        layer: "server",
        usage: "Bootstraps temporary fast sign-in bookmark token",
      },
      {
        component: "FastSignInQrCode",
        layer: "ui",
        usage: "Displays QR code for operator sign-in handoff",
      },
    ],
  },
  SPORTSDESK_FAST_SIGNIN_EXPIRES_AT: {
    label: "Fast Sign-In Expiry (ISO)",
    category: "Security & Auth",
    valueType: "string",
    description: "Optional ISO-8601 expiration timestamp for seeded fast sign-in tokens.",
    consumers: [
      {
        component: "lib/http_auth.ts",
        layer: "server",
        usage: "Enforces token expiration window",
      },
    ],
  },
  SPORTSDESK_FAST_SIGNIN_TTL_MINUTES: {
    label: "Fast Sign-In TTL (min)",
    category: "Security & Auth",
    valueType: "number",
    minNumber: 5,
    maxNumber: 43200,
    description: "Default lifetime in minutes for newly minted fast sign-in bookmarks.",
    consumers: [
      {
        component: "lib/http_auth.ts",
        layer: "server",
        usage: "Computes expiry on POST /api/auth/fast-signin",
      },
      {
        component: "OperatorProfileMenu",
        layer: "ui",
        usage: "Mints temporary fast sign-in QR bookmarks",
      },
    ],
  },
  SPORTSDESK_IP_HASH_SALT: {
    label: "IP Redaction HMAC Salt",
    category: "Security & Auth",
    valueType: "string",
    sensitive: true,
    description: "Keyed HMAC salt producing deterministic /24#hash redaction in weblogs.",
    consumers: [
      {
        component: "lib/http_auth.ts",
        layer: "server",
        usage: "Redacts raw customer IPs in AccessLog ingestion",
      },
      {
        component: "SystemLogsPanel",
        layer: "ui",
        usage: "Displays redacted IP forensics in System Logs",
        tabId: "system-logs",
      },
    ],
  },
  SPORTSDESK_AUTH_DISABLED: {
    label: "Local Dev Auth Bypass",
    category: "Security & Auth",
    valueType: "boolean",
    description: "Local dev/test opt-out ONLY; unconditionally ignored when NODE_ENV=production.",
    consumers: [
      {
        component: "packages/backend/src/parsers.ts",
        layer: "server",
        usage: "Evaluated only outside production",
      },
      {
        component: "packages/api/src/router.ts",
        layer: "api",
        usage: "Checked by isExplicitDevAdminBypass in dev/test",
      },
      {
        component: "lib/http_auth.ts",
        layer: "server",
        usage: "Gates local dev authentication bypass",
      },
    ],
  },
  SPORTSDESK_ALLOWED_ORIGINS: {
    label: "Allowed CORS/WS Origins",
    category: "Security & Auth",
    valueType: "list",
    description:
      "Comma-separated allowlist of trusted browser origins for API & WebSocket upgrades.",
    consumers: [
      {
        component: "server.ts",
        layer: "server",
        usage: "Validates Origin headers on cookie-auth mutations & WS upgrades",
      },
    ],
  },
  DATABASE_URL: {
    label: "PostgreSQL Connection URL",
    category: "Storage & R2",
    valueType: "string",
    sensitive: true,
    description: "Optional PostgreSQL DSN for Cloudflare Worker / MCP storage.",
    consumers: [
      {
        component: "src/mcp/handler.ts",
        layer: "server",
        usage: "Worker MCP database connection binding",
      },
      {
        component: "src/s3/sealed_r2_handle.ts",
        layer: "server",
        usage: "Scrubbed from ambient S3 client scope",
      },
    ],
  },
  CLOUDFLARE_API_TOKEN: {
    label: "Cloudflare API Token",
    category: "Storage & R2",
    valueType: "string",
    sensitive: true,
    description: "Server-only Cloudflare API bearer token for MCP & R2 diagnostics.",
    consumers: [
      {
        component: "server/bun_r2_inspect.ts",
        layer: "server",
        usage: "Tracks Cloudflare API token posture in R2 inspection",
      },
      {
        component: "src/mcp/handler.ts",
        layer: "server",
        usage: "Authenticates Cloudflare Worker MCP operations",
      },
    ],
  },
  R2_ACCESS_KEY_ID: {
    label: "R2 Access Key ID",
    category: "Storage & R2",
    valueType: "string",
    sensitive: true,
    description: "S3-compatible R2 access key ID (server-only).",
    consumers: [
      {
        component: "server/bun_r2_inspect.ts",
        layer: "server",
        usage: "Signs S3/R2 artifact requests via sealed handle",
      },
      {
        component: "server.ts",
        layer: "server",
        usage: "Configures R2 archive & inspection routes",
      },
    ],
  },
  R2_SECRET_ACCESS_KEY: {
    label: "R2 Secret Access Key",
    category: "Storage & R2",
    valueType: "string",
    sensitive: true,
    description: "S3-compatible R2 secret key (server-only).",
    consumers: [
      {
        component: "server/bun_r2_inspect.ts",
        layer: "server",
        usage: "Signs S3/R2 artifact requests via sealed handle",
      },
      {
        component: "server.ts",
        layer: "server",
        usage: "Configures R2 archive & inspection routes",
      },
    ],
  },
  R2_SESSION_TOKEN: {
    label: "R2 Session Token",
    category: "Storage & R2",
    valueType: "string",
    sensitive: true,
    description: "Optional temporary STS session token for scoped R2 credentials.",
    consumers: [
      {
        component: "server/bun_r2_inspect.ts",
        layer: "server",
        usage: "Included in sealed S3Client credentials when present",
      },
    ],
  },
  R2_ENDPOINT: {
    label: "R2 S3 Endpoint URL",
    category: "Storage & R2",
    valueType: "url",
    description: "S3-compatible Cloudflare R2 endpoint URI.",
    consumers: [
      {
        component: "server/bun_r2_inspect.ts",
        layer: "server",
        usage: "Connects sealed Bun S3Client to R2 object store",
      },
      {
        component: "R2PipelineTabPanel",
        layer: "ui",
        usage: "Tracks R2 sink freshness and Last-Modified headers",
        tabId: "r2",
      },
    ],
  },
  R2_BUCKET_NAME: {
    label: "R2 Bucket Name",
    category: "Storage & R2",
    valueType: "string",
    description: "Target R2 bucket storing desk reports and ticker snapshots.",
    consumers: [
      {
        component: "R2PipelineTabPanel",
        layer: "ui",
        usage: "Lists bucket sink keys and SLA health",
        tabId: "r2",
      },
      {
        component: "server/bun_r2_inspect.ts",
        layer: "server",
        usage: "Targets R2 bucket for archive & S3 HEAD inspection",
      },
    ],
  },
  TELEGRAM_BOT_TOKEN: {
    label: "Telegram Bot Token",
    category: "Integrations",
    valueType: "string",
    sensitive: true,
    description: "Server-only Telegram bot token for high-priority alert delivery.",
    consumers: [
      {
        component: "server/adapters.ts",
        layer: "server",
        usage: "Dispatches outgoing Telegram risk alerts",
      },
      {
        component: "AlertsTabPanel",
        layer: "ui",
        usage: "Monitors Telegram alert delivery status & DLQ",
        tabId: "alerts",
      },
    ],
  },
  TELEGRAM_WEBHOOK_URL: {
    label: "Telegram Webhook URL",
    category: "Integrations",
    valueType: "url",
    description: "Public HTTPS webhook endpoint referenced by config/wager_tiers.toml.",
    consumers: [
      {
        component: "config/wager_tiers.toml",
        layer: "config",
        usage: "Alert escalation sink endpoint (env:TELEGRAM_WEBHOOK_URL)",
      },
    ],
  },
  TELEGRAM_ALLOWED_CHATS: {
    label: "Telegram Allowed Chats",
    category: "Integrations",
    valueType: "list",
    description: "Comma-separated allowlist of Telegram chat IDs for Worker MCP alerts.",
    consumers: [
      {
        component: "src/mcp/handler.ts",
        layer: "server",
        usage: "Authorizes inbound/outbound Telegram chats in Cloudflare Worker",
      },
    ],
  },
  DESK_ADMIN_TOKEN: {
    label: "Worker MCP Admin Token",
    category: "Security & Auth",
    valueType: "string",
    sensitive: true,
    description: "Cloudflare Worker / MCP administrative bearer token.",
    consumers: [
      {
        component: "src/mcp/handler.ts",
        layer: "server",
        usage: "Authenticates privileged Cloudflare Worker MCP calls",
      },
    ],
  },
  WORKSPACE_VAULT_KEY: {
    label: "Workspace Vault Key",
    category: "Security & Auth",
    valueType: "string",
    sensitive: true,
    description: "Encryption key secret for Cloudflare Worker workspace vault records.",
    consumers: [
      {
        component: "src/mcp/handler.ts",
        layer: "server",
        usage: "Protects encrypted vault payloads in Cloudflare Worker",
      },
    ],
  },
  SPORTSDESK_BIND_HOST: {
    label: "Server Bind Host",
    category: "Server & Runtime",
    valueType: "string",
    description: "Bind interface address used by local runtime verification harness.",
    consumers: [
      {
        component: "scripts/verify_runtime_connections.ts",
        layer: "server",
        usage: "Isolates local verification listener to 127.0.0.1",
      },
    ],
  },
  SPORTSDESK_TLS_CERT_PATH: {
    label: "TLS Certificate Path",
    category: "Security & Auth",
    valueType: "string",
    description: "Optional PEM certificate path for HTTPS/WSS runtime verification.",
    consumers: [
      {
        component: "scripts/verify_runtime_connections.ts",
        layer: "server",
        usage: "Enables --tls verification runs against local cert",
      },
    ],
  },
  SPORTSDESK_TLS_KEY_PATH: {
    label: "TLS Private Key Path",
    category: "Security & Auth",
    valueType: "string",
    description: "Optional PEM private key path paired with SPORTSDESK_TLS_CERT_PATH.",
    consumers: [
      {
        component: "scripts/verify_runtime_connections.ts",
        layer: "server",
        usage: "Pairs with TLS cert during --tls verification runs",
      },
    ],
  },
  F402_OFFLINE_ONLY: {
    label: "Fantasy402 Offline Mode",
    category: "Fantasy402 Gateway",
    valueType: "boolean",
    description: "When 1/true, keeps runtime verification isolated from external Fantasy402 calls.",
    consumers: [
      {
        component: "scripts/verify_runtime_connections.ts",
        layer: "server",
        usage: "Forces offline fixture isolation during runtime verification",
      },
      {
        component: "RankingsTabPanel",
        layer: "ui",
        usage: "Determines local vs live conduit ranking posture",
        tabId: "rankings",
      },
    ],
  },
  SPORTSDESK_CUSTOMER_ROSTER_JSON: {
    label: "Projected Customer Roster Path",
    category: "Telemetry & Thresholds",
    valueType: "string",
    description: "Optional private projected manager roster JSON path.",
    consumers: [
      {
        component: "scripts/verify_runtime_connections.ts",
        layer: "server",
        usage: "Supplies isolated customer roster fixture during verification",
      },
    ],
  },
  SPORTSDESK_CUSTOMER_HISTORY_JSON: {
    label: "Projected Customer History Path",
    category: "Telemetry & Thresholds",
    valueType: "string",
    description:
      "Optional aggregate customer history JSON path generated by project_customer_history.ts.",
    consumers: [
      {
        component: "scripts/verify_runtime_connections.ts",
        layer: "server",
        usage: "Supplies projected retained customer history during verification",
      },
    ],
  },
  SPORTSDESK_SESSION_DB_PATH: {
    label: "Session SQLite DB Path",
    category: "Security & Auth",
    valueType: "string",
    description: "Optional private SQLite path for persistent dashboard sessions.",
    consumers: [
      {
        component: "scripts/verify_runtime_connections.ts",
        layer: "server",
        usage: "Verifies persistent SQLite session storage in isolated temp dir",
      },
    ],
  },
  R2_HEALTHCHECK_KEY: {
    label: "R2 Private Healthcheck Key",
    category: "Storage & R2",
    valueType: "string",
    description: "Optional private object key used for admin S3 HEAD verification.",
    consumers: [
      {
        component: "scripts/verify_runtime_connections.ts",
        layer: "server",
        usage: "Exercises signed S3 HEAD check against fixture key",
      },
    ],
  },
  R2_PUBLIC_URL: {
    label: "R2 Public Base URL",
    category: "Storage & R2",
    valueType: "url",
    description: "Public R2 dev/CDN base URL for published dashboard reports and image provenance.",
    consumers: [
      {
        component: "R2PipelineTabPanel",
        layer: "ui",
        usage: "Builds public artifact inspection links",
        tabId: "r2",
      },
      {
        component: "scripts/verify_runtime_connections.ts",
        layer: "server",
        usage: "Overrides public R2 probe base during local verification",
      },
    ],
  },
}

/** Built-in fallback mirror of `.env.example` keys if filesystem read is unavailable. */
const FALLBACK_ENV_EXAMPLE_KEYS: readonly {
  readonly key: string
  readonly defaultValue: string
}[] = [
  { key: "PORT", defaultValue: "3000" },
  { key: "NODE_ENV", defaultValue: "development" },
  { key: "SPORTSDESK_API_ORIGIN", defaultValue: "" },
  { key: "SPORTSDESK_BRIDGE_STATE_PATH", defaultValue: "" },
  { key: "SPORTSDESK_LIVE_WAGERS_JSON", defaultValue: "" },
  { key: "SHADOW_PRICE_DB", defaultValue: "" },
  { key: "SPORTSDESK_DASHBOARD_TOKEN", defaultValue: "" },
  { key: "SPORTSDESK_OPERATOR_PASSWORD", defaultValue: "" },
  { key: "SPORTSDESK_ADMIN_TOKEN", defaultValue: "" },
  { key: "CSRF_SECRET", defaultValue: "" },
  { key: "SPORTSDESK_FAST_SIGNIN_TOKEN", defaultValue: "" },
  { key: "SPORTSDESK_FAST_SIGNIN_EXPIRES_AT", defaultValue: "" },
  { key: "SPORTSDESK_FAST_SIGNIN_TTL_MINUTES", defaultValue: "1440" },
  { key: "SPORTSDESK_IP_HASH_SALT", defaultValue: "" },
  { key: "SPORTSDESK_AUTH_DISABLED", defaultValue: "" },
  { key: "SPORTSDESK_ALLOWED_ORIGINS", defaultValue: "" },
  { key: "DATABASE_URL", defaultValue: "" },
  { key: "CLOUDFLARE_API_TOKEN", defaultValue: "" },
  { key: "R2_ACCESS_KEY_ID", defaultValue: "" },
  { key: "R2_SECRET_ACCESS_KEY", defaultValue: "" },
  { key: "R2_SESSION_TOKEN", defaultValue: "" },
  { key: "R2_ENDPOINT", defaultValue: "" },
  { key: "R2_BUCKET_NAME", defaultValue: "sportsdesk-ops-reports" },
  { key: "TELEGRAM_BOT_TOKEN", defaultValue: "" },
  { key: "TELEGRAM_WEBHOOK_URL", defaultValue: "" },
  { key: "TELEGRAM_ALLOWED_CHATS", defaultValue: "" },
  { key: "DESK_ADMIN_TOKEN", defaultValue: "" },
  { key: "WORKSPACE_VAULT_KEY", defaultValue: "" },
  { key: "SPORTSDESK_BIND_HOST", defaultValue: "0.0.0.0" },
  { key: "SPORTSDESK_TLS_CERT_PATH", defaultValue: "" },
  { key: "SPORTSDESK_TLS_KEY_PATH", defaultValue: "" },
  { key: "F402_OFFLINE_ONLY", defaultValue: "1" },
  { key: "SPORTSDESK_CUSTOMER_ROSTER_JSON", defaultValue: "" },
  { key: "SPORTSDESK_CUSTOMER_HISTORY_JSON", defaultValue: "" },
  { key: "SPORTSDESK_SESSION_DB_PATH", defaultValue: "" },
  { key: "R2_HEALTHCHECK_KEY", defaultValue: "" },
  { key: "R2_PUBLIC_URL", defaultValue: "https://pub-d061f943df0e4477ba7ff200721eddb1.r2.dev" },
]

/** Canonical build-time constants & runtime variables traced across components. */
const CONSTANT_AND_VARIABLE_SPECS: readonly ConfigItemSpec[] = [
  {
    key: "DASHBOARD_THRESHOLDS.sharp",
    label: "Sharp Percentile Gate",
    kind: "constant",
    category: "Telemetry & Thresholds",
    valueType: "number",
    minNumber: 1,
    maxNumber: 100,
    description: "Composite percentile gate for sharp-action alert dispatch (dashboard.toml).",
    sourceFile: "packages/ui/src/config/dashboard.toml",
    sensitive: false,
    editable: true,
    defaultValue: "70",
    consumers: [
      {
        component: "SurveillanceTabPanel",
        layer: "ui",
        usage: "Displays sharp dispatch percentile threshold",
        tabId: "surveillance",
      },
      {
        component: "CustomersTabPanel",
        layer: "ui",
        usage: "Classifies originator sharp tiers",
        tabId: "customers",
      },
      {
        component: "RiskOverviewPanel",
        layer: "ui",
        usage: "Aggregates sharp cohort exposure",
        tabId: "risk-overview",
      },
    ],
  },
  {
    key: "DASHBOARD_THRESHOLDS.elite_sharp_score",
    label: "Elite Sharp Score Floor",
    kind: "constant",
    category: "Telemetry & Thresholds",
    valueType: "number",
    minNumber: 0,
    maxNumber: 10,
    description: "10-point composite floor for ELITE_SHARP classification.",
    sourceFile: "packages/ui/src/config/dashboard.toml",
    sensitive: false,
    editable: true,
    defaultValue: "8.9",
    consumers: [
      {
        component: "CustomersTabPanel",
        layer: "ui",
        usage: "Assigns ELITE_SHARP tier classification",
        tabId: "customers",
      },
      {
        component: "RankingsTabPanel",
        layer: "ui",
        usage: "Highlights top-scoring downline bettors",
        tabId: "rankings",
      },
    ],
  },
  {
    key: "DASHBOARD_THRESHOLDS.sharp_score",
    label: "Sharp Score Floor",
    kind: "constant",
    category: "Telemetry & Thresholds",
    valueType: "number",
    minNumber: 0,
    maxNumber: 10,
    description: "10-point composite floor for SHARP badge classification.",
    sourceFile: "packages/ui/src/config/dashboard.toml",
    sensitive: false,
    editable: true,
    defaultValue: "7.5",
    consumers: [
      {
        component: "CustomersTabPanel",
        layer: "ui",
        usage: "Separates sharp vs semi-sharp bettors",
        tabId: "customers",
      },
      {
        component: "BettorChurnSimulationPanel",
        layer: "ui",
        usage: "Segments retention cohorts by sharp score",
        tabId: "churn-simulation",
      },
    ],
  },
  {
    key: "DASHBOARD_THRESHOLDS.steam",
    label: "Steam Consensus Move Delta",
    kind: "constant",
    category: "Telemetry & Thresholds",
    valueType: "number",
    minNumber: 0.001,
    maxNumber: 1,
    description: "5.0% implied-probability / consensus line move threshold.",
    sourceFile: "packages/ui/src/config/dashboard.toml",
    sensitive: false,
    editable: true,
    defaultValue: "0.05",
    consumers: [
      {
        component: "ShadowPricingPanel",
        layer: "ui",
        usage: "Triggers counterfactual steam reprice markers",
        tabId: "shadow",
      },
      {
        component: "LiveWagersTabPanel",
        layer: "ui",
        usage: "Flags steam/sharp tickets on live tape",
        tabId: "wagers",
      },
    ],
  },
  {
    key: "DASHBOARD_THRESHOLDS.clv_alert_bps",
    label: "CLV Anomaly Floor (bps)",
    kind: "constant",
    category: "Telemetry & Thresholds",
    valueType: "number",
    minNumber: 1,
    maxNumber: 5000,
    description: "Closing-line value anomaly alert floor in basis points (100 bps = 10c).",
    sourceFile: "packages/ui/src/config/dashboard.toml",
    sensitive: false,
    editable: true,
    defaultValue: "100",
    consumers: [
      {
        component: "LiveWagersTabPanel",
        layer: "ui",
        usage: "Computes CLV ramp highlights",
        tabId: "wagers",
      },
      {
        component: "SurveillanceTabPanel",
        layer: "ui",
        usage: "Displays CLV alert threshold in brief",
        tabId: "surveillance",
      },
    ],
  },
  {
    key: "DASHBOARD_THRESHOLDS.conduit_concentration_pct",
    label: "Conduit Concentration Warning (%)",
    kind: "constant",
    category: "Telemetry & Thresholds",
    valueType: "number",
    minNumber: 1,
    maxNumber: 100,
    description: "Sub-agent top-customer handle concentration warning threshold (%).",
    sourceFile: "packages/ui/src/config/dashboard.toml",
    sensitive: false,
    editable: true,
    defaultValue: "60.0",
    consumers: [
      {
        component: "RankingsTabPanel",
        layer: "ui",
        usage: "Flags concentrated proxy conduits in Downlines",
        tabId: "rankings",
      },
      {
        component: "AgentInspectorModal",
        layer: "ui",
        usage: "Highlights conduit concentration risk",
        tabId: "rankings",
      },
    ],
  },
  {
    key: "DASHBOARD_THRESHOLDS.high_risk_wager_usd",
    label: "High-Risk Ticket Floor ($)",
    kind: "constant",
    category: "Telemetry & Thresholds",
    valueType: "number",
    minNumber: 50,
    maxNumber: 1_000_000,
    description: "Single-ticket USD risk floor for high-risk tape highlighting.",
    sourceFile: "packages/ui/src/config/dashboard.toml",
    sensitive: false,
    editable: true,
    defaultValue: "5000",
    consumers: [
      {
        component: "LiveWagersTabPanel",
        layer: "ui",
        usage: "Marks high-risk tickets on the live tape",
        tabId: "wagers",
      },
      {
        component: "ShiftHandoffModal",
        layer: "ui",
        usage: "Counts critical high-risk tickets in 8h summary",
      },
    ],
  },
  {
    key: "DASHBOARD_FRESHNESS.poll_dashboard_seconds",
    label: "Health & Dashboard Poll Interval (s)",
    kind: "constant",
    category: "UI & Desk Controls",
    valueType: "number",
    minNumber: 5,
    maxNumber: 600,
    description: "Polling cadence for /api/health and dashboard refresh.",
    sourceFile: "packages/ui/src/config/dashboard.toml",
    sensitive: false,
    editable: true,
    defaultValue: "15",
    consumers: [
      { component: "App.tsx", layer: "ui", usage: "Drives 15s /health polling interval" },
      {
        component: "ApiUsageCard",
        layer: "ui",
        usage: "Tracks periodic session API request rate",
        tabId: "surveillance",
      },
    ],
  },
  {
    key: "DASHBOARD_FRESHNESS.poll_wagers_seconds",
    label: "Live Wagers Poll Cadence (s)",
    kind: "constant",
    category: "UI & Desk Controls",
    valueType: "number",
    minNumber: 2,
    maxNumber: 300,
    description: "Fallback HTTP polling cadence when WebSocket stream is idle.",
    sourceFile: "packages/ui/src/config/dashboard.toml",
    sensitive: false,
    editable: true,
    defaultValue: "5",
    consumers: [
      {
        component: "LiveWagersTabPanel",
        layer: "ui",
        usage: "Keeps incoming wager tape hydrated",
        tabId: "wagers",
      },
      {
        component: "BetTickerTabPanel",
        layer: "ui",
        usage: "Refreshes bet ticker wire stream",
        tabId: "bet-ticker",
      },
    ],
  },
  {
    key: "DASHBOARD_FRESHNESS.stale_after_minutes",
    label: "Feed Stale Budget (min)",
    kind: "constant",
    category: "Telemetry & Thresholds",
    valueType: "number",
    minNumber: 1,
    maxNumber: 1440,
    description: "Age in minutes before R2 sinks or feeds transition to stale status.",
    sourceFile: "packages/ui/src/config/dashboard.toml",
    sensitive: false,
    editable: true,
    defaultValue: "30",
    consumers: [
      {
        component: "R2PipelineTabPanel",
        layer: "ui",
        usage: "Evaluates R2 artifact SLA freshness",
        tabId: "r2",
      },
      { component: "App.tsx", layer: "ui", usage: "Computes feed freshness banner badges" },
    ],
  },
  {
    key: "DASHBOARD_PANELS.customers_page_size",
    label: "Profiles Table Page Size",
    kind: "constant",
    category: "UI & Desk Controls",
    valueType: "number",
    minNumber: 10,
    maxNumber: 500,
    description: "Default visible rows per page in the Profiles tab.",
    sourceFile: "packages/ui/src/config/dashboard.toml",
    sensitive: false,
    editable: true,
    defaultValue: "50",
    consumers: [
      {
        component: "CustomersTabPanel",
        layer: "ui",
        usage: "Paginates customer cohort rows",
        tabId: "customers",
      },
    ],
  },
  {
    key: "DASHBOARD_PANELS.dns_cache_capacity",
    label: "DNS Cache Capacity",
    kind: "constant",
    category: "Server & Runtime",
    valueType: "number",
    minNumber: 16,
    maxNumber: 4096,
    description: "Maximum cached host entries tracked in Bun.dns telemetry.",
    sourceFile: "packages/ui/src/config/dashboard.toml",
    sensitive: false,
    editable: true,
    defaultValue: "256",
    consumers: [
      {
        component: "SurveillanceTabPanel",
        layer: "ui",
        usage: "Renders DNS cache utilization gauge",
        tabId: "surveillance",
      },
      {
        component: "packages/api/src/router.ts",
        layer: "api",
        usage: "Serves GET /api/dns and /api/surveillance/dns",
      },
    ],
  },
  {
    key: "SHIFT_HANDOFF_THRESHOLD_SECONDS",
    label: "Shift Handoff Alert Mark (s)",
    kind: "constant",
    category: "UI & Desk Controls",
    valueType: "number",
    minNumber: 3600,
    maxNumber: 86400,
    description: "Elapsed shift duration (28800s = 8h) triggering the subtle handoff reminder.",
    sourceFile: "packages/ui/src/panels/ShiftDurationTimer.tsx",
    sensitive: false,
    editable: true,
    defaultValue: "28800",
    consumers: [
      {
        component: "ShiftDurationTimer",
        layer: "ui",
        usage: "Transitions clock tone at 7.5h warning and 8h due mark",
      },
      {
        component: "ShiftHandoffReminderToast",
        layer: "ui",
        usage: "Prompts operator to initiate handoff after 8h",
      },
      {
        component: "ShiftHandoffModal",
        layer: "ui",
        usage: "Calculates rolling 8-hour handoff metrics",
      },
    ],
  },
  {
    key: "RANKINGS_HEATMAP_BUCKETS",
    label: "Rankings Heat-Map Buckets",
    kind: "constant",
    category: "UI & Desk Controls",
    valueType: "number",
    minNumber: 4,
    maxNumber: 8,
    description: "Discrete intensity levels (0 inactive + 1..5 active log10/P5-P95 scale).",
    sourceFile: "packages/ui/src/panels/rankings_heatmap.ts",
    sensitive: false,
    editable: false,
    defaultValue: "6",
    consumers: [
      {
        component: "RankingsTabPanel",
        layer: "ui",
        usage: "Maps filtered handle volume to data-heat-bucket 0..5 & legend",
        tabId: "rankings",
      },
      {
        component: "packages/ui/src/desk.css",
        layer: "ui",
        usage: "Defines dark/light sequential blue heat-map CSS custom properties",
      },
    ],
  },
  {
    key: "SHIFT_SESSION_LOG_CAP",
    label: "Shift Session Log Ring Cap",
    kind: "variable",
    category: "Server & Runtime",
    valueType: "number",
    minNumber: 50,
    maxNumber: 5000,
    description:
      "Bounded ring-buffer capacity for timestamped operator actions in /api/shift/logs.",
    sourceFile: "packages/api/src/shift_logs.ts",
    sensitive: false,
    editable: true,
    defaultValue: "500",
    consumers: [
      {
        component: "packages/api/src/shift_logs.ts",
        layer: "api",
        usage: "Bounds in-memory session log retention",
      },
      {
        component: "packages/api/src/router.ts",
        layer: "api",
        usage: "Records and serves GET/POST /api/shift/logs",
      },
      { component: "ShiftHandoffModal", layer: "ui", usage: "Renders Session Logs timeline feed" },
    ],
  },
  {
    key: "DASHBOARD_ROUTES.count",
    label: "Registered Canonical API Routes",
    kind: "variable",
    category: "Server & Runtime",
    valueType: "number",
    description:
      "Count of canonical routes declared in DASHBOARD_ROUTES for Bun.serve radix matching.",
    sourceFile: "packages/api/src/bun_routes.ts",
    sensitive: false,
    editable: false,
    defaultValue: "19",
    consumers: [
      {
        component: "packages/api/src/bun_routes.ts",
        layer: "api",
        usage: "Exports DASHBOARD_ROUTES, ExtractRouteParams, and buildApiUrl",
      },
      {
        component: "packages/api/src/bun_server.ts",
        layer: "api",
        usage: "Mounts static root Response and radix-tree routes in Bun.serve",
      },
      {
        component: "packages/api/src/router.ts",
        layer: "api",
        usage: "Binds single-pass safeDecodeRouteParam handlers",
      },
    ],
  },
  {
    key: "DASHBOARD_LEAGUES.primary",
    label: "Primary Monitored Leagues",
    kind: "constant",
    category: "Telemetry & Thresholds",
    valueType: "list",
    description: "Primary sports prioritized in filters, shadow slices, and tape highlights.",
    sourceFile: "packages/ui/src/config/dashboard.toml",
    sensitive: false,
    editable: true,
    defaultValue: "NFL, CFB, NBA, NCAAB",
    consumers: [
      {
        component: "LiveWagersTabPanel",
        layer: "ui",
        usage: "Populates primary sport filters",
        tabId: "wagers",
      },
      {
        component: "ShadowPricingPanel",
        layer: "ui",
        usage: "Groups counterfactual hold-floor slices by league",
        tabId: "shadow",
      },
      {
        component: "RiskOverviewPanel",
        layer: "ui",
        usage: "Breaks down desk risk by sport",
        tabId: "risk-overview",
      },
    ],
  },
  {
    key: "DASHBOARD_META.auto_execute",
    label: "Signal Honesty Auto-Execute",
    kind: "constant",
    category: "Security & Auth",
    valueType: "boolean",
    description: "Invariant locked to false: all risk directives require human operator review.",
    sourceFile: "packages/ui/src/config/dashboard.toml",
    sensitive: false,
    editable: false,
    defaultValue: "false",
    consumers: [
      { component: "App.tsx", layer: "ui", usage: "Enforces human-in-the-loop review invariant" },
      {
        component: "packages/api/src/router.ts",
        layer: "api",
        usage: "Emits autoExecute: false on agent detail responses",
      },
      {
        component: "AgentInspectorModal",
        layer: "ui",
        usage: "Confirms manual review mode in inspector",
        tabId: "rankings",
      },
    ],
  },
  {
    key: "BUN_INSTALL.ignoreScripts",
    label: "Bun Install Ignore Scripts",
    kind: "constant",
    category: "Security & Auth",
    valueType: "boolean",
    description:
      "Blocks package lifecycle scripts during bun install (bunfig.toml & .npmrc ignore-scripts).",
    sourceFile: "bunfig.toml",
    sensitive: false,
    editable: false,
    defaultValue: "true",
    consumers: [
      {
        component: "packages/api/src/npmrc_loader.ts",
        layer: "api",
        usage: "Merges .npmrc ignore-scripts, bunfig.toml, and NPM_CONFIG_IGNORE_SCRIPTS",
      },
      {
        component: "StatusDashboardPanel",
        layer: "ui",
        usage: "Surfaces resolved .npmrc & bunfig install policy",
        tabId: "status-dashboard",
      },
    ],
  },
  {
    key: "BUN_INSTALL.minimumReleaseAge",
    label: "Package Quarantine Window",
    kind: "constant",
    category: "Security & Auth",
    valueType: "string",
    description:
      "Minimum registry release age before bun install accepts newly published packages.",
    sourceFile: "bunfig.toml",
    sensitive: false,
    editable: false,
    defaultValue: "3d",
    consumers: [
      {
        component: "packages/api/src/npmrc_loader.ts",
        layer: "api",
        usage: "Inventories active bunfig.toml [install] security settings",
      },
      {
        component: "StatusDashboardPanel",
        layer: "ui",
        usage: "Displays .npmrc / bunfig precedence layers",
        tabId: "status-dashboard",
      },
    ],
  },
  {
    key: "BUN_INSTALL.lockfile.save",
    label: "Save Text Lockfile (bun.lock)",
    kind: "constant",
    category: "Server & Runtime",
    valueType: "boolean",
    description:
      "Persists text-based bun.lock during bun install ([install.lockfile].save & saveTextLockfile).",
    sourceFile: "bunfig.toml",
    sensitive: false,
    editable: false,
    defaultValue: "true",
    consumers: [
      {
        component: "packages/api/src/npmrc_loader.ts",
        layer: "api",
        usage: "Resolves [install.lockfile] save, print, and frozenLockfile rules",
      },
      {
        component: "StatusDashboardPanel",
        layer: "ui",
        usage: "Displays lockfile & auto-install policy in .npmrc & bunfig tab",
        tabId: "status-dashboard",
      },
    ],
  },
  {
    key: "BUN_RUN.noOrphans",
    label: "Runner Orphan Process Guard",
    kind: "constant",
    category: "Server & Runtime",
    valueType: "boolean",
    description:
      "Terminates Bun and all descendant child processes automatically when the parent process exits ([run].noOrphans).",
    sourceFile: "bunfig.toml",
    sensitive: false,
    editable: false,
    defaultValue: "true",
    consumers: [
      {
        component: "packages/api/src/npmrc_loader.ts",
        layer: "api",
        usage: "Resolves [run] shell, bun, silent, and noOrphans directives",
      },
      {
        component: "StatusDashboardPanel",
        layer: "ui",
        usage: "Displays [run] process supervision posture",
        tabId: "status-dashboard",
      },
    ],
  },
  {
    key: "BUN_LOCKFILE.configVersion",
    label: "BunLockFile Config Version (Linker Strategy)",
    kind: "constant",
    category: "Server & Runtime",
    valueType: "number",
    description:
      "Controls Bun's default install linker strategy: configVersion 1 defaults workspace monorepos to isolated and single-package projects to hoisted; configVersion 0 preserves legacy hoisted installs.",
    sourceFile: "bun.lock",
    sensitive: false,
    editable: false,
    defaultValue: "1",
    consumers: [
      {
        component: "packages/api/src/npmrc_loader.ts",
        layer: "api",
        usage:
          "Reads ./bun.lock configVersion & workspaces to derive default install linker strategy",
      },
      {
        component: "StatusDashboardPanel",
        layer: "ui",
        usage: "Renders BunLockFile & Install Linker Strategy telemetry card",
        tabId: "status-dashboard",
      },
    ],
  },
  {
    key: "BUN_LOCKFILE.lockfileVersion",
    label: "BunLockFile Schema Version",
    kind: "constant",
    category: "Security & Auth",
    valueType: "number",
    description:
      "Text lockfile schema version (v2+ records hasInstallScript and native libc constraints for reproducible supply-chain verification).",
    sourceFile: "bun.lock",
    sensitive: false,
    editable: false,
    defaultValue: "2",
    consumers: [
      {
        component: "packages/api/src/npmrc_loader.ts",
        layer: "api",
        usage:
          "Parses ./bun.lock schema metadata, install-script count, and libc native package counts",
      },
      {
        component: "StatusDashboardPanel",
        layer: "ui",
        usage: "Displays lockfile schema & workspace inventory in .npmrc & bunfig tab",
        tabId: "status-dashboard",
      },
    ],
  },
  {
    key: "BUN_YAML.betFlagsSchemaVersion",
    label: "Bet-Flags YAML Schema Version",
    kind: "constant",
    category: "Telemetry & Thresholds",
    valueType: "number",
    description:
      "Schema version parsed from config/bet-flags.yml via Bun.YAML.parse (YAML 1.2 engine) governing incoming-bet flag predicates and windowed aggregates.",
    sourceFile: "config/bet-flags.yml",
    sensitive: false,
    editable: false,
    defaultValue: "1",
    consumers: [
      {
        component: "packages/api/src/yaml_loader.ts",
        layer: "api",
        usage: "Parses config/bet-flags.yml via Bun.YAML.parse and summarizes rule pack telemetry",
      },
      {
        component: "StatusDashboardPanel",
        layer: "ui",
        usage: "Renders YAML (Bun.YAML) workspace rules table and interactive parser playground",
        tabId: "status-dashboard",
      },
    ],
  },
  {
    key: "BUN_YAML.engine",
    label: "Bun.YAML.parse Runtime Engine",
    kind: "constant",
    category: "Server & Runtime",
    valueType: "string",
    description:
      "Uses Bun's native Rust YAML 1.2 parser (Bun.YAML.parse / Bun.YAML.stringify) under Bun and a zero-dependency YAML 1.2 fallback in Node.js and browser contexts.",
    sourceFile: "packages/contracts/src/bun_yaml.ts",
    sensitive: false,
    editable: false,
    defaultValue: "YAML 1.2 (Bun.YAML.parse)",
    consumers: [
      {
        component: "packages/api/src/yaml_loader.ts",
        layer: "api",
        usage: "Loads workspace YAML configs with prototype-pollution and size-limit guards",
      },
      {
        component: "StatusDashboardPanel",
        layer: "ui",
        usage: "Powers interactive Bun.YAML.parse / Bun.YAML.stringify playground",
        tabId: "status-dashboard",
      },
    ],
  },
  {
    key: "BUN_RUNTIME.surfaceAudit",
    label: "Bun Runtime Surface Audit",
    kind: "constant",
    category: "Server & Runtime",
    valueType: "string",
    description:
      "Read-only introspection of Bun globals (3 tiers), Bun.* Zig/C++ utilities, core Bun.*/bun:* modules, namespaces, classes, constants, symbol kinds, and interactive Bun.markdown.render / AnsiTheme studio.",
    sourceFile: "packages/contracts/src/bun_runtime_surface.ts",
    sensitive: false,
    editable: false,
    defaultValue: "Bun 1.4.x Runtime Surface",
    consumers: [
      {
        component: "packages/api/src/bun_runtime_surface_loader.ts",
        layer: "api",
        usage:
          "Executes deep read-only surface audit (Bun.* kinds, namespaces, classes, bun:* modules) in-process or via scrubbed binary probe",
      },
      {
        component: "StatusDashboardPanel",
        layer: "ui",
        usage:
          "Renders Bun Runtime Surface inspector, Modules & Classes explorer, live exports table, and Bun.markdown.render + AnsiTheme studio",
        tabId: "status-dashboard",
      },
    ],
  },
  {
    key: "BUN_BUNDLER.fileLoader",
    label: "file Loader -> BunFile (Blob) & --compile Pipeline",
    kind: "constant",
    category: "Server & Runtime",
    valueType: "string",
    description:
      "Pairs Bun's --loader:<ext>=file hashed asset emission with lazy Blob-compatible Bun.file() handles, Bun.embeddedFiles in --compile executables, and sibling napi TSFN addon loading.",
    sourceFile: "packages/contracts/src/bun_file_loader.ts",
    sensitive: false,
    editable: false,
    defaultValue: "file -> BunFile (Blob) + napi + --compile",
    consumers: [
      {
        component: "packages/api/src/bun_runtime_surface_loader.ts",
        layer: "api",
        usage:
          "Live-probes Bun.file() Blob compatibility, MIME inference, lazy slicing, Response/FormData streaming, and Bun.embeddedFiles",
      },
      {
        component: "StatusDashboardPanel",
        layer: "ui",
        usage:
          "Renders interactive file Loader -> BunFile & --compile Pipeline builder inside Bun Runtime Surface",
        tabId: "status-dashboard",
      },
    ],
  },
]

function sanitizeConfigInputValue(raw: unknown, maxLength = 512): string {
  const str =
    typeof raw === "string"
      ? raw
      : typeof raw === "number" || typeof raw === "boolean"
        ? String(raw)
        : ""
  return str
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, maxLength)
}

function validateTypedConfigValue(
  spec: ConfigItemSpec,
  value: string,
):
  | { readonly ok: true; readonly normalized: string }
  | { readonly ok: false; readonly error: string } {
  if (value === "") {
    return { ok: true, normalized: "" }
  }

  if (spec.valueType === "number") {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) {
      return { ok: false, error: `${spec.key} must be a valid finite number` }
    }
    if (spec.minNumber !== undefined && parsed < spec.minNumber) {
      return {
        ok: false,
        error: `${spec.key} must be >= ${spec.minNumber}`,
      }
    }
    if (spec.maxNumber !== undefined && parsed > spec.maxNumber) {
      return {
        ok: false,
        error: `${spec.key} must be <= ${spec.maxNumber}`,
      }
    }
    return { ok: true, normalized: String(parsed) }
  }

  if (spec.valueType === "boolean") {
    const lower = value.toLowerCase()
    if (!["1", "0", "true", "false"].includes(lower)) {
      return {
        ok: false,
        error: `${spec.key} must be one of: true, false, 1, 0`,
      }
    }
    return { ok: true, normalized: lower }
  }

  if (spec.valueType === "url") {
    const checked = validateConfigHttpUrl(value)
    if (!checked.ok) {
      return {
        ok: false,
        error: `${spec.key} must be a valid http(s) URL without credentials, query, hash, or backslashes (${checked.code})`,
      }
    }
    return { ok: true, normalized: checked.normalized }
  }

  if (spec.key === "SPORTSDESK_ALLOWED_ORIGINS") {
    const normalizedOrigins: string[] = []
    for (const part of value.split(",")) {
      const origin = part.trim()
      if (origin === "") continue
      const checked = validateConfigHttpUrl(origin, { originOnly: true })
      if (!checked.ok) {
        return {
          ok: false,
          error: `${spec.key} contains invalid origin "${origin}" (${checked.code})`,
        }
      }
      normalizedOrigins.push(checked.normalized)
    }
    return { ok: true, normalized: normalizedOrigins.join(",") }
  }

  return { ok: true, normalized: value }
}

function loadEnvExampleFileText(envExamplePath?: string): string | null {
  try {
    const targetPath = envExamplePath ?? resolve(process.cwd(), ".env.example")
    return readFileSync(targetPath, "utf8")
  } catch {
    return null
  }
}

export interface CreateConfigStatusStoreOptions {
  readonly env?: Record<string, string | undefined> | undefined
  readonly envExampleText?: string | undefined
  readonly envExamplePath?: string | undefined
}

export function createConfigStatusStore(
  options: CreateConfigStatusStoreOptions = {},
): ConfigStatusStore {
  const envSource = options.env ?? process.env
  const rawEnvExample = options.envExampleText ?? loadEnvExampleFileText(options.envExamplePath)
  const parsedEnvEntries = rawEnvExample
    ? parseEnvExample(rawEnvExample)
    : FALLBACK_ENV_EXAMPLE_KEYS.map((entry) => ({
        key: entry.key,
        defaultValue: entry.defaultValue,
        comment: "",
        rawLine: `${entry.key}=${entry.defaultValue}`,
      }))

  // Build unified spec catalog: all .env.example entries + constants + runtime variables
  const specs: ConfigItemSpec[] = []
  const seenKeys = new Set<string>()

  for (const parsed of parsedEnvEntries) {
    if (seenKeys.has(parsed.key)) continue
    seenKeys.add(parsed.key)
    const meta = ENV_SPEC_METADATA[parsed.key]
    const sensitive = meta?.sensitive ?? isSensitiveConfigKey(parsed.key)
    specs.push({
      key: parsed.key,
      label: meta?.label ?? parsed.key,
      kind: "env",
      category: meta?.category ?? "Server & Runtime",
      valueType: meta?.valueType ?? "string",
      description:
        meta?.description ||
        parsed.comment ||
        `Environment variable declared in .env.example (${parsed.key}).`,
      sourceFile: ".env.example",
      sensitive,
      editable: !sensitive,
      defaultValue: sensitive ? "" : parsed.defaultValue,
      minNumber: meta?.minNumber,
      maxNumber: meta?.maxNumber,
      consumers: meta?.consumers ?? [
        { component: "server.ts", layer: "server", usage: "Runtime server environment" },
      ],
    })
  }

  for (const spec of CONSTANT_AND_VARIABLE_SPECS) {
    if (seenKeys.has(spec.key)) continue
    seenKeys.add(spec.key)
    specs.push(spec)
  }

  const specByKey = new Map<string, ConfigItemSpec>(specs.map((spec) => [spec.key, spec]))

  // Runtime non-secret overrides saved from the Status Dashboard
  const overrides = new Map<string, string>()
  let updatedAt = new Date().toISOString()

  function buildSanitizedEnvExample(): string {
    const lines: string[] = [
      "# SportsDesk Ops — Sanitized .env.example",
      "# Generated by Status & Config Dashboard (secrets intentionally blanked)",
      "",
    ]
    let currentCategory: string | null = null
    for (const spec of specs) {
      if (spec.kind !== "env") continue
      if (spec.category !== currentCategory) {
        if (currentCategory !== null) lines.push("")
        lines.push(`# ${spec.category}`)
        currentCategory = spec.category
      }
      if (spec.sensitive) {
        // NEVER emit real secret values in downloadable/previewed .env.example
        lines.push(`${spec.key}=`)
      } else {
        const effective =
          overrides.get(spec.key) ?? envSource[spec.key]?.trim() ?? spec.defaultValue
        const needsQuotes = /\s/.test(effective)
        lines.push(`${spec.key}=${needsQuotes ? JSON.stringify(effective) : effective}`)
      }
    }
    return `${lines.join("\n")}\n`
  }

  function getSnapshot(): ConfigStatusSnapshot {
    const items: ConfigStatusItem[] = []
    const componentMap = new Map<
      string,
      {
        component: string
        layer: "ui" | "api" | "server" | "config"
        tabId?: string | undefined
        items: {
          readonly key: string
          readonly kind: ConfigItemKind
          readonly status: ConfigStatusItem["status"]
          readonly sensitive: boolean
          readonly usage: string
        }[]
      }
    >()

    let envCount = 0
    let constantCount = 0
    let variableCount = 0
    let configuredCount = 0
    let overriddenCount = 0
    let unsetCount = 0
    let secretCount = 0
    let secretConfiguredCount = 0

    for (const spec of specs) {
      if (spec.kind === "env") envCount += 1
      else if (spec.kind === "constant") constantCount += 1
      else variableCount += 1

      const hasOverride = !spec.sensitive && overrides.has(spec.key)
      const rawEnvVal = spec.kind === "env" ? envSource[spec.key] : undefined
      const hasEnvVal = typeof rawEnvVal === "string" && rawEnvVal.trim() !== ""

      let status: ConfigStatusItem["status"]
      let configured: boolean
      let value: string | null

      if (spec.sensitive) {
        secretCount += 1
        configured = hasEnvVal
        if (configured) secretConfiguredCount += 1
        status = configured ? "configured" : "unset"
        value = null // Strictly redacted
      } else if (hasOverride) {
        configured = true
        status = "overridden"
        value = overrides.get(spec.key)!
      } else if (spec.kind === "env") {
        if (hasEnvVal) {
          configured = true
          status = "configured"
          value = rawEnvVal!.trim()
        } else if (spec.defaultValue !== "") {
          configured = true
          status = "default"
          value = spec.defaultValue
        } else {
          configured = false
          status = "unset"
          value = ""
        }
      } else {
        configured = true
        status = "default"
        value = spec.defaultValue
      }

      if (status === "overridden") overriddenCount += 1
      if (configured) configuredCount += 1
      else unsetCount += 1

      items.push({
        key: spec.key,
        label: spec.label,
        kind: spec.kind,
        category: spec.category,
        valueType: spec.valueType,
        description: spec.description,
        sourceFile: spec.sourceFile,
        sensitive: spec.sensitive,
        editable: spec.editable,
        configured,
        overridden: hasOverride,
        status,
        value,
        defaultValue: spec.defaultValue,
        ...(spec.kind === "env"
          ? {
              envExampleLine: `${spec.key}=${spec.sensitive ? "" : spec.defaultValue}`,
            }
          : {}),
        consumers: spec.consumers,
      })

      for (const trace of spec.consumers) {
        let bucket = componentMap.get(trace.component)
        if (!bucket) {
          bucket = {
            component: trace.component,
            layer: trace.layer,
            tabId: trace.tabId,
            items: [],
          }
          componentMap.set(trace.component, bucket)
        }
        if (!bucket.tabId && trace.tabId) {
          bucket.tabId = trace.tabId
        }
        bucket.items.push({
          key: spec.key,
          kind: spec.kind,
          status,
          sensitive: spec.sensitive,
          usage: trace.usage,
        })
      }
    }

    const components: ComponentTraceSummary[] = Array.from(componentMap.values())
      .map((entry) => ({
        component: entry.component,
        layer: entry.layer,
        ...(entry.tabId ? { tabId: entry.tabId } : {}),
        itemCount: entry.items.length,
        envCount: entry.items.filter((i) => i.kind === "env").length,
        constantCount: entry.items.filter((i) => i.kind === "constant").length,
        variableCount: entry.items.filter((i) => i.kind === "variable").length,
        secretCount: entry.items.filter((i) => i.sensitive).length,
        items: entry.items,
      }))
      .sort((a, b) => b.itemCount - a.itemCount || a.component.localeCompare(b.component))

    let npmrcSummary: RedactedNpmrcStatusSummary | undefined
    try {
      npmrcSummary = loadRedactedNpmrcStatusSummary({ env: envSource })
    } catch {
      npmrcSummary = undefined
    }

    let yamlConfig: WorkspaceYamlConfigSummary | undefined
    try {
      yamlConfig = loadWorkspaceYamlConfigSummary()
    } catch {
      yamlConfig = undefined
    }

    let runtimeSurface: BunRuntimeSurfaceAuditSnapshot | undefined
    try {
      runtimeSurface = loadBunRuntimeSurfaceAudit()
    } catch {
      runtimeSurface = undefined
    }

    return {
      items,
      components,
      summary: {
        totalItems: items.length,
        envCount,
        constantCount,
        variableCount,
        configuredCount,
        overriddenCount,
        unsetCount,
        secretCount,
        secretConfiguredCount,
        componentCount: components.length,
      },
      overrides: Object.fromEntries(overrides.entries()),
      envExampleText: buildSanitizedEnvExample(),
      ...(npmrcSummary ? { npmrc: npmrcSummary } : {}),
      ...(yamlConfig ? { yamlConfig } : {}),
      ...(runtimeSurface ? { runtimeSurface } : {}),
      updatedAt,
    }
  }

  function saveOverrides(
    rawOverrides: Readonly<Record<string, unknown>>,
  ): SaveConfigOverridesResult | SaveConfigOverridesError {
    const entries = Object.entries(rawOverrides)
    if (entries.length === 0) {
      return {
        ok: false,
        code: "EMPTY_PAYLOAD",
        error: "Provide at least one non-secret configuration key to save.",
      }
    }

    const validated: [string, string][] = []
    for (const [key, rawVal] of entries) {
      const spec = specByKey.get(key)
      if (!spec) {
        return {
          ok: false,
          code: "INVALID_CONFIG_KEY",
          key,
          error: `Unknown configuration key: ${key}`,
        }
      }
      if (spec.sensitive || !spec.editable) {
        return {
          ok: false,
          code: "SENSITIVE_KEY_READONLY",
          key,
          error: `${key} is read-only and must be configured in server environment secrets.`,
        }
      }

      const sanitized = sanitizeConfigInputValue(rawVal, 512)
      const checked = validateTypedConfigValue(spec, sanitized)
      if (!checked.ok) {
        return {
          ok: false,
          code: "INVALID_CONFIG_VALUE",
          key,
          error: checked.error,
        }
      }
      validated.push([key, checked.normalized])
    }

    const savedKeys: string[] = []
    for (const [key, normalized] of validated) {
      const spec = specByKey.get(key)!
      if (normalized === "" && spec.defaultValue === "") {
        overrides.delete(key)
      } else if (normalized === spec.defaultValue && spec.kind !== "env") {
        overrides.delete(key)
      } else {
        overrides.set(key, normalized)
      }
      savedKeys.push(key)
    }

    updatedAt = new Date().toISOString()
    return {
      ok: true,
      savedKeys,
      snapshot: getSnapshot(),
    }
  }

  function resetOverrides(keys?: readonly string[] | undefined): ConfigStatusSnapshot {
    if (!keys || keys.length === 0) {
      overrides.clear()
    } else {
      for (const key of keys) {
        overrides.delete(key)
      }
    }
    updatedAt = new Date().toISOString()
    return getSnapshot()
  }

  return {
    getSnapshot,
    saveOverrides,
    resetOverrides,
  }
}
