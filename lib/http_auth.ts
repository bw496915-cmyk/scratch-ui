/**
 * @file lib/http_auth.ts
 * @description Centralized fail-closed HTTP & WebSocket authentication, CSRF
 * protection, separate admin-exec gating, IP privacy redaction, and terminal
 * command allowlist validation for SportsDesk Ops.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type express from "express";
import { isDashboardAuthRequired } from "../packages/backend/src/index.ts";
import {
  ALLOWED_TERMINAL_COMMAND_HEADS,
  validateTerminalCommand,
} from "../src/lib/shell_boundary.ts";
import { auditConfig } from "./audit_log.ts";

export { ALLOWED_TERMINAL_COMMAND_HEADS, validateTerminalCommand };

export type AuthRole = "OPERATOR" | "ADMIN";

export interface AuthPrincipal {
  readonly authenticated: true;
  readonly operatorId: string;
  readonly role: AuthRole;
  readonly method: "session" | "bearer" | "dev-disabled";
  readonly sessionId?: string | undefined;
  readonly csrfToken?: string | undefined;
}

export interface AuthFailure {
  readonly authenticated: false;
  readonly status: 401 | 403 | 503;
  readonly error: string;
  readonly code:
    | "AUTH_NOT_CONFIGURED"
    | "UNAUTHENTICATED"
    | "CSRF_INVALID"
    | "ADMIN_NOT_CONFIGURED"
    | "ADMIN_TOKEN_REQUIRED"
    | "ADMIN_REQUIRED";
}

export type AuthCheckResult = AuthPrincipal | AuthFailure;

export interface HttpAuthOptions {
  readonly env?: Record<string, string | undefined> | undefined;
  readonly sessionTtlMs?: number | undefined;
  readonly fastSignInTtlMs?: number | undefined;
  readonly rateLimitWindowMs?: number | undefined;
  readonly rateLimitMaxAttempts?: number | undefined;
  readonly now?: (() => number) | undefined;
}

export interface SessionRecord {
  readonly sessionId?: string | undefined;
  readonly csrfToken: string;
  readonly operatorId: string;
  readonly role: AuthRole;
  readonly credentialProof?: string | undefined;
  readonly createdAtMs?: number | undefined;
  expiresAtMs: number;
}

export interface SessionStore {
  get(id: string): SessionRecord | undefined;
  insert(id: string, record: SessionRecord): void;
  delete(id: string): void;
  purgeExpired(now: number): number;
}

interface FastSignInTokenRecord {
  readonly id: string;
  readonly tokenHash: string;
  readonly operatorId: string;
  readonly role: AuthRole;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  useCount: number;
  lastUsedAtMs: number | null;
}

export const SESSION_COOKIE_NAME = "sd_session";
export const CSRF_COOKIE_NAME = "sd_csrf";
export const DASHBOARD_COOKIE_NAMES: readonly string[] = [
  SESSION_COOKIE_NAME,
  CSRF_COOKIE_NAME,
];
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const DEFAULT_RATE_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_RATE_MAX_ATTEMPTS = 10;

export const FAST_SIGNIN_QUERY_PARAM = "fast_signin";
export const FAST_SIGNIN_TOKEN_PREFIX = "sdfast_";
export const DEFAULT_FAST_SIGNIN_TTL_MS = 24 * 60 * 60 * 1000;
export const MIN_FAST_SIGNIN_TTL_MS = 5 * 60 * 1000;
export const MAX_FAST_SIGNIN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ACTIVE_FAST_SIGNIN_TOKENS = 128;
const MIN_ENV_FAST_SIGNIN_TOKEN_LENGTH = 16;

const PROCESS_FALLBACK_IP_SALT = randomBytes(32).toString("hex");

const SAFE_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Public routes that intentionally bypass authentication.
 * Everything else under `/api/*`, `/agent/*`, `/docs/*`, `/mcp`, and `/ws` MUST authenticate.
 */
export function isPublicApiRoute(pathname: string, method: string): boolean {
  const m = method.toUpperCase();
  if ((pathname === "/health" || pathname === "/api/health") && (m === "GET" || m === "HEAD")) {
    return true;
  }
  if (pathname === "/api/auth/me" && m === "GET") {
    return true;
  }
  if ((pathname === "/api/auth/login" || pathname === "/api/auth/logout") && m === "POST") {
    return true;
  }
  return false;
}

/**
 * Build baseline HTTP security headers that harden HTML & API responses while
 * preserving React inline styles and Telegram Mini-App / AI Studio preview embedding.
 * Note: `X-Frame-Options` is intentionally omitted so CSP `frame-ancestors` governs framing.
 */
export function buildSecurityHeaders(options: {
  readonly isProd: boolean;
  readonly isHttps: boolean;
}): Record<string, string> {
  const scriptSrc = options.isProd
    ? "script-src 'self'"
    : "script-src 'self' 'unsafe-inline' 'unsafe-eval'";
  const csp = [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://*.r2.dev",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org telegram: https://*.ai.studio https://*.google.com",
  ].join("; ");

  return {
    "Content-Security-Policy": csp,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    ...(options.isProd || options.isHttps
      ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" }
      : {}),
  };
}

/** Constant-time equality over SHA-256 digests so string length never leaks timing. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/** Parse a `Cookie` header string into a key-value map. */
export function parseCookieHeader(raw: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

/** Digest a raw browser session ID into a non-reversible SHA-256 hex key for storage. */
export function digestSessionId(sessionId: string): string {
  return createHash("sha256").update(sessionId, "utf8").digest("hex");
}

/** Return the recognized dashboard cookie names present in a raw `Cookie` header. */
export function readDashboardCookieNames(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const parsed = parseCookieHeader(raw);
  return DASHBOARD_COOKIE_NAMES.filter((name) => Object.hasOwn(parsed, name));
}

function getIpHashSalt(env: Record<string, string | undefined> = process.env): string {
  const configured = env.SPORTSDESK_IP_HASH_SALT?.trim();
  return configured && configured.length >= 8 ? configured : PROCESS_FALLBACK_IP_SALT;
}

/**
 * Redact a raw IPv4/IPv6 address into a non-reversible `/24` prefix + keyed 8-hex HMAC token.
 * Example: `102.128.164.122` -> `{ redacted: "102.128.164.0/24#a9f3c1e2", subnet24: "102.128.164.0/24", hash: "a9f3c1e2" }`
 */
export function redactIpToSubnetHash(
  rawIp: string,
  salt?: string,
): { readonly redacted: string; readonly subnet24: string; readonly hash: string } {
  const clean = rawIp.trim();
  if (!clean || clean.toLowerCase() === "unknown" || clean === "—") {
    return { redacted: "unknown", subnet24: "unknown", hash: "00000000" };
  }
  // Idempotency: if already redacted (`x.y.z.0/24#<hex>`), preserve cleanly.
  const alreadyRedacted = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.0\/24)#([0-9a-f]{8})$/i.exec(clean);
  if (alreadyRedacted) {
    return {
      redacted: `${alreadyRedacted[1]}#${alreadyRedacted[2]!.toLowerCase()}`,
      subnet24: alreadyRedacted[1]!,
      hash: alreadyRedacted[2]!.toLowerCase(),
    };
  }

  const key = salt ?? getIpHashSalt();
  const hash = createHmac("sha256", key).update(clean, "utf8").digest("hex").slice(0, 8);

  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(clean);
  if (ipv4Match) {
    const subnet24 = `${ipv4Match[1]}.${ipv4Match[2]}.${ipv4Match[3]}.0/24`;
    return {
      redacted: `${subnet24}#${hash}`,
      subnet24,
      hash,
    };
  }

  if (clean.includes(":")) {
    const prefix = clean.split(":").slice(0, 3).join(":") || "::";
    const subnet24 = `${prefix}::/48`;
    return {
      redacted: `${subnet24}#${hash}`,
      subnet24,
      hash,
    };
  }

  return {
    redacted: `net#${hash}`,
    subnet24: "net/unknown",
    hash,
  };
}

/** Replace any raw IPv4 literals inside an arbitrary log/action string with `/24#hash`. */
export function redactRawIpsInText(text: string, salt?: string): string {
  if (!text) return text;
  return text.replace(
    /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b(?!\/24)/g,
    (match) => redactIpToSubnetHash(match, salt).redacted,
  );
}



const DEV_BEARER_PREFIX = "sd_dev_";

/**
 * Strictly dev-only quick sign-in gate.
 * Returns true ONLY when running the explicit local/preview dev server
 * (`NODE_ENV=development` AND `SPORTSDESK_DEV_SERVER=1`). Never true in
 * production, staging, unset NODE_ENV, or unit tests without explicit opt-in.
 */
export function isDevQuickLoginAllowed(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.NODE_ENV === "development" && env.SPORTSDESK_DEV_SERVER === "1";
}

function isHttpsRequest(headers: Headers): boolean {
  const forwarded = headers.get("x-forwarded-proto") ?? "";
  if (forwarded.toLowerCase().split(",")[0]?.trim() === "https") return true;
  return process.env.NODE_ENV === "production";
}

function buildCookieSameSiteAndSecure(
  headers: Headers,
  env: Record<string, string | undefined>,
): string {
  const https = isHttpsRequest(headers);
  const fetchSite = (headers.get("sec-fetch-site") ?? "").toLowerCase();
  const fetchDest = (headers.get("sec-fetch-dest") ?? "").toLowerCase();
  const isCrossSiteFrame =
    fetchSite === "cross-site" ||
    fetchDest === "iframe" ||
    isDevQuickLoginAllowed(env);

  if (https && isCrossSiteFrame) {
    return "; SameSite=None; Secure; Partitioned";
  }
  return `; SameSite=Lax${https ? "; Secure" : ""}`;
}

function getHeader(
  headers: Headers | IncomingMessage["headers"],
  name: string,
): string | null {
  if (headers instanceof Headers) {
    return headers.get(name);
  }
  const val = headers[name.toLowerCase()];
  if (Array.isArray(val)) return val[0] ?? null;
  return typeof val === "string" ? val : null;
}

function extractBearerToken(headers: Headers | IncomingMessage["headers"]): string | null {
  const auth = getHeader(headers, "authorization");
  if (!auth) return null;
  const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return match?.[1]?.trim() || null;
}

function sanitizeOperatorId(raw: unknown, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const cleaned = raw.trim().replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 40);
  return cleaned || fallback;
}

function hashFastSignInToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function clampFastSignInTtlMs(rawMs: unknown, fallbackMs: number): number {
  if (typeof rawMs !== "number" || !Number.isFinite(rawMs)) {
    return Math.min(
      MAX_FAST_SIGNIN_TTL_MS,
      Math.max(MIN_FAST_SIGNIN_TTL_MS, Math.round(fallbackMs)),
    );
  }
  return Math.min(
    MAX_FAST_SIGNIN_TTL_MS,
    Math.max(MIN_FAST_SIGNIN_TTL_MS, Math.round(rawMs)),
  );
}

export function createHttpAuthController(options: HttpAuthOptions = {}) {
  const env = options.env ?? process.env;
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const envFastTtlMinutes = Number(env.SPORTSDESK_FAST_SIGNIN_TTL_MINUTES);
  const defaultFastSignInTtlMs = clampFastSignInTtlMs(
    options.fastSignInTtlMs ??
      (Number.isFinite(envFastTtlMinutes) && envFastTtlMinutes > 0
        ? envFastTtlMinutes * 60 * 1000
        : DEFAULT_FAST_SIGNIN_TTL_MS),
    DEFAULT_FAST_SIGNIN_TTL_MS,
  );
  const rateWindowMs = options.rateLimitWindowMs ?? DEFAULT_RATE_WINDOW_MS;
  const rateMaxAttempts = options.rateLimitMaxAttempts ?? DEFAULT_RATE_MAX_ATTEMPTS;
  const nowFn = options.now ?? Date.now;

  const sessions = new Map<string, SessionRecord>();
  const fastSignInTokens = new Map<string, FastSignInTokenRecord>();
  const loginFailures = new Map<string, number[]>();

  const getOperatorTokens = (): string[] => {
    const tokens: string[] = [];
    const t1 = env.SPORTSDESK_DASHBOARD_TOKEN?.trim();
    const t2 = env.SPORTSDESK_OPERATOR_PASSWORD?.trim();
    if (t1) tokens.push(t1);
    if (t2 && t2 !== t1) tokens.push(t2);
    return tokens;
  };

  const getAdminToken = (): string | null => {
    const t = env.SPORTSDESK_ADMIN_TOKEN?.trim();
    return t && t.length > 0 ? t : null;
  };

  const isAuthRequired = (): boolean => isDashboardAuthRequired(env);

  const isDevQuickLoginEnabled = (): boolean => isDevQuickLoginAllowed(env);

  const isConfigured = (): boolean =>
    getOperatorTokens().length > 0 || getAdminToken() !== null;

  const isAdminConfigured = (): boolean => getAdminToken() !== null;

  const purgeExpiredFastSignInTokens = (): number => {
    const now = nowFn();
    let purged = 0;
    for (const [tokenHash, rec] of fastSignInTokens.entries()) {
      if (rec.expiresAtMs <= now) {
        fastSignInTokens.delete(tokenHash);
        purged += 1;
      }
    }
    return purged;
  };

  const mintFastSignInToken = (input: {
    readonly operatorId: string;
    readonly role: AuthRole;
    readonly ttlMs?: number | undefined;
  }) => {
    purgeExpiredFastSignInTokens();
    while (fastSignInTokens.size >= MAX_ACTIVE_FAST_SIGNIN_TOKENS) {
      const oldestKey = fastSignInTokens.keys().next().value;
      if (oldestKey === undefined) break;
      fastSignInTokens.delete(oldestKey);
    }

    const now = nowFn();
    const ttlMs = clampFastSignInTtlMs(input.ttlMs, defaultFastSignInTtlMs);
    const token = `${FAST_SIGNIN_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const tokenHash = hashFastSignInToken(token);
    const id = `ft_${randomBytes(6).toString("hex")}`;
    const operatorId = sanitizeOperatorId(
      input.operatorId,
      input.role === "ADMIN" ? "desk-admin" : "desk-operator",
    );
    const record: FastSignInTokenRecord = {
      id,
      tokenHash,
      operatorId,
      role: input.role,
      createdAtMs: now,
      expiresAtMs: now + ttlMs,
      useCount: 0,
      lastUsedAtMs: null,
    };
    fastSignInTokens.set(tokenHash, record);
    return {
      token,
      tokenId: record.id,
      operatorId: record.operatorId,
      role: record.role,
      createdAtMs: record.createdAtMs,
      expiresAtMs: record.expiresAtMs,
      expiresAtIso: new Date(record.expiresAtMs).toISOString(),
      ttlMs,
      activeCount: fastSignInTokens.size,
    };
  };

  const verifyFastSignInToken = (
    candidate: string,
  ):
    | {
        readonly ok: true;
        readonly tokenId: string;
        readonly operatorId: string;
        readonly role: AuthRole;
        readonly expiresAtMs: number | null;
      }
    | {
        readonly ok: false;
        readonly reason: "invalid" | "expired";
      } => {
    const trimmed = candidate.trim();
    if (!trimmed) return { ok: false, reason: "invalid" };

    const now = nowFn();
    const candidateHash = hashFastSignInToken(trimmed);
    const rec = fastSignInTokens.get(candidateHash);
    if (rec && constantTimeEqual(rec.tokenHash, candidateHash)) {
      if (rec.expiresAtMs <= now) {
        fastSignInTokens.delete(candidateHash);
        return { ok: false, reason: "expired" };
      }
      rec.useCount += 1;
      rec.lastUsedAtMs = now;
      return {
        ok: true,
        tokenId: rec.id,
        operatorId: rec.operatorId,
        role: rec.role,
        expiresAtMs: rec.expiresAtMs,
      };
    }

    const envFastToken = env.SPORTSDESK_FAST_SIGNIN_TOKEN?.trim() ?? "";
    if (
      envFastToken.length >= MIN_ENV_FAST_SIGNIN_TOKEN_LENGTH &&
      constantTimeEqual(trimmed, envFastToken)
    ) {
      const expiresRaw = env.SPORTSDESK_FAST_SIGNIN_EXPIRES_AT?.trim();
      let expiresAtMs: number | null = null;
      if (expiresRaw) {
        const parsedMs = Date.parse(expiresRaw);
        if (!Number.isFinite(parsedMs) || parsedMs <= now) {
          return { ok: false, reason: "expired" };
        }
        expiresAtMs = parsedMs;
      }
      return {
        ok: true,
        tokenId: "env-fast-token",
        operatorId: "desk-operator",
        role: "OPERATOR",
        expiresAtMs,
      };
    }

    return { ok: false, reason: "invalid" };
  };

  const cleanupSessions = async (): Promise<number> => {
    const now = nowFn();
    let purged = 0;
    for (const [sid, rec] of sessions.entries()) {
      if (rec.expiresAtMs <= now) {
        sessions.delete(sid);
        purged += 1;
      }
    }
    purged += purgeExpiredFastSignInTokens();
    return purged;
  };

  const matchesOperatorToken = (candidate: string): boolean => {
    for (const tok of getOperatorTokens()) {
      if (constantTimeEqual(candidate, tok)) return true;
    }
    return false;
  };

  const matchesAdminToken = (candidate: string): boolean => {
    const adminTok = getAdminToken();
    return adminTok !== null && constantTimeEqual(candidate, adminTok);
  };

  const checkRateLimit = (clientKey: string): { allowed: boolean; retryAfterSec: number } => {
    const now = nowFn();
    const cutoff = now - rateWindowMs;
    const recent = (loginFailures.get(clientKey) ?? []).filter((ts) => ts >= cutoff);
    if (recent.length === 0) {
      loginFailures.delete(clientKey);
    } else {
      loginFailures.set(clientKey, recent);
    }
    if (recent.length >= rateMaxAttempts) {
      const oldest = recent[0] ?? now;
      const retryAfterSec = Math.max(1, Math.ceil((oldest + rateWindowMs - now) / 1000));
      return { allowed: false, retryAfterSec };
    }
    return { allowed: true, retryAfterSec: 0 };
  };

  const recordLoginFailure = (clientKey: string): void => {
    const now = nowFn();
    const cutoff = now - rateWindowMs;
    const recent = (loginFailures.get(clientKey) ?? []).filter((ts) => ts >= cutoff);
    recent.push(now);
    loginFailures.set(clientKey, recent);
  };

  const clientKeyFromHeaders = (headers: Headers | IncomingMessage["headers"]): string => {
    const forwarded = getHeader(headers, "x-forwarded-for");
    const rawIp = forwarded?.split(",")[0]?.trim() || "local";
    return redactIpToSubnetHash(rawIp).redacted;
  };

  const lookupLiveSession = (
    sid: string,
    headers: Headers | IncomingMessage["headers"],
    method: string,
    skipCsrfCheck = false,
  ): AuthCheckResult | null => {
    const rec = sessions.get(sid);
    if (!rec) return null;
    const now = nowFn();
    if (rec.expiresAtMs <= now) {
      sessions.delete(sid);
      return null;
    }
    if (!skipCsrfCheck && !SAFE_HTTP_METHODS.has(method.toUpperCase())) {
      const csrfHeader = getHeader(headers, "x-csrf-token") ?? "";
      if (!csrfHeader || !constantTimeEqual(csrfHeader, rec.csrfToken)) {
        return {
          authenticated: false,
          status: 403,
          code: "CSRF_INVALID",
          error: "Missing or invalid x-csrf-token header",
        };
      }
    }
    rec.expiresAtMs = now + sessionTtlMs;
    return {
      authenticated: true,
      operatorId: rec.operatorId,
      role: rec.role,
      method: "session",
      sessionId: rec.sessionId,
      csrfToken: rec.csrfToken,
    };
  };

  const authenticateHeaders = (
    headers: Headers | IncomingMessage["headers"],
    method: string,
  ): AuthCheckResult => {
    if (!isAuthRequired()) {
      return {
        authenticated: true,
        operatorId: "local-dev",
        role: "OPERATOR",
        method: "dev-disabled",
      };
    }

    const devQuickEnabled = isDevQuickLoginEnabled();

    if (!isConfigured() && !devQuickEnabled) {
      return {
        authenticated: false,
        status: 401,
        code: "AUTH_NOT_CONFIGURED",
        error:
          "Authentication required: server is in fail-closed mode until explicit tokens are configured.",
      };
    }

    const bearer = extractBearerToken(headers);
    if (bearer) {
      if (devQuickEnabled && bearer.startsWith(DEV_BEARER_PREFIX)) {
        const devSid = bearer.slice(DEV_BEARER_PREFIX.length);
        const devMatch = lookupLiveSession(devSid, headers, method, true);
        if (devMatch) return devMatch;
      }
      if (matchesAdminToken(bearer)) {
        return {
          authenticated: true,
          operatorId: "api-admin",
          role: "ADMIN",
          method: "bearer",
        };
      }
      if (matchesOperatorToken(bearer)) {
        return {
          authenticated: true,
          operatorId: "api-operator",
          role: "OPERATOR",
          method: "bearer",
        };
      }
      return {
        authenticated: false,
        status: 401,
        code: "UNAUTHENTICATED",
        error: "Invalid Bearer token",
      };
    }

    const cookies = parseCookieHeader(getHeader(headers, "cookie"));
    const sid = cookies[SESSION_COOKIE_NAME];
    if (sid) {
      const sessionResult = lookupLiveSession(sid, headers, method, false);
      if (sessionResult) return sessionResult;
    }

    return {
      authenticated: false,
      status: 401,
      code: !isConfigured() && !devQuickEnabled ? "AUTH_NOT_CONFIGURED" : "UNAUTHENTICATED",
      error: "Authentication required",
    };
  };

  const enforceAuth = async (req: Request): Promise<Response | null> => {
    const result = authenticateHeaders(req.headers, req.method);
    if (result.authenticated) return null;

    const pathname = new URL(req.url).pathname;
    auditConfig({
      action: "auth_denied",
      details: {
        pathname,
        method: req.method,
        status: result.status,
        code: result.code,
        client: clientKeyFromHeaders(req.headers),
      },
    });
    return Response.json(
      { error: result.error, code: result.code },
      {
        status: result.status,
        headers: {
          "Cache-Control": "no-store",
          ...(result.status === 401
            ? { "WWW-Authenticate": 'Bearer realm="sportsdesk-ops"' }
            : {}),
        },
      },
    );
  };

  const enforceAdminAuth = async (req: Request): Promise<Response | null> => {
    const base = authenticateHeaders(req.headers, req.method);
    if (!base.authenticated) {
      const pathname = new URL(req.url).pathname;
      auditConfig({
        action: "admin_auth_denied",
        details: {
          pathname,
          method: req.method,
          status: base.status,
          code: base.code,
          client: clientKeyFromHeaders(req.headers),
        },
      });
      return Response.json(
        { error: base.error, code: base.code },
        { status: base.status, headers: { "Cache-Control": "no-store" } },
      );
    }

    if (!isAuthRequired()) {
      // Even in dev-disabled mode, if an admin token IS explicitly set, require it on admin exec routes?
      // No: explicit local dev opt-out (`NODE_ENV=development SPORTSDESK_AUTH_DISABLED=1`) permits local testing.
      return null;
    }

    // In explicit dev-server mode (`NODE_ENV=development SPORTSDESK_DEV_SERVER=1`),
    // an authenticated Dev Admin session (`role === "ADMIN"`) may execute allowlisted
    // terminal commands without re-entering a server-injected SPORTSDESK_ADMIN_TOKEN,
    // unless an invalid `x-admin-token` header is explicitly supplied.
    const suppliedAdminHeader = req.headers.get("x-admin-token")?.trim() ?? "";
    if (isDevQuickLoginEnabled() && base.role === "ADMIN") {
      if (!suppliedAdminHeader) {
        return null;
      }
      if (isAdminConfigured() && !matchesAdminToken(suppliedAdminHeader)) {
        auditConfig({
          action: "admin_elevation_denied",
          details: {
            pathname: new URL(req.url).pathname,
            operatorId: base.operatorId,
            role: base.role,
            reason: "invalid_x_admin_token",
            client: clientKeyFromHeaders(req.headers),
          },
        });
        return Response.json(
          {
            error: "Invalid x-admin-token header",
            code: "ADMIN_REQUIRED",
          },
          { status: 403, headers: { "Cache-Control": "no-store" } },
        );
      }
      return null;
    }

    if (!isAdminConfigured()) {
      auditConfig({
        action: "admin_gate_unconfigured",
        details: {
          pathname: new URL(req.url).pathname,
          operatorId: base.operatorId,
        },
      });
      return Response.json(
        {
          error:
            "Admin execution gate is disabled: SPORTSDESK_ADMIN_TOKEN is not configured on the server.",
          code: "ADMIN_NOT_CONFIGURED",
        },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }

    const adminHeader = req.headers.get("x-admin-token")?.trim() ?? "";
    if (!adminHeader) {
      auditConfig({
        action: "admin_elevation_denied",
        details: {
          pathname: new URL(req.url).pathname,
          operatorId: base.operatorId,
          role: base.role,
          reason: "missing_x_admin_token",
          client: clientKeyFromHeaders(req.headers),
        },
      });
      return Response.json(
        {
          error: "Missing required x-admin-token header",
          code: "ADMIN_TOKEN_REQUIRED",
        },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }

    if (!matchesAdminToken(adminHeader)) {
      auditConfig({
        action: "admin_elevation_denied",
        details: {
          pathname: new URL(req.url).pathname,
          operatorId: base.operatorId,
          role: base.role,
          reason: "invalid_x_admin_token",
          client: clientKeyFromHeaders(req.headers),
        },
      });
      return Response.json(
        {
          error: "Invalid x-admin-token header",
          code: "ADMIN_REQUIRED",
        },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }

    return null;
  };

  const verifyWebSocketUpgrade = (req: IncomingMessage): AuthCheckResult => {
    const headerAuth = authenticateHeaders(req.headers, "GET");
    if (headerAuth.authenticated) return headerAuth;

    // Dev-server fallback for third-party iframes that block WS upgrade cookies
    if (isDevQuickLoginEnabled() && req.url) {
      try {
        const parsed = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
        const devTok = parsed.searchParams.get("dev_session")?.trim() ?? "";
        if (devTok.startsWith(DEV_BEARER_PREFIX)) {
          const devSid = devTok.slice(DEV_BEARER_PREFIX.length);
          const match = lookupLiveSession(devSid, req.headers, "GET", true);
          if (match) return match;
        }
      } catch {
        // ignore malformed upgrade URL
      }
    }
    return headerAuth;
  };

  const handleLogin = async (req: Request): Promise<Response> => {
    if (!isAuthRequired()) {
      return Response.json(
        {
          ok: true,
          authenticated: true,
          authRequired: false,
          operatorId: "local-dev",
          role: "OPERATOR",
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    let body: {
      token?: unknown;
      password?: unknown;
      fastToken?: unknown;
      operatorId?: unknown;
      devQuickLogin?: unknown;
      mintFastSignInOnly?: unknown;
      ttlMinutes?: unknown;
      role?: unknown;
    } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return Response.json(
        { ok: false, error: "Invalid JSON body" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }

    const devQuickEnabled = isDevQuickLoginEnabled();
    const rawFastToken =
      typeof body.fastToken === "string" ? body.fastToken.trim() : "";

    if (rawFastToken.length > 0) {
      const clientKey = clientKeyFromHeaders(req.headers);
      const rate = checkRateLimit(clientKey);
      if (!rate.allowed) {
        auditConfig({
          action: "auth_fast_signin_rate_limited",
          details: { client: clientKey, retryAfterSec: rate.retryAfterSec },
        });
        return Response.json(
          {
            ok: false,
            authenticated: false,
            error: "Too many failed sign-in attempts. Try again shortly.",
          },
          {
            status: 429,
            headers: {
              "Cache-Control": "no-store",
              "Retry-After": String(rate.retryAfterSec),
            },
          },
        );
      }

      const verified = verifyFastSignInToken(rawFastToken);
      if (!verified.ok) {
        recordLoginFailure(clientKey);
        auditConfig({
          action: "auth_fast_signin_failed",
          details: { reason: verified.reason, client: clientKey },
        });
        return Response.json(
          {
            ok: false,
            authenticated: false,
            code:
              verified.reason === "expired"
                ? "FAST_SIGNIN_EXPIRED"
                : "FAST_SIGNIN_INVALID",
            error:
              verified.reason === "expired"
                ? "Fast Sign-In token has expired. Sign in manually to generate a new bookmark link."
                : "Invalid or revoked Fast Sign-In token.",
          },
          { status: 401, headers: { "Cache-Control": "no-store" } },
        );
      }

      const now = nowFn();
      const sessionId = randomBytes(32).toString("base64url");
      const csrfToken = randomBytes(24).toString("base64url");
      const operatorId = sanitizeOperatorId(body.operatorId, verified.operatorId);

      sessions.set(sessionId, {
        sessionId,
        csrfToken,
        operatorId,
        role: verified.role,
        createdAtMs: now,
        expiresAtMs: now + sessionTtlMs,
      });
      loginFailures.delete(clientKey);

      auditConfig({
        action: "auth_fast_signin_success",
        details: {
          tokenId: verified.tokenId,
          operatorId,
          role: verified.role,
          client: clientKey,
        },
      });

      const maxAgeSec = Math.floor(sessionTtlMs / 1000);
      const cookieFlags = buildCookieSameSiteAndSecure(req.headers, env);
      const headers = new Headers({ "Cache-Control": "no-store" });
      headers.append(
        "Set-Cookie",
        `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; Max-Age=${maxAgeSec}${cookieFlags}`,
      );
      headers.append(
        "Set-Cookie",
        `${CSRF_COOKIE_NAME}=${encodeURIComponent(csrfToken)}; Path=/; Max-Age=${maxAgeSec}${cookieFlags}`,
      );

      return Response.json(
        {
          ok: true,
          authenticated: true,
          authRequired: true,
          authConfigured: isConfigured(),
          devQuickLoginAvailable: devQuickEnabled,
          fastSignIn: true,
          operatorId,
          role: verified.role,
          adminConfigured:
            isAdminConfigured() || (devQuickEnabled && verified.role === "ADMIN"),
          fastTokenExpiresAt:
            verified.expiresAtMs !== null
              ? new Date(verified.expiresAtMs).toISOString()
              : null,
          ...(devQuickEnabled
            ? { devSessionToken: `${DEV_BEARER_PREFIX}${sessionId}`, csrfToken }
            : {}),
        },
        { headers },
      );
    }

    const wantsDevQuickLogin = body.devQuickLogin === true;
    const wantsMintFastOnly = body.mintFastSignInOnly === true;
    const requestedTtlMs =
      typeof body.ttlMinutes === "number" && Number.isFinite(body.ttlMinutes)
        ? body.ttlMinutes * 60 * 1000
        : undefined;

    if (wantsDevQuickLogin && devQuickEnabled) {
      const role: AuthRole = body.role === "ADMIN" ? "ADMIN" : "OPERATOR";
      const operatorId = sanitizeOperatorId(
        body.operatorId,
        role === "ADMIN" ? "dev-admin" : "dev-operator",
      );

      if (wantsMintFastOnly) {
        const minted = mintFastSignInToken({
          operatorId,
          role,
          ttlMs: requestedTtlMs,
        });
        auditConfig({
          action: "auth_fast_signin_minted",
          details: {
            via: "dev_quick_login",
            tokenId: minted.tokenId,
            operatorId: minted.operatorId,
            role: minted.role,
            expiresAtIso: minted.expiresAtIso,
            client: clientKeyFromHeaders(req.headers),
          },
        });
        return Response.json(
          {
            ok: true,
            authenticated: false,
            mintFastSignInOnly: true,
            paramName: FAST_SIGNIN_QUERY_PARAM,
            fastToken: minted.token,
            tokenId: minted.tokenId,
            operatorId: minted.operatorId,
            role: minted.role,
            expiresAtIso: minted.expiresAtIso,
            ttlSeconds: Math.floor(minted.ttlMs / 1000),
            activeCount: minted.activeCount,
          },
          { status: 201, headers: { "Cache-Control": "no-store" } },
        );
      }

      const now = nowFn();
      const sessionId = randomBytes(32).toString("base64url");
      const csrfToken = randomBytes(24).toString("base64url");

      sessions.set(sessionId, {
        sessionId,
        csrfToken,
        operatorId,
        role,
        createdAtMs: now,
        expiresAtMs: now + sessionTtlMs,
      });

      auditConfig({
        action: "auth_dev_quick_login",
        details: { operatorId, role, client: clientKeyFromHeaders(req.headers) },
      });

      const maxAgeSec = Math.floor(sessionTtlMs / 1000);
      const cookieFlags = buildCookieSameSiteAndSecure(req.headers, env);
      const headers = new Headers({ "Cache-Control": "no-store" });
      headers.append(
        "Set-Cookie",
        `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; Max-Age=${maxAgeSec}${cookieFlags}`,
      );
      headers.append(
        "Set-Cookie",
        `${CSRF_COOKIE_NAME}=${encodeURIComponent(csrfToken)}; Path=/; Max-Age=${maxAgeSec}${cookieFlags}`,
      );

      return Response.json(
        {
          ok: true,
          authenticated: true,
          authRequired: true,
          devQuickLogin: true,
          operatorId,
          role,
          adminConfigured: isAdminConfigured() || role === "ADMIN",
          devSessionToken: `${DEV_BEARER_PREFIX}${sessionId}`,
          csrfToken,
        },
        { headers },
      );
    }

    if (!isConfigured()) {
      return Response.json(
        {
          ok: false,
          authenticated: false,
          code: "AUTH_NOT_CONFIGURED",
          error:
            "Authentication required: set SPORTSDESK_DASHBOARD_TOKEN or SPORTSDESK_ADMIN_TOKEN on the server.",
        },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    }

    const clientKey = clientKeyFromHeaders(req.headers);
    const rate = checkRateLimit(clientKey);
    if (!rate.allowed) {
      auditConfig({
        action: "auth_login_rate_limited",
        details: { client: clientKey, retryAfterSec: rate.retryAfterSec },
      });
      return Response.json(
        {
          ok: false,
          error: "Too many failed login attempts. Try again shortly.",
        },
        {
          status: 429,
          headers: {
            "Cache-Control": "no-store",
            "Retry-After": String(rate.retryAfterSec),
          },
        },
      );
    }

    const secret =
      typeof body.token === "string" && body.token.trim().length > 0
        ? body.token.trim()
        : typeof body.password === "string"
          ? body.password.trim()
          : "";

    let role: AuthRole | null = null;
    if (secret && matchesAdminToken(secret)) {
      role = "ADMIN";
    } else if (secret && matchesOperatorToken(secret)) {
      role = "OPERATOR";
    }

    if (!role) {
      recordLoginFailure(clientKey);
      auditConfig({
        action: "auth_login_failed",
        details: { client: clientKey },
      });
      return Response.json(
        { ok: false, authenticated: false, error: "Invalid credentials" },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    }

    const operatorId = sanitizeOperatorId(
      body.operatorId,
      role === "ADMIN" ? "desk-admin" : "desk-operator",
    );
    loginFailures.delete(clientKey);

    if (wantsMintFastOnly) {
      const minted = mintFastSignInToken({
        operatorId,
        role,
        ttlMs: requestedTtlMs,
      });
      auditConfig({
        action: "auth_fast_signin_minted",
        details: {
          via: "credential_login",
          tokenId: minted.tokenId,
          operatorId: minted.operatorId,
          role: minted.role,
          expiresAtIso: minted.expiresAtIso,
          client: clientKey,
        },
      });
      return Response.json(
        {
          ok: true,
          authenticated: false,
          mintFastSignInOnly: true,
          paramName: FAST_SIGNIN_QUERY_PARAM,
          fastToken: minted.token,
          tokenId: minted.tokenId,
          operatorId: minted.operatorId,
          role: minted.role,
          expiresAtIso: minted.expiresAtIso,
          ttlSeconds: Math.floor(minted.ttlMs / 1000),
          activeCount: minted.activeCount,
        },
        { status: 201, headers: { "Cache-Control": "no-store" } },
      );
    }

    const now = nowFn();
    const sessionId = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(24).toString("base64url");

    sessions.set(sessionId, {
      sessionId,
      csrfToken,
      operatorId,
      role,
      createdAtMs: now,
      expiresAtMs: now + sessionTtlMs,
    });

    auditConfig({
      action: "auth_login_success",
      details: { operatorId, role, client: clientKey },
    });

    const maxAgeSec = Math.floor(sessionTtlMs / 1000);
    const cookieFlags = buildCookieSameSiteAndSecure(req.headers, env);
    const headers = new Headers({ "Cache-Control": "no-store" });
    headers.append(
      "Set-Cookie",
      `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; Max-Age=${maxAgeSec}${cookieFlags}`,
    );
    headers.append(
      "Set-Cookie",
      `${CSRF_COOKIE_NAME}=${encodeURIComponent(csrfToken)}; Path=/; Max-Age=${maxAgeSec}${cookieFlags}`,
    );

    return Response.json(
      {
        ok: true,
        authenticated: true,
        authRequired: true,
        operatorId,
        role,
        adminConfigured: isAdminConfigured(),
        ...(devQuickEnabled
          ? { devSessionToken: `${DEV_BEARER_PREFIX}${sessionId}`, csrfToken }
          : {}),
      },
      { headers },
    );
  };

  const handleLogout = async (req: Request): Promise<Response> => {
    const cookies = parseCookieHeader(req.headers.get("cookie"));
    const bearer = extractBearerToken(req.headers);
    const sid =
      cookies[SESSION_COOKIE_NAME] ??
      (isDevQuickLoginEnabled() && bearer?.startsWith(DEV_BEARER_PREFIX)
        ? bearer.slice(DEV_BEARER_PREFIX.length)
        : undefined);
    if (sid) {
      const existing = sessions.get(sid);
      sessions.delete(sid);
      if (existing) {
        auditConfig({
          action: "auth_logout",
          details: { operatorId: existing.operatorId, role: existing.role },
        });
      }
    }
    const cookieFlags = buildCookieSameSiteAndSecure(req.headers, env);
    const headers = new Headers({ "Cache-Control": "no-store" });
    headers.append(
      "Set-Cookie",
      `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0${cookieFlags}`,
    );
    headers.append(
      "Set-Cookie",
      `${CSRF_COOKIE_NAME}=; Path=/; Max-Age=0${cookieFlags}`,
    );
    return Response.json({ ok: true, authenticated: false }, { headers });
  };

  const handleMe = async (req: Request): Promise<Response> => {
    const required = isAuthRequired();
    const configured = isConfigured();
    const adminConfigured = isAdminConfigured();
    const devQuickLoginAvailable = isDevQuickLoginEnabled();
    const result = authenticateHeaders(req.headers, "GET");

    if (result.authenticated) {
      return Response.json(
        {
          authenticated: true,
          authRequired: required,
          authConfigured: configured,
          adminConfigured:
            adminConfigured || (devQuickLoginAvailable && result.role === "ADMIN"),
          devQuickLoginAvailable,
          operatorId: result.operatorId,
          role: result.role,
          method: result.method,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    return Response.json(
      {
        authenticated: false,
        authRequired: required,
        authConfigured: configured,
        adminConfigured,
        devQuickLoginAvailable,
        operatorId: null,
        role: null,
        code: result.code,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  };

  const handleFastSignInCreate = async (req: Request): Promise<Response> => {
    const auth = authenticateHeaders(req.headers, "POST");
    if (!auth.authenticated) {
      return Response.json(
        { ok: false, error: auth.error, code: auth.code },
        { status: auth.status, headers: { "Cache-Control": "no-store" } },
      );
    }

    let body: {
      ttlMinutes?: unknown;
      role?: unknown;
      operatorId?: unknown;
    } = {};
    try {
      const text = await req.text();
      if (text.trim().length > 0) {
        body = JSON.parse(text) as typeof body;
      }
    } catch {
      return Response.json(
        { ok: false, error: "Invalid JSON body" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }

    // Never permit privilege escalation: only ADMIN callers may mint ADMIN fast tokens.
    const requestedRole: AuthRole =
      body.role === "ADMIN" && auth.role === "ADMIN" ? "ADMIN" : "OPERATOR";
    const ttlMinutes =
      typeof body.ttlMinutes === "number" && Number.isFinite(body.ttlMinutes)
        ? body.ttlMinutes
        : undefined;
    const ttlMs =
      ttlMinutes !== undefined ? ttlMinutes * 60 * 1000 : defaultFastSignInTtlMs;
    const operatorId = sanitizeOperatorId(body.operatorId, auth.operatorId);

    const minted = mintFastSignInToken({
      operatorId,
      role: requestedRole,
      ttlMs,
    });

    auditConfig({
      action: "auth_fast_signin_minted",
      details: {
        tokenId: minted.tokenId,
        operatorId: minted.operatorId,
        role: minted.role,
        expiresAtIso: minted.expiresAtIso,
        client: clientKeyFromHeaders(req.headers),
      },
    });

    return Response.json(
      {
        ok: true,
        paramName: FAST_SIGNIN_QUERY_PARAM,
        token: minted.token,
        tokenId: minted.tokenId,
        operatorId: minted.operatorId,
        role: minted.role,
        expiresAtIso: minted.expiresAtIso,
        ttlSeconds: Math.floor(minted.ttlMs / 1000),
        activeCount: minted.activeCount,
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  };

  const handleFastSignInList = async (req: Request): Promise<Response> => {
    const auth = authenticateHeaders(req.headers, "GET");
    if (!auth.authenticated) {
      return Response.json(
        { ok: false, error: auth.error, code: auth.code },
        { status: auth.status, headers: { "Cache-Control": "no-store" } },
      );
    }

    purgeExpiredFastSignInTokens();
    const tokens = [];
    for (const rec of fastSignInTokens.values()) {
      if (auth.role !== "ADMIN" && rec.operatorId !== auth.operatorId) continue;
      tokens.push({
        tokenId: rec.id,
        operatorId: rec.operatorId,
        role: rec.role,
        createdAtIso: new Date(rec.createdAtMs).toISOString(),
        expiresAtIso: new Date(rec.expiresAtMs).toISOString(),
        useCount: rec.useCount,
        lastUsedAtIso:
          rec.lastUsedAtMs !== null
            ? new Date(rec.lastUsedAtMs).toISOString()
            : null,
      });
    }

    return Response.json(
      {
        ok: true,
        paramName: FAST_SIGNIN_QUERY_PARAM,
        activeCount: tokens.length,
        tokens,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  };

  const handleFastSignInRevoke = async (req: Request): Promise<Response> => {
    const auth = authenticateHeaders(req.headers, "DELETE");
    if (!auth.authenticated) {
      return Response.json(
        { ok: false, error: auth.error, code: auth.code },
        { status: auth.status, headers: { "Cache-Control": "no-store" } },
      );
    }

    const url = new URL(req.url);
    const targetTokenId = url.searchParams.get("tokenId")?.trim() || null;
    const revokeAll =
      auth.role === "ADMIN" && url.searchParams.get("scope") === "all";

    let revokedCount = 0;
    for (const [tokenHash, rec] of fastSignInTokens.entries()) {
      const canRevoke =
        revokeAll ||
        rec.operatorId === auth.operatorId ||
        (auth.role === "ADMIN" && targetTokenId !== null);
      if (!canRevoke) continue;
      if (targetTokenId && rec.id !== targetTokenId) continue;
      fastSignInTokens.delete(tokenHash);
      revokedCount += 1;
    }

    auditConfig({
      action: "auth_fast_signin_revoked",
      details: {
        operatorId: auth.operatorId,
        role: auth.role,
        targetTokenId,
        revokedCount,
        client: clientKeyFromHeaders(req.headers),
      },
    });

    return Response.json(
      {
        ok: true,
        revokedCount,
        remainingCount: fastSignInTokens.size,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  };

  const getSessionCsrfToken = (sessionId: string): string | null => {
    const rec = sessions.get(sessionId);
    if (!rec) return null;
    if (rec.expiresAtMs <= nowFn()) {
      sessions.delete(sessionId);
      return null;
    }
    return rec.csrfToken;
  };

  const authenticateRequest = (req: Request): AuthCheckResult =>
    authenticateHeaders(req.headers, req.method);

  const refreshSecureSessionCookie = (req: Request): void => {
    const cookies = parseCookieHeader(req.headers.get("cookie"));
    const sid = cookies[SESSION_COOKIE_NAME];
    if (!sid) return;
    const rec = sessions.get(sid);
    if (!rec) return;
    const now = nowFn();
    if (rec.expiresAtMs <= now) {
      sessions.delete(sid);
      return;
    }
    rec.expiresAtMs = now + sessionTtlMs;
  };

  return {
    isAuthRequired,
    isConfigured,
    isAdminConfigured,
    authenticateHeaders,
    authenticateRequest,
    refreshSecureSessionCookie,
    enforceAuth,
    enforceAdminAuth,
    verifyWebSocketUpgrade,
    cleanupSessions,
    getSessionCsrfToken,
    mintFastSignInToken,
    auth: {
      login: handleLogin,
      logout: handleLogout,
      me: handleMe,
      fastSignInCreate: handleFastSignInCreate,
      fastSignInList: handleFastSignInList,
      fastSignInRevoke: handleFastSignInRevoke,
    },
  };
}

export type HttpAuthController = ReturnType<typeof createHttpAuthController>;

function expressReqToWebAuthRequest(
  req: express.Request,
  fallbackPort = 3000,
): Request {
  const origin = `http://${req.headers.host || `127.0.0.1:${fallbackPort}`}`;
  const url = new URL(req.originalUrl, origin);
  const headers = new Headers();
  for (const [key, val] of Object.entries(req.headers)) {
    if (Array.isArray(val)) {
      for (const v of val) headers.append(key, v);
    } else if (val !== undefined) {
      headers.set(key, val);
    }
  }
  return new Request(url.toString(), {
    method: req.method.toUpperCase(),
    headers,
  });
}

async function writeWebResponseToExpress(
  res: express.Response,
  webRes: Response,
): Promise<void> {
  res.status(webRes.status);
  webRes.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "transfer-encoding") {
      res.setHeader(key, value);
    }
  });
  const buf = Buffer.from(await webRes.arrayBuffer());
  res.send(buf);
}

/**
 * Create an Express middleware that enforces fail-closed (`401`) authentication
 * and CSRF verification for cookie-authenticated writes.
 */
export function createEnforceAuthMiddleware(
  controller: HttpAuthController,
  options?: { readonly fallbackPort?: number | undefined },
): express.RequestHandler {
  const fallbackPort = options?.fallbackPort ?? 3000;
  return async (req, res, next) => {
    try {
      const denied = await controller.enforceAuth(
        expressReqToWebAuthRequest(req, fallbackPort),
      );
      if (denied) {
        await writeWebResponseToExpress(res, denied);
        return;
      }
      next();
    } catch (err) {
      res.status(401).json({
        error: err instanceof Error ? err.message : "Authentication required",
        code: "UNAUTHENTICATED",
      });
    }
  };
}

/**
 * Create an Express middleware enforcing separate admin elevation (`SPORTSDESK_ADMIN_TOKEN`).
 */
export function createEnforceAdminMiddleware(
  controller: HttpAuthController,
  options?: { readonly fallbackPort?: number | undefined },
): express.RequestHandler {
  const fallbackPort = options?.fallbackPort ?? 3000;
  return async (req, res, next) => {
    try {
      const denied = await controller.enforceAdminAuth(
        expressReqToWebAuthRequest(req, fallbackPort),
      );
      if (denied) {
        await writeWebResponseToExpress(res, denied);
        return;
      }
      next();
    } catch (err) {
      res.status(403).json({
        error: err instanceof Error ? err.message : "Admin elevation required",
        code: "ADMIN_REQUIRED",
      });
    }
  };
}

/** Process-default fail-closed HTTP auth controller bound to live `process.env`. */
export const defaultHttpAuth = createHttpAuthController();

/**
 * Default fail-closed `enforceAuth` hook returning `401` unless explicit tokens
 * are configured and valid credentials (session cookie + CSRF or Bearer token) are provided.
 */
export const enforceAuth = (req: Request): Promise<Response | null> =>
  defaultHttpAuth.enforceAuth(req);

