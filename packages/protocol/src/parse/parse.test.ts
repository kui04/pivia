import { describe, expect, it } from "vitest";

import {
    assertNever,
    commandIdOf,
    INITIAL_CATALOG_SEQ,
    isRecord,
    nextCatalogSeq,
    parseAfterSeq,
    parseAuthLoginResponse,
    parseAuthLogoutResponse,
    parseAuthStatusResponse,
    parseCatalogEpoch,
    parseCatalogSeq,
    parseCloseSessionResponse,
    parseCreateSessionResponse,
    parseDirectoryListResponse,
    parseEntriesVersion,
    parseExtensionUiResponse,
    parseHealthResponse,
    parseSessionDetailResponse,
    parseSessionId,
    parseSessionListResponse,
    parseSessionPrefixAnchor,
    parseSessionStateSnapshot,
    parseSessionSummary,
    parseSessionSummaryPatch,
    parseSessionWsClientCommand,
    parseSessionWsHandshakeQuery,
    parseSessionWsServerMessage,
    parseWorkspaceWsServerMessage,
} from "./index.ts";

describe("protocol parse helpers", () => {
    it("isRecord accepts plain objects and rejects null, arrays, and primitives", () => {
        expect(isRecord({})).toBe(true);
        expect(isRecord({ a: 1 })).toBe(true);
        expect(isRecord(null)).toBe(false);
        expect(isRecord([])).toBe(false);
        expect(isRecord("text")).toBe(false);
        expect(isRecord(42)).toBe(false);
    });

    it("assertNever throws with the serialized value", () => {
        expect(() => assertNever("unexpected" as never, "Bad variant")).toThrow('Bad variant: "unexpected"');
    });

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

    it("parseAfterSeq distinguishes absent, valid, and invalid values", () => {
        expect(parseAfterSeq(undefined)).toEqual({ ok: true, afterSeq: undefined });
        expect(parseAfterSeq("0")).toEqual({ ok: true, afterSeq: 0 });
        expect(parseAfterSeq("42")).toEqual({ ok: true, afterSeq: 42 });
        expect(parseAfterSeq("-1")).toEqual({ ok: false });
        expect(parseAfterSeq("abc")).toEqual({ ok: false });
        expect(parseAfterSeq(5)).toEqual({ ok: false });
    });

    it("parseSessionWsHandshakeQuery parses afterSeq strictly and degrades invalid cache hints", () => {
        expect(
            parseSessionWsHandshakeQuery({
                afterSeq: "10",
                runtimeId: "rt-1",
                entriesVersion: "3:1.5.2",
                afterCount: "3",
                afterEntryId: "e3",
            }),
        ).toEqual({
            ok: true,
            value: {
                afterSeq: 10,
                runtimeId: "rt-1",
                prefixAnchor: { entriesVersion: "3:1.5.2", afterCount: 3, afterEntryId: "e3" },
            },
        });

        expect(parseSessionWsHandshakeQuery({ afterSeq: "nope" })).toEqual({
            ok: false,
            message: "Invalid afterSeq parameter.",
        });

        expect(parseSessionWsHandshakeQuery({ afterSeq: "2", entriesVersion: "bad", afterCount: "0" })).toEqual({
            ok: true,
            value: { afterSeq: 2 },
        });

        expect(parseSessionWsHandshakeQuery(undefined)).toEqual({ ok: true, value: {} });
    });

    it("parses valid WS client commands and extension UI responses", () => {
        expect(commandIdOf({ id: "cmd-1" })).toBe("cmd-1");
        expect(commandIdOf("not-a-record")).toBeUndefined();

        expect(parseExtensionUiResponse({ type: "extension_ui_response", id: "req-1", confirmed: true })).toEqual({
            type: "extension_ui_response",
            id: "req-1",
            confirmed: true,
        });

        expect(
            parseSessionWsClientCommand({ type: "prompt", id: "p1", message: "hello", streamingBehavior: "steer" }),
        ).toEqual({
            type: "prompt",
            id: "p1",
            message: "hello",
            streamingBehavior: "steer",
        });

        expect(parseSessionWsClientCommand({ type: "set_thinking_level", level: "invalid" })).toBeNull();
        expect(parseSessionWsClientCommand({ type: "unknown_command" })).toBeNull();
    });

    it("parses HTTP response payloads and rejects malformed shapes", () => {
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

        expect(parseHealthResponse({ status: "ok", version: "0.1.0" })).toEqual({ status: "ok", version: "0.1.0" });
        expect(parseHealthResponse({ status: "down", version: "0.1.0" })).toBeNull();
        expect(parseAuthStatusResponse({ authRequired: true, authenticated: false })).toEqual({
            authRequired: true,
            authenticated: false,
        });
        expect(parseAuthLoginResponse({ authenticated: true })).toEqual({ authenticated: true });
        expect(parseAuthLoginResponse({ authenticated: false })).toBeNull();
        expect(parseAuthLogoutResponse({ authenticated: false })).toEqual({ authenticated: false });
        expect(parseCloseSessionResponse({ closed: true })).toEqual({ closed: true });
        expect(parseSessionSummary(summary)).toEqual(summary);
        const longFirstMessage = "x".repeat(2_000);
        expect(parseSessionSummary({ ...summary, firstMessage: longFirstMessage })?.firstMessage).toBe(
            longFirstMessage,
        );
        expect(parseSessionSummary({ ...summary, id: "../bad" })).toBeNull();
        expect(
            parseSessionListResponse({
                sessions: [summary],
                scannedAtMs: 5000,
                catalogEpoch: "epoch-1",
                catalogSeq: 0,
            }),
        ).toEqual({
            sessions: [summary],
            scannedAtMs: 5000,
            catalogEpoch: "epoch-1",
            catalogSeq: 0,
        });
        expect(parseSessionListResponse({ sessions: [summary], scannedAtMs: 5000 })).toBeNull();
        expect(
            parseSessionListResponse({
                sessions: [summary],
                scannedAtMs: 5000,
                catalogEpoch: "",
                catalogSeq: 0,
            }),
        ).toBeNull();
        expect(
            parseSessionListResponse({
                sessions: [summary],
                scannedAtMs: 5000,
                catalogEpoch: "epoch-1",
                catalogSeq: -1,
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

    it("parses WS server messages and rejects malformed or unknown frames", () => {
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
            pendingMessageCount: 0,
            steeringMessages: [],
            followUpMessages: [],
        };

        expect(parseSessionStateSnapshot(stateSnapshot)).toEqual(stateSnapshot);
        expect(parseSessionStateSnapshot({ ...stateSnapshot, thinkingLevel: "bogus" })).toBeNull();

        expect(
            parseSessionWsServerMessage({
                type: "snapshot",
                sessionId: "session-1",
                runtimeId: "rt-1",
                seq: 0,
                entriesVersion: "3:1.5.2",
                baseEntryCount: 0,
                entriesMode: "inline",
                entries: [],
                state: stateSnapshot,
                liveMessage: null,
                pendingUiRequests: [],
            }),
        ).toMatchObject({ type: "snapshot", entriesMode: "inline" });

        expect(
            parseSessionWsServerMessage({
                type: "replay",
                sessionId: "session-1",
                runtimeId: "rt-1",
                seq: 2,
                entriesVersion: "3:1.5.2",
                state: stateSnapshot,
                events: [{ seq: 2, event: { type: "agent_start" } }],
                liveMessage: { role: "assistant", content: [{ type: "text", text: "streaming" }] },
                appendedSlice: { baseEntryCount: 1, entries: [{ type: "message" }] },
                pendingUiRequests: [],
            }),
        ).toMatchObject({
            type: "replay",
            liveMessage: { role: "assistant", content: [{ type: "text", text: "streaming" }] },
            appendedSlice: { baseEntryCount: 1 },
        });

        expect(parseSessionWsServerMessage({ type: "response", command: "abort", success: true })).toEqual({
            type: "response",
            command: "abort",
            success: true,
        });
        expect(parseSessionWsServerMessage({ type: "response", command: "abort", success: false })).toBeNull();
        expect(parseSessionWsServerMessage({ type: "response", command: "made_up", success: true })).toBeNull();
        expect(parseSessionWsServerMessage({ type: "unknown_type" })).toBeNull();
    });

    it("parses directory list responses and rejects malformed payloads", () => {
        expect(
            parseDirectoryListResponse({
                path: "/home/u",
                parent: "/home",
                directories: ["repo", "docs"],
                truncated: false,
            }),
        ).toEqual({
            path: "/home/u",
            parent: "/home",
            directories: ["repo", "docs"],
            truncated: false,
        });
        expect(parseDirectoryListResponse({ path: "/", parent: null, directories: [], truncated: false })).toEqual({
            path: "/",
            parent: null,
            directories: [],
            truncated: false,
        });
        expect(parseDirectoryListResponse({ path: "", parent: null, directories: [], truncated: false })).toBeNull();
        expect(parseDirectoryListResponse({ path: "/", parent: 123, directories: [], truncated: false })).toBeNull();
        expect(
            parseDirectoryListResponse({ path: "/", parent: null, directories: [123], truncated: false }),
        ).toBeNull();
        expect(parseDirectoryListResponse({ path: "/", parent: null, directories: [] })).toBeNull();
    });

    it("parses workspace WebSocket messages and rejects malformed payloads", () => {
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

        expect(parseCatalogEpoch("epoch-1")).toBe("epoch-1");
        expect(parseCatalogEpoch("")).toBeNull();
        expect(parseCatalogSeq(0)).toBe(0);
        expect(parseCatalogSeq(-1)).toBeNull();
        expect(parseCatalogSeq(1.5)).toBeNull();
        expect(nextCatalogSeq(INITIAL_CATALOG_SEQ)).toBe(1);

        expect(
            parseWorkspaceWsServerMessage({
                type: "catalog_snapshot",
                sessions: [sessionSummary],
                updatedAtMs: 3000,
                catalogEpoch: "epoch-1",
                catalogSeq: 0,
            }),
        ).toEqual({
            type: "catalog_snapshot",
            sessions: [sessionSummary],
            updatedAtMs: 3000,
            catalogEpoch: "epoch-1",
            catalogSeq: 0,
        });

        expect(
            parseWorkspaceWsServerMessage({
                type: "session_upserted",
                catalogEpoch: "epoch-1",
                seq: 1,
                session: sessionSummary,
            }),
        ).toEqual({
            type: "session_upserted",
            catalogEpoch: "epoch-1",
            seq: 1,
            session: sessionSummary,
        });

        expect(
            parseWorkspaceWsServerMessage({
                type: "session_updated",
                catalogEpoch: "epoch-1",
                seq: 2,
                sessionId: "session-1",
                patch: {
                    name: null,
                    firstMessage: "full message",
                    messageCount: 3,
                    modifiedAtMs: 2500,
                    runtimeState: "streaming",
                    attachedClients: 2,
                },
            }),
        ).toEqual({
            type: "session_updated",
            catalogEpoch: "epoch-1",
            seq: 2,
            sessionId: "session-1",
            patch: {
                name: null,
                firstMessage: "full message",
                messageCount: 3,
                modifiedAtMs: 2500,
                runtimeState: "streaming",
                attachedClients: 2,
            },
        });
        expect(parseSessionSummaryPatch({ runtimeState: "idle" })).toEqual({ runtimeState: "idle" });

        expect(
            parseWorkspaceWsServerMessage({
                type: "session_removed",
                catalogEpoch: "epoch-1",
                seq: 3,
                sessionId: "session-1",
            }),
        ).toEqual({
            type: "session_removed",
            catalogEpoch: "epoch-1",
            seq: 3,
            sessionId: "session-1",
        });

        expect(parseWorkspaceWsServerMessage(null)).toBeNull();
        expect(parseWorkspaceWsServerMessage({ type: "unknown_type" })).toBeNull();
        expect(
            parseWorkspaceWsServerMessage({
                type: "catalog_snapshot",
                sessions: [sessionSummary],
                updatedAtMs: 3000,
            }),
        ).toBeNull();
        expect(
            parseWorkspaceWsServerMessage({
                type: "catalog_snapshot",
                sessions: [{ ...sessionSummary, id: "../bad" }],
                updatedAtMs: 3000,
                catalogEpoch: "epoch-1",
                catalogSeq: 0,
            }),
        ).toBeNull();
        expect(
            parseWorkspaceWsServerMessage({
                type: "catalog_snapshot",
                sessions: [sessionSummary],
                updatedAtMs: Number.NaN,
                catalogEpoch: "epoch-1",
                catalogSeq: 0,
            }),
        ).toBeNull();
        expect(
            parseWorkspaceWsServerMessage({
                type: "session_upserted",
                catalogEpoch: "epoch-1",
                seq: 1,
                session: { ...sessionSummary, runtimeState: "bogus" },
            }),
        ).toBeNull();
        expect(
            parseWorkspaceWsServerMessage({
                type: "session_upserted",
                catalogEpoch: "",
                seq: 1,
                session: sessionSummary,
            }),
        ).toBeNull();
        expect(
            parseWorkspaceWsServerMessage({
                type: "session_updated",
                catalogEpoch: "epoch-1",
                seq: 2,
                sessionId: "../bad",
                patch: { runtimeState: "idle" },
            }),
        ).toBeNull();
        expect(
            parseWorkspaceWsServerMessage({
                type: "session_updated",
                catalogEpoch: "epoch-1",
                seq: 2,
                sessionId: "session-1",
                patch: {},
            }),
        ).toBeNull();
        expect(
            parseWorkspaceWsServerMessage({
                type: "session_updated",
                catalogEpoch: "epoch-1",
                seq: 2,
                sessionId: "session-1",
                patch: { runtimeState: "bogus" },
            }),
        ).toBeNull();
        expect(parseSessionSummaryPatch({ messageCount: -1 })).toBeNull();
        expect(parseSessionSummaryPatch({ attachedClients: 1.5 })).toBeNull();
        expect(parseSessionSummaryPatch({ modifiedAtMs: Number.NaN })).toBeNull();
        expect(parseSessionSummaryPatch({ name: 42 })).toBeNull();
        expect(parseSessionSummaryPatch({ firstMessage: 42 })).toBeNull();
        expect(
            parseWorkspaceWsServerMessage({
                type: "session_removed",
                catalogEpoch: "epoch-1",
                seq: -1,
                sessionId: "session-1",
            }),
        ).toBeNull();
        expect(
            parseWorkspaceWsServerMessage({
                type: "session_removed",
                catalogEpoch: "epoch-1",
                seq: 3,
                sessionId: "../bad",
            }),
        ).toBeNull();
    });
});
