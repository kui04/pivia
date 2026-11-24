import type { FileEntry } from "@earendil-works/pi-coding-agent";

import { isNonNegativeSafeInteger, isRecord, type StrictOmit } from "../shared/primitives.ts";
import { parseSyncCursor } from "../sync/index.ts";
import { parseCatalogSnapshot, type CatalogCursor, type CatalogSnapshot } from "../workspace/ws.ts";
import { parseEntriesVersion, type EntriesVersion } from "./ids.ts";
import { parseSessionSummary, type SessionSummary } from "./summary.ts";

/** Response payload returned by `GET /api/sessions`. */
export interface SessionListResponse extends CatalogSnapshot {
    /** Server catalog cursor covered by this snapshot. */
    readonly cursor: CatalogCursor;
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

/**
 * Narrow an untrusted value to a minimal SDK {@link FileEntry} record.
 *
 * Pre-migration v1 session entries on disk omit `id`, so only the object shape and string `type`
 * discriminant are required here.
 */
export function isFileEntryRecord(value: unknown): value is FileEntry {
    return isRecord(value) && typeof value.type === "string";
}

/** Parse an array of SDK {@link FileEntry} records, or return `null` if any element is malformed. */
export function parseFileEntryArray(raw: unknown): FileEntry[] | null {
    if (!Array.isArray(raw)) {
        return null;
    }
    const entries: FileEntry[] = [];
    for (const item of raw) {
        if (!isFileEntryRecord(item)) {
            return null;
        }
        entries.push(item);
    }
    return entries;
}

/** Parse a `GET /api/sessions` payload. */
export function parseSessionListResponse(raw: unknown): SessionListResponse | null {
    if (!isRecord(raw)) {
        return null;
    }
    const snapshot = parseCatalogSnapshot(raw);
    const cursor = parseSyncCursor<"catalog">(raw.cursor);
    if (snapshot === null || cursor === null) {
        return null;
    }
    return { ...snapshot, cursor };
}

/** Parse a `GET /api/sessions/:id` payload. */
export function parseSessionDetailResponse(raw: unknown): SessionDetailResponse | null {
    if (!isRecord(raw)) {
        return null;
    }
    const session = parseSessionSummary(raw.session);
    if (session === null || !isNonNegativeSafeInteger(raw.baseEntryCount)) {
        return null;
    }
    const entriesVersion = raw.entriesVersion === null ? null : parseEntriesVersion(raw.entriesVersion);
    if (raw.entriesVersion !== null && entriesVersion === null) {
        return null;
    }
    const entries = parseFileEntryArray(raw.entries);
    if (entries === null) {
        return null;
    }
    return {
        session,
        entriesVersion,
        baseEntryCount: raw.baseEntryCount,
        entries,
    };
}

/** Parse a `POST /api/sessions` payload. */
export function parseCreateSessionResponse(raw: unknown): CreateSessionResponse | null {
    if (!isRecord(raw)) {
        return null;
    }
    const session = parseSessionSummary(raw.session);
    return session === null ? null : { session };
}

/** Parse a `POST /api/sessions/:id/close` payload. */
export function parseCloseSessionResponse(raw: unknown): CloseSessionResponse | null {
    if (!isRecord(raw) || typeof raw.closed !== "boolean") {
        return null;
    }
    return { closed: raw.closed };
}
