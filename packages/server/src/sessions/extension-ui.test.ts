import type { RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";

import { parseSessionId } from "@pivia/protocol";
import { describe, expect, it } from "vitest";

import { SessionUiBridge, type SessionUiDelta } from "./extension-ui.ts";

function createBridge(): { bridge: SessionUiBridge; deltas: SessionUiDelta[] } {
    const deltas: SessionUiDelta[] = [];
    const sessionId = parseSessionId("session-1");
    if (sessionId === null) {
        throw new Error("invalid test session id");
    }
    const bridge = new SessionUiBridge(sessionId, (delta) => deltas.push(delta), { nowMs: () => 1_000 });
    return { bridge, deltas };
}

describe("SessionUiBridge", () => {
    it("keeps a mismatched response pending and accepts the matching payload", async () => {
        const { bridge, deltas } = createBridge();
        const confirmed = bridge.context.confirm("Clear session?", "All messages will be lost.");
        const request = bridge.pendingRequests()[0];
        if (request === undefined) {
            throw new Error("expected a pending confirm dialog");
        }

        const mismatched: RpcExtensionUIResponse = {
            type: "extension_ui_response",
            id: request.id,
            value: "not-a-confirmation",
        };
        expect(bridge.handleResponse(mismatched)).toEqual({ ok: false, reason: "mismatched" });
        expect(bridge.hasPending()).toBe(true);
        expect(deltas.some((delta) => delta.kind === "ui_resolved")).toBe(false);

        expect(bridge.handleResponse({ type: "extension_ui_response", id: request.id, confirmed: true })).toEqual({
            ok: true,
        });
        await expect(confirmed).resolves.toBe(true);
        expect(bridge.hasPending()).toBe(false);
    });

    it("ignores unknown response ids", () => {
        const { bridge } = createBridge();
        expect(bridge.handleResponse({ type: "extension_ui_response", id: "unknown", cancelled: true })).toEqual({
            ok: false,
            reason: "unknown",
        });
    });

    it("resolves defaults and stops emitting after dispose", async () => {
        const { bridge, deltas } = createBridge();
        const selected = bridge.context.select("Pick one", ["yes", "no"]);
        expect(bridge.hasPending()).toBe(true);

        bridge.dispose();
        await expect(selected).resolves.toBeUndefined();
        expect(bridge.hasPending()).toBe(false);
        expect(bridge.pendingRequests()).toEqual([]);

        const deltaCount = deltas.length;
        const confirmed = bridge.context.confirm("After dispose", "Must resolve immediately.");
        await expect(confirmed).resolves.toBe(false);
        expect(bridge.hasPending()).toBe(false);
        expect(deltas).toHaveLength(deltaCount);
        expect(bridge.handleResponse({ type: "extension_ui_response", id: "unknown", cancelled: true })).toEqual({
            ok: false,
            reason: "unknown",
        });
    });

    it("cancelPending resolves defaults and notifies clients", async () => {
        const { bridge, deltas } = createBridge();
        const selected = bridge.context.select("Pick one", ["yes", "no"]);
        const request = bridge.pendingRequests()[0];
        if (request === undefined) {
            throw new Error("expected a pending select dialog");
        }

        bridge.cancelPending();
        await expect(selected).resolves.toBeUndefined();
        expect(bridge.hasPending()).toBe(false);
        expect(deltas).toContainEqual({
            kind: "ui_resolved",
            requestId: request.id,
        });
    });
});
