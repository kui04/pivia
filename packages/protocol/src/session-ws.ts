import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
    AgentSession,
    ExtensionError,
    FileEntry,
    JsonAgentSessionEvent,
    RpcCommand,
    RpcExtensionUIRequest,
    RpcExtensionUIResponse,
    RpcSessionState,
} from "@earendil-works/pi-coding-agent";

import type { SessionModelInfo, SessionPrefixAnchor } from "./http.ts";
import type { PatchOf, StrictOmit } from "./parse/primitives.ts";
import type { EntriesVersion, SessionId } from "./parse/session.ts";
import type { Delivery, SyncCursor, SyncFrame, SyncHandshake } from "./sync/index.ts";

/** Logical clock cursor for one session stream. */
export type SessionCursor = SyncCursor<"session">;

/** Handshake parameters sent on `/ws/sessions/:id` connect and reconnect. */
export type SessionHandshake = SyncHandshake<"session", SessionPrefixAnchor>;

/** WebSocket close codes shared by the session server and the browser client. */
export const SESSION_CLOSE_CODE = {
    normal: 1000,
    goingAway: 1001,
    internalError: 1011,
    slowConsumer: 1013,
    sessionClosed: 4400,
    sessionNotFound: 4404,
} as const;

/** One known close code used by the session WebSocket route. */
export type SessionCloseCode = (typeof SESSION_CLOSE_CODE)[keyof typeof SESSION_CLOSE_CODE];

/** Why the server closed a session socket. */
export type SessionRemoteCloseReason = "session" | "slow-consumer" | "disconnected";

/** Why a browser client closed a session socket. */
export type SessionCloseReason = "client" | SessionRemoteCloseReason;

/**
 * Classifies a server-sent close code.
 *
 * A deliberate session close and a missing session are terminal. A slow consumer is closed so
 * the client can reconnect and replay. Everything else, including the standard `goingAway` code,
 * is treated as a transport drop that can be retried.
 */
export function classifySessionClose(code: number): SessionRemoteCloseReason {
    switch (code) {
        case SESSION_CLOSE_CODE.sessionClosed:
        case SESSION_CLOSE_CODE.sessionNotFound:
            return "session";
        case SESSION_CLOSE_CODE.slowConsumer:
            return "slow-consumer";
        default:
            return "disconnected";
    }
}

/** Command outcome for `steer` and `follow_up`, derived from the SDK session methods. */
export type SessionQueuedInputDisposition = Awaited<ReturnType<AgentSession["steer"]>>;

/**
 * State snapshot of one open session runtime, derived from the SDK {@link RpcSessionState}.
 *
 * The snapshot deliberately omits `sessionFile` so clients never learn host filesystem locations,
 * and omits `pendingMessageCount` because `steeringMessages` and `followUpMessages` already carry
 * the exact queue contents. `name` is `null` when the session has no display name.
 */
export interface SessionStateSnapshot extends Readonly<
    StrictOmit<RpcSessionState, "model" | "sessionFile" | "sessionId" | "sessionName" | "pendingMessageCount">
> {
    readonly sessionId: SessionId;
    readonly cwd: string;
    readonly name: string | null;
    readonly model: SessionModelInfo | null;
    readonly steeringMessages: readonly string[];
    readonly followUpMessages: readonly string[];
}

/** HTTP offload metadata for session entry slices (`baseEntryCount` lives on the enclosing payload). */
export interface SessionEntriesHttpMeta {
    readonly entryCount: number;
}

/** Versioned entry slice carried by session snapshots and `entries_appended` deltas. */
export interface SessionEntrySlice {
    readonly entriesVersion: EntriesVersion;
    readonly baseEntryCount: number;
    readonly entries: Delivery<readonly FileEntry[], SessionEntriesHttpMeta>;
}

/** Full or prefix-anchored session snapshot replicated over the Sync lane. */
export interface SessionSnapshot extends SessionEntrySlice {
    readonly state: SessionStateSnapshot;
    readonly liveMessage: AssistantMessage | null;
    /** Dialog requests that are still waiting for a response. */
    readonly pendingUiRequests: readonly RpcExtensionUIRequest[];
}

/**
 * Incremental patch for {@link SessionStateSnapshot} fields mutated outside `AgentSessionEvent`
 * (such as `set_model` or message count updates).
 */
export type SessionStatePatch = PatchOf<
    SessionStateSnapshot,
    "model" | "messageCount" | "autoCompactionEnabled" | "steeringMode" | "followUpMode"
>;

/** Causal session state mutations replicated on the unified session sync clock. */
export type SessionDelta =
    | { readonly kind: "agent_event"; readonly event: JsonAgentSessionEvent }
    | ({ readonly kind: "entries_appended" } & SessionEntrySlice)
    | { readonly kind: "state_patched"; readonly patch: SessionStatePatch }
    | { readonly kind: "ui_request"; readonly request: RpcExtensionUIRequest }
    | { readonly kind: "ui_resolved"; readonly requestId: string }
    | ({ readonly kind: "extension_error" } & Readonly<StrictOmit<ExtensionError, "stack">>);

/** Server-to-client Sync lane frames for `/ws/sessions/:id`. */
export type SessionSyncFrame = SyncFrame<"session", SessionSnapshot, SessionDelta>;

/**
 * Control command payload sent inside `rpc:command`.
 *
 * Every command may carry an `id`; the matching `rpc:response` repeats it so clients can correlate
 * concurrent commands.
 */
export type SessionRpcCommand = Extract<
    RpcCommand,
    {
        type:
            | "prompt"
            | "steer"
            | "follow_up"
            | "abort"
            | "clear_queue"
            | "get_state"
            | "set_model"
            | "get_available_models"
            | "set_thinking_level"
            | "get_available_thinking_levels"
            | "set_session_name"
            | "compact";
    }
>;

/** Discriminant names of client control commands that produce a {@link SessionRpcServerMessage}. */
export type SessionWsCommandName = SessionRpcCommand["type"];

/** Orthogonal client-to-server RPC lane messages sent over `/ws/sessions/:id`. */
export type SessionWsClientMessage =
    | { readonly type: "rpc:command"; readonly command: SessionRpcCommand }
    | { readonly type: "rpc:ui_response"; readonly response: RpcExtensionUIResponse };

/** Orthogonal server-to-client RPC lane responses and protocol errors. */
export type SessionRpcServerMessage =
    | {
          readonly type: "rpc:response";
          readonly id?: string | undefined;
          readonly command: SessionWsCommandName;
          readonly success: true;
          readonly data?: unknown;
      }
    | {
          readonly type: "rpc:response";
          readonly id?: string | undefined;
          readonly command: SessionWsCommandName;
          readonly success: false;
          readonly error: string;
      }
    | {
          readonly type: "rpc:error";
          readonly code?: string | undefined;
          readonly message: string;
          /** Present when the rejected input carried a command or request id. */
          readonly id?: string | undefined;
      };

/** Messages the server sends over `/ws/sessions/:id` (Sync lane + orthogonal RPC lane). */
export type SessionWsServerMessage = SessionSyncFrame | SessionRpcServerMessage;
