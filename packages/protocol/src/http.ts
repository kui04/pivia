import type { Api, Model } from "@earendil-works/pi-ai";
import type { FileEntry, SessionInfo } from "@earendil-works/pi-coding-agent";

import type { StrictOmit } from "./parse/primitives.ts";
import type { EntriesVersion, SessionId } from "./parse/session.ts";
import type { CatalogCursor, CatalogSnapshot } from "./workspace-ws.ts";

/** Health status payload returned by `GET /api/health`. */
export interface HealthResponse {
    readonly status: "ok";
    readonly version: string;
}

/** Machine-readable error codes returned by HTTP endpoints. */
export type ApiErrorCode =
    | "invalid_request"
    | "unauthorized"
    | "invalid_credentials"
    | "rate_limited"
    | "not_found"
    | "directory_not_found"
    | "internal_error";

/** Standard JSON error envelope returned by HTTP endpoints. */
export interface ApiErrorResponse {
    readonly error: ApiErrorCode;
    readonly message: string;
}

/** API endpoints that stay public so the login gate can be reached. */
export const PUBLIC_API_PATHS = ["/api/health", "/api/auth", "/api/auth/status", "/api/auth/logout"] as const;

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

/** Lifecycle state of one session runtime. */
export type SessionRuntimeState = "starting" | "idle" | "streaming" | "compacting" | "closing";

/** Public model identity sent to clients; never contains credentials. */
export type SessionModelInfo = Pick<Model<Api>, "provider" | "id" | "name">;

/**
 * Summary of one session, merged from disk discovery and any live runtime.
 *
 * `createdAtMs` and `modifiedAtMs` are finite Unix epoch milliseconds. The server uses
 * `modifiedAtMs` as the fallback when the stored creation timestamp cannot be parsed. Live
 * sessions override the disk fields with in-memory state, including sessions whose file has not
 * been written yet.
 */
export interface SessionSummary extends Readonly<Pick<SessionInfo, "cwd" | "firstMessage" | "messageCount">> {
    readonly id: SessionId;
    /** Latest display name set by the user, or `null` when the session has no name. */
    readonly name: string | null;
    readonly createdAtMs: number;
    readonly modifiedAtMs: number;
    /** True when the session header names a parent session (forked session). */
    readonly hasParent: boolean;
    /**
     * Live runtime state. `"starting"` while extensions bind, `"closing"` while resources are
     * released, and `"idle"` when the server has no open runtime for the session.
     */
    readonly runtimeState: SessionRuntimeState;
    /** Number of authenticated WebSocket clients attached to the session runtime. */
    readonly attachedClients: number;
}

/** Response payload returned by `GET /api/sessions`. */
export interface SessionListResponse extends CatalogSnapshot {
    /** Server catalog cursor covered by this snapshot. */
    readonly cursor: CatalogCursor;
}

/**
 * Prefix anchor verified by both HTTP slice reads (`GET /api/sessions/:id`) and WS Tier 1/2
 * handshakes. `afterCount` includes the session header (`entries[0]`).
 */
export interface SessionPrefixAnchor {
    readonly entriesVersion: EntriesVersion;
    readonly afterCount: number;
    readonly afterEntryId: string;
}

/** Response payload returned by `GET /api/sessions/:id`. */
export interface SessionDetailResponse {
    readonly session: SessionSummary;
    /** Composite `${sessionVersion}:${sdkVersion}`, or `null` for unmigrated v1/v2 disk files. */
    readonly entriesVersion: EntriesVersion | null;
    /** Starting index in the session's `[header, ...entries]` array; `0` for a full response. */
    readonly baseEntryCount: number;
    /** Session entries (or slice from `baseEntryCount`) with header first on full responses. */
    readonly entries: readonly FileEntry[];
}

/** Request payload accepted by `POST /api/sessions`. */
export interface CreateSessionRequest {
    /** Existing absolute directory (or target directory when `createDirectory` is true) for the new session. */
    readonly cwd: string;
    /** When true, creates the directory recursively if it does not exist yet. */
    readonly createDirectory?: boolean | undefined;
}

/** Optional flags for creating a session when `cwd` is supplied separately. */
export type CreateSessionOptions = StrictOmit<CreateSessionRequest, "cwd">;

/** Response payload returned by `POST /api/sessions` on success. */
export interface CreateSessionResponse {
    readonly session: SessionSummary;
}

/** Response payload returned by `POST /api/sessions/:id/close`. */
export interface CloseSessionResponse {
    /** True when the server released an active runtime; false when the session was not open. */
    readonly closed: boolean;
}

/** Response payload returned by `GET /api/fs/directories`. */
export interface DirectoryListResponse {
    /** Canonical resolved directory path on the server. */
    readonly path: string;
    /** Parent directory path, or `null` at the filesystem root. */
    readonly parent: string | null;
    /** Immediate subdirectory names inside `path`, sorted case-insensitively. */
    readonly directories: readonly string[];
    /** True when `path` holds more subdirectories than the server returns in `directories`. */
    readonly truncated: boolean;
}
