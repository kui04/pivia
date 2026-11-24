import { isRecord, type JsonDecoder } from "../shared/primitives.ts";
import { parsePositiveSyncSeq, parseSyncEpoch, parseSyncSeq, parseSyncSeqString, type SyncCursor } from "./clock.ts";
import type { Delivery, SequencedDelta, SyncFrame, SyncHandshake, SyncServerResyncReason } from "./stream.ts";

export type { JsonDecoder };

const SERVER_RESYNC_REASONS: Readonly<Record<SyncServerResyncReason, true>> = {
    gap: true,
    epoch_changed: true,
    buffer_evicted: true,
};

function isServerResyncReason(value: unknown): value is SyncServerResyncReason {
    return typeof value === "string" && Object.hasOwn(SERVER_RESYNC_REASONS, value);
}

/** Parse a `{ epoch, seq }` cursor from untrusted JSON, or return `null` when malformed. */
export function parseSyncCursor<D extends string>(raw: unknown): SyncCursor<D> | null {
    if (!isRecord(raw)) {
        return null;
    }
    const epoch = parseSyncEpoch<D>(raw.epoch);
    const seq = parseSyncSeq<D>(raw.seq);
    if (epoch === null || seq === null) {
        return null;
    }
    return { epoch, seq };
}

function parsePositiveSyncCursor<D extends string>(raw: unknown): SyncCursor<D> | null {
    if (!isRecord(raw)) {
        return null;
    }
    const epoch = parseSyncEpoch<D>(raw.epoch);
    const seq = parsePositiveSyncSeq<D>(raw.seq);
    if (epoch === null || seq === null) {
        return null;
    }
    return { epoch, seq };
}

/** Parse a {@link Delivery} payload at a trust boundary using decoders for inline data and HTTP metadata. */
export function parseDelivery<T, THttpMeta>(
    raw: unknown,
    parseData: JsonDecoder<T>,
    parseMeta: JsonDecoder<THttpMeta>,
): Delivery<T, THttpMeta> | null {
    if (!isRecord(raw) || typeof raw.mode !== "string") {
        return null;
    }
    if (raw.mode === "inline") {
        const data = parseData(raw.data);
        return data === null ? null : { mode: "inline", data };
    }
    if (raw.mode === "http") {
        const meta = parseMeta(raw.meta);
        return meta === null ? null : { mode: "http", meta };
    }
    return null;
}

/** Options for {@link createSyncFrameParser}. */
export interface SyncFrameParserOptions<TSnapshot, TDelta> {
    readonly parseSnapshot: JsonDecoder<TSnapshot>;
    readonly parseDelta: JsonDecoder<TDelta>;
}

/**
 * Build a boundary parser for {@link SyncFrame} envelopes of domain `D`.
 *
 * Rejects `sync:replay` frames whose deltas are non-monotonic or fall outside `(fromSeq, cursor.seq]`,
 * and rejects `sync:delta` frames with `seq < 1`.
 */
export function createSyncFrameParser<D extends string, TSnapshot, TDelta>(
    options: SyncFrameParserOptions<TSnapshot, TDelta>,
): JsonDecoder<SyncFrame<D, TSnapshot, TDelta>> {
    return (raw: unknown): SyncFrame<D, TSnapshot, TDelta> | null => {
        if (!isRecord(raw) || typeof raw.type !== "string") {
            return null;
        }
        switch (raw.type) {
            case "sync:snapshot": {
                const cursor = parseSyncCursor<D>(raw.cursor);
                if (cursor === null) {
                    return null;
                }
                const snapshot = options.parseSnapshot(raw.snapshot);
                if (snapshot === null) {
                    return null;
                }
                return { type: "sync:snapshot", cursor, snapshot };
            }
            case "sync:replay": {
                const cursor = parseSyncCursor<D>(raw.cursor);
                const fromSeq = parseSyncSeq<D>(raw.fromSeq);
                if (cursor === null || fromSeq === null || fromSeq > cursor.seq || !Array.isArray(raw.deltas)) {
                    return null;
                }
                if (raw.deltas.length === 0 && fromSeq !== cursor.seq) {
                    return null;
                }
                const deltas: SequencedDelta<D, TDelta>[] = [];
                let expectedSeq: number = fromSeq + 1;
                for (const item of raw.deltas) {
                    if (!isRecord(item)) {
                        return null;
                    }
                    const seq = parsePositiveSyncSeq<D>(item.seq);
                    if (seq === null || seq !== expectedSeq || seq > cursor.seq) {
                        return null;
                    }
                    const payload = options.parseDelta(item.payload);
                    if (payload === null) {
                        return null;
                    }
                    deltas.push({ seq, payload });
                    expectedSeq += 1;
                }
                if (deltas.length > 0 && expectedSeq - 1 !== cursor.seq) {
                    return null;
                }
                return { type: "sync:replay", cursor, fromSeq, deltas };
            }
            case "sync:delta": {
                const cursor = parsePositiveSyncCursor<D>(raw.cursor);
                if (cursor === null) {
                    return null;
                }
                const delta = options.parseDelta(raw.delta);
                if (delta === null) {
                    return null;
                }
                return { type: "sync:delta", cursor, delta };
            }
            case "sync:resync": {
                if (!isServerResyncReason(raw.reason)) {
                    return null;
                }
                return { type: "sync:resync", reason: raw.reason };
            }
            default:
                return null;
        }
    };
}

/**
 * Parse WebSocket upgrade query parameters into a {@link SyncHandshake}.
 *
 * Missing or malformed `epoch` / `afterSeq` degrade cleanly to `cursor: undefined` so the server
 * falls back to a full snapshot instead of failing the upgrade.
 */
export function parseSyncHandshakeQuery<D extends string, THint = undefined>(
    query: unknown,
    parseHint?: (query: Record<string, unknown>) => THint | undefined,
): SyncHandshake<D, THint> {
    if (!isRecord(query)) {
        return {};
    }
    const epoch = parseSyncEpoch<D>(query.epoch);
    const afterSeq = parseSyncSeqString<D>(query.afterSeq);
    const cursor = epoch !== null && afterSeq !== null ? ({ epoch, seq: afterSeq } satisfies SyncCursor<D>) : undefined;
    const hint = parseHint?.(query);
    return {
        ...(cursor === undefined ? {} : { cursor }),
        ...(hint === undefined ? {} : { hint }),
    };
}

/** Encode a generic {@link SyncHandshake} into URL query parameters symmetric with {@link parseSyncHandshakeQuery}. */
export function encodeSyncHandshakeQuery<D extends string, THint = undefined>(
    handshake?: SyncHandshake<D, THint>,
    encodeHint?: (hint: THint, params: URLSearchParams) => void,
): URLSearchParams {
    const params = new URLSearchParams();
    if (handshake === undefined) {
        return params;
    }
    if (handshake.cursor !== undefined) {
        params.set("epoch", handshake.cursor.epoch);
        params.set("afterSeq", String(handshake.cursor.seq));
    }
    if (handshake.hint !== undefined && encodeHint !== undefined) {
        encodeHint(handshake.hint, params);
    }
    return params;
}
