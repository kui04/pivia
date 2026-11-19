import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";

export const SESSION_COOKIE_NAME = "pivia_session";

const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_SESSION_TTL_MS = 1000;
const MAX_ACTIVE_SESSIONS = 256;
const DEFAULT_MAX_AUTH_FAILURES = 10;
const DEFAULT_RATE_WINDOW_MS = 60 * 1000;
const MAX_FAILURE_BUCKETS = 1024;

/** Options for constructing {@link AuthService}. */
export interface AuthServiceOptions {
    /** Plaintext password/token; hashed in memory before storage. */
    password?: string | undefined;
    /** Disable authentication (must only be used when caller explicitly opts out). */
    disabled?: boolean | undefined;
    /** Session cookie lifetime in milliseconds (at least 1000); defaults to 7 days. */
    sessionTtlMs?: number | undefined;
    /** Maximum failed attempts per client key inside `rateWindowMs` (integer >= 1). */
    maxFailures?: number | undefined;
    /** Failure rate-limit window in milliseconds (> 0). */
    rateWindowMs?: number | undefined;
    /** Clock override for deterministic testing. */
    nowMs?: (() => number) | undefined;
}

/** Result of a credential check against {@link AuthService}. */
export type LoginAttemptResult =
    | { readonly ok: true; readonly sessionId: string }
    | { readonly ok: false; readonly reason: "invalid_credentials" }
    | { readonly ok: false; readonly reason: "rate_limited"; readonly retryAfterSeconds: number };

/** Result of checking an incoming request's session cookie or Bearer header. */
export type RequestAuthResult =
    | { readonly authenticated: true }
    | {
          readonly authenticated: false;
          readonly rateLimited: boolean;
          readonly retryAfterSeconds: number;
          readonly badBearer: boolean;
      };

function sha256(value: string): Buffer {
    return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Generate a high-entropy URL-safe startup password/token.
 */
export function generateStartupSecret(): string {
    return randomBytes(24).toString("base64url");
}

/**
 * Returns true when `host` resolves to a bindable loopback address (`localhost`, `::1`, or `127.x.y.z`).
 * Bracketed IPv6 literals such as `"[::1]"` are rejected because `net.Server.listen` fails with `ENOTFOUND`.
 */
export function isLoopbackHost(host: string): boolean {
    const normalized = host.trim().toLowerCase();
    if (normalized === "localhost" || normalized === "::1") {
        return true;
    }
    if (!normalized.startsWith("127.")) {
        return false;
    }
    const octets = normalized.split(".");
    if (octets.length !== 4) {
        return false;
    }
    return octets.every((part) => {
        if (!/^\d+$/.test(part)) {
            return false;
        }
        const value = Number(part);
        return value >= 0 && value <= 255;
    });
}

function buildSecretDigest(options: AuthServiceOptions): Buffer | null {
    if (options.disabled) {
        if (options.password !== undefined) {
            throw new Error("Cannot combine disabled authentication with a password.");
        }
        return null;
    }
    if (options.password !== undefined) {
        if (options.password.length === 0) {
            throw new Error("Password must not be empty.");
        }
        return sha256(options.password);
    }
    throw new Error("AuthService requires a password or disabled: true.");
}

function verifySecretDigest(digest: Buffer, candidate: string): boolean {
    if (candidate.length === 0) {
        return false;
    }
    // Compare fixed-length SHA-256 digests so variable-length passwords never fail timingSafeEqual.
    return timingSafeEqual(sha256(candidate), digest);
}

interface FailureBucket {
    count: number;
    windowStartMs: number;
}

/**
 * Manages password verification, per-client failure rate limiting, and opaque session cookies.
 */
export class AuthService {
    private readonly secretDigest: Buffer | null;
    private readonly sessionTtlMs: number;
    private readonly maxFailures: number;
    private readonly rateWindowMs: number;
    private readonly nowMs: () => number;
    private readonly sessions = new Map<string, number>();
    private readonly failures = new Map<string, FailureBucket>();

    constructor(options: AuthServiceOptions) {
        this.secretDigest = buildSecretDigest(options);

        const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
        if (!Number.isFinite(sessionTtlMs) || sessionTtlMs < MIN_SESSION_TTL_MS) {
            throw new Error(`sessionTtlMs must be at least ${MIN_SESSION_TTL_MS} ms.`);
        }

        const maxFailures = options.maxFailures ?? DEFAULT_MAX_AUTH_FAILURES;
        if (!Number.isInteger(maxFailures) || maxFailures < 1) {
            throw new Error("maxFailures must be a positive integer.");
        }

        const rateWindowMs = options.rateWindowMs ?? DEFAULT_RATE_WINDOW_MS;
        if (!Number.isFinite(rateWindowMs) || rateWindowMs <= 0) {
            throw new Error("rateWindowMs must be a positive finite number.");
        }

        this.sessionTtlMs = sessionTtlMs;
        this.maxFailures = maxFailures;
        this.rateWindowMs = rateWindowMs;
        this.nowMs = options.nowMs ?? (() => Date.now());
    }

    /** True when requests must present a valid session cookie or Bearer credential. */
    get authRequired(): boolean {
        return this.secretDigest !== null;
    }

    /**
     * Atomically check and reserve one failure slot for `clientKey` before running verification.
     * Callers clear `this.failures` on success so concurrent bad attempts cannot race past the limit.
     */
    private reserveAttempt(clientKey: string): { readonly limited: boolean; readonly retryAfterSeconds: number } {
        const now = this.nowMs();
        const existing = this.failures.get(clientKey);

        if (existing) {
            const elapsed = now - existing.windowStartMs;
            if (elapsed >= this.rateWindowMs) {
                this.failures.delete(clientKey);
            } else if (existing.count >= this.maxFailures) {
                const remainingMs = this.rateWindowMs - elapsed;
                return {
                    limited: true,
                    retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)),
                };
            } else {
                existing.count += 1;
                return { limited: false, retryAfterSeconds: 0 };
            }
        }

        // Sweep expired buckets and enforce a hard cap so rotated keys cannot grow RAM without bound.
        if (this.failures.size >= MAX_FAILURE_BUCKETS) {
            for (const [key, bucket] of this.failures) {
                if (now - bucket.windowStartMs >= this.rateWindowMs) {
                    this.failures.delete(key);
                }
            }
            while (this.failures.size >= MAX_FAILURE_BUCKETS) {
                const oldestKey = this.failures.keys().next().value;
                if (oldestKey === undefined) {
                    break;
                }
                this.failures.delete(oldestKey);
            }
        }

        this.failures.set(clientKey, { count: 1, windowStartMs: now });
        return { limited: false, retryAfterSeconds: 0 };
    }

    private verifyWithRateLimit(
        digest: Buffer,
        candidate: string,
        clientKey: string,
    ):
        | { readonly valid: true }
        | { readonly valid: false; readonly rateLimited: boolean; readonly retryAfterSeconds: number } {
        const reservation = this.reserveAttempt(clientKey);
        if (reservation.limited) {
            return { valid: false, rateLimited: true, retryAfterSeconds: reservation.retryAfterSeconds };
        }

        if (verifySecretDigest(digest, candidate)) {
            this.failures.delete(clientKey);
            return { valid: true };
        }

        return { valid: false, rateLimited: false, retryAfterSeconds: 0 };
    }

    private createSession(): string {
        const now = this.nowMs();
        for (const [id, expiresAt] of this.sessions) {
            if (expiresAt <= now) {
                this.sessions.delete(id);
            }
        }
        // Evict the oldest active session if the cap is reached so unclosed tabs cannot grow RAM without bound.
        while (this.sessions.size >= MAX_ACTIVE_SESSIONS) {
            const oldestKey = this.sessions.keys().next().value;
            if (oldestKey === undefined) {
                break;
            }
            this.sessions.delete(oldestKey);
        }
        const sessionId = randomBytes(32).toString("base64url");
        this.sessions.set(sessionId, now + this.sessionTtlMs);
        return sessionId;
    }

    /** Verify a password/token for `clientKey`, returning an opaque session id on success. */
    login(password: string, clientKey: string): LoginAttemptResult {
        if (this.secretDigest === null) {
            return { ok: true, sessionId: this.createSession() };
        }
        const check = this.verifyWithRateLimit(this.secretDigest, password, clientKey);
        if (!check.valid) {
            if (check.rateLimited) {
                return { ok: false, reason: "rate_limited", retryAfterSeconds: check.retryAfterSeconds };
            }
            return { ok: false, reason: "invalid_credentials" };
        }
        return { ok: true, sessionId: this.createSession() };
    }

    /** Revoke an active session id, if present. */
    logout(sessionId: string | undefined): void {
        if (sessionId !== undefined) {
            this.sessions.delete(sessionId);
        }
    }

    /** Check whether a session cookie id is currently valid. */
    isSessionValid(sessionId: string | undefined): boolean {
        if (this.secretDigest === null) {
            return true;
        }
        if (sessionId === undefined || sessionId.length === 0) {
            return false;
        }
        const expiresAt = this.sessions.get(sessionId);
        if (expiresAt === undefined) {
            return false;
        }
        if (expiresAt <= this.nowMs()) {
            this.sessions.delete(sessionId);
            return false;
        }
        return true;
    }

    /** Verify an incoming HTTP request via session cookie or `Authorization: Bearer` header. */
    authenticateRequest(request: FastifyRequest, clientKey: string): RequestAuthResult {
        if (this.secretDigest === null) {
            return { authenticated: true };
        }

        const cookieId = request.cookies[SESSION_COOKIE_NAME];
        if (this.isSessionValid(cookieId)) {
            return { authenticated: true };
        }

        const authHeader = request.headers.authorization;
        if (typeof authHeader === "string") {
            const match = /^Bearer\s+(.+)$/i.exec(authHeader);
            if (match?.[1] !== undefined) {
                const check = this.verifyWithRateLimit(this.secretDigest, match[1], clientKey);
                if (check.valid) {
                    return { authenticated: true };
                }
                if (check.rateLimited) {
                    return {
                        authenticated: false,
                        rateLimited: true,
                        retryAfterSeconds: check.retryAfterSeconds,
                        badBearer: true,
                    };
                }
                return {
                    authenticated: false,
                    rateLimited: false,
                    retryAfterSeconds: 0,
                    badBearer: true,
                };
            }
        }

        return { authenticated: false, rateLimited: false, retryAfterSeconds: 0, badBearer: false };
    }

    /** Attach the opaque session cookie to `reply`. */
    setSessionCookie(reply: FastifyReply, sessionId: string): void {
        reply.setCookie(SESSION_COOKIE_NAME, sessionId, {
            path: "/",
            httpOnly: true,
            sameSite: "strict",
            secure: "auto",
            maxAge: Math.floor(this.sessionTtlMs / 1000),
        });
    }

    /** Clear the session cookie on `reply`. */
    clearSessionCookie(reply: FastifyReply): void {
        reply.clearCookie(SESSION_COOKIE_NAME, {
            path: "/",
            httpOnly: true,
            sameSite: "strict",
            secure: "auto",
        });
    }
}
