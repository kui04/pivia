import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { FileEntry, RpcExtensionUIRequest } from "@earendil-works/pi-coding-agent";
import {
    parseEntriesVersion,
    parseSessionId,
    parseSyncEpoch,
    parseSyncSeq,
    type EntriesVersion,
    type SessionDelta,
    type SessionId,
    type SessionSnapshot,
    type SessionStateSnapshot,
    type SyncEpoch,
    type SyncSeq,
} from "@pivia/protocol";

type SessionEvent = Extract<SessionDelta, { readonly kind: "agent_event" }>["event"];
import { describe, expect, it } from "vitest";

import { SyncStreamClient } from "@/lib/sync";

import {
    applyHydratedEntries,
    applySessionClosed,
    createSessionSyncReducer,
    initialSessionState,
    liveAssistantMessage,
    type SessionHttpHydrationDescriptor,
    type SessionState,
} from "./reducer";

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

function rt(raw: string): SyncEpoch<"session"> {
    const parsed = parseSyncEpoch<"session">(raw);
    if (parsed === null) {
        throw new Error(`Invalid test runtime id: ${raw}`);
    }
    return parsed;
}

function seq(raw: number): SyncSeq<"session"> {
    const parsed = parseSyncSeq<"session">(raw);
    if (parsed === null) {
        throw new Error(`Invalid test session seq: ${raw}`);
    }
    return parsed;
}

const SESSION_1 = sid("session-1");
const OTHER_SESSION = sid("other");
const RUNTIME_1 = rt("runtime-1");
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

function makeSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
    return {
        entriesVersion: V152,
        baseEntryCount: 0,
        entries: { mode: "inline", data: [] },
        state: summary(),
        liveMessage: null,
        pendingUiRequests: [],
        ...overrides,
    };
}

type AssistantDelta = Extract<SessionEvent, { type: "message_update" }>["assistantMessageEvent"];

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

function connectingState(sessionId: SessionId = SESSION_1): SessionState {
    return {
        ...initialSessionState,
        status: "connecting",
        sessionId,
    };
}

describe("session sync reducer", () => {
    it("starts idle and replaces snapshot fields atomically", () => {
        expect(initialSessionState).toEqual({
            status: "idle",
            sessionId: null,
            entriesVersion: null,
            state: null,
            entries: [],
            entriesSync: { kind: "idle" },
            liveMessage: { kind: "none" },
            pendingUiRequests: [],
            lastError: null,
        });

        const reducer = createSessionSyncReducer();
        const afterDelta = reducer.applyDelta(connectingState(), {
            kind: "agent_event",
            event: { type: "agent_start" },
        });

        const entries: readonly FileEntry[] = [];
        const next = reducer.applySnapshot(
            afterDelta,
            makeSnapshot({
                state: summary({ messageCount: 5 }),
                entries: { mode: "inline", data: entries },
                pendingUiRequests: [dialog("a"), notifyRequest("ignored")],
            }),
        );

        expect(next.status).toBe("open");
        expect(next.state).toEqual(summary({ messageCount: 5 }));
        expect(next.entries).toBe(entries);
        expect(next.pendingUiRequests).toEqual([dialog("a")]);
    });

    it("ignores a snapshot for another session", () => {
        const reducer = createSessionSyncReducer();
        const state = connectingState();
        const next = reducer.applySnapshot(state, makeSnapshot({ state: summary({ sessionId: OTHER_SESSION }) }));
        expect(next).toBe(state);
    });

    it("applies state_patched and agent_event deltas deterministically during replay", () => {
        const client = new SyncStreamClient<
            "session",
            SessionState,
            SessionSnapshot,
            SessionDelta,
            SessionHttpHydrationDescriptor
        >({
            initialState: connectingState(),
            reducer: createSessionSyncReducer(),
        });

        client.markConnecting();
        client.handleFrame({
            type: "sync:snapshot",
            cursor: { epoch: RUNTIME_1, seq: seq(2) },
            snapshot: makeSnapshot({
                state: summary({ isStreaming: true, messageCount: 2 }),
                pendingUiRequests: [dialog("stale")],
            }),
        });

        client.markReconnecting(1);
        client.handleFrame({
            type: "sync:replay",
            cursor: { epoch: RUNTIME_1, seq: seq(5) },
            fromSeq: seq(2),
            deltas: [
                { seq: seq(3), payload: { kind: "agent_event", event: { type: "agent_settled", aborted: false } } },
                { seq: seq(4), payload: { kind: "ui_resolved", requestId: "stale" } },
                {
                    seq: seq(5),
                    payload: {
                        kind: "state_patched",
                        patch: {
                            model: { provider: "anthropic", id: "claude-sonnet-4", name: "Claude" },
                            messageCount: 4,
                            steeringMode: "all",
                        },
                    },
                },
            ],
        });

        const state = client.currentState;
        expect(client.appliedCursor).toEqual({ epoch: RUNTIME_1, seq: seq(5) });
        expect(state.state?.isStreaming).toBe(false);
        expect(state.state?.messageCount).toBe(4);
        expect(state.state?.steeringMode).toBe("all");
        expect(state.state?.model?.id).toBe("claude-sonnet-4");
        expect(state.pendingUiRequests).toEqual([]);
    });

    it("adds only interactive UI requests and removes resolved ones by id", () => {
        const reducer = createSessionSyncReducer();
        let state = reducer.applySnapshot(connectingState(), makeSnapshot());

        state = reducer.applyDelta(state, { kind: "ui_request", request: dialog("confirm") });
        state = reducer.applyDelta(state, { kind: "ui_request", request: dialog("select", "select") });
        state = reducer.applyDelta(state, { kind: "ui_request", request: notifyRequest("notify") });
        state = reducer.applyDelta(state, { kind: "ui_request", request: dialog("confirm") });

        expect(state.pendingUiRequests.map((request) => request.id)).toEqual(["confirm", "select"]);

        state = reducer.applyDelta(state, { kind: "ui_resolved", requestId: "confirm" });
        expect(state.pendingUiRequests.map((request) => request.id)).toEqual(["select"]);

        const unchanged = reducer.applyDelta(state, { kind: "ui_resolved", requestId: "missing" });
        expect(unchanged).toBe(state);
    });

    it("folds message_update deltas into liveMessage", () => {
        const reducer = createSessionSyncReducer();
        let state = reducer.applySnapshot(connectingState(), makeSnapshot());

        state = reducer.applyDelta(state, {
            kind: "agent_event",
            event: { type: "message_start", message: assistant({ content: [{ type: "text", text: "" }] }) },
        });
        const update = (delta: AssistantDelta): SessionDelta => ({
            kind: "agent_event",
            event: { type: "message_update", usage: usage(), assistantMessageEvent: delta },
        });
        state = reducer.applyDelta(state, update({ type: "text_start", contentIndex: 0 }));
        state = reducer.applyDelta(state, update({ type: "text_delta", contentIndex: 0, delta: "Hello" }));
        state = reducer.applyDelta(state, update({ type: "text_delta", contentIndex: 0, delta: " world" }));

        expect(liveAssistantMessage(state)?.content[0]).toEqual({ type: "text", text: "Hello world" });

        state = reducer.applyDelta(state, {
            kind: "agent_event",
            event: {
                type: "message_end",
                message: assistant({ content: [{ type: "text", text: "Hello world" }] }),
            },
        });
        expect(state.liveMessage.kind).toBe("settled");
    });

    it("eliminates message_end flicker by holding settled liveMessage until matching entry arrives", () => {
        const reducer = createSessionSyncReducer();
        const headerEntry: FileEntry = {
            type: "session",
            version: 3,
            id: "session-1",
            timestamp: "2026-04-01T00:00:00.000Z",
            cwd: "/tmp",
        };
        let state = reducer.applySnapshot(
            connectingState(),
            makeSnapshot({ entries: { mode: "inline", data: [headerEntry] } }),
        );

        const msg = assistant({ timestamp: 12345, content: [{ type: "text", text: "Final answer" }] });
        state = reducer.applyDelta(state, {
            kind: "agent_event",
            event: { type: "message_start", message: assistant({ timestamp: 12345 }) },
        });
        state = reducer.applyDelta(state, { kind: "agent_event", event: { type: "message_end", message: msg } });
        expect(state.liveMessage).toEqual({ kind: "settled", message: msg });

        // Non-matching entry keeps settled message visible without 1-frame vanish.
        state = reducer.applyDelta(state, {
            kind: "entries_appended",
            entriesVersion: V152,
            baseEntryCount: 1,
            entries: {
                mode: "inline",
                data: [
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
        state = reducer.applyDelta(state, {
            kind: "entries_appended",
            entriesVersion: V152,
            baseEntryCount: 2,
            entries: {
                mode: "inline",
                data: [
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

    it("delegates pending delta buffering during HTTP hydration to SyncStreamClient", async () => {
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

        const hydrateGate = Promise.withResolvers<SessionState>();
        const client = new SyncStreamClient<
            "session",
            SessionState,
            SessionSnapshot,
            SessionDelta,
            SessionHttpHydrationDescriptor
        >({
            initialState: connectingState(),
            reducer: createSessionSyncReducer(),
            onHydrateHttp: () => hydrateGate.promise,
        });

        client.markConnecting();
        client.handleFrame({
            type: "sync:snapshot",
            cursor: { epoch: RUNTIME_1, seq: seq(1) },
            snapshot: makeSnapshot({
                entries: { mode: "http", meta: { entryCount: 2 } },
            }),
        });
        expect(client.currentPhase.kind).toBe("hydrating_http");
        expect(client.currentState.entriesSync).toEqual({
            kind: "loading",
        });

        client.handleFrame({
            type: "sync:delta",
            cursor: { epoch: RUNTIME_1, seq: seq(2) },
            delta: {
                kind: "entries_appended",
                entriesVersion: V152,
                baseEntryCount: 2,
                entries: { mode: "inline", data: [msg2] },
            },
        });

        // HTTP returns [header, msg1] without msg2; SyncStreamClient applies msg2 afterward cleanly.
        hydrateGate.resolve(applyHydratedEntries(client.currentState, V152, 0, [headerEntry, msg1]));
        await Promise.resolve();
        await Promise.resolve();

        expect(client.currentPhase).toEqual({ kind: "live", cursor: { epoch: RUNTIME_1, seq: seq(2) } });
        expect(client.currentState.entriesSync).toEqual({ kind: "idle" });
        expect(client.currentState.entries.map((entry) => entry.id)).toEqual(["session-1", "e1", "e2"]);
    });

    it("converges terminal closed state and ignores subsequent frames", () => {
        const reducer = createSessionSyncReducer();
        const base = reducer.applySnapshot(connectingState(), makeSnapshot({ pendingUiRequests: [dialog("a")] }));

        const sessionClose = applySessionClosed(base, "session", "Session closed");
        expect(sessionClose.status).toBe("closed");
        expect(sessionClose.pendingUiRequests).toEqual([]);
        expect(sessionClose.lastError).toBe("Session closed");

        expect(reducer.applyDelta(sessionClose, { kind: "agent_event", event: { type: "agent_start" } })).toBe(
            sessionClose,
        );
        expect(reducer.applyDelta(sessionClose, { kind: "ui_request", request: dialog("late") })).toBe(sessionClose);
    });
});
