import { isRecord, isStringArray } from "../shared/primitives.ts";
import type {
    AuthLoginResponse,
    AuthLogoutResponse,
    AuthStatusResponse,
    DirectoryListQuery,
    DirectoryListResponse,
    HealthResponse,
} from "./types.ts";

/** Parse a `GET /api/health` payload. */
export function parseHealthResponse(raw: unknown): HealthResponse | null {
    if (!isRecord(raw) || raw.status !== "ok" || typeof raw.version !== "string") {
        return null;
    }
    return { status: "ok", version: raw.version };
}

/** Parse a `GET /api/auth/status` payload. */
export function parseAuthStatusResponse(raw: unknown): AuthStatusResponse | null {
    if (!isRecord(raw) || typeof raw.authRequired !== "boolean" || typeof raw.authenticated !== "boolean") {
        return null;
    }
    return { authRequired: raw.authRequired, authenticated: raw.authenticated };
}

/** Parse a `POST /api/auth` payload. */
export function parseAuthLoginResponse(raw: unknown): AuthLoginResponse | null {
    return isRecord(raw) && raw.authenticated === true ? { authenticated: true } : null;
}

/** Parse a `POST /api/auth/logout` payload. */
export function parseAuthLogoutResponse(raw: unknown): AuthLogoutResponse | null {
    return isRecord(raw) && raw.authenticated === false ? { authenticated: false } : null;
}

/** Parse raw query parameters for `GET /api/fs/directories`. */
export function parseDirectoryListQuery(raw: unknown): DirectoryListQuery {
    if (!isRecord(raw) || typeof raw.path !== "string") {
        return {};
    }
    const trimmed = raw.path.trim();
    return trimmed === "" ? {} : { path: trimmed };
}

/** Encode {@link DirectoryListQuery} into URL query parameters, omitting blank paths. */
export function encodeDirectoryListQuery(query?: DirectoryListQuery): URLSearchParams {
    const params = new URLSearchParams();
    const trimmed = query?.path?.trim() ?? "";
    if (trimmed !== "") {
        params.set("path", trimmed);
    }
    return params;
}

/** Parse a `GET /api/fs/directories` payload. */
export function parseDirectoryListResponse(raw: unknown): DirectoryListResponse | null {
    if (
        !isRecord(raw) ||
        typeof raw.path !== "string" ||
        raw.path.length === 0 ||
        (raw.parent !== null && typeof raw.parent !== "string") ||
        !isStringArray(raw.directories) ||
        typeof raw.truncated !== "boolean"
    ) {
        return null;
    }
    return {
        path: raw.path,
        parent: raw.parent,
        directories: raw.directories,
        truncated: raw.truncated,
    };
}
