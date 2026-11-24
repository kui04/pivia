import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { FileEntry, JsonAgentSessionEvent, RpcExtensionUIRequest } from "@earendil-works/pi-coding-agent";
import {
    assertNever,
    isRecord,
    type EntriesVersion,
    type HydratableSyncReducer,
    type SessionCloseReason,
    type SessionDelta,
    type SessionId,
    type SessionPrefixAnchor,
    type SessionSnapshot,
    type SessionStatePatch,
    type SessionStateSnapshot,
} from "@pivia/protocol";

import {
    toNonNegativeDuration,
    toToolArguments,
    toToolResultBlocks,
    type NormalizedToolResultBlock,
    type TranscriptToolArguments,
} from "./tool-details";

type ToolExecutionStartEvent = Extract<JsonAgentSessionEvent, { type: "tool_execution_start" }>;
type ToolExecutionEndEvent = Extract<JsonAgentSessionEvent, { type: "tool_execution_end" }>;
type CompactionStartEvent = Extract<JsonAgentSessionEvent, { type: "compaction_start" }>;
type AutoRetryStartEvent = Extract<JsonAgentSessionEvent, { type: "auto_retry_start" }>;

/** Normalized payload carried by `tool_execution_update` and `tool_execution_end` wire events. */
export interface LiveToolExecutionResult {
    readonly content: readonly NormalizedToolResultBlock[];
    readonly details: unknown;
}

/** Live execution state for one top-level tool call before its persisted `toolResult` entry arrives. */
export type LiveToolExecutionState =
    | {
          readonly kind: "running";
          readonly toolCallId: ToolExecutionStartEvent["toolCallId"];
          readonly toolName: ToolExecutionStartEvent["toolName"];
          readonly args: TranscriptToolArguments;
          readonly partialResult: LiveToolExecutionResult | null;
      }
    | {
          readonly kind: "settled";
          readonly toolCallId: ToolExecutionEndEvent["toolCallId"];
          readonly toolName: ToolExecutionEndEvent["toolName"];
          readonly args: TranscriptToolArguments;
          readonly result: LiveToolExecutionResult;
          readonly isError: ToolExecutionEndEvent["isError"];
          readonly durationMs: number | null;
      };

/** Compaction trigger reason; `null` when hydrated solely from a boolean `SessionStateSnapshot`. */
export type CompactionReason = CompactionStartEvent["reason"] | null;

/** Live session activity state driving `WorkingIndicator` and compaction/retry banners. */
export type SessionLiveActivity =
    | { readonly kind: "idle" }
    | { readonly kind: "working" }
    | { readonly kind: "compacting"; readonly reason: CompactionReason }
    | { readonly kind: "summarizingBranch" }
    | {
          readonly kind: "retrying";
          readonly scope: "turn" | "summarization";
          readonly attempt: AutoRetryStartEvent["attempt"];
          readonly maxAttempts: AutoRetryStartEvent["maxAttempts"];
          readonly delayMs: AutoRetryStartEvent["delayMs"];
          readonly errorMessage: AutoRetryStartEvent["errorMessage"];
      };

/** Transient terminal compaction or auto-retry status notice shown until the next run starts. */
export interface SessionActivityNotice {
    readonly tone: "status" | "error";
    readonly message: string;
}

const EMPTY_LIVE_TOOL_EXECUTIONS: Readonly<Record<string, LiveToolExecutionState>> = {};

/** Connection lifecycle of the one session the workspace currently shows. */
export type SessionConnectionStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed" | "error";

/**
 * Sum type for the streaming assistant message.
 *
 * `"settled"` keeps the finalized message visible after `message_end` until the matching
 * persisted entry lands in `entries`, eliminating the 1-frame vanish without allowing the illegal
 * state `{ liveMessage: null, settled: true }`.
 */
export type LiveMessageState =
    | { readonly kind: "none" }
    | { readonly kind: "streaming"; readonly message: AssistantMessage }
    | { readonly kind: "settled"; readonly message: AssistantMessage };

/**
 * Sum type for HTTP entry synchronization (`Delivery.http` snapshots and large appends).
 *
 * Pending WebSocket deltas are owned by `SyncStreamClient`'s `hydrating_http` phase rather than
 * duplicated in UI store state.
 */
export type EntriesSyncState =
    { readonly kind: "idle" } | { readonly kind: "loading" } | { readonly kind: "error"; readonly message: string };

/** HTTP hydration descriptor returned to `SyncStreamClient` when session entries offload to HTTP. */
export interface SessionHttpHydrationDescriptor {
    readonly kind: "snapshot" | "delta";
    readonly baseEntryCount: number;
}

/** Everything the session view needs from the active runtime. */
export interface SessionState {
    readonly status: SessionConnectionStatus;
    readonly sessionId: SessionId | null;
    /** Composite `${sessionVersion}:${sdkVersion}`, or `null` when uncached/unmigrated. */
    readonly entriesVersion: EntriesVersion | null;
    readonly state: SessionStateSnapshot | null;
    readonly entries: readonly FileEntry[];
    readonly entriesSync: EntriesSyncState;
    /** Assistant message being streamed or awaiting its persisted entry; deltas fold into it. */
    readonly liveMessage: LiveMessageState;
    /** Top-level tool executions still running or awaiting their persisted `toolResult` entry. */
    readonly liveToolExecutions: Readonly<Record<string, LiveToolExecutionState>>;
    /** Current runtime activity (working, compacting, retrying, or summarizing a branch). */
    readonly liveActivity: SessionLiveActivity;
    /** Terminal cancellation or retry-failure notice cleared on the next run or session reset. */
    readonly activityNotice: SessionActivityNotice | null;
    readonly pendingUiRequests: readonly RpcExtensionUIRequest[];
    readonly lastError: string | null;
}

/** Cached transcript and state snapshot loaded from IndexedDB or the memory LRU. */
export interface SessionLocalHydrationInput {
    readonly sessionId: SessionId;
    readonly entriesVersion: EntriesVersion | null;
    readonly entries: readonly FileEntry[];
    readonly state?: SessionStateSnapshot | null | undefined;
}

/** The session state before a socket exists. */
export const initialSessionState: SessionState = {
    status: "idle",
    sessionId: null,
    entriesVersion: null,
    state: null,
    entries: [],
    entriesSync: { kind: "idle" },
    liveMessage: { kind: "none" },
    liveToolExecutions: EMPTY_LIVE_TOOL_EXECUTIONS,
    liveActivity: { kind: "idle" },
    activityNotice: null,
    pendingUiRequests: [],
    lastError: null,
};

/** Extract the active assistant message for rendering, regardless of streaming vs settled state. */
export function liveAssistantMessage(state: SessionState): AssistantMessage | null {
    return state.liveMessage.kind === "none" ? null : state.liveMessage.message;
}

/** Build a Tier 2 entry-prefix anchor when the store holds a non-empty cached transcript. */
export function buildSessionPrefixAnchor(state: SessionState): SessionPrefixAnchor | undefined {
    const lastEntry = state.entries.at(-1);
    if (state.entriesVersion === null || lastEntry === undefined) {
        return undefined;
    }
    return {
        entriesVersion: state.entriesVersion,
        afterCount: state.entries.length,
        afterEntryId: lastEntry.id,
    };
}

type AssistantDelta = Extract<JsonAgentSessionEvent, { type: "message_update" }>["assistantMessageEvent"];

const INTERACTIVE_METHODS: ReadonlySet<RpcExtensionUIRequest["method"]> = new Set([
    "select",
    "confirm",
    "input",
    "editor",
]);

function isDialogRequest(request: RpcExtensionUIRequest): boolean {
    return INTERACTIVE_METHODS.has(request.method);
}

function filterInteractiveUiRequests(requests: readonly RpcExtensionUIRequest[]): readonly RpcExtensionUIRequest[] {
    return requests.filter(isDialogRequest);
}

function replaceContent(message: AssistantMessage, index: number, block: AssistantMessage["content"][number]) {
    const content = [...message.content];
    content[index] = block;
    return { ...message, content };
}

/**
 * Applies one assistant delta to the streaming message.
 *
 * The wire event removes the cumulative `partial` field, so text and thinking blocks are rebuilt
 * from their deltas. Tool arguments are complete only at `toolcall_end`; until then the live
 * message carries the tool id and name.
 */
function applyAssistantDelta(message: AssistantMessage, delta: AssistantDelta): AssistantMessage {
    switch (delta.type) {
        case "text_start":
            return replaceContent(message, delta.contentIndex, { type: "text", text: "" });
        case "text_delta": {
            const block = message.content[delta.contentIndex];
            if (block?.type !== "text") {
                return message;
            }
            return replaceContent(message, delta.contentIndex, { ...block, text: block.text + delta.delta });
        }
        case "text_end":
            return replaceContent(message, delta.contentIndex, { type: "text", text: delta.content });
        case "thinking_start":
            return replaceContent(message, delta.contentIndex, { type: "thinking", thinking: "" });
        case "thinking_delta": {
            const block = message.content[delta.contentIndex];
            if (block?.type !== "thinking") {
                return message;
            }
            return replaceContent(message, delta.contentIndex, {
                ...block,
                thinking: block.thinking + delta.delta,
            });
        }
        case "thinking_end":
            return replaceContent(message, delta.contentIndex, { type: "thinking", thinking: delta.content });
        case "toolcall_start":
            return replaceContent(message, delta.contentIndex, {
                type: "toolCall",
                id: delta.id,
                name: delta.toolName,
                arguments: {},
            });
        case "toolcall_end":
            return replaceContent(message, delta.contentIndex, delta.toolCall);
        case "toolcall_delta":
        case "start":
        case "done":
        case "error":
            return message;
    }
}

function toLiveMessageState(message: AssistantMessage | null): LiveMessageState {
    return message === null ? { kind: "none" } : { kind: "streaming", message };
}

/**
 * Applies one session event to the live assistant message.
 *
 * `message_start` starts streaming; `message_end` transitions to `"settled"` so the finalized
 * message stays rendered until the matching persisted entry arrives in `entries`.
 */
function applyAssistantEvent(live: LiveMessageState, event: JsonAgentSessionEvent): LiveMessageState {
    switch (event.type) {
        case "message_start":
            return event.message.role === "assistant"
                ? { kind: "streaming", message: event.message }
                : { kind: "none" };
        case "message_update":
            return live.kind === "streaming"
                ? {
                      kind: "streaming",
                      message: {
                          ...applyAssistantDelta(live.message, event.assistantMessageEvent),
                          usage: event.usage,
                      },
                  }
                : live;
        case "message_end":
            return event.message.role === "assistant" ? { kind: "settled", message: event.message } : live;
        default:
            return live;
    }
}

function containsAssistantMessage(entries: readonly FileEntry[], timestamp: number): boolean {
    return entries.some(
        (entry) =>
            entry.type === "message" && entry.message.role === "assistant" && entry.message.timestamp === timestamp,
    );
}

/** Merge newly appended entries idempotently by `entry.id` and clear a settled `liveMessage` only when matched. */
export function mergeAppendedEntries(
    existing: readonly FileEntry[],
    baseEntryCount: number,
    additions: readonly FileEntry[],
    live: LiveMessageState,
): { readonly entries: readonly FileEntry[]; readonly liveMessage: LiveMessageState } {
    if (additions.length === 0 || baseEntryCount > existing.length) {
        return { entries: existing, liveMessage: live };
    }
    const overlapStart = Math.max(0, baseEntryCount);
    const seenIds = new Set<string>();
    for (let index = overlapStart; index < existing.length; index += 1) {
        const entry = existing[index];
        if (entry !== undefined) {
            seenIds.add(entry.id);
        }
    }
    const toAdd: FileEntry[] = [];
    for (const entry of additions) {
        if (!seenIds.has(entry.id)) {
            seenIds.add(entry.id);
            toAdd.push(entry);
        }
    }
    const nextEntries = toAdd.length === 0 ? existing : [...existing, ...toAdd];
    const nextLive =
        live.kind === "settled" && containsAssistantMessage(additions, live.message.timestamp)
            ? ({ kind: "none" } as const)
            : live;
    return { entries: nextEntries, liveMessage: nextLive };
}

/**
 * Folds one live event into the state summary.
 *
 * Only fields whose value the event states in full are updated. Non-event state mutations such as
 * `model` and `messageCount` arrive via {@link SessionDelta} `state_patched` frames so replays remain
 * deterministic.
 */
function applySessionEvent(
    summary: SessionStateSnapshot | null,
    event: JsonAgentSessionEvent,
): SessionStateSnapshot | null {
    if (summary === null) {
        return null;
    }
    switch (event.type) {
        case "agent_start":
            return summary.isStreaming ? summary : { ...summary, isStreaming: true };
        case "agent_settled":
            return summary.isStreaming ? { ...summary, isStreaming: false } : summary;
        case "compaction_start":
            return summary.isCompacting ? summary : { ...summary, isCompacting: true };
        case "compaction_end":
            return summary.isCompacting ? { ...summary, isCompacting: false } : summary;
        case "session_info_changed": {
            const name = event.name ?? null;
            return summary.name === name ? summary : { ...summary, name };
        }
        case "thinking_level_changed":
            return summary.thinkingLevel === event.level ? summary : { ...summary, thinkingLevel: event.level };
        case "queue_update":
            return {
                ...summary,
                steeringMessages: event.steering,
                followUpMessages: event.followUp,
            };
        default:
            return summary;
    }
}

function applyStatePatch(summary: SessionStateSnapshot | null, patch: SessionStatePatch): SessionStateSnapshot | null {
    if (summary === null) {
        return null;
    }
    return {
        ...summary,
        ...(patch.model === undefined ? {} : { model: patch.model }),
        ...(patch.messageCount === undefined ? {} : { messageCount: patch.messageCount }),
        ...(patch.autoCompactionEnabled === undefined ? {} : { autoCompactionEnabled: patch.autoCompactionEnabled }),
        ...(patch.steeringMode === undefined ? {} : { steeringMode: patch.steeringMode }),
        ...(patch.followUpMode === undefined ? {} : { followUpMode: patch.followUpMode }),
    };
}

function extractToolExecutionResult(raw: unknown): LiveToolExecutionResult {
    if (!isRecord(raw)) {
        return { content: [], details: undefined };
    }
    return {
        content: toToolResultBlocks(raw.content),
        details: raw.details,
    };
}

function applyToolExecutionEvent(
    liveTools: Readonly<Record<string, LiveToolExecutionState>>,
    event: JsonAgentSessionEvent,
): Readonly<Record<string, LiveToolExecutionState>> {
    switch (event.type) {
        case "tool_execution_start":
            if (typeof event.parentToolCallId === "string" && event.parentToolCallId !== "") {
                return liveTools;
            }
            return {
                ...liveTools,
                [event.toolCallId]: {
                    kind: "running",
                    toolCallId: event.toolCallId,
                    toolName: event.toolName,
                    args: toToolArguments(event.args),
                    partialResult: null,
                },
            };
        case "tool_execution_update": {
            if (typeof event.parentToolCallId === "string" && event.parentToolCallId !== "") {
                return liveTools;
            }
            const existing = liveTools[event.toolCallId];
            const args =
                existing !== undefined && Object.keys(existing.args).length > 0
                    ? existing.args
                    : toToolArguments(event.args);
            return {
                ...liveTools,
                [event.toolCallId]: {
                    kind: "running",
                    toolCallId: event.toolCallId,
                    toolName: event.toolName,
                    args,
                    partialResult: extractToolExecutionResult(event.partialResult),
                },
            };
        }
        case "tool_execution_end": {
            if (typeof event.parentToolCallId === "string" && event.parentToolCallId !== "") {
                return liveTools;
            }
            const existing = liveTools[event.toolCallId];
            return {
                ...liveTools,
                [event.toolCallId]: {
                    kind: "settled",
                    toolCallId: event.toolCallId,
                    toolName: event.toolName,
                    args: existing?.args ?? {},
                    result: extractToolExecutionResult(event.result),
                    isError: event.isError === true,
                    durationMs: toNonNegativeDuration(event.durationMs),
                },
            };
        }
        case "agent_settled":
            return Object.keys(liveTools).length === 0 ? liveTools : EMPTY_LIVE_TOOL_EXECUTIONS;
        default:
            return liveTools;
    }
}

function pruneSettledLiveTools(
    liveTools: Readonly<Record<string, LiveToolExecutionState>>,
    entries: readonly FileEntry[],
): Readonly<Record<string, LiveToolExecutionState>> {
    if (Object.keys(liveTools).length === 0) {
        return liveTools;
    }
    let next: Record<string, LiveToolExecutionState> | null = null;
    for (const entry of entries) {
        if (entry.type === "message" && entry.message.role === "toolResult") {
            const toolCallId = entry.message.toolCallId;
            if (typeof toolCallId === "string" && Object.prototype.hasOwnProperty.call(liveTools, toolCallId)) {
                next ??= { ...liveTools };
                delete next[toolCallId];
            }
        }
    }
    return next ?? liveTools;
}

function snapshotLiveActivity(summary: SessionStateSnapshot): SessionLiveActivity {
    if (summary.isCompacting) {
        return { kind: "compacting", reason: null };
    }
    return summary.isStreaming ? { kind: "working" } : { kind: "idle" };
}

function applyActivityEvent(
    prevActivity: SessionLiveActivity,
    prevNotice: SessionActivityNotice | null,
    event: JsonAgentSessionEvent,
    nextSummary: SessionStateSnapshot | null,
): { readonly activity: SessionLiveActivity; readonly notice: SessionActivityNotice | null } {
    switch (event.type) {
        case "agent_start":
            return { activity: { kind: "working" }, notice: null };
        case "turn_start":
            return prevActivity.kind === "idle" || (prevActivity.kind === "retrying" && prevActivity.scope === "turn")
                ? { activity: { kind: "working" }, notice: prevNotice }
                : { activity: prevActivity, notice: prevNotice };
        case "agent_settled":
            if (
                prevActivity.kind === "working" ||
                (prevActivity.kind === "retrying" && prevActivity.scope === "turn")
            ) {
                return {
                    activity: nextSummary?.isCompacting ? { kind: "compacting", reason: null } : { kind: "idle" },
                    notice: prevNotice,
                };
            }
            return { activity: prevActivity, notice: prevNotice };
        case "compaction_start":
            return { activity: { kind: "compacting", reason: event.reason }, notice: null };
        case "compaction_end": {
            const activity: SessionLiveActivity = nextSummary?.isStreaming ? { kind: "working" } : { kind: "idle" };
            let notice: SessionActivityNotice | null = null;
            if (event.aborted) {
                notice = {
                    tone: "status",
                    message: event.reason === "manual" ? "Compaction cancelled" : "Auto-compaction cancelled",
                };
            } else if (
                event.result === undefined &&
                typeof event.errorMessage === "string" &&
                event.errorMessage !== ""
            ) {
                notice = {
                    tone: "error",
                    message: event.errorMessage,
                };
            }
            return { activity, notice };
        }
        case "auto_retry_start":
            return {
                activity: {
                    kind: "retrying",
                    scope: "turn",
                    attempt: event.attempt,
                    maxAttempts: event.maxAttempts,
                    delayMs: toNonNegativeDuration(event.delayMs) ?? 0,
                    errorMessage: event.errorMessage,
                },
                notice: null,
            };
        case "auto_retry_end":
            if (event.success) {
                return {
                    activity: nextSummary?.isStreaming ? { kind: "working" } : { kind: "idle" },
                    notice: null,
                };
            }
            return {
                activity: nextSummary?.isCompacting ? { kind: "compacting", reason: null } : { kind: "idle" },
                notice: {
                    tone: "error",
                    message: `Retry failed after ${event.attempt} attempt${event.attempt === 1 ? "" : "s"}: ${event.finalError || "Unknown error"}`,
                },
            };
        case "summarization_retry_scheduled":
            return {
                activity: {
                    kind: "retrying",
                    scope: "summarization",
                    attempt: event.attempt,
                    maxAttempts: event.maxAttempts,
                    delayMs: toNonNegativeDuration(event.delayMs) ?? 0,
                    errorMessage: event.errorMessage,
                },
                notice: {
                    tone: "error",
                    message: event.errorMessage,
                },
            };
        case "summarization_retry_attempt_start":
            return {
                activity:
                    event.source === "branchSummary"
                        ? { kind: "summarizingBranch" }
                        : { kind: "compacting", reason: event.reason },
                notice: null,
            };
        case "summarization_retry_finished":
            return {
                activity:
                    prevActivity.kind === "summarizingBranch"
                        ? prevActivity
                        : nextSummary?.isCompacting
                          ? {
                                kind: "compacting",
                                reason: prevActivity.kind === "compacting" ? prevActivity.reason : null,
                            }
                          : nextSummary?.isStreaming
                            ? { kind: "working" }
                            : { kind: "idle" },
                notice: prevNotice,
            };
        default:
            return { activity: prevActivity, notice: prevNotice };
    }
}

/** Merge an HTTP `GET /api/sessions/:id` entry slice cleanly into `state`. */
export function applyHydratedEntries(
    state: SessionState,
    entriesVersion: EntriesVersion | null,
    baseEntryCount: number,
    entries: readonly FileEntry[],
): SessionState {
    if (state.status === "closed") {
        return state;
    }
    const basePrefix = baseEntryCount > 0 ? state.entries.slice(0, baseEntryCount) : [];
    const seenIds = new Set(basePrefix.map((entry) => entry.id));
    const additions: FileEntry[] = [];
    for (const entry of entries) {
        if (!seenIds.has(entry.id)) {
            seenIds.add(entry.id);
            additions.push(entry);
        }
    }
    const mergedEntries = basePrefix.length === 0 ? additions : [...basePrefix, ...additions];
    const nextLive =
        state.liveMessage.kind === "settled" && containsAssistantMessage(entries, state.liveMessage.message.timestamp)
            ? ({ kind: "none" } as const)
            : state.liveMessage;
    return {
        ...state,
        entriesVersion: entriesVersion ?? state.entriesVersion,
        entries: mergedEntries,
        entriesSync: { kind: "idle" },
        liveMessage: nextLive,
        liveToolExecutions: pruneSettledLiveTools(state.liveToolExecutions, entries),
    };
}

/** Hydrate locally cached entries/summary without assigning a server clock cursor. */
export function applyLocalSessionHydration(state: SessionState, input: SessionLocalHydrationInput): SessionState {
    if (state.status === "closed" || input.sessionId !== state.sessionId || state.entries.length > 0) {
        return state;
    }
    return {
        ...state,
        entriesVersion: input.entriesVersion,
        entries: input.entries,
        state: input.state ?? state.state,
        // Keep liveMessage empty when hydrating locally until the WS handshake confirms live state.
        liveMessage: { kind: "none" },
    };
}

function closeReasonError(reason: SessionCloseReason): string | null {
    switch (reason) {
        case "slow-consumer":
            return "The connection fell behind and was closed.";
        case "disconnected":
            return "The connection closed unexpectedly.";
        case "client":
        case "session":
            return null;
    }
}

/** Format a terminal server/transport close into the state summary's `lastError`. */
export function sessionCloseError(reason: SessionCloseReason, message?: string): string | null {
    if (reason === "session") {
        return message ?? "The session closed.";
    }
    return closeReasonError(reason);
}

/** Fields holding ephemeral live stream/execution state, cleared on close or terminal disconnect. */
export const CLEARED_LIVE_RUNTIME_STATE = {
    liveMessage: { kind: "none" },
    liveToolExecutions: EMPTY_LIVE_TOOL_EXECUTIONS,
    liveActivity: { kind: "idle" },
    activityNotice: null,
} as const satisfies Pick<SessionState, "liveMessage" | "liveToolExecutions" | "liveActivity" | "activityNotice">;

/** Transition into terminal `closed` state while wiping transient dialogs and live streams. */
export function applySessionClosed(state: SessionState, reason: SessionCloseReason, message?: string): SessionState {
    return {
        ...state,
        status: "closed",
        ...CLEARED_LIVE_RUNTIME_STATE,
        pendingUiRequests: [],
        lastError: sessionCloseError(reason, message),
    };
}

/**
 * Create the pure {@link HydratableSyncReducer} consumed by `SyncStreamClient<"session", ...>`.
 *
 * Offloaded HTTP snapshots and large `entries_appended` deltas trigger `hydrating_http` before
 * subsequent deltas execute.
 */
export function createSessionSyncReducer(): HydratableSyncReducer<
    SessionState,
    SessionSnapshot,
    SessionDelta,
    SessionHttpHydrationDescriptor
> {
    return {
        applySnapshot(prev, snapshot) {
            if (prev.status === "closed" || (prev.sessionId !== null && snapshot.state.sessionId !== prev.sessionId)) {
                return prev;
            }
            if (snapshot.entries.mode === "http") {
                const basePrefix = snapshot.baseEntryCount > 0 ? prev.entries.slice(0, snapshot.baseEntryCount) : [];
                return {
                    ...prev,
                    status: "open",
                    sessionId: snapshot.state.sessionId,
                    entriesVersion: snapshot.entriesVersion,
                    state: snapshot.state,
                    entries: basePrefix,
                    entriesSync: { kind: "loading" },
                    liveMessage: toLiveMessageState(snapshot.liveMessage),
                    liveToolExecutions: EMPTY_LIVE_TOOL_EXECUTIONS,
                    liveActivity: snapshotLiveActivity(snapshot.state),
                    activityNotice: null,
                    pendingUiRequests: filterInteractiveUiRequests(snapshot.pendingUiRequests),
                    lastError: null,
                };
            }
            const nextEntries =
                snapshot.baseEntryCount === 0
                    ? snapshot.entries.data
                    : [...prev.entries.slice(0, snapshot.baseEntryCount), ...snapshot.entries.data];
            return {
                ...prev,
                status: "open",
                sessionId: snapshot.state.sessionId,
                entriesVersion: snapshot.entriesVersion,
                state: snapshot.state,
                entries: nextEntries,
                entriesSync: { kind: "idle" },
                liveMessage: toLiveMessageState(snapshot.liveMessage),
                liveToolExecutions: EMPTY_LIVE_TOOL_EXECUTIONS,
                liveActivity: snapshotLiveActivity(snapshot.state),
                activityNotice: null,
                pendingUiRequests: filterInteractiveUiRequests(snapshot.pendingUiRequests),
                lastError: null,
            };
        },
        inspectSnapshot(snapshot, nextState) {
            if (nextState.status === "closed" || snapshot.entries.mode !== "http") {
                return null;
            }
            return {
                kind: "snapshot",
                baseEntryCount: snapshot.baseEntryCount,
            };
        },
        inspectDelta(delta, state) {
            if (state.status === "closed" || delta.kind !== "entries_appended" || delta.entries.mode !== "http") {
                return null;
            }
            // Skip redundant HTTP reads when the transcript already reached the advertised entry count.
            if (
                state.entriesVersion === delta.entriesVersion &&
                state.entries.length >= delta.entries.meta.entryCount
            ) {
                return null;
            }
            return {
                kind: "delta",
                baseEntryCount: Math.min(state.entries.length, delta.baseEntryCount),
            };
        },
        recoverHydrationFailure(prevState, _descriptor, message) {
            return prevState.status === "closed"
                ? prevState
                : {
                      ...prevState,
                      entriesSync: {
                          kind: "error",
                          message,
                      },
                  };
        },
        applyDelta(prev, delta) {
            if (prev.status === "closed") {
                return prev;
            }
            switch (delta.kind) {
                case "agent_event": {
                    const nextSummary = applySessionEvent(prev.state, delta.event);
                    const nextActivity = applyActivityEvent(
                        prev.liveActivity,
                        prev.activityNotice,
                        delta.event,
                        nextSummary,
                    );
                    return {
                        ...prev,
                        status: "open",
                        state: nextSummary,
                        liveMessage: applyAssistantEvent(prev.liveMessage, delta.event),
                        liveToolExecutions: applyToolExecutionEvent(prev.liveToolExecutions, delta.event),
                        liveActivity: nextActivity.activity,
                        activityNotice: nextActivity.notice,
                        lastError: null,
                    };
                }
                case "entries_appended": {
                    if (delta.entries.mode === "http") {
                        return delta.entriesVersion === prev.entriesVersion
                            ? prev
                            : { ...prev, entriesVersion: delta.entriesVersion };
                    }
                    if (delta.baseEntryCount > prev.entries.length) {
                        return prev;
                    }
                    const merged = mergeAppendedEntries(
                        prev.entries,
                        delta.baseEntryCount,
                        delta.entries.data,
                        prev.liveMessage,
                    );
                    return {
                        ...prev,
                        entriesVersion: delta.entriesVersion,
                        entries: merged.entries,
                        liveMessage: merged.liveMessage,
                        liveToolExecutions: pruneSettledLiveTools(prev.liveToolExecutions, delta.entries.data),
                    };
                }
                case "state_patched":
                    return {
                        ...prev,
                        status: "open",
                        state: applyStatePatch(prev.state, delta.patch),
                        lastError: null,
                    };
                case "ui_request": {
                    if (!isDialogRequest(delta.request)) {
                        return prev;
                    }
                    if (prev.pendingUiRequests.some((candidate) => candidate.id === delta.request.id)) {
                        return prev;
                    }
                    return {
                        ...prev,
                        pendingUiRequests: [...prev.pendingUiRequests, delta.request],
                    };
                }
                case "ui_resolved": {
                    const pendingUiRequests = prev.pendingUiRequests.filter(
                        (candidate) => candidate.id !== delta.requestId,
                    );
                    return pendingUiRequests.length === prev.pendingUiRequests.length
                        ? prev
                        : { ...prev, pendingUiRequests };
                }
                case "extension_error":
                    return prev;
                default:
                    return assertNever(delta);
            }
        },
    };
}
