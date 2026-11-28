import { describe, expect, it } from "vitest";

import { createFrameCoalescer, type FrameScheduler } from "./useFrameCoalescedValue";

function createManualScheduler(): {
    scheduler: FrameScheduler;
    flushFrame: () => void;
    pendingCount: () => number;
} {
    let nextId = 1;
    const pending = new Map<number, () => void>();
    return {
        scheduler: {
            request(callback) {
                const id = nextId;
                nextId += 1;
                pending.set(id, callback);
                return id;
            },
            cancel(handle) {
                pending.delete(handle);
            },
        },
        flushFrame() {
            const entries = [...pending.values()];
            pending.clear();
            for (const run of entries) {
                run();
            }
        },
        pendingCount() {
            return pending.size;
        },
    };
}

describe("createFrameCoalescer", () => {
    it("collapses multiple pushes inside one frame to a single latest commit", () => {
        const manual = createManualScheduler();
        const committed: string[] = [];
        const coalescer = createFrameCoalescer("v0", (next) => committed.push(next), manual.scheduler);

        coalescer.push("v1");
        coalescer.push("v2");
        coalescer.push("v3");

        expect(committed).toEqual([]);
        expect(manual.pendingCount()).toBe(1);

        manual.flushFrame();
        expect(committed).toEqual(["v3"]);
        expect(manual.pendingCount()).toBe(0);
    });

    it("flushes immediately and cancels any pending frame when flushImmediately returns true", () => {
        const manual = createManualScheduler();
        const committed: string[] = [];
        const coalescer = createFrameCoalescer("idle", (next) => committed.push(next), manual.scheduler);

        const flushOnEnd = (_prev: string, next: string): boolean => next === "done";

        coalescer.push("tok-1", flushOnEnd);
        expect(manual.pendingCount()).toBe(1);

        coalescer.push("done", flushOnEnd);
        expect(committed).toEqual(["done"]);
        expect(manual.pendingCount()).toBe(0);

        manual.flushFrame();
        expect(committed).toEqual(["done"]);
    });

    it("cancels scheduled work on dispose", () => {
        const manual = createManualScheduler();
        const committed: number[] = [];
        const coalescer = createFrameCoalescer(0, (next) => committed.push(next), manual.scheduler);

        coalescer.push(1);
        expect(manual.pendingCount()).toBe(1);
        coalescer.dispose();
        expect(manual.pendingCount()).toBe(0);
        manual.flushFrame();
        expect(committed).toEqual([]);
    });
});
