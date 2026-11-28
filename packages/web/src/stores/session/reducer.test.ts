import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { FileEntry, RpcExtensionUIRequest } from "@earendil-works/pi-coding-agent";
import {
    EMPTY_SESSION_UI_STATE,
    type ExtensionDialogRequest,
    type SessionDelta,
    type SessionId,
    type SessionSnapshot,
    type SessionStateSnapshot,
} from "@pivia/protocol";

type SessionEvent = Extract<SessionDelta, { readonly kind: "agent_event" }>["event"];
import { describe, expect, it } from "vitest";

import { makeSessionStateSnapshot } from "@/test/fixtures";
import { ev, sid } from "@/test/ids";

import {
    applyHydratedEntries,
    applySessionClosed,
    createSessionSyncReducer,
    initialSessionState,
    liveAssistantMessage,
    type SessionState,
} from "./reducer";

const SESSION_1 = sid("session-1");
const OTHER_SESSION = sid("other");
const V152 = ev("3:1.5.2");

function summary(overrides: Partial<SessionStateSnapshot> = {}): SessionStateSnapshot {
    return makeSessionStateSnapshot({ messageCount: 2, ...overrides });
}

function dialog(id: string, method: "confirm" | "select" | "input" | "editor" = "confirm"): ExtensionDialogRequest {
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

type NotifyRequest = Extract<RpcExtensionUIRequest, { readonly method: "notify" }>;

function notifyRequest(id: string, notifyType?: "info" | "warning" | "error"): NotifyRequest {
    return {
        type: "extension_ui_request",
        id,
        method: "notify",
        message: "Heads up",
        ...(notifyType === undefined ? {} : { notifyType }),
    };
}

function makeSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
    return {
        entriesVersion: V152,
        baseEntryCount: 0,
        entries: { mode: "inline", data: [] },
        state: summary(),
        liveMessage: null,
        pendingUiRequests: [],
        uiState: EMPTY_SESSION_UI_STATE,
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
            liveToolExecutions: {},
            liveActivity: { kind: "idle" },
            activityNotice: null,
            pendingUiRequests: [],
            uiState: EMPTY_SESSION_UI_STATE,
            notices: [],
            editorTextSequence: 0,
            editorTextRequest: null,
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
                pendingUiRequests: [dialog("a")],
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

    it("applies state_patched and agent_event deltas deterministically", () => {
        const reducer = createSessionSyncReducer();
        let state = reducer.applySnapshot(
            connectingState(),
            makeSnapshot({
                state: summary({ isStreaming: true, messageCount: 2 }),
                pendingUiRequests: [dialog("stale")],
            }),
        );

        state = reducer.applyDelta(state, {
            kind: "agent_event",
            event: { type: "agent_settled", aborted: false },
        });
        state = reducer.applyDelta(state, { kind: "ui_resolved", requestId: "stale" });
        state = reducer.applyDelta(state, {
            kind: "state_patched",
            patch: {
                model: {
                    provider: "anthropic",
                    id: "claude-sonnet-4",
                    name: "Claude",
                    contextWindow: 200_000,
                    reasoning: true,
                },
                contextUsage: { tokens: 12_000, contextWindow: 200_000, percent: 6 },
                routedModel: {
                    model: {
                        provider: "openai",
                        id: "gpt-5",
                        name: "GPT-5",
                        contextWindow: 272_000,
                        reasoning: true,
                    },
                    thinkingLevel: "high",
                },
                messageCount: 4,
                steeringMode: "all",
            },
        });

        expect(state.state?.isStreaming).toBe(false);
        expect(state.state?.messageCount).toBe(4);
        expect(state.state?.steeringMode).toBe("all");
        expect(state.state?.model?.id).toBe("claude-sonnet-4");
        expect(state.state?.contextUsage).toEqual({ tokens: 12_000, contextWindow: 200_000, percent: 6 });
        expect(state.state?.routedModel?.model.id).toBe("gpt-5");
        expect(state.state?.routedModel?.thinkingLevel).toBe("high");
        expect(state.pendingUiRequests).toEqual([]);

        state = reducer.applyDelta(state, {
            kind: "state_patched",
            patch: { contextUsage: null, routedModel: null },
        });
        expect(state.state?.contextUsage).toBeNull();
        expect(state.state?.routedModel).toBeNull();
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

    it("ignores malformed dialog requests in ui_request deltas", () => {
        const reducer = createSessionSyncReducer();
        // A `select` without options cannot render; the wire type cannot express that, so the test forges it.
        const malformed = {
            type: "extension_ui_request",
            id: "broken",
            method: "select",
            title: "Pick",
        } as unknown as RpcExtensionUIRequest;

        let state = reducer.applySnapshot(connectingState(), makeSnapshot({ pendingUiRequests: [dialog("ok")] }));
        expect(state.pendingUiRequests).toEqual([dialog("ok")]);

        state = reducer.applyDelta(state, { kind: "ui_request", request: malformed });
        expect(state.pendingUiRequests).toEqual([dialog("ok")]);
    });

    it("turns notify requests into deduplicated notices by tone", () => {
        const reducer = createSessionSyncReducer();
        let state = reducer.applySnapshot(connectingState(), makeSnapshot());

        state = reducer.applyDelta(state, { kind: "ui_request", request: notifyRequest("info-1") });
        state = reducer.applyDelta(state, { kind: "ui_request", request: notifyRequest("warn-1", "warning") });
        state = reducer.applyDelta(state, { kind: "ui_request", request: notifyRequest("error-1", "error") });
        state = reducer.applyDelta(state, { kind: "ui_request", request: notifyRequest("info-1") });

        expect(state.notices).toEqual([
            { id: "notify:info-1", tone: "info", title: "Heads up", description: null },
            { id: "notify:warn-1", tone: "warning", title: "Heads up", description: null },
            { id: "notify:error-1", tone: "error", title: "Heads up", description: null },
        ]);
    });

    it("records one extension failure per path and event", () => {
        const reducer = createSessionSyncReducer();
        let state = reducer.applySnapshot(connectingState(), makeSnapshot());

        state = reducer.applyDelta(state, {
            kind: "extension_error",
            extensionPath: "/home/u/.pi/extensions/lint.ts",
            event: "tool_call",
            error: "Cannot read the config",
        });
        state = reducer.applyDelta(state, {
            kind: "extension_error",
            extensionPath: "/home/u/.pi/extensions/lint.ts",
            event: "tool_call",
            error: "Cannot read the config",
        });

        expect(state.notices).toEqual([
            {
                id: "extension-error:/home/u/.pi/extensions/lint.ts:tool_call",
                tone: "error",
                title: "Extension failed",
                description: "/home/u/.pi/extensions/lint.ts: Cannot read the config",
            },
        ]);
    });

    it("keeps only the newest twenty notices", () => {
        const reducer = createSessionSyncReducer();
        let state = reducer.applySnapshot(connectingState(), makeSnapshot());

        for (let index = 0; index < 25; index += 1) {
            state = reducer.applyDelta(state, { kind: "ui_request", request: notifyRequest(`n-${String(index)}`) });
        }

        expect(state.notices).toHaveLength(20);
        expect(state.notices[0]?.id).toBe("notify:n-5");
    });

    it("sequences set_editor_text commands so the composer applies the newest once", () => {
        const reducer = createSessionSyncReducer();
        let state = reducer.applySnapshot(connectingState(), makeSnapshot());

        state = reducer.applyDelta(state, {
            kind: "ui_request",
            request: { type: "extension_ui_request", id: "editor-1", method: "set_editor_text", text: "first" },
        });
        expect(state.editorTextRequest).toEqual({ sequence: 1, text: "first" });

        state = reducer.applyDelta(state, {
            kind: "ui_request",
            request: { type: "extension_ui_request", id: "editor-2", method: "set_editor_text", text: "second" },
        });
        expect(state.editorTextRequest).toEqual({ sequence: 2, text: "second" });
    });

    it("applies extension chrome from deltas and clears it with the session", () => {
        const reducer = createSessionSyncReducer();
        let state = reducer.applySnapshot(connectingState(), makeSnapshot());

        state = reducer.applyDelta(state, {
            kind: "ui_request",
            request: {
                type: "extension_ui_request",
                id: "c1",
                method: "setStatus",
                statusKey: "lint",
                statusText: "clean",
            },
        });
        state = reducer.applyDelta(state, {
            kind: "ui_request",
            request: {
                type: "extension_ui_request",
                id: "c2",
                method: "setWidget",
                widgetKey: "todo",
                widgetLines: ["one"],
                widgetPlacement: "belowEditor",
            },
        });
        state = reducer.applyDelta(state, {
            kind: "ui_request",
            request: { type: "extension_ui_request", id: "c3", method: "setTitle", title: "Release" },
        });

        expect(state.uiState).toEqual({
            statuses: [{ key: "lint", text: "clean" }],
            widgets: [{ key: "todo", lines: ["one"], placement: "belowEditor" }],
            title: "Release",
        });

        state = reducer.applyDelta(state, {
            kind: "ui_request",
            request: {
                type: "extension_ui_request",
                id: "c4",
                method: "setStatus",
                statusKey: "lint",
                statusText: undefined,
            },
        });
        state = reducer.applyDelta(state, {
            kind: "ui_request",
            request: {
                type: "extension_ui_request",
                id: "c5",
                method: "setWidget",
                widgetKey: "todo",
                widgetLines: undefined,
            },
        });
        state = reducer.applyDelta(state, {
            kind: "ui_request",
            request: { type: "extension_ui_request", id: "c6", method: "setTitle", title: "" },
        });

        expect(state.uiState).toEqual(EMPTY_SESSION_UI_STATE);
        expect(applySessionClosed(state, "session").uiState).toEqual(EMPTY_SESSION_UI_STATE);
    });

    it("restores extension chrome from a snapshot", () => {
        const reducer = createSessionSyncReducer();
        const uiState = {
            ...EMPTY_SESSION_UI_STATE,
            statuses: [{ key: "lint", text: "clean" }],
            title: "Release",
        };

        const state = reducer.applySnapshot(connectingState(), makeSnapshot({ uiState }));

        expect(state.uiState).toEqual(uiState);
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

    it("hydrates HTTP entries and appends deltas that follow the hydrated prefix", () => {
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

        const reducer = createSessionSyncReducer();
        let state = reducer.applySnapshot(
            connectingState(),
            makeSnapshot({ entries: { mode: "http", meta: { entryCount: 2 } } }),
        );
        expect(state.entriesSync).toEqual({ kind: "loading" });

        state = applyHydratedEntries(state, V152, 0, [headerEntry, msg1]);
        expect(state.entriesSync).toEqual({ kind: "idle" });

        state = reducer.applyDelta(state, {
            kind: "entries_appended",
            entriesVersion: V152,
            baseEntryCount: 2,
            entries: { mode: "inline", data: [msg2] },
        });

        expect(state.entries.map((entry) => entry.id)).toEqual(["session-1", "e1", "e2"]);
    });

    it("hydrates over a cached prefix without duplicating overlap entries", () => {
        const reducer = createSessionSyncReducer();
        const header: FileEntry = {
            type: "session",
            version: 3,
            id: "session-1",
            timestamp: "2026-04-01T00:00:00.000Z",
            cwd: "/tmp",
        };
        const persisted: FileEntry = {
            type: "message",
            id: "e1",
            parentId: null,
            timestamp: "2026-04-01T00:00:01.000Z",
            message: assistant({ timestamp: 12345, content: [{ type: "text", text: "Final answer" }] }),
        };
        const next: FileEntry = {
            type: "message",
            id: "e2",
            parentId: "e1",
            timestamp: "2026-04-01T00:00:02.000Z",
            message: { role: "user", content: "follow-up", timestamp: 2 },
        };
        let state = reducer.applySnapshot(
            connectingState(),
            makeSnapshot({ entries: { mode: "inline", data: [header, persisted] } }),
        );
        state = reducer.applyDelta(state, {
            kind: "agent_event",
            event: { type: "message_start", message: assistant({ timestamp: 12345 }) },
        });
        state = reducer.applyDelta(state, {
            kind: "agent_event",
            event: { type: "message_end", message: assistant({ timestamp: 12345 }) },
        });
        expect(state.liveMessage.kind).toBe("settled");

        // The HTTP slice repeats the cached entry and adds one more.
        state = applyHydratedEntries(state, V152, 2, [persisted, next]);

        expect(state.entries.map((entry) => entry.id)).toEqual(["session-1", "e1", "e2"]);
        expect(state.liveMessage).toEqual({ kind: "none" });
        expect(state.entriesSync).toEqual({ kind: "idle" });
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

    it("tracks top-level live tool executions and prunes them when persisted toolResult entries arrive", () => {
        const reducer = createSessionSyncReducer();
        let state = reducer.applySnapshot(connectingState(), makeSnapshot());

        state = reducer.applyDelta(state, {
            kind: "agent_event",
            event: {
                type: "tool_execution_start",
                toolCallId: "cm-1",
                toolName: "codemode",
                args: { code: "return 1;" },
            },
        });
        expect(state.liveToolExecutions["cm-1"]).toEqual({
            kind: "running",
            toolCallId: "cm-1",
            toolName: "codemode",
            args: { code: "return 1;" },
            partialResult: null,
        });

        // Nested sub-calls carry parentToolCallId and must not create separate top-level tool entries.
        state = reducer.applyDelta(state, {
            kind: "agent_event",
            event: {
                type: "tool_execution_start",
                toolCallId: "cm-1/1",
                toolName: "read",
                args: { path: "a.ts" },
                parentToolCallId: "cm-1",
            },
        });
        expect(state.liveToolExecutions["cm-1/1"]).toBeUndefined();

        state = reducer.applyDelta(state, {
            kind: "agent_event",
            event: {
                type: "tool_execution_update",
                toolCallId: "cm-1",
                toolName: "codemode",
                args: { code: "return 1;" },
                partialResult: {
                    content: [{ type: "text", text: "line 1\n" }],
                    details: { calls: [{ id: "cm-1/1", name: "read", args: '{"path":"a.ts"}', status: "running" }] },
                },
            },
        });
        expect(state.liveToolExecutions["cm-1"]).toMatchObject({
            kind: "running",
            partialResult: {
                content: [{ type: "text", text: "line 1\n" }],
                details: { calls: [{ id: "cm-1/1", name: "read", status: "running" }] },
            },
        });

        state = reducer.applyDelta(state, {
            kind: "agent_event",
            event: {
                type: "tool_execution_end",
                toolCallId: "cm-1",
                toolName: "codemode",
                result: { content: [{ type: "text", text: "done" }], details: { calls: [] } },
                isError: false,
                durationMs: 245,
            },
        });
        expect(state.liveToolExecutions["cm-1"]).toEqual({
            kind: "settled",
            toolCallId: "cm-1",
            toolName: "codemode",
            args: { code: "return 1;" },
            result: { content: [{ type: "text", text: "done" }], details: { calls: [] } },
            isError: false,
            durationMs: 245,
        });

        state = reducer.applyDelta(state, {
            kind: "entries_appended",
            entriesVersion: V152,
            baseEntryCount: 0,
            entries: {
                mode: "inline",
                data: [
                    {
                        type: "message",
                        id: "tr-1",
                        parentId: null,
                        timestamp: "2026-04-01T00:00:01.000Z",
                        message: {
                            role: "toolResult",
                            toolCallId: "cm-1",
                            toolName: "codemode",
                            content: [{ type: "text", text: "done" }],
                            isError: false,
                            timestamp: 1_000,
                        },
                    },
                ],
            },
        });
        expect(state.liveToolExecutions).toEqual({});
    });

    it("tracks compaction, auto_retry, and summarization retry activity and notices", () => {
        const reducer = createSessionSyncReducer();
        let state = reducer.applySnapshot(connectingState(), makeSnapshot({ state: summary({ isCompacting: true }) }));
        expect(state.liveActivity).toEqual({ kind: "compacting", reason: null });

        state = reducer.applyDelta(state, {
            kind: "agent_event",
            event: { type: "compaction_start", reason: "threshold" },
        });
        expect(state.liveActivity).toEqual({ kind: "compacting", reason: "threshold" });

        state = reducer.applyDelta(state, {
            kind: "agent_event",
            event: {
                type: "compaction_end",
                reason: "threshold",
                result: undefined,
                aborted: true,
                willRetry: false,
            },
        });
        expect(state.liveActivity).toEqual({ kind: "idle" });
        expect(state.activityNotice).toEqual({ tone: "status", message: "Auto-compaction cancelled" });

        state = reducer.applyDelta(state, {
            kind: "agent_event",
            event: {
                type: "auto_retry_start",
                attempt: 1,
                maxAttempts: 3,
                delayMs: 4_000,
                errorMessage: "429 Rate limited",
            },
        });
        expect(state.liveActivity).toEqual({
            kind: "retrying",
            scope: "turn",
            attempt: 1,
            maxAttempts: 3,
            delayMs: 4_000,
            errorMessage: "429 Rate limited",
        });
        expect(state.activityNotice).toBeNull();

        state = reducer.applyDelta(state, {
            kind: "agent_event",
            event: {
                type: "auto_retry_end",
                success: false,
                attempt: 3,
                finalError: "Service overloaded",
            },
        });
        expect(state.liveActivity).toEqual({ kind: "idle" });
        expect(state.activityNotice).toEqual({
            tone: "error",
            message: "Retry failed after 3 attempts: Service overloaded",
        });

        state = reducer.applyDelta(state, {
            kind: "agent_event",
            event: { type: "agent_start" },
        });
        expect(state.liveActivity).toEqual({ kind: "working" });
        expect(state.activityNotice).toBeNull();
    });

    it("handles mid-tool reconnect updates and preserves summarizingBranch across summarization retries", () => {
        const reducer = createSessionSyncReducer();
        let state = reducer.applySnapshot(connectingState(), makeSnapshot({ state: summary({ isCompacting: true }) }));

        // Update/end without prior start (reconnect mid-execution) still captures partial/final state.
        state = reducer.applyDelta(state, {
            kind: "agent_event",
            event: {
                type: "tool_execution_update",
                toolCallId: "reconnected-1",
                toolName: "bash",
                args: { command: "ls" },
                partialResult: { content: [{ type: "text", text: "a.ts" }], details: undefined },
            },
        });
        expect(state.liveToolExecutions["reconnected-1"]).toMatchObject({
            kind: "running",
            args: { command: "ls" },
            partialResult: { content: [{ type: "text", text: "a.ts" }] },
        });

        state = reducer.applyDelta(state, {
            kind: "agent_event",
            event: {
                type: "summarization_retry_scheduled",
                attempt: 1,
                maxAttempts: 2,
                delayMs: 2_000,
                errorMessage: "Temporary error",
            },
        });
        expect(state.liveActivity).toMatchObject({ kind: "retrying", scope: "summarization" });
        expect(state.activityNotice).toEqual({ tone: "error", message: "Temporary error" });

        state = reducer.applyDelta(state, {
            kind: "agent_event",
            event: { type: "summarization_retry_attempt_start", source: "branchSummary" },
        });
        expect(state.liveActivity).toEqual({ kind: "summarizingBranch" });
        expect(state.activityNotice).toBeNull();

        state = reducer.applyDelta(state, {
            kind: "agent_event",
            event: { type: "summarization_retry_finished" },
        });
        expect(state.liveActivity).toEqual({ kind: "summarizingBranch" });

        // Completed compaction clears any earlier notice.
        state = reducer.applyDelta(state, {
            kind: "agent_event",
            event: {
                type: "compaction_end",
                reason: "manual",
                result: { summary: "Done", firstKeptEntryId: "m1", tokensBefore: 1000 },
                aborted: false,
                willRetry: false,
            },
        });
        expect(state.liveActivity).toEqual({ kind: "idle" });
        expect(state.activityNotice).toBeNull();
    });
});
