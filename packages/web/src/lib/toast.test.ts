import { afterEach, describe, expect, it, vi } from "vitest";

import { createToastManager } from "../components/Toast/useToast";

import { toastManager, showError, showWarning } from "./toast";

function probeTimeouts() {
    const manager = createToastManager();
    const timeouts: Array<number | undefined> = [];
    const unsubscribe = manager[" subscribe"]((event) => {
        if (event.action === "add") {
            timeouts.push((event.options as { timeout?: number | undefined }).timeout);
        }
    });

    return { manager, timeouts, unsubscribe };
}

describe("toast manager timeouts", () => {
    it("keeps a warning and an error until the user dismisses them", () => {
        const { manager, timeouts, unsubscribe } = probeTimeouts();

        manager.add({ type: "warning", title: "Slow connection" });
        manager.add({ type: "error", title: "Save failed" });
        manager.add({ type: "info", title: "Update available" });
        manager.add({ type: "success", title: "Saved" });

        expect(timeouts).toEqual([0, 0, undefined, undefined]);
        unsubscribe();
    });

    it("keeps an explicit timeout on every type", () => {
        const { manager, timeouts, unsubscribe } = probeTimeouts();

        manager.add({ type: "warning", title: "Slow connection", timeout: 5000 });
        manager.add({ type: "error", title: "Failed", timeout: 0 });
        manager.add({ type: "info", title: "Update available", timeout: 2000 });

        expect(timeouts).toEqual([5000, 0, 2000]);
        unsubscribe();
    });
});

describe("app toasts", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("sends errors urgently and warnings politely", () => {
        const add = vi.spyOn(toastManager, "add").mockReturnValue("toast-id");

        showError({ id: "save", title: "Save failed" });
        showWarning({ id: "connection", title: "Slow connection" });

        expect(add.mock.calls[0]?.[0]).toMatchObject({
            id: "save",
            type: "error",
            priority: "high",
            title: "Save failed",
        });
        expect(add.mock.calls[1]?.[0]).toMatchObject({
            id: "connection",
            type: "warning",
            priority: "low",
            title: "Slow connection",
        });
    });

    it("passes the description and action through unchanged", () => {
        const add = vi.spyOn(toastManager, "add").mockReturnValue("toast-id");
        const onClick = vi.fn();

        showError({
            id: "network",
            title: "Connection lost",
            description: "The server is not reachable.",
            action: { label: "Retry", onClick },
        });

        expect(add.mock.calls[0]?.[0]).toMatchObject({
            description: "The server is not reachable.",
            actionProps: { children: "Retry", onClick },
        });
    });
});
