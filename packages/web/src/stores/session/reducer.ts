import type {
    AssistantMessage,
    FileEntry,
    RpcExtensionUIRequest,
    SequencedSessionEvent,
    SessionCloseReason,
    SessionStateSnapshot,
    WsErrorMessage,
    WsEventMessage,
    WsExtensionUiRequestMessage,
    WsExtensionUiResolvedMessage,
    WsReplayMessage,
    WsSnapshotMessage,
} from "@pivia/protocol";

/** Connection lifecycle of the one session the workspace currently shows. */
export type SessionConnectionStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed" | "error";

/** Everything the session view needs from the active runtime. */
export interface SessionState {
    readonly status: SessionConnectionStatus;
    readonly sessionId: string | null;
    /** Sequence number of the newest applied event. */
    readonly seq: number;
    readonly state: SessionStateSnapshot | null;
    readonly entries: readonly FileEntry[];
    /** Structural events kept for the live view; message deltas live in `liveMessage`. */
    readonly liveEvents: readonly SequencedSessionEvent[];
    /** Assistant message being streamed; message_update deltas fold into it. */
    readonly liveMessage: AssistantMessage | null;
    readonly pendingUiRequests: readonly RpcExtensionUIRequest[];
    readonly lastError: string | null;
}

/** Inputs the reducer accepts from the transport, the store and route changes. */
export type SessionAction =
    | { readonly type: "connect"; readonly sessionId: string }
    | { readonly type: "open" }
    | { readonly type: "snapshot"; readonly message: WsSnapshotMessage }
    | { readonly type: "replay"; readonly message: WsReplayMessage }
    | { readonly type: "event"; readonly message: WsEventMessage }
    | { readonly type: "extension_ui_request"; readonly message: WsExtensionUiRequestMessage }
    | { readonly type: "extension_ui_resolved"; readonly message: WsExtensionUiResolvedMessage }
    | { readonly type: "server_error"; readonly message: WsErrorMessage }
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
    seq: 0,
    state: null,
    entries: [],
    liveEvents: [],
    liveMessage: null,
    pendingUiRequests: [],
    lastError: null,
};

type SessionEvent = SequencedSessionEvent["event"];
type AssistantDelta = Extract<SessionEvent, { type: "message_update" }>["assistantMessageEvent"];

/**
 * Upper bound for structural events kept in memory.
 *
 * Streaming deltas do not enter this list; they fold into `liveMessage`. The bound still stops
 * tool updates and queue changes from growing without limit.
 */
const MAX_LIVE_EVENTS = 512;

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

/**
 * Applies one session event to the live assistant message.
 *
 * `message_start` and `message_end` mark the boundaries. A snapshot or a terminal close clears
 * the live message because the snapshot entries or the terminal state are authoritative.
 */
function applyAssistantEvent(message: AssistantMessage | null, event: SessionEvent): AssistantMessage | null {
    switch (event.type) {
        case "message_start":
            return event.message.role === "assistant" ? event.message : null;
        case "message_update":
            return message === null
                ? null
                : { ...applyAssistantDelta(message, event.assistantMessageEvent), usage: event.usage };
        case "message_end":
            return event.message.role === "assistant" ? null : message;
        default:
            return message;
    }
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
        case "open":
            return state.status === "closed" ? state : { ...state, status: "open", lastError: null };
        case "snapshot": {
            const { message } = action;
            if (state.status === "closed" || message.sessionId !== state.sessionId) {
                return state;
            }
            return {
                ...state,
                status: "open",
                seq: message.seq,
                state: message.state,
                entries: message.entries,
                liveEvents: [],
                liveMessage: null,
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
            let liveMessage = state.liveMessage;
            const appended: SequencedSessionEvent[] = [];
            for (const sequenced of message.events) {
                if (sequenced.seq <= previousSeq) {
                    continue;
                }
                // The server state already includes these events. Applying the idempotent fields
                // again keeps a replayed state equal to the one the event stream describes.
                summary = applySessionEvent(summary, sequenced.event);
                liveMessage = applyAssistantEvent(liveMessage, sequenced.event);
                if (isStructuralEvent(sequenced.event)) {
                    appended.push(sequenced);
                }
            }
            return {
                ...state,
                status: "open",
                // The server's current sequence covers an empty replay, and the applied events
                // already moved `previousSeq`; keep the newer of the two.
                seq: message.seq > previousSeq ? message.seq : previousSeq,
                state: summary,
                liveEvents: appendLiveEvents(state.liveEvents, appended),
                liveMessage,
                pendingUiRequests: message.pendingUiRequests,
                lastError: null,
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
                liveMessage: null,
                pendingUiRequests: [],
                lastError: closedError(action.reason, action.message),
            };
        case "failed":
            return { ...state, status: "error", liveMessage: null, lastError: action.message };
        case "reset":
            return initialSessionState;
    }
}
