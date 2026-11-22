import type {
    AssistantMessage,
    EntriesVersion,
    FileEntry,
    RpcExtensionUIRequest,
    SequencedSessionEvent,
    SessionCloseReason,
    SessionId,
    SessionStateSnapshot,
    SessionWsEntriesAppendedMessage,
    SessionWsErrorMessage,
    SessionWsEventMessage,
    SessionWsExtensionUiRequestMessage,
    SessionWsExtensionUiResolvedMessage,
    SessionWsReplayMessage,
    SessionWsSnapshotMessage,
} from "@pivia/protocol";

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
 * Sum type for HTTP entry synchronization (`entriesMode: "http"` and gap self-healing).
 *
 * `pendingAppendedEntries` and `targetEntryCount` exist only while a sync is in flight or
 * awaiting retry, making idle-with-pending-queue states unrepresentable.
 */
export type EntriesSyncState =
    | { readonly kind: "idle" }
    | {
          readonly kind: "loading";
          readonly baseEntryCount: number;
          readonly targetEntryCount: number;
          readonly pendingAppendedEntries: readonly FileEntry[];
      }
    | {
          readonly kind: "error";
          readonly baseEntryCount: number;
          readonly targetEntryCount: number;
          readonly message: string;
          readonly pendingAppendedEntries: readonly FileEntry[];
      };

/** Everything the session view needs from the active runtime. */
export interface SessionState {
    readonly status: SessionConnectionStatus;
    readonly sessionId: SessionId | null;
    /** Active server runtime id for Tier 1 replay matching. */
    readonly runtimeId: string | null;
    /** Sequence number of the newest applied event. */
    readonly seq: number;
    /** Composite `${sessionVersion}:${sdkVersion}`, or `null` when uncached/unmigrated. */
    readonly entriesVersion: EntriesVersion | null;
    readonly state: SessionStateSnapshot | null;
    readonly entries: readonly FileEntry[];
    readonly entriesSync: EntriesSyncState;
    /** Structural events kept for the live view; message deltas live in `liveMessage`. */
    readonly liveEvents: readonly SequencedSessionEvent[];
    /** Assistant message being streamed or awaiting its persisted entry; deltas fold into it. */
    readonly liveMessage: LiveMessageState;
    readonly pendingUiRequests: readonly RpcExtensionUIRequest[];
    readonly lastError: string | null;
}

/** Inputs the reducer accepts from the transport, cache, store and route changes. */
export type SessionAction =
    | { readonly type: "connect"; readonly sessionId: SessionId }
    | {
          readonly type: "hydrate_cache";
          readonly sessionId: SessionId;
          readonly entriesVersion: EntriesVersion | null;
          readonly entries: readonly FileEntry[];
          readonly runtimeId?: string | null | undefined;
          readonly seq?: number | undefined;
          readonly state?: SessionStateSnapshot | null | undefined;
          readonly liveEvents?: readonly SequencedSessionEvent[] | undefined;
      }
    | { readonly type: "open" }
    | { readonly type: "snapshot"; readonly message: SessionWsSnapshotMessage }
    | { readonly type: "replay"; readonly message: SessionWsReplayMessage }
    | {
          readonly type: "entries_appended";
          readonly message: Extract<SessionWsEntriesAppendedMessage, { readonly entriesMode: "inline" }>;
      }
    | { readonly type: "entries_sync_started"; readonly baseEntryCount: number; readonly targetEntryCount: number }
    | {
          readonly type: "entries_sync_succeeded";
          readonly sessionId: SessionId;
          readonly entriesVersion: EntriesVersion | null;
          readonly baseEntryCount: number;
          readonly entries: readonly FileEntry[];
      }
    | { readonly type: "entries_sync_failed"; readonly sessionId: SessionId; readonly message: string }
    | { readonly type: "event"; readonly message: SessionWsEventMessage }
    | { readonly type: "extension_ui_request"; readonly message: SessionWsExtensionUiRequestMessage }
    | { readonly type: "extension_ui_resolved"; readonly message: SessionWsExtensionUiResolvedMessage }
    | { readonly type: "server_error"; readonly message: SessionWsErrorMessage }
    | { readonly type: "reconnecting" }
    | {
          readonly type: "closed";
          readonly reason: SessionCloseReason;
          /** Server close reason, used for a terminal session close. */
          readonly message?: string | undefined;
      }
    | { readonly type: "failed"; readonly message: string }
    | { readonly type: "reset" };

/** The session state before a socket exists. */
export const initialSessionState: SessionState = {
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
};

/** Extract the active assistant message for rendering, regardless of streaming vs settled state. */
export function liveAssistantMessage(state: SessionState): AssistantMessage | null {
    return state.liveMessage.kind === "none" ? null : state.liveMessage.message;
}

type SessionEvent = SequencedSessionEvent["event"];
type AssistantDelta = Extract<SessionEvent, { type: "message_update" }>["assistantMessageEvent"];

/**
 * Upper bound for structural events kept in memory.
 *
 * Streaming deltas do not enter this list; they fold into `liveMessage`. The bound still stops
 * tool updates and queue changes from growing without limit.
 */
const MAX_LIVE_EVENTS = 512;

/**
 * Upper bound for entries staged while an HTTP sync owns the transcript.
 *
 * The queue only saves a re-read of the same range, so dropping it on overflow costs one extra
 * request instead of holding an entire session delta in memory during a stalled or failing sync.
 */
const MAX_PENDING_APPENDED_ENTRIES = 512;

const INTERACTIVE_METHODS: ReadonlySet<RpcExtensionUIRequest["method"]> = new Set([
    "select",
    "confirm",
    "input",
    "editor",
]);

function isDialogRequest(request: RpcExtensionUIRequest): boolean {
    return INTERACTIVE_METHODS.has(request.method);
}

function isStructuralEvent(event: SessionEvent): boolean {
    return event.type !== "message_update";
}

function appendLiveEvent(
    events: readonly SequencedSessionEvent[],
    event: SequencedSessionEvent,
): readonly SequencedSessionEvent[] {
    if (events.length < MAX_LIVE_EVENTS) {
        return [...events, event];
    }
    return [...events.slice(events.length - MAX_LIVE_EVENTS + 1), event];
}

function appendLiveEvents(
    events: readonly SequencedSessionEvent[],
    additions: readonly SequencedSessionEvent[],
): readonly SequencedSessionEvent[] {
    if (additions.length === 0) {
        return events;
    }
    const combined = [...events, ...additions];
    return combined.length > MAX_LIVE_EVENTS ? combined.slice(combined.length - MAX_LIVE_EVENTS) : combined;
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
function applyAssistantEvent(live: LiveMessageState, event: SessionEvent): LiveMessageState {
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

/** Merge newly appended entries idempotently by `entry.id` and clear a settled `liveMessage` only when matched. */
function mergeAppendedEntries(
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

function containsAssistantMessage(entries: readonly FileEntry[], timestamp: number): boolean {
    return entries.some(
        (entry) =>
            entry.type === "message" && entry.message.role === "assistant" && entry.message.timestamp === timestamp,
    );
}

/**
 * Folds one live event into the state summary.
 *
 * Only fields whose value the event states in full are updated. Counters such as `messageCount`
 * stay whatever the server last reported, because a partial delta cannot reconstruct them and a
 * replay would otherwise apply the same increment twice.
 */
function applySessionEvent(summary: SessionStateSnapshot | null, event: SessionEvent): SessionStateSnapshot | null {
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
                pendingMessageCount: event.steering.length + event.followUp.length,
            };
        default:
            return summary;
    }
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

function closedError(reason: SessionCloseReason, message: string | undefined): string | null {
    if (reason === "session") {
        return message ?? "The session closed.";
    }
    return closeReasonError(reason);
}

/**
 * Pure reducer for the active session.
 *
 * Snapshots and replays replace `pendingUiRequests` as a whole. An appended or resolved dialog is
 * never merged with an older list, because a resolved dialog that came back would block the
 * extension again.
 */
export function reduceSessionState(state: SessionState, action: SessionAction): SessionState {
    switch (action.type) {
        case "connect":
            return {
                ...initialSessionState,
                status: "connecting",
                sessionId: action.sessionId,
            };
        case "hydrate_cache": {
            if (state.status === "closed" || action.sessionId !== state.sessionId || state.entries.length > 0) {
                return state;
            }
            return {
                ...state,
                entriesVersion: action.entriesVersion,
                entries: action.entries,
                runtimeId: action.runtimeId ?? state.runtimeId,
                seq: action.seq ?? state.seq,
                state: action.state ?? state.state,
                liveEvents: action.liveEvents ?? state.liveEvents,
                // Keep liveMessage empty when hydrating from cache until WS handshake confirms live state.
                liveMessage: { kind: "none" },
            };
        }
        case "open":
            return state.status === "closed" ? state : { ...state, status: "open", lastError: null };
        case "snapshot": {
            const { message } = action;
            if (state.status === "closed" || message.sessionId !== state.sessionId) {
                return state;
            }
            if (message.entriesMode === "http") {
                const basePrefix = message.baseEntryCount > 0 ? state.entries.slice(0, message.baseEntryCount) : [];
                return {
                    ...state,
                    status: "open",
                    runtimeId: message.runtimeId,
                    seq: message.seq,
                    entriesVersion: message.entriesVersion,
                    state: message.state,
                    entries: basePrefix,
                    entriesSync: {
                        kind: "loading",
                        baseEntryCount: message.baseEntryCount,
                        targetEntryCount: message.entryCount,
                        pendingAppendedEntries: [],
                    },
                    liveEvents: [],
                    liveMessage: toLiveMessageState(message.liveMessage),
                    pendingUiRequests: message.pendingUiRequests,
                    lastError: null,
                };
            }
            const nextEntries =
                message.baseEntryCount === 0
                    ? message.entries
                    : [...state.entries.slice(0, message.baseEntryCount), ...message.entries];
            return {
                ...state,
                status: "open",
                runtimeId: message.runtimeId,
                seq: message.seq,
                entriesVersion: message.entriesVersion,
                state: message.state,
                entries: nextEntries,
                entriesSync: { kind: "idle" },
                liveEvents: [],
                liveMessage: toLiveMessageState(message.liveMessage),
                pendingUiRequests: message.pendingUiRequests,
                lastError: null,
            };
        }
        case "replay": {
            const { message } = action;
            if (state.status === "closed" || message.sessionId !== state.sessionId) {
                return state;
            }
            const previousSeq = state.seq;
            let summary: SessionStateSnapshot | null = message.state;
            const appended: SequencedSessionEvent[] = [];
            for (const sequenced of message.events) {
                if (sequenced.seq <= previousSeq) {
                    continue;
                }
                // The server state already includes these events. Applying the idempotent fields
                // again keeps a replayed state equal to the one the event stream describes.
                summary = applySessionEvent(summary, sequenced.event);
                if (isStructuralEvent(sequenced.event)) {
                    appended.push(sequenced);
                }
            }
            const nextEntries =
                message.appendedSlice !== undefined
                    ? mergeAppendedEntries(
                          state.entries,
                          message.appendedSlice.baseEntryCount,
                          message.appendedSlice.entries,
                          { kind: "none" },
                      ).entries
                    : state.entries;
            return {
                ...state,
                status: "open",
                runtimeId: message.runtimeId,
                entriesVersion: message.entriesVersion,
                // The server's current sequence covers an empty replay, and the applied events
                // already moved `previousSeq`; keep the newer of the two.
                seq: message.seq > previousSeq ? message.seq : previousSeq,
                state: summary,
                entries: nextEntries,
                liveEvents: appendLiveEvents(state.liveEvents, appended),
                liveMessage: toLiveMessageState(message.liveMessage),
                pendingUiRequests: message.pendingUiRequests,
                lastError: null,
            };
        }
        case "entries_appended": {
            const { message } = action;
            if (state.status === "closed" || message.sessionId !== state.sessionId) {
                return state;
            }
            if (state.entriesSync.kind !== "idle") {
                const nextTarget = Math.max(
                    state.entriesSync.targetEntryCount,
                    message.baseEntryCount + message.entries.length,
                );
                const staged = [...state.entriesSync.pendingAppendedEntries, ...message.entries];
                return {
                    ...state,
                    entriesVersion: message.entriesVersion,
                    entriesSync: {
                        ...state.entriesSync,
                        targetEntryCount: nextTarget,
                        pendingAppendedEntries: staged.length > MAX_PENDING_APPENDED_ENTRIES ? [] : staged,
                    },
                };
            }
            if (message.baseEntryCount > state.entries.length) {
                return state;
            }
            const merged = mergeAppendedEntries(
                state.entries,
                message.baseEntryCount,
                message.entries,
                state.liveMessage,
            );
            return {
                ...state,
                entriesVersion: message.entriesVersion,
                entries: merged.entries,
                liveMessage: merged.liveMessage,
            };
        }
        case "entries_sync_started": {
            const prev = state.entriesSync;
            const pending = prev.kind === "idle" ? [] : prev.pendingAppendedEntries;
            const target =
                prev.kind === "idle"
                    ? action.targetEntryCount
                    : Math.max(prev.targetEntryCount, action.targetEntryCount);
            return {
                ...state,
                entriesSync: {
                    kind: "loading",
                    baseEntryCount: action.baseEntryCount,
                    targetEntryCount: target,
                    pendingAppendedEntries: pending,
                },
            };
        }
        case "entries_sync_succeeded": {
            if (state.status === "closed" || action.sessionId !== state.sessionId) {
                return state;
            }
            // A handshake or replay already settled the transcript, so no sync is in flight and the
            // response describes a prefix the client no longer holds.
            if (state.entriesSync.kind === "idle") {
                return state;
            }
            const { pendingAppendedEntries: pending, targetEntryCount } = state.entriesSync;
            const basePrefix = action.baseEntryCount > 0 ? state.entries.slice(0, action.baseEntryCount) : [];
            const combinedBase = basePrefix.length === 0 ? action.entries : [...basePrefix, ...action.entries];
            const seenIds = new Set(combinedBase.map((entry) => entry.id));
            const trailing: FileEntry[] = [];
            for (const entry of pending) {
                if (!seenIds.has(entry.id)) {
                    seenIds.add(entry.id);
                    trailing.push(entry);
                }
            }
            const mergedEntries = trailing.length === 0 ? combinedBase : [...combinedBase, ...trailing];
            const settledMatched =
                state.liveMessage.kind === "settled" &&
                (containsAssistantMessage(action.entries, state.liveMessage.message.timestamp) ||
                    containsAssistantMessage(pending, state.liveMessage.message.timestamp));
            const nextLive = settledMatched ? ({ kind: "none" } as const) : state.liveMessage;
            const nextSync: EntriesSyncState =
                mergedEntries.length < targetEntryCount
                    ? {
                          kind: "loading",
                          baseEntryCount: mergedEntries.length,
                          targetEntryCount,
                          pendingAppendedEntries: [],
                      }
                    : { kind: "idle" };
            return {
                ...state,
                entriesVersion: action.entriesVersion,
                entries: mergedEntries,
                entriesSync: nextSync,
                liveMessage: nextLive,
            };
        }
        case "entries_sync_failed": {
            if (state.status === "closed" || action.sessionId !== state.sessionId) {
                return state;
            }
            const prev = state.entriesSync;
            return {
                ...state,
                entriesSync: {
                    kind: "error",
                    baseEntryCount: prev.kind === "idle" ? state.entries.length : prev.baseEntryCount,
                    targetEntryCount: prev.kind === "idle" ? state.entries.length : prev.targetEntryCount,
                    message: action.message,
                    pendingAppendedEntries: prev.kind === "idle" ? [] : prev.pendingAppendedEntries,
                },
            };
        }
        case "event": {
            const { message } = action;
            if (state.status === "closed" || message.sessionId !== state.sessionId || message.seq <= state.seq) {
                return state;
            }
            const sequenced: SequencedSessionEvent = { seq: message.seq, event: message.event };
            return {
                ...state,
                status: "open",
                seq: message.seq,
                state: applySessionEvent(state.state, message.event),
                liveEvents: isStructuralEvent(message.event)
                    ? appendLiveEvent(state.liveEvents, sequenced)
                    : state.liveEvents,
                liveMessage: applyAssistantEvent(state.liveMessage, message.event),
                lastError: null,
            };
        }
        case "extension_ui_request": {
            const { message } = action;
            if (
                state.status === "closed" ||
                message.sessionId !== state.sessionId ||
                !isDialogRequest(message.request)
            ) {
                return state;
            }
            if (state.pendingUiRequests.some((request) => request.id === message.request.id)) {
                return state;
            }
            return {
                ...state,
                pendingUiRequests: [...state.pendingUiRequests, message.request],
            };
        }
        case "extension_ui_resolved": {
            const { message } = action;
            if (state.status === "closed" || message.sessionId !== state.sessionId) {
                return state;
            }
            const pendingUiRequests = state.pendingUiRequests.filter((request) => request.id !== message.requestId);
            return pendingUiRequests.length === state.pendingUiRequests.length
                ? state
                : { ...state, pendingUiRequests };
        }
        case "server_error":
            return { ...state, lastError: action.message.message };
        case "reconnecting":
            return state.status === "closed" ? state : { ...state, status: "reconnecting" };
        case "closed":
            return {
                ...state,
                status: "closed",
                liveMessage: { kind: "none" },
                pendingUiRequests: [],
                lastError: closedError(action.reason, action.message),
            };
        case "failed":
            return { ...state, status: "error", liveMessage: { kind: "none" }, lastError: action.message };
        case "reset":
            return initialSessionState;
    }
}
