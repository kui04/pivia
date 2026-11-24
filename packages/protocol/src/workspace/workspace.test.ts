import { describe, expect, it } from "vitest";

import { parseWorkspaceWsServerMessage } from "./index.ts";

describe("workspace codecs", () => {
    it("parses workspace SyncFrame messages and rejects malformed payloads", () => {
        const sessionSummary = {
            id: "session-1",
            cwd: "/workspace/repo",
            name: "First session",
            firstMessage: "hi",
            messageCount: 2,
            createdAtMs: 1000,
            modifiedAtMs: 2000,
            hasParent: false,
            runtimeState: "idle",
            attachedClients: 1,
        };

        expect(
            parseWorkspaceWsServerMessage({
                type: "sync:snapshot",
                cursor: { epoch: "epoch-1", seq: 0 },
                snapshot: { sessions: [sessionSummary], updatedAtMs: 3000 },
            }),
        ).toEqual({
            type: "sync:snapshot",
            cursor: { epoch: "epoch-1", seq: 0 },
            snapshot: { sessions: [sessionSummary], updatedAtMs: 3000 },
        });

        expect(
            parseWorkspaceWsServerMessage({
                type: "sync:delta",
                cursor: { epoch: "epoch-1", seq: 1 },
                delta: { op: "upsert", item: sessionSummary },
            }),
        ).toEqual({
            type: "sync:delta",
            cursor: { epoch: "epoch-1", seq: 1 },
            delta: { op: "upsert", item: sessionSummary },
        });

        expect(
            parseWorkspaceWsServerMessage({
                type: "sync:delta",
                cursor: { epoch: "epoch-1", seq: 2 },
                delta: {
                    op: "patch",
                    id: "session-1",
                    patch: {
                        name: null,
                        firstMessage: "full message",
                        messageCount: 3,
                        modifiedAtMs: 2500,
                        runtimeState: "streaming",
                        attachedClients: 2,
                    },
                },
            }),
        ).toEqual({
            type: "sync:delta",
            cursor: { epoch: "epoch-1", seq: 2 },
            delta: {
                op: "patch",
                id: "session-1",
                patch: {
                    name: null,
                    firstMessage: "full message",
                    messageCount: 3,
                    modifiedAtMs: 2500,
                    runtimeState: "streaming",
                    attachedClients: 2,
                },
            },
        });

        expect(
            parseWorkspaceWsServerMessage({
                type: "sync:delta",
                cursor: { epoch: "epoch-1", seq: 3 },
                delta: { op: "remove", id: "session-1" },
            }),
        ).toEqual({
            type: "sync:delta",
            cursor: { epoch: "epoch-1", seq: 3 },
            delta: { op: "remove", id: "session-1" },
        });

        expect(parseWorkspaceWsServerMessage(null)).toBeNull();
        expect(parseWorkspaceWsServerMessage({ type: "unknown_type" })).toBeNull();
        expect(
            parseWorkspaceWsServerMessage({
                type: "sync:snapshot",
                snapshot: { sessions: [sessionSummary], updatedAtMs: 3000 },
            }),
        ).toBeNull();
        expect(
            parseWorkspaceWsServerMessage({
                type: "sync:snapshot",
                cursor: { epoch: "epoch-1", seq: 0 },
                snapshot: { sessions: [{ ...sessionSummary, id: "../bad" }], updatedAtMs: 3000 },
            }),
        ).toBeNull();
        expect(
            parseWorkspaceWsServerMessage({
                type: "sync:snapshot",
                cursor: { epoch: "epoch-1", seq: 0 },
                snapshot: { sessions: [sessionSummary], updatedAtMs: Number.NaN },
            }),
        ).toBeNull();
        expect(
            parseWorkspaceWsServerMessage({
                type: "sync:delta",
                cursor: { epoch: "epoch-1", seq: 1 },
                delta: { op: "upsert", item: { ...sessionSummary, runtimeState: "bogus" } },
            }),
        ).toBeNull();
        expect(
            parseWorkspaceWsServerMessage({
                type: "sync:delta",
                cursor: { epoch: "", seq: 1 },
                delta: { op: "upsert", item: sessionSummary },
            }),
        ).toBeNull();
        expect(
            parseWorkspaceWsServerMessage({
                type: "sync:delta",
                cursor: { epoch: "epoch-1", seq: 2 },
                delta: { op: "patch", id: "../bad", patch: { runtimeState: "idle" } },
            }),
        ).toBeNull();
        expect(
            parseWorkspaceWsServerMessage({
                type: "sync:delta",
                cursor: { epoch: "epoch-1", seq: 2 },
                delta: { op: "patch", id: "session-1", patch: {} },
            }),
        ).toBeNull();
        expect(
            parseWorkspaceWsServerMessage({
                type: "sync:delta",
                cursor: { epoch: "epoch-1", seq: 2 },
                delta: { op: "patch", id: "session-1", patch: { runtimeState: "bogus" } },
            }),
        ).toBeNull();
        expect(
            parseWorkspaceWsServerMessage({
                type: "sync:delta",
                cursor: { epoch: "epoch-1", seq: -1 },
                delta: { op: "remove", id: "session-1" },
            }),
        ).toBeNull();
        expect(
            parseWorkspaceWsServerMessage({
                type: "sync:delta",
                cursor: { epoch: "epoch-1", seq: 3 },
                delta: { op: "remove", id: "../bad" },
            }),
        ).toBeNull();
    });
});
