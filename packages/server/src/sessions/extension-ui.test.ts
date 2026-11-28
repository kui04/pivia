import type { RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";

import { EMPTY_SESSION_UI_STATE, parseSessionId } from "@pivia/protocol";
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

    it("keeps statuses, widgets, and the title for late snapshots", () => {
        const { bridge } = createBridge();

        bridge.context.setStatus("lint", "clean");
        bridge.context.setStatus("git", "main");
        bridge.context.setStatus("lint", undefined);
        bridge.context.setWidget("plan", ["step one"], { placement: "belowEditor" });
        bridge.context.setWidget("todo", ["a", "b"]);
        bridge.context.setTitle("Release checklist");

        expect(bridge.uiState()).toEqual({
            statuses: [{ key: "git", text: "main" }],
            widgets: [
                { key: "plan", lines: ["step one"], placement: "belowEditor" },
                { key: "todo", lines: ["a", "b"], placement: "aboveEditor" },
            ],
            title: "Release checklist",
        });
    });

    it("clears chrome on reset and dispose, telling clients to drop it", () => {
        const { bridge, deltas } = createBridge();
        bridge.context.setStatus("lint", "clean");
        bridge.context.setWidget("todo", ["a"]);
        bridge.context.setTitle("Release checklist");

        bridge.resetUiState();

        expect(bridge.uiState()).toEqual(EMPTY_SESSION_UI_STATE);
        const requests = deltas.filter((delta) => delta.kind === "ui_request").map((delta) => delta.request);
        expect(
            requests.some(
                (request) =>
                    request.method === "setStatus" && request.statusKey === "lint" && request.statusText === undefined,
            ),
        ).toBe(true);
        expect(
            requests.some(
                (request) =>
                    request.method === "setWidget" &&
                    request.widgetKey === "todo" &&
                    request.widgetLines === undefined &&
                    request.widgetPlacement === "aboveEditor",
            ),
        ).toBe(true);
        expect(requests.some((request) => request.method === "setTitle" && request.title === "")).toBe(true);

        bridge.context.setStatus("lint", "clean");
        bridge.context.setTitle("");
        expect(bridge.uiState().title).toBeNull();

        bridge.dispose();
        expect(bridge.uiState()).toEqual(EMPTY_SESSION_UI_STATE);

        // Chrome updates arriving after dispose must not repopulate stored snapshot state.
        bridge.context.setStatus("late", "value");
        bridge.context.setWidget("late", ["line"]);
        bridge.context.setTitle("Late");
        expect(bridge.uiState()).toEqual(EMPTY_SESSION_UI_STATE);
    });
});
