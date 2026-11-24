import {
    createSyncFrameParser,
    isRecord,
    parseSyncEpoch,
    parseSyncSeq,
    WS_CLOSE_CODE,
    type SyncCursor,
    type SyncEpoch,
    type SyncFrame,
    type SyncSeq,
} from "@pivia/protocol";
import { describe, expect, it } from "vitest";

import { ReplayRingBuffer } from "./replay-buffer.ts";
import { SyncStreamHost } from "./stream-host.ts";
import type { SyncTransportClient } from "./ws-guard.ts";

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

type TestSnapshot = { readonly items: readonly string[] };
type TestDelta = { readonly value: string };
type TestFrame = SyncFrame<"test", TestSnapshot, TestDelta>;

const parseTestFrame = createSyncFrameParser<"test", TestSnapshot, TestDelta>({
    parseSnapshot: (raw) =>
        isRecord(raw) && Array.isArray(raw["items"]) && raw["items"].every((v) => typeof v === "string")
            ? { items: raw["items"] }
            : null,
    parseDelta: (raw) => (isRecord(raw) && typeof raw["value"] === "string" ? { value: raw["value"] } : null),
});

function createMockTransport() {
    const frames: TestFrame[] = [];
    const closed: Array<{ readonly code: number; readonly reason: string }> = [];
    const client: SyncTransportClient = {
        sendRaw(raw) {
            const parsed = parseTestFrame(JSON.parse(raw) as unknown);
            if (parsed === null) {
                throw new Error(`Unexpected invalid frame: ${raw}`);
            }
            frames.push(parsed);
        },
        close(code, reason) {
            closed.push({ code, reason });
        },
    };
    return { client, frames, closed };
}

describe("SyncStreamHost", () => {
    it("advances monotonic seq even with zero subscribers and serves Tier 1 replay", () => {
        const e1 = epoch<"test">("e1");
        const buffer = new ReplayRingBuffer<"test", TestDelta>({ epoch: e1 });
        const host = new SyncStreamHost<"test", TestSnapshot, TestDelta>({
            buffer,
            getSnapshot: () => ({ cursor: buffer.currentCursor, snapshot: { items: ["a", "b"] } }),
        });

        host.publish({ value: "a" });
        host.publish({ value: "b" });
        expect(host.subscriberCount).toBe(0);
        expect(buffer.currentSeq).toBe(2);

        const c1 = createMockTransport();
        const detach = host.attach(c1.client, { cursor: { epoch: e1, seq: seq<"test">(1) } });
        expect(c1.frames).toEqual([
            {
                type: "sync:replay",
                cursor: { epoch: e1, seq: 2 },
                fromSeq: 1,
                deltas: [{ seq: 2, payload: { value: "b" } }],
            },
        ]);

        host.publish({ value: "c" });
        expect(c1.frames[1]).toEqual({
            type: "sync:delta",
            cursor: { epoch: e1, seq: 3 },
            delta: { value: "c" },
        });
        detach();
        expect(host.subscriberCount).toBe(0);
    });

    it("drains handshaking pending frames strictly above snapshot watermark without duplicates", async () => {
        const e1 = epoch<"test">("e1");
        const buffer = new ReplayRingBuffer<"test", TestDelta>({ epoch: e1 });
        const items: string[] = [];

        const snapshotGate = Promise.withResolvers<{ items: readonly string[]; cursor: SyncCursor<"test"> }>();
        const host = new SyncStreamHost<"test", TestSnapshot, TestDelta>({
            buffer,
            getSnapshot: async () => {
                const settled = await snapshotGate.promise;
                return { cursor: settled.cursor, snapshot: { items: settled.items } };
            },
        });

        const mutate = (value: string) => {
            items.push(value);
            host.publish({ value });
        };

        mutate("first");
        const c1 = createMockTransport();
        host.attach(c1.client);

        // Mutation 2 is already reflected in the async snapshot at seq 2; mutation 3 arrives after.
        mutate("second");
        const cursorAtSnapshot = buffer.currentCursor;
        const snapshotItems = [...items];
        mutate("third");

        snapshotGate.resolve({ items: snapshotItems, cursor: cursorAtSnapshot });
        await Promise.resolve();
        await Promise.resolve();

        expect(c1.frames).toEqual([
            { type: "sync:snapshot", cursor: { epoch: e1, seq: 2 }, snapshot: { items: ["first", "second"] } },
            { type: "sync:delta", cursor: { epoch: e1, seq: 3 }, delta: { value: "third" } },
        ]);
    });

    it("emits sync:resync when handshaking pending buffer overflows and closes on snapshot error", async () => {
        const e1 = epoch<"test">("e1");
        const buffer = new ReplayRingBuffer<"test", TestDelta>({ epoch: e1 });
        const gate = Promise.withResolvers<void>();
        const host = new SyncStreamHost<"test", TestSnapshot, TestDelta>({
            buffer,
            maxPendingPerClient: 2,
            getSnapshot: async () => {
                await gate.promise;
                return { cursor: buffer.currentCursor, snapshot: { items: [] } };
            },
        });

        const c1 = createMockTransport();
        host.attach(c1.client);
        host.publish({ value: "1" });
        host.publish({ value: "2" });
        host.publish({ value: "3" }); // overflows cap of 2

        gate.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(c1.frames).toEqual([{ type: "sync:resync", reason: "buffer_evicted" }]);
        expect(c1.closed).toEqual([{ code: WS_CLOSE_CODE.normal, reason: "Handshake resync required" }]);
        expect(host.subscriberCount).toBe(0);

        const failingHost = new SyncStreamHost<"test", TestSnapshot, TestDelta>({
            buffer,
            getSnapshot: () => Promise.reject(new Error("disk error")),
        });
        const c2 = createMockTransport();
        failingHost.attach(c2.client);
        await Promise.resolve();
        await Promise.resolve();
        expect(c2.closed).toEqual([{ code: WS_CLOSE_CODE.internalError, reason: "Snapshot unavailable" }]);
        expect(failingHost.subscriberCount).toBe(0);
    });

    it("aborts cleanly when client detaches during async snapshot and closes on dispose", async () => {
        const e1 = epoch<"test">("e1");
        const buffer = new ReplayRingBuffer<"test", TestDelta>({ epoch: e1 });
        const gate = Promise.withResolvers<void>();
        const host = new SyncStreamHost<"test", TestSnapshot, TestDelta>({
            buffer,
            getSnapshot: async () => {
                await gate.promise;
                return { cursor: buffer.currentCursor, snapshot: { items: ["x"] } };
            },
        });

        const c1 = createMockTransport();
        const detach = host.attach(c1.client);
        detach();
        gate.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(c1.frames).toEqual([]);

        const c2 = createMockTransport();
        host.attach(c2.client);
        host.dispose();
        expect(c2.closed).toEqual([{ code: WS_CLOSE_CODE.goingAway, reason: "Stream disposed" }]);

        const c3 = createMockTransport();
        host.attach(c3.client);
        expect(c3.closed).toEqual([{ code: WS_CLOSE_CODE.goingAway, reason: "Stream disposed" }]);
    });
});
