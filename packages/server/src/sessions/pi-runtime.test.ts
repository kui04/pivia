import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { observeSessionManagerAppends, SESSION_APPEND_METHODS } from "./pi-runtime.ts";

describe("observeSessionManagerAppends", () => {
    // The incremental sync depends on every write reaching the client. A renamed SDK method would
    // otherwise stop the broadcast silently, so the contract is asserted against the installed SDK.
    it("covers every append method the installed SDK exposes", () => {
        for (const methodName of SESSION_APPEND_METHODS) {
            expect(typeof SessionManager.prototype[methodName], methodName).toBe("function");
        }
    });

    it("notifies on every wrapped call and restores the originals on dispose", () => {
        const original = {
            appendMessage: (message: unknown) => `id-${String(message)}`,
            appendUsage: () => "usage",
        };
        const manager = { ...original } as unknown as SessionManager;
        const listener = vi.fn();

        const dispose = observeSessionManagerAppends(manager, listener);
        const patched = manager as unknown as typeof original;

        expect(patched.appendMessage("hello")).toBe("id-hello");
        expect(patched.appendUsage()).toBe("usage");
        expect(listener).toHaveBeenCalledTimes(2);

        dispose();

        expect(patched.appendMessage).toBe(original.appendMessage);
        expect(patched.appendUsage).toBe(original.appendUsage);
    });
});
