import {
    parseEntriesVersion,
    parseSessionId,
    type AssistantMessage,
    type EntriesVersion,
    type FileEntry,
    type RpcExtensionUIRequest,
    type SessionId,
    type SessionStateSnapshot,
    type SessionWsEventMessage,
    type SessionWsReplayMessage,
    type SessionWsSnapshotMessage,
} from "@pivia/protocol";
import { describe, expect, it } from "vitest";

import { initialSessionState, liveAssistantMessage, reduceSessionState, type SessionState } from "./reducer";

function sid(raw: string): SessionId {
    const parsed = parseSessionId(raw);
    if (parsed === null) {
        throw new Error(`Invalid test session id: ${raw}`);
    }
    return parsed;
}

function ev(raw: string): EntriesVersion {
    const parsed = parseEntriesVersion(raw);
    if (parsed === null) {
        throw new Error(`Invalid test entries version: ${raw}`);
    }
    return parsed;
}

const SESSION_1 = sid("session-1");
const OTHER_SESSION = sid("other");
const V152 = ev("3:1.5.2");

function summary(overrides: Partial<SessionStateSnapshot> = {}): SessionStateSnapshot {
    return {
        sessionId: SESSION_1,
        cwd: "/home/u/project",
        name: null,
        model: null,
        thinkingLevel: "medium",
        isStreaming: false,
        isCompacting: false,
        steeringMode: "one-at-a-time",
        followUpMode: "one-at-a-time",
        autoCompactionEnabled: true,
        messageCount: 2,
        pendingMessageCount: 0,
        steeringMessages: [],
        followUpMessages: [],
        ...overrides,
    };
}

function dialog(id: string, method: "confirm" | "select" | "input" | "editor" = "confirm"): RpcExtensionUIRequest {
    switch (method) {
        case "confirm":
            return { type: "extension_ui_request", id, method, title: "Continue?", message: "Confirm the action." };
        case "select":
            return { type: "extension_ui_request", id, method, title: "Choose", options: ["a", "b"] };
        case "input":
            return { type: "extension_ui_request", id, method, title: "Name", placeholder: "a name" };
        case "editor":
            return { type: "extension_ui_request", id, method, title: "Edit", prefill: "text" };
    }
}

function notifyRequest(id: string): RpcExtensionUIRequest {
    return { type: "extension_ui_request", id, method: "notify", message: "Heads up" };
}

function connected(): SessionState {
    return reduceSessionState(initialSessionState, { type: "connect", sessionId: SESSION_1 });
}

type InlineSnapshotMessage = Extract<SessionWsSnapshotMessage, { readonly entriesMode: "inline" }>;

function snapshot(seq: number, overrides: Partial<InlineSnapshotMessage> = {}): InlineSnapshotMessage {
    return {
        type: "snapshot",
        sessionId: SESSION_1,
        runtimeId: "runtime-1",
        seq,
        entriesVersion: V152,
        baseEntryCount: 0,
        entriesMode: "inline",
        state: summary(),
        entries: [],
        liveMessage: null,
        pendingUiRequests: [],
        ...overrides,
    };
}

function replay(seq: number, overrides: Partial<SessionWsReplayMessage> = {}): SessionWsReplayMessage {
    return {
        type: "replay",
        sessionId: SESSION_1,
        runtimeId: "runtime-1",
        seq,
        entriesVersion: V152,
        state: summary(),
        events: [],
        liveMessage: null,
        pendingUiRequests: [],
        ...overrides,
    };
}

function event(seq: number, eventMessage: SessionWsEventMessage["event"]): SessionWsEventMessage {
    return { type: "event", sessionId: SESSION_1, seq, event: eventMessage };
}

type AssistantDelta = Extract<SessionWsEventMessage["event"], { type: "message_update" }>["assistantMessageEvent"];

function usage(): AssistantMessage["usage"] {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
}

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
    return {
        role: "assistant",
        content: [],
        api: "test",
        provider: "test",
        model: "test",
        usage: usage(),
        stopReason: "stop",
        timestamp: 0,
        ...overrides,
    };
}

function messageUpdate(seq: number, delta: AssistantDelta): SessionWsEventMessage {
    return event(seq, { type: "message_update", usage: usage(), assistantMessageEvent: delta });
}

describe("session reducer", () => {
    it("starts idle and resets connection state on connect", () => {
        expect(initialSessionState).toEqual({
            status: "idle",
            sessionId: null,
            runtimeId: null,
            seq: 0,
            entriesVersion: null,
            state: null,
            entries: [],
            entriesSync: { kind: "idle" },
            liveEvents: [],
            liveMessage: { kind: "none" },
            pendingUiRequests: [],
            lastError: null,
        });

        const next = connected();

        expect(next.status).toBe("connecting");
        expect(next.sessionId).toBe("session-1");
        expect(next.seq).toBe(0);
        expect(next.state).toBeNull();
    });

    it("replaces every snapshot field and clears incremental events", () => {
        const before = reduceSessionState(connected(), {
            type: "event",
            message: event(9, { type: "agent_start" }),
        });
        expect(before.liveEvents).toHaveLength(1);

        const entries: readonly FileEntry[] = [];
        const message = snapshot(4, {
            state: summary({ messageCount: 5 }),
            entries,
            pendingUiRequests: [dialog("a")],
        });
        const next = reduceSessionState(before, { type: "snapshot", message });

        expect(next.status).toBe("open");
        expect(next.seq).toBe(4);
        expect(next.state).toEqual(summary({ messageCount: 5 }));
        expect(next.entries).toBe(entries);
        expect(next.liveEvents).toEqual([]);
        expect(next.pendingUiRequests).toEqual([dialog("a")]);
    });

    it("ignores a snapshot or event for another session", () => {
        const state = connected();
        const next = reduceSessionState(state, {
            type: "snapshot",
            message: snapshot(1, { sessionId: OTHER_SESSION }),
        });

        expect(next).toBe(state);
        expect(
            reduceSessionState(state, {
                type: "event",
                message: { ...event(1, { type: "agent_start" }), sessionId: OTHER_SESSION },
            }),
        ).toBe(state);
    });

    it("applies only replay events after the local sequence and replaces pending dialogs", () => {
        const base = reduceSessionState(connected(), {
            type: "snapshot",
            message: snapshot(2, {
                state: summary({ isStreaming: true }),
                pendingUiRequests: [dialog("stale")],
            }),
        });

        const next = reduceSessionState(base, {
            type: "replay",
            message: replay(4, {
                state: summary({ isStreaming: false, name: "Renamed" }),
                events: [
                    { seq: 2, event: { type: "session_info_changed", name: "duplicate" } },
                    { seq: 3, event: { type: "agent_settled", aborted: false } },
                    { seq: 4, event: { type: "session_info_changed", name: "Renamed" } },
                ],
                pendingUiRequests: [dialog("fresh")],
            }),
        });

        expect(next.status).toBe("open");
        expect(next.seq).toBe(4);
        expect(next.state).toEqual(summary({ isStreaming: false, name: "Renamed" }));
        expect(next.liveEvents.map((entry) => entry.seq)).toEqual([3, 4]);
        expect(next.pendingUiRequests).toEqual([dialog("fresh")]);
        expect(next.lastError).toBeNull();
    });

    it("keeps the local sequence when a replay is older than the applied events", () => {
        const base = reduceSessionState(connected(), {
            type: "snapshot",
            message: snapshot(10),
        });

        const next = reduceSessionState(base, {
            type: "replay",
            message: replay(8, {
                events: [{ seq: 9, event: { type: "agent_start" } }],
            }),
        });

        expect(next.seq).toBe(10);
        expect(next.liveEvents).toEqual([]);
    });

    it("appends monotonic events and updates the state summary", () => {
        let state = reduceSessionState(connected(), {
            type: "snapshot",
            message: snapshot(3, { state: summary({ messageCount: 5 }) }),
        });

        state = reduceSessionState(state, { type: "event", message: event(4, { type: "agent_start" }) });
        expect(state.state?.isStreaming).toBe(true);
        expect(state.seq).toBe(4);

        const duplicate = reduceSessionState(state, { type: "event", message: event(4, { type: "agent_start" }) });
        expect(duplicate).toBe(state);

        state = reduceSessionState(state, {
            type: "event",
            message: event(5, { type: "compaction_start", reason: "manual" }),
        });
        expect(state.state?.isCompacting).toBe(true);

        state = reduceSessionState(state, {
            type: "event",
            message: event(6, { type: "session_info_changed", name: "Renamed" }),
        });
        expect(state.state?.name).toBe("Renamed");

        state = reduceSessionState(state, {
            type: "event",
            message: event(7, {
                type: "compaction_end",
                reason: "manual",
                result: undefined,
                aborted: false,
                willRetry: false,
            }),
        });
        expect(state.state?.isCompacting).toBe(false);

        state = reduceSessionState(state, {
            type: "event",
            message: event(8, { type: "agent_settled", aborted: false }),
        });
        expect(state.state?.isStreaming).toBe(false);

        expect(state.state?.messageCount).toBe(5);
        expect(state.liveEvents.map((entry) => entry.seq)).toEqual([4, 5, 6, 7, 8]);
    });

    it("adds only interactive UI requests and removes resolved ones by id", () => {
        let state = connected();

        state = reduceSessionState(state, {
            type: "extension_ui_request",
            message: { type: "extension_ui_request", sessionId: SESSION_1, request: dialog("confirm") },
        });
        state = reduceSessionState(state, {
            type: "extension_ui_request",
            message: { type: "extension_ui_request", sessionId: SESSION_1, request: dialog("select", "select") },
        });
        state = reduceSessionState(state, {
            type: "extension_ui_request",
            message: { type: "extension_ui_request", sessionId: SESSION_1, request: notifyRequest("notify") },
        });
        state = reduceSessionState(state, {
            type: "extension_ui_request",
            message: { type: "extension_ui_request", sessionId: SESSION_1, request: dialog("confirm") },
        });

        expect(state.pendingUiRequests.map((request) => request.id)).toEqual(["confirm", "select"]);

        state = reduceSessionState(state, {
            type: "extension_ui_resolved",
            message: { type: "extension_ui_resolved", sessionId: SESSION_1, requestId: "confirm" },
        });
        expect(state.pendingUiRequests.map((request) => request.id)).toEqual(["select"]);

        const unchanged = reduceSessionState(state, {
            type: "extension_ui_resolved",
            message: { type: "extension_ui_resolved", sessionId: SESSION_1, requestId: "missing" },
        });
        expect(unchanged).toBe(state);

        const otherSession = reduceSessionState(state, {
            type: "extension_ui_request",
            message: { type: "extension_ui_request", sessionId: OTHER_SESSION, request: dialog("other") },
        });
        expect(otherSession).toBe(state);
    });

    it("folds message_update deltas into liveMessage and keeps structural events", () => {
        let state = reduceSessionState(connected(), {
            type: "snapshot",
            message: snapshot(0),
        });
        state = reduceSessionState(state, {
            type: "event",
            message: event(1, {
                type: "message_start",
                message: assistant({ content: [{ type: "text", text: "" }] }),
            }),
        });
        state = reduceSessionState(state, {
            type: "event",
            message: messageUpdate(2, { type: "text_start", contentIndex: 0 }),
        });
        state = reduceSessionState(state, {
            type: "event",
            message: messageUpdate(3, { type: "text_delta", contentIndex: 0, delta: "Hello" }),
        });
        state = reduceSessionState(state, {
            type: "event",
            message: messageUpdate(4, { type: "text_delta", contentIndex: 0, delta: " world" }),
        });

        expect(liveAssistantMessage(state)?.content[0]).toEqual({ type: "text", text: "Hello world" });
        expect(state.liveEvents.map((entry) => entry.seq)).toEqual([1]);
        expect(state.seq).toBe(4);

        state = reduceSessionState(state, {
            type: "event",
            message: event(5, {
                type: "message_end",
                message: assistant({ content: [{ type: "text", text: "Hello world" }] }),
            }),
        });

        expect(state.liveMessage.kind).toBe("settled");
        expect(state.liveEvents.map((entry) => entry.seq)).toEqual([1, 5]);
    });

    it("bounds the structural event log", () => {
        let state = connected();
        for (let seq = 1; seq <= 520; seq += 1) {
            state = reduceSessionState(state, { type: "event", message: event(seq, { type: "agent_start" }) });
        }

        expect(state.liveEvents).toHaveLength(512);
        expect(state.liveEvents[0]?.seq).toBe(9);
        expect(state.liveEvents.at(-1)?.seq).toBe(520);
    });

    it("keeps pending dialogs across a reconnect until the replay replaces them", () => {
        const base = reduceSessionState(connected(), {
            type: "snapshot",
            message: snapshot(1, { pendingUiRequests: [dialog("keep")] }),
        });

        const reconnecting = reduceSessionState(base, { type: "reconnecting" });
        expect(reconnecting.pendingUiRequests).toEqual([dialog("keep")]);

        const replayed = reduceSessionState(reconnecting, {
            type: "replay",
            message: replay(2, { pendingUiRequests: [dialog("keep"), dialog("new")] }),
        });
        expect(replayed.pendingUiRequests).toEqual([dialog("keep"), dialog("new")]);

        const cleared = reduceSessionState(replayed, {
            type: "replay",
            message: replay(3, { pendingUiRequests: [] }),
        });
        expect(cleared.pendingUiRequests).toEqual([]);
    });

    it("converges the connection status for closes, errors and resets", () => {
        const base = reduceSessionState(connected(), {
            type: "snapshot",
            message: snapshot(1, { pendingUiRequests: [dialog("a")] }),
        });

        const sessionClose = reduceSessionState(base, {
            type: "closed",
            reason: "session",
            message: "Session closed",
        });
        expect(sessionClose.status).toBe("closed");
        expect(sessionClose.pendingUiRequests).toEqual([]);
        expect(sessionClose.lastError).toBe("Session closed");

        // A late frame must not reopen a session whose runtime already closed.
        const lateEvent = reduceSessionState(sessionClose, {
            type: "event",
            message: event(2, { type: "agent_start" }),
        });
        expect(lateEvent).toBe(sessionClose);

        const lateDialog = reduceSessionState(sessionClose, {
            type: "extension_ui_request",
            message: { type: "extension_ui_request", sessionId: SESSION_1, request: dialog("late") },
        });
        expect(lateDialog).toBe(sessionClose);

        const slowConsumer = reduceSessionState(base, { type: "closed", reason: "slow-consumer" });
        expect(slowConsumer.status).toBe("closed");
        expect(slowConsumer.lastError).toBe("The connection fell behind and was closed.");

        const reconnecting = reduceSessionState(sessionClose, { type: "reconnecting" });
        expect(reconnecting.status).toBe("closed");

        const failed = reduceSessionState(base, { type: "failed", message: "Cannot reconnect." });
        expect(failed.status).toBe("error");
        expect(failed.lastError).toBe("Cannot reconnect.");

        const serverError = reduceSessionState(base, {
            type: "server_error",
            message: { type: "error", code: "invalid_request", message: "Invalid command." },
        });
        expect(serverError.lastError).toBe("Invalid command.");

        expect(reduceSessionState(base, { type: "reset" })).toEqual(initialSessionState);
    });

    it("eliminates message_end flicker by holding settled liveMessage until matching entry arrives", () => {
        const headerEntry: FileEntry = {
            type: "session",
            version: 3,
            id: "session-1",
            timestamp: "2026-04-01T00:00:00.000Z",
            cwd: "/tmp",
        };
        let state = reduceSessionState(connected(), {
            type: "snapshot",
            message: snapshot(0, { entries: [headerEntry] }),
        });

        const msg = assistant({ timestamp: 12345, content: [{ type: "text", text: "Final answer" }] });
        state = reduceSessionState(state, {
            type: "event",
            message: event(1, { type: "message_start", message: assistant({ timestamp: 12345, content: [] }) }),
        });
        state = reduceSessionState(state, {
            type: "event",
            message: event(2, { type: "message_end", message: msg }),
        });
        expect(state.liveMessage).toEqual({ kind: "settled", message: msg });

        // Non-matching entry (e.g. usage/custom) keeps settled message visible without 1-frame vanish.
        state = reduceSessionState(state, {
            type: "entries_appended",
            message: {
                type: "entries_appended",
                sessionId: SESSION_1,
                entriesVersion: V152,
                entriesMode: "inline",
                baseEntryCount: 1,
                entries: [
                    {
                        type: "custom",
                        id: "c1",
                        parentId: null,
                        timestamp: "2026-04-01T00:00:01.000Z",
                        customType: "meta",
                    },
                ],
            },
        });
        expect(state.liveMessage).toEqual({ kind: "settled", message: msg });

        // Matching persisted assistant entry clears settled liveMessage atomically.
        state = reduceSessionState(state, {
            type: "entries_appended",
            message: {
                type: "entries_appended",
                sessionId: SESSION_1,
                entriesVersion: V152,
                entriesMode: "inline",
                baseEntryCount: 2,
                entries: [
                    {
                        type: "message",
                        id: "m1",
                        parentId: "c1",
                        timestamp: "2026-04-01T00:00:02.000Z",
                        message: msg,
                    },
                ],
            },
        });
        expect(state.liveMessage).toEqual({ kind: "none" });
        expect(state.entries).toHaveLength(3);
    });

    it("stages entries_appended while HTTP sync is loading and deduplicates on completion", () => {
        const headerEntry: FileEntry = {
            type: "session",
            version: 3,
            id: "session-1",
            timestamp: "2026-04-01T00:00:00.000Z",
            cwd: "/tmp",
        };
        const msg1: FileEntry = {
            type: "message",
            id: "e1",
            parentId: null,
            timestamp: "2026-04-01T00:00:01.000Z",
            message: { role: "user", content: "q1", timestamp: 1 },
        };
        const msg2: FileEntry = {
            type: "message",
            id: "e2",
            parentId: "e1",
            timestamp: "2026-04-01T00:00:02.000Z",
            message: { role: "user", content: "q2", timestamp: 2 },
        };

        let state = reduceSessionState(connected(), {
            type: "snapshot",
            message: {
                type: "snapshot",
                sessionId: SESSION_1,
                runtimeId: "runtime-1",
                seq: 1,
                entriesVersion: V152,
                baseEntryCount: 0,
                entriesMode: "http",
                entryCount: 2,
                state: summary(),
                liveMessage: null,
                pendingUiRequests: [],
            },
        });
        expect(state.entriesSync).toEqual({
            kind: "loading",
            baseEntryCount: 0,
            targetEntryCount: 2,
            pendingAppendedEntries: [],
        });

        state = reduceSessionState(state, {
            type: "entries_appended",
            message: {
                type: "entries_appended",
                sessionId: SESSION_1,
                entriesVersion: V152,
                entriesMode: "inline",
                baseEntryCount: 2,
                entries: [msg2],
            },
        });
        expect(state.entriesSync).toMatchObject({ kind: "loading", targetEntryCount: 3 });

        // HTTP returns [header, msg1] (without msg2); reducer merges msg2 cleanly without duplication.
        state = reduceSessionState(state, {
            type: "entries_sync_succeeded",
            sessionId: SESSION_1,
            entriesVersion: V152,
            baseEntryCount: 0,
            entries: [headerEntry, msg1],
        });
        expect(state.entriesSync).toEqual({ kind: "idle" });
        expect(state.entries.map((entry) => entry.id)).toEqual(["session-1", "e1", "e2"]);
    });

    it("caps staged appends while an HTTP sync owns the transcript", () => {
        const staged = Array.from({ length: 600 }, (_, offset): FileEntry => {
            return {
                type: "message",
                id: `e${String(offset)}`,
                parentId: null,
                timestamp: "2026-04-01T00:00:02.000Z",
                message: { role: "user", content: "queued", timestamp: offset },
            };
        });

        let state = reduceSessionState(connected(), {
            type: "snapshot",
            message: {
                type: "snapshot",
                sessionId: SESSION_1,
                runtimeId: "runtime-1",
                seq: 1,
                entriesVersion: V152,
                baseEntryCount: 0,
                entriesMode: "http",
                entryCount: 2,
                state: summary(),
                liveMessage: null,
                pendingUiRequests: [],
            },
        });
        state = reduceSessionState(state, {
            type: "entries_appended",
            message: {
                type: "entries_appended",
                sessionId: SESSION_1,
                entriesVersion: V152,
                entriesMode: "inline",
                baseEntryCount: 2,
                entries: staged,
            },
        });

        // The target keeps the chase going; the queue is dropped instead of holding the whole delta.
        expect(state.entriesSync).toEqual({
            kind: "loading",
            baseEntryCount: 0,
            targetEntryCount: 602,
            pendingAppendedEntries: [],
        });
    });
});
