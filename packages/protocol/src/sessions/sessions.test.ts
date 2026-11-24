import { describe, expect, it } from "vitest";

import {
    commandIdOf,
    parseCloseSessionResponse,
    parseCreateSessionResponse,
    parseEntriesVersion,
    parseExtensionUiResponse,
    parseSessionDetailResponse,
    parseSessionId,
    parseSessionListResponse,
    parseSessionPrefixAnchor,
    parseSessionRpcCommand,
    parseSessionStateSnapshot,
    parseSessionSummary,
    parseSessionSummaryPatch,
    parseSessionWsClientMessage,
    parseSessionWsHandshakeQuery,
    parseSessionWsServerMessage,
} from "./index.ts";

describe("sessions codecs", () => {
    it("parseSessionId accepts safe SDK session ids and rejects path traversal or invalid edges", () => {
        expect(parseSessionId("session-1")).toBe("session-1");
        expect(parseSessionId("0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b")).toBe("0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b");
        expect(parseSessionId("a.b_c-d")).toBe("a.b_c-d");

        expect(parseSessionId(null)).toBeNull();
        expect(parseSessionId("")).toBeNull();
        expect(parseSessionId("..")).toBeNull();
        expect(parseSessionId("../escape")).toBeNull();
        expect(parseSessionId("a/b")).toBeNull();
        expect(parseSessionId("a\\b")).toBeNull();
        expect(parseSessionId("-leading")).toBeNull();
        expect(parseSessionId("trailing-")).toBeNull();
        expect(parseSessionId("%2e%2e")).toBeNull();
    });

    it("parseEntriesVersion validates composite version strings", () => {
        expect(parseEntriesVersion("3:1.5.2")).toBe("3:1.5.2");
        expect(parseEntriesVersion("3:unknown")).toBe("3:unknown");
        expect(parseEntriesVersion("")).toBeNull();
        expect(parseEntriesVersion("3:")).toBeNull();
        expect(parseEntriesVersion("abc:1.0")).toBeNull();
        expect(parseEntriesVersion(123)).toBeNull();
    });

    it("parseSessionPrefixAnchor parses complete valid query anchors and drops incomplete ones", () => {
        expect(
            parseSessionPrefixAnchor({
                entriesVersion: "3:1.5.2",
                afterCount: "4",
                afterEntryId: "entry-4",
            }),
        ).toEqual({
            entriesVersion: "3:1.5.2",
            afterCount: 4,
            afterEntryId: "entry-4",
        });

        expect(
            parseSessionPrefixAnchor({ entriesVersion: "3:1.5.2", afterCount: "0", afterEntryId: "e" }),
        ).toBeUndefined();
        expect(parseSessionPrefixAnchor({ entriesVersion: "bad", afterCount: "2", afterEntryId: "e" })).toBeUndefined();
        expect(parseSessionPrefixAnchor({ entriesVersion: "3:1.5.2", afterCount: "2" })).toBeUndefined();
        expect(parseSessionPrefixAnchor(null)).toBeUndefined();
    });

    it("parseSessionWsHandshakeQuery parses cursor and prefixAnchor and degrades malformed cursors", () => {
        expect(
            parseSessionWsHandshakeQuery({
                epoch: "rt-1",
                afterSeq: "10",
                entriesVersion: "3:1.5.2",
                afterCount: "3",
                afterEntryId: "e3",
            }),
        ).toEqual({
            cursor: { epoch: "rt-1", seq: 10 },
            hint: { entriesVersion: "3:1.5.2", afterCount: 3, afterEntryId: "e3" },
        });

        expect(parseSessionWsHandshakeQuery({ epoch: "rt-1", afterSeq: "nope" })).toEqual({});

        expect(
            parseSessionWsHandshakeQuery({ epoch: "rt-1", afterSeq: "2", entriesVersion: "bad", afterCount: "0" }),
        ).toEqual({
            cursor: { epoch: "rt-1", seq: 2 },
        });

        expect(parseSessionWsHandshakeQuery(undefined)).toEqual({});
    });

    it("parses valid RPC client frames, commands, and extension UI responses", () => {
        expect(commandIdOf({ type: "rpc:command", command: { type: "abort", id: "cmd-1" } })).toBe("cmd-1");
        expect(commandIdOf({ type: "rpc:ui_response", response: { type: "extension_ui_response", id: "req-1" } })).toBe(
            "req-1",
        );
        expect(commandIdOf("not-a-record")).toBeUndefined();

        expect(parseExtensionUiResponse({ type: "extension_ui_response", id: "req-1", confirmed: true })).toEqual({
            type: "extension_ui_response",
            id: "req-1",
            confirmed: true,
        });

        expect(
            parseSessionRpcCommand({ type: "prompt", id: "p1", message: "hello", streamingBehavior: "steer" }),
        ).toEqual({
            type: "prompt",
            id: "p1",
            message: "hello",
            streamingBehavior: "steer",
        });

        expect(
            parseSessionWsClientMessage({
                type: "rpc:command",
                command: { type: "prompt", id: "p1", message: "hello", streamingBehavior: "steer" },
            }),
        ).toEqual({
            type: "rpc:command",
            command: { type: "prompt", id: "p1", message: "hello", streamingBehavior: "steer" },
        });

        expect(
            parseSessionWsClientMessage({
                type: "rpc:ui_response",
                response: { type: "extension_ui_response", id: "req-1", confirmed: true },
            }),
        ).toEqual({
            type: "rpc:ui_response",
            response: { type: "extension_ui_response", id: "req-1", confirmed: true },
        });

        expect(parseSessionRpcCommand({ type: "set_thinking_level", level: "invalid" })).toBeNull();
        expect(parseSessionWsClientMessage({ type: "unknown_command" })).toBeNull();
    });

    it("parses session HTTP responses and summary payloads", () => {
        const summary = {
            id: "session-1",
            cwd: "/tmp/project",
            name: null,
            firstMessage: "hi",
            messageCount: 1,
            createdAtMs: 1000,
            modifiedAtMs: 2000,
            hasParent: false,
            runtimeState: "idle",
            attachedClients: 0,
        };

        expect(parseCloseSessionResponse({ closed: true })).toEqual({ closed: true });
        expect(parseSessionSummary(summary)).toEqual(summary);
        const longFirstMessage = "x".repeat(2_000);
        expect(parseSessionSummary({ ...summary, firstMessage: longFirstMessage })?.firstMessage).toBe(
            longFirstMessage,
        );
        expect(parseSessionSummary({ ...summary, id: "../bad" })).toBeNull();
        expect(parseSessionSummaryPatch({ runtimeState: "idle" })).toEqual({ runtimeState: "idle" });
        expect(parseSessionSummaryPatch({ messageCount: -1 })).toBeNull();
        expect(parseSessionSummaryPatch({ attachedClients: 1.5 })).toBeNull();
        expect(parseSessionSummaryPatch({ modifiedAtMs: Number.NaN })).toBeNull();
        expect(parseSessionSummaryPatch({ name: 42 })).toBeNull();
        expect(parseSessionSummaryPatch({ firstMessage: 42 })).toBeNull();

        expect(
            parseSessionListResponse({
                sessions: [summary],
                updatedAtMs: 5000,
                cursor: { epoch: "epoch-1", seq: 0 },
            }),
        ).toEqual({
            sessions: [summary],
            updatedAtMs: 5000,
            cursor: { epoch: "epoch-1", seq: 0 },
        });
        expect(parseSessionListResponse({ sessions: [summary], updatedAtMs: 5000 })).toBeNull();
        expect(
            parseSessionListResponse({
                sessions: [summary],
                updatedAtMs: 5000,
                cursor: { epoch: "", seq: 0 },
            }),
        ).toBeNull();
        expect(
            parseSessionListResponse({
                sessions: [summary],
                updatedAtMs: 5000,
                cursor: { epoch: "epoch-1", seq: -1 },
            }),
        ).toBeNull();
        expect(parseCreateSessionResponse({ session: summary })).toEqual({ session: summary });
        expect(
            parseSessionDetailResponse({
                session: summary,
                entriesVersion: "3:1.5.2",
                baseEntryCount: 0,
                entries: [{ type: "session", id: "session-1" }],
            }),
        ).toEqual({
            session: summary,
            entriesVersion: "3:1.5.2",
            baseEntryCount: 0,
            entries: [{ type: "session", id: "session-1" }],
        });
        expect(
            parseSessionDetailResponse({
                session: summary,
                entriesVersion: null,
                baseEntryCount: 0,
                entries: [{ type: "session", id: "session-1" }],
            }),
        ).toEqual({
            session: summary,
            entriesVersion: null,
            baseEntryCount: 0,
            entries: [{ type: "session", id: "session-1" }],
        });
        expect(
            parseSessionDetailResponse({
                session: summary,
                entriesVersion: "bad",
                baseEntryCount: 0,
                entries: [],
            }),
        ).toBeNull();
    });

    it("parses session sync and rpc server messages and rejects malformed or unknown frames", () => {
        const stateSnapshot = {
            sessionId: "session-1",
            cwd: "/tmp/project",
            name: null,
            model: { provider: "anthropic", id: "claude", name: "Claude" },
            thinkingLevel: "medium",
            isStreaming: false,
            isCompacting: false,
            steeringMode: "one-at-a-time",
            followUpMode: "all",
            autoCompactionEnabled: true,
            messageCount: 0,
            steeringMessages: [],
            followUpMessages: [],
        };

        expect(parseSessionStateSnapshot(stateSnapshot)).toEqual(stateSnapshot);
        expect(parseSessionStateSnapshot({ ...stateSnapshot, thinkingLevel: "bogus" })).toBeNull();

        expect(
            parseSessionWsServerMessage({
                type: "sync:snapshot",
                cursor: { epoch: "rt-1", seq: 0 },
                snapshot: {
                    entriesVersion: "3:1.5.2",
                    baseEntryCount: 0,
                    entries: { mode: "inline", data: [] },
                    state: stateSnapshot,
                    liveMessage: null,
                    pendingUiRequests: [],
                },
            }),
        ).toMatchObject({ type: "sync:snapshot", cursor: { epoch: "rt-1", seq: 0 } });

        expect(
            parseSessionWsServerMessage({
                type: "sync:snapshot",
                cursor: { epoch: "rt-1", seq: 3 },
                snapshot: {
                    entriesVersion: "3:1.5.2",
                    baseEntryCount: 2,
                    entries: { mode: "http", meta: { entryCount: 10 } },
                    state: stateSnapshot,
                    liveMessage: null,
                    pendingUiRequests: [],
                },
            }),
        ).toMatchObject({
            type: "sync:snapshot",
            snapshot: { entries: { mode: "http", meta: { entryCount: 10 } } },
        });

        expect(
            parseSessionWsServerMessage({
                type: "sync:replay",
                cursor: { epoch: "rt-1", seq: 3 },
                fromSeq: 1,
                deltas: [
                    { seq: 2, payload: { kind: "agent_event", event: { type: "agent_start" } } },
                    {
                        seq: 3,
                        payload: {
                            kind: "entries_appended",
                            entriesVersion: "3:1.5.2",
                            baseEntryCount: 1,
                            entries: { mode: "inline", data: [{ type: "message" }] },
                        },
                    },
                ],
            }),
        ).toMatchObject({ type: "sync:replay", fromSeq: 1, cursor: { epoch: "rt-1", seq: 3 } });

        expect(
            parseSessionWsServerMessage({
                type: "sync:delta",
                cursor: { epoch: "rt-1", seq: 4 },
                delta: {
                    kind: "state_patched",
                    patch: { model: { provider: "openai", id: "gpt-5", name: "GPT-5" }, messageCount: 4 },
                },
            }),
        ).toMatchObject({ type: "sync:delta", cursor: { epoch: "rt-1", seq: 4 } });

        expect(parseSessionWsServerMessage({ type: "rpc:response", command: "abort", success: true })).toEqual({
            type: "rpc:response",
            command: "abort",
            success: true,
        });
        expect(parseSessionWsServerMessage({ type: "rpc:response", command: "abort", success: false })).toBeNull();
        expect(parseSessionWsServerMessage({ type: "rpc:response", command: "made_up", success: true })).toBeNull();
        expect(parseSessionWsServerMessage({ type: "rpc:error", code: "invalid_json", message: "Bad JSON" })).toEqual({
            type: "rpc:error",
            code: "invalid_json",
            message: "Bad JSON",
        });
        expect(parseSessionWsServerMessage({ type: "unknown_type" })).toBeNull();
    });
});
