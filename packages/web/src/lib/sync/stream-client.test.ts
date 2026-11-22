import {
    parseSyncEpoch,
    parseSyncSeq,
    type Delivery,
    type HydratableSyncReducer,
    type SyncCursor,
    type SyncEpoch,
    type SyncResyncReason,
    type SyncSeq,
} from "@pivia/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SyncStreamClient } from "./stream-client";

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

interface Item {
    readonly id: string;
    readonly text: string;
}

interface Snapshot {
    readonly items: Delivery<readonly Item[], { readonly total: number }>;
}

type Delta =
    | { readonly kind: "append"; readonly items: Delivery<readonly Item[], { readonly total: number }> }
    | { readonly kind: "note"; readonly note: string };

interface State {
    readonly items: readonly Item[];
    readonly notes: readonly string[];
    readonly hydrationError?: string | null;
}

type Hydration = { readonly kind: "snap" | "delta"; readonly total: number };

function createHydratableReducer(): HydratableSyncReducer<State, Snapshot, Delta, Hydration> {
    return {
        applySnapshot(prev, snapshot) {
            return {
                items: snapshot.items.mode === "inline" ? snapshot.items.data : prev.items,
                notes: [],
                hydrationError: null,
            };
        },
        applyDelta(prev, delta) {
            if (delta.kind === "note") {
                return { ...prev, notes: [...prev.notes, delta.note] };
            }
            return delta.items.mode === "inline" ? { ...prev, items: [...prev.items, ...delta.items.data] } : prev;
        },
        inspectSnapshot(snapshot) {
            return snapshot.items.mode === "http" ? { kind: "snap", total: snapshot.items.meta.total } : null;
        },
        inspectDelta(delta) {
            return delta.kind === "append" && delta.items.mode === "http"
                ? { kind: "delta", total: delta.items.meta.total }
                : null;
        },
        recoverHydrationFailure(prev, _descriptor, message) {
            return { ...prev, hydrationError: message };
        },
    };
}

describe("SyncStreamClient", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("applies inline snapshots, contiguous deltas, ignores duplicates, and detects gaps/epoch changes", () => {
        const e1 = epoch<"test">("e1");
        const e2 = epoch<"test">("e2");
        const resyncs: Array<{ reason: SyncResyncReason; cursor: SyncCursor<"test"> | null }> = [];

        const client = new SyncStreamClient<"test", State, Snapshot, Delta, Hydration>({
            initialState: { items: [], notes: [] },
            reducer: createHydratableReducer(),
            onResyncRequired: (reason, cursor) => resyncs.push({ reason, cursor }),
        });

        client.markConnecting();
        client.handleFrame({
            type: "sync:snapshot",
            cursor: { epoch: e1, seq: seq<"test">(1) },
            snapshot: { items: { mode: "inline", data: [{ id: "1", text: "one" }] } },
        });
        expect(client.currentPhase).toEqual({ kind: "live", cursor: { epoch: e1, seq: 1 } });

        // Duplicate seq <= 1 is ignored.
        client.handleFrame({
            type: "sync:delta",
            cursor: { epoch: e1, seq: seq<"test">(1) },
            delta: { kind: "note", note: "dup" },
        });
        expect(client.currentState.notes).toEqual([]);

        // Contiguous seq = 2 applies.
        client.handleFrame({
            type: "sync:delta",
            cursor: { epoch: e1, seq: seq<"test">(2) },
            delta: { kind: "note", note: "n2" },
        });
        expect(client.currentState.notes).toEqual(["n2"]);
        expect(client.appliedCursor).toEqual({ epoch: e1, seq: 2 });

        // Gap seq = 4 triggers resyncing with resumeCursor = seq 2.
        client.handleFrame({
            type: "sync:delta",
            cursor: { epoch: e1, seq: seq<"test">(4) },
            delta: { kind: "note", note: "n4" },
        });
        expect(client.currentPhase).toEqual({
            kind: "resyncing",
            reason: "gap",
            resumeCursor: { epoch: e1, seq: 2 },
        });
        expect(resyncs).toEqual([{ reason: "gap", cursor: { epoch: e1, seq: 2 } }]);

        // Epoch mismatch clears resumeCursor.
        client.handleFrame({
            type: "sync:snapshot",
            cursor: { epoch: e1, seq: seq<"test">(4) },
            snapshot: { items: { mode: "inline", data: [] } },
        });
        client.handleFrame({
            type: "sync:delta",
            cursor: { epoch: e2, seq: seq<"test">(1) },
            delta: { kind: "note", note: "other" },
        });
        expect(client.currentPhase).toEqual({
            kind: "resyncing",
            reason: "epoch_changed",
            resumeCursor: null,
        });
    });

    it("enforces 4-point sync:replay verification and handles Delivery.http mid-replay and in snapshots", async () => {
        const e1 = epoch<"test">("e1");
        const hydrateGate = Promise.withResolvers<State>();
        const resyncs: SyncResyncReason[] = [];

        const client = new SyncStreamClient<"test", State, Snapshot, Delta, Hydration>({
            initialState: { items: [], notes: [] },
            reducer: createHydratableReducer(),
            onHydrateHttp: () => hydrateGate.promise,
            onResyncRequired: (reason) => resyncs.push(reason),
        });

        // Replay without lastCursor is rejected.
        client.markConnecting(null);
        client.handleFrame({
            type: "sync:replay",
            cursor: { epoch: e1, seq: seq<"test">(1) },
            fromSeq: seq<"test">(0),
            deltas: [{ seq: seq<"test">(1), payload: { kind: "note", note: "a" } }],
        });
        expect(resyncs).toEqual(["invalid_replay"]);

        // Valid replay with an offloaded delta mid-slice pauses at seq 2, buffers seq 3 and live seq 4, then drains.
        client.markConnecting({ epoch: e1, seq: seq<"test">(1) });
        client.handleFrame({
            type: "sync:replay",
            cursor: { epoch: e1, seq: seq<"test">(3) },
            fromSeq: seq<"test">(1),
            deltas: [
                {
                    seq: seq<"test">(2),
                    payload: { kind: "append", items: { mode: "http", meta: { total: 2 } } },
                },
                { seq: seq<"test">(3), payload: { kind: "note", note: "from-replay-tail" } },
            ],
        });
        expect(client.currentPhase.kind).toBe("hydrating_http");

        // Live delta arriving while hydrating_http is queued into pending.
        client.handleFrame({
            type: "sync:delta",
            cursor: { epoch: e1, seq: seq<"test">(4) },
            delta: { kind: "note", note: "from-live" },
        });

        hydrateGate.resolve({
            items: [
                { id: "1", text: "one" },
                { id: "2", text: "two" },
            ],
            notes: [],
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(client.currentPhase).toEqual({ kind: "live", cursor: { epoch: e1, seq: 4 } });
        expect(client.currentState.items).toHaveLength(2);
        expect(client.currentState.notes).toEqual(["from-replay-tail", "from-live"]);
    });

    it("triggers resync on pending overflow or hydration gap during HTTP hydration", async () => {
        const e1 = epoch<"test">("e1");
        const hydrateGate = Promise.withResolvers<State>();
        const resyncs: SyncResyncReason[] = [];

        const client = new SyncStreamClient<"test", State, Snapshot, Delta, Hydration>({
            initialState: { items: [], notes: [] },
            reducer: createHydratableReducer(),
            maxPendingDeltas: 1,
            onHydrateHttp: () => hydrateGate.promise,
            onResyncRequired: (reason) => resyncs.push(reason),
        });

        client.markConnecting();
        client.handleFrame({
            type: "sync:snapshot",
            cursor: { epoch: e1, seq: seq<"test">(1) },
            snapshot: { items: { mode: "http", meta: { total: 10 } } },
        });
        client.handleFrame({
            type: "sync:delta",
            cursor: { epoch: e1, seq: seq<"test">(2) },
            delta: { kind: "note", note: "1" },
        });
        client.handleFrame({
            type: "sync:delta",
            cursor: { epoch: e1, seq: seq<"test">(3) },
            delta: { kind: "note", note: "2-overflow" },
        });

        hydrateGate.resolve({ items: [{ id: "1", text: "one" }], notes: [] });
        await Promise.resolve();
        await Promise.resolve();

        expect(client.currentPhase).toEqual({
            kind: "resyncing",
            reason: "pending_overflow",
            resumeCursor: null,
        });
        expect(resyncs).toEqual(["pending_overflow"]);
    });

    it("supports recoverable HTTP hydration failure and background retryHydration while live", async () => {
        const e1 = epoch<"test">("e1");
        const firstGate = Promise.withResolvers<State>();
        const retryGate = Promise.withResolvers<State>();
        let call = 0;

        const client = new SyncStreamClient<"test", State, Snapshot, Delta, Hydration>({
            initialState: { items: [], notes: [], hydrationError: null },
            reducer: createHydratableReducer(),
            onHydrateHttp: async (_descriptor, ctx) => {
                call += 1;
                if (call === 1) {
                    return firstGate.promise;
                }
                const resolved = await retryGate.promise;
                return { ...ctx.getLatestState(), items: resolved.items, hydrationError: null };
            },
        });

        client.markConnecting();
        client.handleFrame({
            type: "sync:snapshot",
            cursor: { epoch: e1, seq: seq<"test">(1) },
            snapshot: { items: { mode: "http", meta: { total: 2 } } },
        });
        client.handleFrame({
            type: "sync:delta",
            cursor: { epoch: e1, seq: seq<"test">(2) },
            delta: { kind: "note", note: "queued-during-failure" },
        });

        firstGate.reject(new Error("Temporary 503"));
        await vi.waitFor(() => {
            expect(client.currentPhase).toEqual({ kind: "live", cursor: { epoch: e1, seq: 2 } });
        });
        expect(client.hasPendingHydrationRetry).toBe(true);
        expect(client.currentState.hydrationError).toBe("Temporary 503");
        expect(client.currentState.notes).toEqual(["queued-during-failure"]);

        // Live deltas continue applying even before retry succeeds.
        expect(client.retryHydration((prev) => ({ ...prev, hydrationError: null }))).toBe(true);
        client.handleFrame({
            type: "sync:delta",
            cursor: { epoch: e1, seq: seq<"test">(3) },
            delta: { kind: "note", note: "during-retry" },
        });

        retryGate.resolve({ items: [{ id: "1", text: "hydrated" }], notes: [] });
        await vi.waitFor(() => {
            expect(client.hasPendingHydrationRetry).toBe(false);
        });
        expect(client.currentState).toEqual({
            items: [{ id: "1", text: "hydrated" }],
            notes: ["queued-during-failure", "during-retry"],
            hydrationError: null,
        });
    });

    it("keeps orthogonal external HTTP refresh independent of live WebSocket state", () => {
        const e1 = epoch<"test">("e1");
        const client = new SyncStreamClient<"test", State, Snapshot, Delta, Hydration>({
            initialState: { items: [], notes: [] },
            reducer: createHydratableReducer(),
        });

        client.markConnecting();
        client.handleFrame({
            type: "sync:snapshot",
            cursor: { epoch: e1, seq: seq<"test">(2) },
            snapshot: { items: { mode: "inline", data: [{ id: "1", text: "init" }] } },
        });

        // Failed external refresh does not touch live WS cursor or state.
        client.beginExternalRefresh();
        client.failExternalRefresh();
        expect(client.currentPhase).toEqual({ kind: "live", cursor: { epoch: e1, seq: 2 } });

        // Successful external refresh folds deltas buffered while HTTP was in flight.
        client.beginExternalRefresh();
        client.handleFrame({
            type: "sync:delta",
            cursor: { epoch: e1, seq: seq<"test">(3) },
            delta: { kind: "note", note: "during-refresh" },
        });
        const applied = client.completeExternalRefresh(
            { items: { mode: "inline", data: [{ id: "1", text: "refreshed" }] } },
            { epoch: e1, seq: seq<"test">(2) },
        );
        expect(applied).toBe(true);
        expect(client.currentState.items).toEqual([{ id: "1", text: "refreshed" }]);
        expect(client.currentState.notes).toEqual(["during-refresh"]);
        expect(client.currentPhase).toEqual({ kind: "live", cursor: { epoch: e1, seq: 3 } });

        // Superseded external refresh is ignored when a newer WS snapshot landed mid-flight.
        client.beginExternalRefresh();
        client.handleFrame({
            type: "sync:snapshot",
            cursor: { epoch: e1, seq: seq<"test">(5) },
            snapshot: { items: { mode: "inline", data: [{ id: "2", text: "newer-ws" }] } },
        });
        const staleApplied = client.completeExternalRefresh(
            { items: { mode: "inline", data: [{ id: "1", text: "stale-http" }] } },
            { epoch: e1, seq: seq<"test">(4) },
        );
        expect(staleApplied).toBe(false);
        expect(client.currentState.items).toEqual([{ id: "2", text: "newer-ws" }]);
    });

    it("forces a clean snapshot instead of Tier 1 replay when reconnecting with failed hydration", async () => {
        const e1 = epoch<"test">("e1");
        const firstGate = Promise.withResolvers<State>();

        const client = new SyncStreamClient<"test", State, Snapshot, Delta, Hydration>({
            initialState: { items: [], notes: [], hydrationError: null },
            reducer: createHydratableReducer(),
            onHydrateHttp: () => firstGate.promise,
        });

        client.markConnecting();
        client.handleFrame({
            type: "sync:snapshot",
            cursor: { epoch: e1, seq: seq<"test">(1) },
            snapshot: { items: { mode: "inline", data: [] } },
        });
        client.handleFrame({
            type: "sync:delta",
            cursor: { epoch: e1, seq: seq<"test">(2) },
            delta: { kind: "append", items: { mode: "http", meta: { total: 1 } } },
        });
        firstGate.reject(new Error("Temporary 503"));
        await vi.waitFor(() => {
            expect(client.hasPendingHydrationRetry).toBe(true);
        });

        // Disconnecting with unhydrated entries must drop the replay cursor so reconnect reloads snapshot.
        client.markReconnecting(1);
        expect(client.handshakeCursor()).toBeUndefined();
        client.markConnecting();
        expect(client.handshakeCursor()).toBeUndefined();

        client.handleFrame({
            type: "sync:snapshot",
            cursor: { epoch: e1, seq: seq<"test">(3) },
            snapshot: { items: { mode: "inline", data: [{ id: "1", text: "from-snapshot" }] } },
        });
        expect(client.hasPendingHydrationRetry).toBe(false);
        expect(client.currentPhase).toEqual({ kind: "live", cursor: { epoch: e1, seq: 3 } });
        expect(client.currentState.items).toEqual([{ id: "1", text: "from-snapshot" }]);
    });

    it("rejects stale-epoch externalRefresh while live and recovers when connecting WS snapshot lags", () => {
        const e1 = epoch<"test">("e1");
        const e2 = epoch<"test">("e2");
        const client = new SyncStreamClient<"test", State, Snapshot, Delta, Hydration>({
            initialState: { items: [], notes: [] },
            reducer: createHydratableReducer(),
            maxPendingDeltas: 2,
        });

        // Connecting + HTTP refresh advances cursor to seq 10, then lagging WS snapshot seq 8 arrives.
        client.markConnecting();
        client.beginExternalRefresh();
        expect(
            client.completeExternalRefresh(
                { items: { mode: "inline", data: [{ id: "10", text: "http-10" }] } },
                { epoch: e1, seq: seq<"test">(10) },
            ),
        ).toBe(true);
        client.handleFrame({
            type: "sync:snapshot",
            cursor: { epoch: e1, seq: seq<"test">(8) },
            snapshot: { items: { mode: "inline", data: [{ id: "8", text: "stale-ws-8" }] } },
        });
        expect(client.currentPhase).toEqual({ kind: "live", cursor: { epoch: e1, seq: 10 } });
        expect(client.currentState.items).toEqual([{ id: "10", text: "http-10" }]);

        // Watermark-drained deltas <= 10 dedupe; seq 11 applies cleanly.
        client.handleFrame({
            type: "sync:delta",
            cursor: { epoch: e1, seq: seq<"test">(9) },
            delta: { kind: "note", note: "dup-9" },
        });
        client.handleFrame({
            type: "sync:delta",
            cursor: { epoch: e1, seq: seq<"test">(11) },
            delta: { kind: "note", note: "live-11" },
        });
        expect(client.currentState.notes).toEqual(["live-11"]);

        // Server restarts onto e2; an HTTP refresh carrying stale e1 must be rejected.
        client.beginExternalRefresh();
        client.handleFrame({
            type: "sync:snapshot",
            cursor: { epoch: e2, seq: seq<"test">(1) },
            snapshot: { items: { mode: "inline", data: [{ id: "2", text: "live-e2" }] } },
        });
        expect(
            client.completeExternalRefresh(
                { items: { mode: "inline", data: [{ id: "1", text: "stale-e1" }] } },
                { epoch: e1, seq: seq<"test">(50) },
            ),
        ).toBe(false);
        expect(client.currentPhase).toEqual({ kind: "live", cursor: { epoch: e2, seq: 1 } });
        expect(client.currentState.items).toEqual([{ id: "2", text: "live-e2" }]);

        // Rejecting externalRefresh when WS buffer overflows maxPendingDeltas while HTTP is in flight.
        client.beginExternalRefresh();
        client.handleFrame({
            type: "sync:delta",
            cursor: { epoch: e2, seq: seq<"test">(2) },
            delta: { kind: "note", note: "d2" },
        });
        client.handleFrame({
            type: "sync:delta",
            cursor: { epoch: e2, seq: seq<"test">(3) },
            delta: { kind: "note", note: "d3" },
        });
        client.handleFrame({
            type: "sync:delta",
            cursor: { epoch: e2, seq: seq<"test">(4) },
            delta: { kind: "note", note: "d4-overflows-refresh-buffer" },
        });
        expect(
            client.completeExternalRefresh(
                { items: { mode: "inline", data: [{ id: "1", text: "stale-http" }] } },
                { epoch: e2, seq: seq<"test">(1) },
            ),
        ).toBe(false);
        expect(client.currentState.notes).toEqual(["d2", "d3", "d4-overflows-refresh-buffer"]);
    });

    it("ignores stale-epoch externalRefresh deltas and preserves pendingOverflow cleanly", async () => {
        const e1 = epoch<"test">("e1");
        const e2 = epoch<"test">("e2");
        const gate = Promise.withResolvers<State>();
        const resyncReasons: string[] = [];

        const client = new SyncStreamClient<"test", State, Snapshot, Delta, Hydration>({
            initialState: { items: [], notes: [] },
            reducer: createHydratableReducer(),
            maxPendingDeltas: 1,
            onHydrateHttp: () => gate.promise,
            onResyncRequired: (reason) => resyncReasons.push(reason),
        });

        client.markConnecting();
        client.handleFrame({
            type: "sync:snapshot",
            cursor: { epoch: e1, seq: seq<"test">(1) },
            snapshot: { items: { mode: "inline", data: [] } },
        });

        client.beginExternalRefresh();
        client.handleFrame({
            type: "sync:delta",
            cursor: { epoch: e1, seq: seq<"test">(2) },
            delta: { kind: "note", note: "old-epoch-delta" },
        });
        // Transport drops into reconnecting before HTTP returns from a newly restarted server on e2.
        client.markReconnecting(1);
        const applied = client.completeExternalRefresh(
            { items: { mode: "inline", data: [{ id: "2", text: "new-epoch" }] } },
            { epoch: e2, seq: seq<"test">(1) },
        );
        expect(applied).toBe(true);
        expect(client.currentState.notes).toEqual([]);

        // Trigger hydration overflow then send a skipped-seq delta; overflow must win over hydration_gap.
        client.markConnecting();
        client.handleFrame({
            type: "sync:snapshot",
            cursor: { epoch: e2, seq: seq<"test">(2) },
            snapshot: { items: { mode: "http", meta: { total: 5 } } },
        });
        client.handleFrame({
            type: "sync:delta",
            cursor: { epoch: e2, seq: seq<"test">(3) },
            delta: { kind: "note", note: "p1" },
        });
        client.handleFrame({
            type: "sync:delta",
            cursor: { epoch: e2, seq: seq<"test">(4) },
            delta: { kind: "note", note: "overflows" },
        });
        client.handleFrame({
            type: "sync:delta",
            cursor: { epoch: e2, seq: seq<"test">(10) },
            delta: { kind: "note", note: "skipped-after-overflow" },
        });

        gate.resolve({ items: [{ id: "1", text: "done" }], notes: [] });
        await vi.waitFor(() => {
            expect(resyncReasons).toEqual(["pending_overflow"]);
        });
    });

    it("aborts an in-flight retryHydration when enterResyncing fires on epoch mismatch", async () => {
        const e1 = epoch<"test">("e1");
        const e2 = epoch<"test">("e2");
        const firstGate = Promise.withResolvers<State>();
        const retryGate = Promise.withResolvers<State>();
        let retrySignal: AbortSignal | undefined;
        let call = 0;

        const client = new SyncStreamClient<"test", State, Snapshot, Delta, Hydration>({
            initialState: { items: [], notes: [], hydrationError: null },
            reducer: createHydratableReducer(),
            onHydrateHttp: (_descriptor, ctx) => {
                call += 1;
                if (call === 1) {
                    return firstGate.promise;
                }
                retrySignal = ctx.signal;
                return retryGate.promise;
            },
        });

        client.markConnecting();
        client.handleFrame({
            type: "sync:snapshot",
            cursor: { epoch: e1, seq: seq<"test">(1) },
            snapshot: { items: { mode: "inline", data: [] } },
        });
        client.handleFrame({
            type: "sync:delta",
            cursor: { epoch: e1, seq: seq<"test">(2) },
            delta: { kind: "append", items: { mode: "http", meta: { total: 1 } } },
        });
        firstGate.reject(new Error("Temporary 503"));
        await vi.waitFor(() => {
            expect(client.hasPendingHydrationRetry).toBe(true);
        });

        expect(client.retryHydration()).toBe(true);
        expect(retrySignal?.aborted).toBe(false);

        client.handleFrame({
            type: "sync:delta",
            cursor: { epoch: e2, seq: seq<"test">(1) },
            delta: { kind: "note", note: "new-epoch" },
        });
        expect(retrySignal?.aborted).toBe(true);
        expect(client.hasPendingHydrationRetry).toBe(false);
    });
});
