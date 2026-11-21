import type { SessionPrefixAnchor } from "../index.ts";
import { isRecord } from "./primitives.ts";

declare const SessionIdBrand: unique symbol;

/** Validated session identifier matching the SDK session manager filename safety rule. */
export type SessionId = string & { readonly [SessionIdBrand]: "SessionId" };

declare const EntriesVersionBrand: unique symbol;

/** Composite `${sessionVersion}:${sdkVersion}` transcript version identifier. */
export type EntriesVersion = string & { readonly [EntriesVersionBrand]: "EntriesVersion" };

/**
 * Session ids mirror the rule of the SDK session manager: non-empty, only alphanumeric
 * characters, `-`, `_`, and `.`, and the first and last character must be alphanumeric.
 * The pattern rejects path separators and `..`.
 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

const ENTRIES_VERSION_PATTERN = /^\d+:.+$/;

/** Parse an untrusted value into a {@link SessionId}, or return `null` when invalid. */
export function parseSessionId(raw: unknown): SessionId | null {
    return typeof raw === "string" && SESSION_ID_PATTERN.test(raw) ? (raw as SessionId) : null;
}

/** Parse an untrusted `${sessionVersion}:${sdkVersion}` string into an {@link EntriesVersion}. */
export function parseEntriesVersion(raw: unknown): EntriesVersion | null {
    return typeof raw === "string" && ENTRIES_VERSION_PATTERN.test(raw) ? (raw as EntriesVersion) : null;
}

/**
 * Parse a {@link SessionPrefixAnchor} from HTTP or WebSocket query parameters.
 *
 * Returns `undefined` when any anchor field is missing or malformed so callers cleanly fall back
 * to a full transcript response.
 */
export function parseSessionPrefixAnchor(query: unknown): SessionPrefixAnchor | undefined {
    if (!isRecord(query)) {
        return undefined;
    }
    const entriesVersion = parseEntriesVersion(query.entriesVersion);
    if (entriesVersion === null) {
        return undefined;
    }
    const { afterCount, afterEntryId } = query;
    if (
        typeof afterEntryId !== "string" ||
        afterEntryId.length === 0 ||
        typeof afterCount !== "string" ||
        !/^[1-9]\d*$/.test(afterCount)
    ) {
        return undefined;
    }
    const parsedCount = Number(afterCount);
    if (!Number.isSafeInteger(parsedCount) || parsedCount < 1) {
        return undefined;
    }
    return {
        entriesVersion,
        afterCount: parsedCount,
        afterEntryId,
    };
}
