import { afterEach, describe, expect, it, vi } from "vitest";

import { createHeartbeat, type HeartbeatSocket } from "./heartbeat.ts";

interface FakeSocket extends HeartbeatSocket {
    readyState: number;
    pings: number;
    terminations: number;
}

/** `ws` readyState value for a closed connection. */
const WS_READY_STATE_CLOSED = 3;

function createFakeSocket(readyState = 1): FakeSocket {
    const socket: FakeSocket = {
        readyState,
        pings: 0,
        terminations: 0,
        ping() {
            socket.pings += 1;
        },
        terminate() {
            socket.terminations += 1;
        },
    };
    return socket;
}

describe("websocket heartbeat", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("pings a tracked socket and terminates it after one missed pong", () => {
        vi.useFakeTimers();
        const stale: HeartbeatSocket[] = [];
        const heartbeat = createHeartbeat({ intervalMs: 1_000, onStale: (socket) => stale.push(socket) });
        const socket = createFakeSocket();
        heartbeat.track(socket);

        vi.advanceTimersByTime(1_000);
        expect(socket.pings).toBe(1);
        expect(socket.terminations).toBe(0);

        vi.advanceTimersByTime(1_000);
        expect(socket.terminations).toBe(1);
        expect(stale).toEqual([socket]);
        expect(heartbeat.size).toBe(0);

        // A terminated socket is forgotten, so later ticks touch nothing.
        vi.advanceTimersByTime(5_000);
        expect(socket.terminations).toBe(1);
        heartbeat.dispose();
    });

    it("keeps a socket that answers every ping", () => {
        vi.useFakeTimers();
        const heartbeat = createHeartbeat({ intervalMs: 1_000 });
        const socket = createFakeSocket();
        heartbeat.track(socket);

        for (let tick = 0; tick < 5; tick += 1) {
            vi.advanceTimersByTime(1_000);
            heartbeat.markAlive(socket);
        }

        expect(socket.pings).toBe(5);
        expect(socket.terminations).toBe(0);
        expect(heartbeat.size).toBe(1);
        heartbeat.dispose();
    });

    it("forgets a closed socket without pinging or terminating it", () => {
        vi.useFakeTimers();
        const heartbeat = createHeartbeat({ intervalMs: 1_000 });
        const socket = createFakeSocket(WS_READY_STATE_CLOSED);
        heartbeat.track(socket);

        vi.advanceTimersByTime(5_000);

        expect(socket.pings).toBe(0);
        expect(socket.terminations).toBe(0);
        expect(heartbeat.size).toBe(0);
        heartbeat.dispose();
    });

    it("stops tracking a socket after untrack", () => {
        vi.useFakeTimers();
        const heartbeat = createHeartbeat({ intervalMs: 1_000 });
        const socket = createFakeSocket();
        heartbeat.track(socket);
        heartbeat.untrack(socket);
        expect(heartbeat.size).toBe(0);

        vi.advanceTimersByTime(5_000);

        expect(socket.pings).toBe(0);
        expect(socket.terminations).toBe(0);
        heartbeat.dispose();
    });

    it("does not track anything when the interval is disabled", () => {
        vi.useFakeTimers();
        const heartbeat = createHeartbeat({ intervalMs: 0 });
        const socket = createFakeSocket();
        heartbeat.track(socket);

        vi.advanceTimersByTime(60_000);

        expect(heartbeat.size).toBe(0);
        expect(socket.pings).toBe(0);
        heartbeat.dispose();
    });

    it("stops the timer on dispose", () => {
        vi.useFakeTimers();
        const heartbeat = createHeartbeat({ intervalMs: 1_000 });
        const socket = createFakeSocket();
        heartbeat.track(socket);
        heartbeat.dispose();
        expect(heartbeat.size).toBe(0);

        vi.advanceTimersByTime(5_000);

        expect(socket.pings).toBe(0);
        expect(socket.terminations).toBe(0);
    });

    it("reports a failed ping and stops tracking that socket", () => {
        vi.useFakeTimers();
        const errors: unknown[] = [];
        const heartbeat = createHeartbeat({
            intervalMs: 1_000,
            onError: (error) => errors.push(error),
        });
        const failure = new Error("ping failed");
        const socket: FakeSocket = {
            ...createFakeSocket(),
            ping() {
                throw failure;
            },
        };
        heartbeat.track(socket);

        vi.advanceTimersByTime(1_000);

        expect(errors).toEqual([failure]);
        expect(heartbeat.size).toBe(0);
        heartbeat.dispose();
    });

    it("rejects an invalid interval", () => {
        expect(() => createHeartbeat({ intervalMs: -1 })).toThrow("intervalMs must be a non-negative");
        expect(() => createHeartbeat({ intervalMs: Number.NaN })).toThrow("intervalMs must be a non-negative");
    });
});
