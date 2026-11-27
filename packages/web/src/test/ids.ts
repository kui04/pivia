import {
    parseEntriesVersion,
    parseSessionId,
    parseSyncEpoch,
    parseSyncSeq,
    type EntriesVersion,
    type SessionId,
    type SyncEpoch,
    type SyncSeq,
} from "@pivia/protocol";

function invalid(what: string, raw: string | number): Error {
    return new Error(`Invalid test ${what}: ${String(raw)}`);
}

/** Parses a session id literal; an unparsable literal is a test bug and fails at load. */
export function sid(raw: string): SessionId {
    const parsed = parseSessionId(raw);
    if (parsed === null) {
        throw invalid("session id", raw);
    }
    return parsed;
}

/** Parses an entries version literal; an unparsable literal is a test bug and fails at load. */
export function ev(raw: string): EntriesVersion {
    const parsed = parseEntriesVersion(raw);
    if (parsed === null) {
        throw invalid("entries version", raw);
    }
    return parsed;
}

/** Parses a session sync epoch literal. */
export function sessionEpoch(raw: string): SyncEpoch<"session"> {
    const parsed = parseSyncEpoch<"session">(raw);
    if (parsed === null) {
        throw invalid("session sync epoch", raw);
    }
    return parsed;
}

/** Parses a catalog sync epoch literal. */
export function catalogEpoch(raw: string): SyncEpoch<"catalog"> {
    const parsed = parseSyncEpoch<"catalog">(raw);
    if (parsed === null) {
        throw invalid("catalog sync epoch", raw);
    }
    return parsed;
}

/** Parses a session sync sequence number literal. */
export function sessionSeq(raw: number): SyncSeq<"session"> {
    const parsed = parseSyncSeq<"session">(raw);
    if (parsed === null) {
        throw invalid("session sync seq", raw);
    }
    return parsed;
}

/** Parses a catalog sync sequence number literal. */
export function catalogSeq(raw: number): SyncSeq<"catalog"> {
    const parsed = parseSyncSeq<"catalog">(raw);
    if (parsed === null) {
        throw invalid("catalog sync seq", raw);
    }
    return parsed;
}
