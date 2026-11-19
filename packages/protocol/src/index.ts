import type { FileEntry } from "@earendil-works/pi-coding-agent";

/** Health status payload returned by `GET /api/health`. */
export interface HealthResponse {
    readonly status: "ok";
    readonly version: string;
}

/** Machine-readable error codes returned by HTTP endpoints. */
export type ApiErrorCode =
    "invalid_request" | "unauthorized" | "invalid_credentials" | "rate_limited" | "not_found" | "internal_error";

/** Standard JSON error envelope returned by HTTP endpoints. */
export interface ApiErrorResponse {
    readonly error: ApiErrorCode;
    readonly message: string;
}

/** Authentication state returned by `GET /api/auth/status`. */
export interface AuthStatusResponse {
    readonly authRequired: boolean;
    readonly authenticated: boolean;
}

/** Request payload accepted by `POST /api/auth`. */
export interface AuthLoginRequest {
    readonly password: string;
}

/** Response payload returned by `POST /api/auth` on success. */
export interface AuthLoginResponse {
    readonly authenticated: true;
}

/** Response payload returned by `POST /api/auth/logout`. */
export interface AuthLogoutResponse {
    readonly authenticated: false;
}

/**
 * Read-only summary of one discovered session.
 *
 * `createdAtMs` and `modifiedAtMs` are finite Unix epoch milliseconds. The server uses
 * `modifiedAtMs` as the fallback when the stored creation timestamp cannot be parsed.
 */
export interface SessionSummary {
    readonly id: string;
    /** Working directory recorded in the session header; empty for sessions from old versions. */
    readonly cwd: string;
    /** Latest display name set by the user, or `null` when the session has no name. */
    readonly name: string | null;
    /** First user message text, or the SDK placeholder when the session has no messages. */
    readonly firstMessage: string;
    /** Number of message entries stored in the session file. */
    readonly messageCount: number;
    readonly createdAtMs: number;
    readonly modifiedAtMs: number;
    /** True when the session header names a parent session (forked session). */
    readonly hasParent: boolean;
}

/** Response payload returned by `GET /api/sessions`. */
export interface SessionListResponse {
    readonly sessions: readonly SessionSummary[];
    /** Time the server finished the discovery pass, in Unix epoch milliseconds. */
    readonly scannedAtMs: number;
}

/** Response payload returned by `GET /api/sessions/:id`. */
export interface SessionDetailResponse {
    readonly session: SessionSummary;
    /** Parsed session file entries after in-memory migration to the current format. */
    readonly entries: readonly FileEntry[];
}
