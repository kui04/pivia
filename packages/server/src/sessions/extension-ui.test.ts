import type { RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";

import type { WsServerMessage } from "@pivia/protocol";
import { describe, expect, it } from "vitest";

import { SessionUiBridge } from "./extension-ui.ts";

function createBridge(): { bridge: SessionUiBridge; messages: WsServerMessage[] } {
    const messages: WsServerMessage[] = [];
    const bridge = new SessionUiBridge("session-1", (message) => messages.push(message), { nowMs: () => 1_000 });
    return { bridge, messages };
}

describe("SessionUiBridge", () => {
    it("keeps a mismatched response pending and accepts the matching payload", async () => {
        const { bridge, messages } = createBridge();
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
        expect(messages.some((message) => message.type === "extension_ui_resolved")).toBe(false);

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
        const { bridge, messages } = createBridge();
        const selected = bridge.context.select("Pick one", ["yes", "no"]);
        expect(bridge.hasPending()).toBe(true);

        bridge.dispose();
        await expect(selected).resolves.toBeUndefined();
        expect(bridge.hasPending()).toBe(false);
        expect(bridge.pendingRequests()).toEqual([]);

        const messageCount = messages.length;
        const confirmed = bridge.context.confirm("After dispose", "Must resolve immediately.");
        await expect(confirmed).resolves.toBe(false);
        expect(bridge.hasPending()).toBe(false);
        expect(messages).toHaveLength(messageCount);
        expect(bridge.handleResponse({ type: "extension_ui_response", id: "unknown", cancelled: true })).toEqual({
            ok: false,
            reason: "unknown",
        });
    });

    it("cancelPending resolves defaults and notifies clients", async () => {
        const { bridge, messages } = createBridge();
        const selected = bridge.context.select("Pick one", ["yes", "no"]);
        const request = bridge.pendingRequests()[0];
        if (request === undefined) {
            throw new Error("expected a pending select dialog");
        }

        bridge.cancelPending();
        await expect(selected).resolves.toBeUndefined();
        expect(bridge.hasPending()).toBe(false);
        expect(messages).toContainEqual({
            type: "extension_ui_resolved",
            sessionId: "session-1",
            requestId: request.id,
        });
    });
});
