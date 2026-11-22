import { afterEach, describe, expect, it, vi } from "vitest";

import { createReconnectController } from "./reconnect";

describe("createReconnectController", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("applies exponential backoff, auth probe cutoff, and resync storm protection", async () => {
        vi.useFakeTimers();
        let now = 10_000;
        const reconnects: number[] = [];
        const unauthorized = vi.fn();
        const exhausted = vi.fn();
        let authenticated = true;

        const controller = createReconnectController({
            delaysMs: [100, 200, 400],
            maxAttempts: 4,
            authProbeFailureThreshold: 2,
            authProbe: () => Promise.resolve({ authRequired: true, authenticated }),
            onUnauthorized: unauthorized,
            onReconnect: (attempt) => reconnects.push(attempt),
            onExhausted: exhausted,
            nowMs: () => now,
            listenBrowserEvents: false,
        });

        controller.start();
        // First close schedules immediately without auth probe.
        controller.notifyClosed();
        await vi.advanceTimersByTimeAsync(100);
        expect(reconnects).toEqual([1]);

        // Second close triggers authProbe; authenticated=true schedules attempt 2.
        controller.notifyClosed();
        await Promise.resolve();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(200);
        expect(reconnects).toEqual([1, 2]);

        // First resync in steady state fires immediately via microtask.
        controller.markConnected();
        controller.scheduleResync("gap");
        await Promise.resolve();
        expect(reconnects).toEqual([1, 2, 0]);

        // Repeated resync within cooldown backs off.
        controller.markConnected();
        now += 50;
        controller.scheduleResync("gap");
        await Promise.resolve();
        expect(reconnects).toEqual([1, 2, 0]);
        await vi.advanceTimersByTimeAsync(100);
        expect(reconnects).toEqual([1, 2, 0, 0]);

        // Expired auth cuts off reconnect loop.
        authenticated = false;
        controller.notifyClosed();
        controller.notifyClosed();
        await Promise.resolve();
        await Promise.resolve();
        expect(unauthorized).toHaveBeenCalledOnce();

        controller.stop();
    });

    it("cancels queued scheduleResync microtask when stop/start or wake runs synchronously", async () => {
        const reconnects: number[] = [];
        const controller = createReconnectController({
            delaysMs: [100],
            listenBrowserEvents: false,
            onReconnect: (attempt) => reconnects.push(attempt),
        });

        controller.start();
        controller.scheduleResync("gap");
        controller.stop();
        controller.start();
        await Promise.resolve();
        expect(reconnects).toEqual([]);

        // Calling wake() supersedes the queued scheduleResync microtask so only wake fires.
        controller.scheduleResync("gap");
        controller.wake();
        await Promise.resolve();
        expect(reconnects).toEqual([0]);

        controller.stop();
    });
});
