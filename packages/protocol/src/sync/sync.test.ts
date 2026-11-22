import { describe, expect, it } from "vitest";

import {
    canApplySyncSnapshot,
    createSyncFrameParser,
    evaluateDeltaCursor,
    initialSyncSeq,
    nextSyncSeq,
    parseDelivery,
    parsePositiveSyncSeq,
    parseSyncEpoch,
    parseSyncHandshakeQuery,
    parseSyncSeq,
    parseSyncSeqString,
    type SyncCursor,
    type SyncEpoch,
    type SyncSeq,
} from "./index.ts";

function mustEpoch<D extends string>(raw: string): SyncEpoch<D> {
    const parsed = parseSyncEpoch<D>(raw);
    if (parsed === null) {
        throw new Error(`Invalid test epoch: ${raw}`);
    }
    return parsed;
}

function mustSeq<D extends string>(raw: number): SyncSeq<D> {
    const parsed = parseSyncSeq<D>(raw);
    if (parsed === null) {
        throw new Error(`Invalid test seq: ${raw}`);
    }
    return parsed;
}

describe("sync clock and cursor semantics", () => {
    it("enforces compile-time domain isolation across branded epochs, seqs, and cursors", () => {
        const catalogEpoch = mustEpoch<"catalog">("cat-1");
        const catalogSeq = mustSeq<"catalog">(1);
        const catalogCursor: SyncCursor<"catalog"> = { epoch: catalogEpoch, seq: catalogSeq };

        const sessionEpoch = mustEpoch<"session">("ses-1");
        const sessionSeq = mustSeq<"session">(1);
        const sessionCursor: SyncCursor<"session"> = { epoch: sessionEpoch, seq: sessionSeq };

        // @ts-expect-error cross-domain epoch must be rejected at compile time
        const badCursor1: SyncCursor<"catalog"> = { epoch: sessionEpoch, seq: catalogSeq };
        // @ts-expect-error cross-domain seq must be rejected at compile time
        const badCursor2: SyncCursor<"catalog"> = { epoch: catalogEpoch, seq: sessionSeq };
        // @ts-expect-error cross-domain evaluateDeltaCursor must fail to compile
        evaluateDeltaCursor(catalogCursor, sessionCursor);
        // @ts-expect-error cross-domain canApplySyncSnapshot must fail to compile
        canApplySyncSnapshot(catalogCursor, sessionCursor);

        void badCursor1;
        void badCursor2;
        expect(catalogCursor.epoch).toBe("cat-1");
        expect(sessionCursor.epoch).toBe("ses-1");
    });

    it("parses epochs, sequences, string sequences, and detects overflow", () => {
        expect(initialSyncSeq<"catalog">()).toBe(0);
        expect(parseSyncEpoch<"catalog">("e1")).toBe("e1");
        expect(parseSyncEpoch<"catalog">("")).toBeNull();
        expect(parseSyncEpoch<"catalog">(123)).toBeNull();

        expect(parseSyncSeq<"catalog">(0)).toBe(0);
        expect(parseSyncSeq<"catalog">(-1)).toBeNull();
        expect(parseSyncSeq<"catalog">(1.5)).toBeNull();
        expect(parsePositiveSyncSeq<"catalog">(0)).toBeNull();
        expect(parsePositiveSyncSeq<"catalog">(1)).toBe(1);

        expect(parseSyncSeqString<"catalog">("0")).toBe(0);
        expect(parseSyncSeqString<"catalog">("42")).toBe(42);
        expect(parseSyncSeqString<"catalog">("-1")).toBeNull();
        expect(parseSyncSeqString<"catalog">("abc")).toBeNull();
        expect(parseSyncSeqString<"catalog">("99999999999999999999")).toBeNull();

        expect(nextSyncSeq(mustSeq<"catalog">(4))).toBe(5);
        expect(() => nextSyncSeq(mustSeq<"catalog">(Number.MAX_SAFE_INTEGER))).toThrow(RangeError);
    });

    it("evaluates delta cursors and snapshot precedence without boolean blindness", () => {
        const e1 = mustEpoch<"session">("e1");
        const e2 = mustEpoch<"session">("e2");
        const current: SyncCursor<"session"> = { epoch: e1, seq: mustSeq<"session">(5) };

        expect(evaluateDeltaCursor(current, { epoch: e1, seq: mustSeq<"session">(6) })).toEqual({ kind: "apply" });
        expect(evaluateDeltaCursor(current, { epoch: e1, seq: mustSeq<"session">(5) })).toEqual({ kind: "duplicate" });
        expect(evaluateDeltaCursor(current, { epoch: e1, seq: mustSeq<"session">(2) })).toEqual({ kind: "duplicate" });
        expect(evaluateDeltaCursor(current, { epoch: e1, seq: mustSeq<"session">(8) })).toEqual({
            kind: "gap",
            expectedSeq: 6,
            receivedSeq: 8,
        });
        expect(evaluateDeltaCursor(current, { epoch: e2, seq: mustSeq<"session">(6) })).toEqual({
            kind: "epoch_mismatch",
        });

        expect(canApplySyncSnapshot(null, current)).toBe(true);
        expect(canApplySyncSnapshot(current, { epoch: e1, seq: mustSeq<"session">(5) })).toBe(true);
        expect(canApplySyncSnapshot(current, { epoch: e1, seq: mustSeq<"session">(6) })).toBe(true);
        expect(canApplySyncSnapshot(current, { epoch: e1, seq: mustSeq<"session">(4) })).toBe(false);
        expect(canApplySyncSnapshot(current, { epoch: e2, seq: mustSeq<"session">(0) })).toBe(true);
    });
});

describe("sync frame and handshake boundary parsers", () => {
    const parseTasksFrame = createSyncFrameParser<"tasks", { readonly count: number }, { readonly op: string }>({
        parseSnapshot: (raw) =>
            typeof raw === "object" && raw !== null && "count" in raw && typeof raw.count === "number"
                ? { count: raw.count }
                : null,
        parseDelta: (raw) =>
            typeof raw === "object" && raw !== null && "op" in raw && typeof raw.op === "string"
                ? { op: raw.op }
                : null,
    });

    it("parses valid sync frames and rejects seq/range integrity violations", () => {
        expect(
            parseTasksFrame({
                type: "sync:snapshot",
                cursor: { epoch: "e1", seq: 0 },
                snapshot: { count: 0 },
            }),
        ).toEqual({
            type: "sync:snapshot",
            cursor: { epoch: "e1", seq: 0 },
            snapshot: { count: 0 },
        });

        expect(
            parseTasksFrame({
                type: "sync:replay",
                cursor: { epoch: "e1", seq: 2 },
                fromSeq: 2,
                deltas: [],
            }),
        ).toEqual({
            type: "sync:replay",
            cursor: { epoch: "e1", seq: 2 },
            fromSeq: 2,
            deltas: [],
        });

        expect(
            parseTasksFrame({
                type: "sync:replay",
                cursor: { epoch: "e1", seq: 3 },
                fromSeq: 1,
                deltas: [
                    { seq: 2, payload: { op: "a" } },
                    { seq: 3, payload: { op: "b" } },
                ],
            }),
        ).toEqual({
            type: "sync:replay",
            cursor: { epoch: "e1", seq: 3 },
            fromSeq: 1,
            deltas: [
                { seq: 2, payload: { op: "a" } },
                { seq: 3, payload: { op: "b" } },
            ],
        });

        // Empty deltas with fromSeq !== cursor.seq is invalid.
        expect(
            parseTasksFrame({
                type: "sync:replay",
                cursor: { epoch: "e1", seq: 3 },
                fromSeq: 1,
                deltas: [],
            }),
        ).toBeNull();

        // Non-contiguous or out-of-range delta seqs are rejected.
        expect(
            parseTasksFrame({
                type: "sync:replay",
                cursor: { epoch: "e1", seq: 3 },
                fromSeq: 1,
                deltas: [{ seq: 3, payload: { op: "skip" } }],
            }),
        ).toBeNull();
        expect(
            parseTasksFrame({
                type: "sync:replay",
                cursor: { epoch: "e1", seq: 3 },
                fromSeq: 1,
                deltas: [
                    { seq: 2, payload: { op: "a" } },
                    { seq: 2, payload: { op: "dup" } },
                ],
            }),
        ).toBeNull();

        // sync:delta cannot carry seq 0.
        expect(
            parseTasksFrame({
                type: "sync:delta",
                cursor: { epoch: "e1", seq: 0 },
                delta: { op: "a" },
            }),
        ).toBeNull();
        expect(
            parseTasksFrame({
                type: "sync:delta",
                cursor: { epoch: "e1", seq: 1 },
                delta: { op: "a" },
            }),
        ).toEqual({
            type: "sync:delta",
            cursor: { epoch: "e1", seq: 1 },
            delta: { op: "a" },
        });

        expect(parseTasksFrame({ type: "sync:resync", reason: "buffer_evicted" })).toEqual({
            type: "sync:resync",
            reason: "buffer_evicted",
        });
        expect(parseTasksFrame({ type: "sync:resync", reason: "unknown_reason" })).toBeNull();
    });

    it("degrades malformed handshake cursors to undefined while preserving valid hints", () => {
        expect(parseSyncHandshakeQuery<"tasks">({ epoch: "e1", afterSeq: "5" })).toEqual({
            cursor: { epoch: "e1", seq: 5 },
        });
        expect(parseSyncHandshakeQuery<"tasks">({ epoch: "e1", afterSeq: "-1" })).toEqual({});
        expect(parseSyncHandshakeQuery<"tasks">({ epoch: "", afterSeq: "5" })).toEqual({});
        expect(parseSyncHandshakeQuery<"tasks">(undefined)).toEqual({});

        expect(
            parseSyncHandshakeQuery<"tasks", string>({ epoch: "e1", afterSeq: "nope", tag: "v1" }, (q) =>
                typeof q.tag === "string" ? q.tag : undefined,
            ),
        ).toEqual({ hint: "v1" });
    });

    it("parses Delivery inline and http envelopes", () => {
        const parseStr = (raw: unknown): string | null => (typeof raw === "string" ? raw : null);
        const parseMeta = (raw: unknown): { readonly count: number } | null =>
            typeof raw === "object" && raw !== null && "count" in raw && typeof raw.count === "number"
                ? { count: raw.count }
                : null;

        expect(parseDelivery({ mode: "inline", data: "ok" }, parseStr, parseMeta)).toEqual({
            mode: "inline",
            data: "ok",
        });
        expect(parseDelivery({ mode: "http", meta: { count: 10 } }, parseStr, parseMeta)).toEqual({
            mode: "http",
            meta: { count: 10 },
        });
        expect(parseDelivery({ mode: "http", meta: { count: "bad" } }, parseStr, parseMeta)).toBeNull();
        expect(parseDelivery({ mode: "unknown" }, parseStr, parseMeta)).toBeNull();
    });
});
