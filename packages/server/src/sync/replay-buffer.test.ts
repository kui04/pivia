import { parseSyncEpoch, parseSyncSeq, type SyncEpoch, type SyncSeq } from "@pivia/protocol";
import { describe, expect, it, vi } from "vitest";

import { ReplayRingBuffer } from "./replay-buffer.ts";

function epoch<D extends string>(raw: string): SyncEpoch<D> {
    const parsed = parseSyncEpoch<D>(raw);
    if (parsed === null) {
        throw new Error(`Invalid epoch: ${raw}`);
    }
    return parsed;
}

function seq<D extends string>(raw: number): SyncSeq<D> {
    const parsed = parseSyncSeq<D>(raw);
    if (parsed === null) {
        throw new Error(`Invalid seq: ${raw}`);
    }
    return parsed;
}

type TestDelta = { readonly value: string };

describe("ReplayRingBuffer", () => {
    it("retains bounded entries and serves contiguous replay slices", () => {
        const e1 = epoch<"test">("e1");
        const e2 = epoch<"test">("e2");
        const buffer = new ReplayRingBuffer<"test", TestDelta>({ epoch: e1, maxEntries: 3 });

        expect(buffer.currentSeq).toBe(0);
        expect(buffer.since(undefined)).toEqual({
            kind: "snapshot_required",
            cursor: { epoch: e1, seq: 0 },
            reason: "missing_cursor",
        });

        buffer.push({ value: "a" });
        buffer.push({ value: "b" });
        buffer.push({ value: "c" });
        buffer.push({ value: "d" });

        expect(buffer.currentSeq).toBe(4);
        expect(buffer.earliestSeq).toBe(2);
        expect(buffer.retainedCount).toBe(3);

        // Oldest retained is 2, so afterSeq=1 is contiguous.
        expect(buffer.since({ epoch: e1, seq: seq<"test">(1) })).toEqual({
            kind: "replay",
            fromSeq: 1,
            cursor: { epoch: e1, seq: 4 },
            deltas: [
                { seq: 2, payload: { value: "b" } },
                { seq: 3, payload: { value: "c" } },
                { seq: 4, payload: { value: "d" } },
            ],
        });

        // Up-to-date reconnect returns empty replay.
        expect(buffer.since({ epoch: e1, seq: seq<"test">(4) })).toEqual({
            kind: "replay",
            fromSeq: 4,
            cursor: { epoch: e1, seq: 4 },
            deltas: [],
        });

        // Evicted cursor, wrong epoch, and ahead-of-head cursor require snapshots.
        expect(buffer.since({ epoch: e1, seq: seq<"test">(0) })).toMatchObject({
            kind: "snapshot_required",
            reason: "buffer_evicted",
        });
        expect(buffer.since({ epoch: e2, seq: seq<"test">(3) })).toMatchObject({
            kind: "snapshot_required",
            reason: "epoch_changed",
        });
        expect(buffer.since({ epoch: e1, seq: seq<"test">(5) })).toMatchObject({
            kind: "snapshot_required",
            reason: "ahead_of_head",
        });
    });

    it("enforces maxBytes budget and skips measureBytes when maxBytes is unset", () => {
        const measureUnbounded = vi.fn(() => 10);
        const unbounded = new ReplayRingBuffer<"test", TestDelta>({
            epoch: epoch<"test">("e1"),
            measureBytes: measureUnbounded,
        });
        unbounded.push({ value: "hello" });
        expect(measureUnbounded).not.toHaveBeenCalled();

        const bounded = new ReplayRingBuffer<"test", TestDelta>({
            epoch: epoch<"test">("e1"),
            maxEntries: 10,
            maxBytes: 40,
        });
        bounded.push({ value: "12345" }); // {"value":"12345"} = 17 bytes
        bounded.push({ value: "67890" }); // +17 = 34 bytes
        expect(bounded.retainedCount).toBe(2);
        expect(bounded.retainedBytes).toBe(34);

        bounded.push({ value: "abcde" }); // +17 = 51 -> evicts oldest -> 34 bytes
        expect(bounded.retainedCount).toBe(2);
        expect(bounded.earliestSeq).toBe(2);

        // Single delta exceeding maxBytes clears retained entries while advancing seq.
        bounded.push({ value: "x".repeat(60) });
        expect(bounded.currentSeq).toBe(4);
        expect(bounded.retainedCount).toBe(0);
        expect(bounded.retainedBytes).toBe(0);
        expect(bounded.since({ epoch: epoch<"test">("e1"), seq: seq<"test">(3) })).toMatchObject({
            kind: "snapshot_required",
            reason: "buffer_evicted",
        });
        expect(bounded.since({ epoch: epoch<"test">("e1"), seq: seq<"test">(4) })).toMatchObject({
            kind: "replay",
            deltas: [],
        });
    });
});
