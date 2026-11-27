import type { WorkspaceWsServerMessage } from "@pivia/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FakeWebSocket } from "@/test/fake-socket";
import { catalogEpoch, catalogSeq, sid } from "@/test/ids";

import { buildWorkspaceSocketUrl, connectWorkspaceSocket } from "./workspace-socket";

describe("workspace-socket", () => {
    beforeEach(() => {
        FakeWebSocket.reset();
    });

    it("builds ws and wss URLs from page URL and optional cursor", () => {
        expect(buildWorkspaceSocketUrl("http://127.0.0.1:3141/workspace/abc")).toBe("ws://127.0.0.1:3141/ws/workspace");
        expect(buildWorkspaceSocketUrl("https://pivia.example.com/workspace?x=1#top")).toBe(
            "wss://pivia.example.com/ws/workspace",
        );
        expect(
            buildWorkspaceSocketUrl("https://pivia.example.com/workspace", {
                epoch: catalogEpoch("epoch-1"),
                seq: catalogSeq(7),
            }),
        ).toBe("wss://pivia.example.com/ws/workspace?epoch=epoch-1&afterSeq=7");
    });

    it("decodes valid workspace messages and reports protocol errors for malformed frames", () => {
        const received: WorkspaceWsServerMessage[] = [];
        const protocolErrors: string[] = [];
        const onOpen = vi.fn();
        const onClose = vi.fn();

        const handle = connectWorkspaceSocket({
            url: "ws://localhost/ws/workspace",
            WebSocket: FakeWebSocket,
            handlers: {
                onOpen,
                onMessage: (message) => {
                    received.push(message);
                },
                onClose,
                onProtocolError: (reason) => {
                    protocolErrors.push(reason);
                },
            },
        });

        const socket = FakeWebSocket.instances[0];
        if (socket === undefined) {
            throw new Error("expected socket instance");
        }
        expect(socket.url).toBe("ws://localhost/ws/workspace");

        socket.open();
        expect(onOpen).toHaveBeenCalledTimes(1);

        const summary = {
            id: sid("session-1"),
            cwd: "/workspace/repo",
            name: "One",
            firstMessage: "hi",
            messageCount: 1,
            createdAtMs: 1000,
            modifiedAtMs: 2000,
            hasParent: false,
            runtimeState: "idle" as const,
            attachedClients: 0,
        };

        const epoch = catalogEpoch("epoch-1");
        socket.receive({
            type: "sync:snapshot",
            cursor: { epoch, seq: 0 },
            snapshot: {
                sessions: [summary],
                updatedAtMs: 3000,
            },
        });
        socket.receive({
            type: "sync:delta",
            cursor: { epoch, seq: 1 },
            delta: { op: "upsert", item: summary },
        });
        socket.receive({
            type: "sync:delta",
            cursor: { epoch, seq: 2 },
            delta: { op: "patch", id: summary.id, patch: { runtimeState: "streaming" } },
        });
        socket.receive({
            type: "sync:delta",
            cursor: { epoch, seq: 3 },
            delta: { op: "remove", id: summary.id },
        });
        socket.receive({
            type: "sync:replay",
            cursor: { epoch, seq: 4 },
            fromSeq: 3,
            deltas: [{ seq: 4, payload: { op: "remove", id: summary.id } }],
        });
        socket.receive({ type: "sync:resync", reason: "gap" });

        expect(received).toEqual([
            {
                type: "sync:snapshot",
                cursor: { epoch, seq: catalogSeq(0) },
                snapshot: { sessions: [summary], updatedAtMs: 3000 },
            },
            {
                type: "sync:delta",
                cursor: { epoch, seq: catalogSeq(1) },
                delta: { op: "upsert", item: summary },
            },
            {
                type: "sync:delta",
                cursor: { epoch, seq: catalogSeq(2) },
                delta: { op: "patch", id: summary.id, patch: { runtimeState: "streaming" } },
            },
            {
                type: "sync:delta",
                cursor: { epoch, seq: catalogSeq(3) },
                delta: { op: "remove", id: summary.id },
            },
            {
                type: "sync:replay",
                cursor: { epoch, seq: catalogSeq(4) },
                fromSeq: catalogSeq(3),
                deltas: [{ seq: catalogSeq(4), payload: { op: "remove", id: summary.id } }],
            },
            { type: "sync:resync", reason: "gap" },
        ]);

        socket.receiveRaw(new ArrayBuffer(4));
        socket.receiveRaw("{bad json");
        socket.receive({ type: "session_removed", sessionId: "../invalid" });

        expect(received).toHaveLength(6);
        expect(protocolErrors).toHaveLength(3);

        socket.serverClose(1006, "Lost", false);
        expect(onClose).toHaveBeenCalledWith({ code: 1006, reason: "Lost", wasClean: false });

        // Closing after remote close is a no-op.
        handle.close(1000, "Done");
        expect(socket.closeCalls).toEqual([]);
    });

    it("closes cleanly without invoking onClose after explicit client close", () => {
        const onClose = vi.fn();
        const handle = connectWorkspaceSocket({
            url: "ws://localhost/ws/workspace",
            WebSocket: FakeWebSocket,
            handlers: {
                onMessage: () => {},
                onClose,
            },
        });

        const socket = FakeWebSocket.instances[0];
        if (socket === undefined) {
            throw new Error("expected socket instance");
        }

        handle.close(1000, "Workspace closed");
        handle.close(1000, "Workspace closed");
        socket.serverClose(1000, "Workspace closed", true);

        expect(socket.closeCalls).toEqual([{ code: 1000, reason: "Workspace closed" }]);
        expect(onClose).not.toHaveBeenCalled();
    });
});
