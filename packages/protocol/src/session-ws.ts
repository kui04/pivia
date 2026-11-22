import type { QueueMode, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
    AgentSession,
    FileEntry,
    JsonAgentSessionEvent,
    RpcCommand,
    RpcExtensionUIRequest,
    RpcExtensionUIResponse,
    RpcResponse,
} from "@earendil-works/pi-coding-agent";

import type { SessionModelInfo } from "./http.ts";
import type { EntriesVersion, SessionId } from "./parse/session.ts";

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

/** Command outcome for `prompt`, derived from the SDK RPC response type. */
export type SessionPromptDisposition = Extract<
    RpcResponse,
    { command: "prompt"; success: true }
>["data"]["disposition"];

/** Command outcome for `steer` and `follow_up`, derived from the SDK session methods. */
export type SessionQueuedInputDisposition = Awaited<ReturnType<AgentSession["steer"]>>;

/**
 * State snapshot of one open session runtime.
 *
 * The snapshot deliberately omits the session file path so clients never learn host filesystem
 * locations. `name` is `null` when the session has no display name.
 */
export interface SessionStateSnapshot {
    readonly sessionId: SessionId;
    readonly cwd: string;
    readonly name: string | null;
    readonly model: SessionModelInfo | null;
    readonly thinkingLevel: ThinkingLevel;
    readonly isStreaming: boolean;
    readonly isCompacting: boolean;
    readonly steeringMode: QueueMode;
    readonly followUpMode: QueueMode;
    readonly autoCompactionEnabled: boolean;
    readonly messageCount: number;
    readonly pendingMessageCount: number;
    readonly steeringMessages: readonly string[];
    readonly followUpMessages: readonly string[];
}

/**
 * Commands a client sends over `/ws/sessions/:id`.
 *
 * Every command may carry an `id`; the matching `response` repeats it so clients can correlate
 * concurrent commands. `extension_ui_response` answers an `extension_ui_request` and uses the
 * request id.
 */
export type SessionWsClientCommand =
    | Extract<
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
      >
    | RpcExtensionUIResponse;

/** Discriminant names of client control commands that produce a {@link SessionWsResponseMessage}. */
export type SessionWsCommandName = Exclude<SessionWsClientCommand, RpcExtensionUIResponse>["type"];

/** One session event with its monotonic replay sequence number. */
export interface SequencedSessionEvent {
    readonly seq: number;
    readonly event: JsonAgentSessionEvent;
}

/** Initial or Tier 2 incremental state sent when a connection cannot use hot event replay. */
export type SessionWsSnapshotMessage =
    | {
          readonly type: "snapshot";
          readonly sessionId: SessionId;
          readonly runtimeId: string;
          readonly seq: number;
          readonly entriesVersion: EntriesVersion;
          /** Starting index of `entries` (`0` for full snapshot, `> 0` for Tier 2 slice). */
          readonly baseEntryCount: number;
          readonly entriesMode: "inline";
          readonly entries: readonly FileEntry[];
          readonly state: SessionStateSnapshot;
          readonly liveMessage: AssistantMessage | null;
          /** Dialog requests that are still waiting for a response. */
          readonly pendingUiRequests: readonly RpcExtensionUIRequest[];
      }
    | {
          readonly type: "snapshot";
          readonly sessionId: SessionId;
          readonly runtimeId: string;
          readonly seq: number;
          readonly entriesVersion: EntriesVersion;
          /** Anchor count for HTTP slice (`0` for full download, `> 0` for incremental slice). */
          readonly baseEntryCount: number;
          readonly entriesMode: "http";
          /** Authoritative total entry count (including header) on the server at handshake time. */
          readonly entryCount: number;
          readonly state: SessionStateSnapshot;
          readonly liveMessage: AssistantMessage | null;
          /** Dialog requests that are still waiting for a response. */
          readonly pendingUiRequests: readonly RpcExtensionUIRequest[];
      };

/** Appended entries slice carried by a Tier 1 hot replay when new entries persisted after the client's prefix anchor. */
export interface SessionWsReplayAppendedSlice {
    readonly baseEntryCount: number;
    readonly entries: readonly FileEntry[];
}

/** Tier 1 hot replay after a reconnect that asks for events after `afterSeq`. */
export interface SessionWsReplayMessage {
    readonly type: "replay";
    readonly sessionId: SessionId;
    readonly runtimeId: string;
    readonly seq: number;
    readonly entriesVersion: EntriesVersion;
    readonly state: SessionStateSnapshot;
    readonly events: readonly SequencedSessionEvent[];
    /** Authoritative streaming assistant message at `seq`, or `null` when none is streaming. */
    readonly liveMessage: AssistantMessage | null;
    readonly appendedSlice?: SessionWsReplayAppendedSlice;
    readonly pendingUiRequests: readonly RpcExtensionUIRequest[];
}

/** Orthogonal persisted-entry notification; carries no `seq` and never enters `EventBuffer`. */
export type SessionWsEntriesAppendedMessage =
    | {
          readonly type: "entries_appended";
          readonly sessionId: SessionId;
          readonly entriesVersion: EntriesVersion;
          readonly entriesMode: "inline";
          readonly baseEntryCount: number;
          readonly entries: readonly FileEntry[];
      }
    | {
          readonly type: "entries_appended";
          readonly sessionId: SessionId;
          readonly entriesVersion: EntriesVersion;
          readonly entriesMode: "http";
          readonly baseEntryCount: number;
          readonly entryCount: number;
      };

/** One live session event. */
export interface SessionWsEventMessage {
    readonly type: "event";
    readonly sessionId: SessionId;
    readonly seq: number;
    readonly event: JsonAgentSessionEvent;
}

/** A dialog or fire-and-forget notification from an extension. */
export interface SessionWsExtensionUiRequestMessage {
    readonly type: "extension_ui_request";
    readonly sessionId: SessionId;
    readonly request: RpcExtensionUIRequest;
}

/** Tells every client to dismiss a dialog that another client already answered. */
export interface SessionWsExtensionUiResolvedMessage {
    readonly type: "extension_ui_resolved";
    readonly sessionId: SessionId;
    readonly requestId: string;
}

/** An extension handler failed; the session continues running. */
export interface SessionWsExtensionErrorMessage {
    readonly type: "extension_error";
    readonly sessionId: SessionId;
    readonly extensionPath: string;
    readonly event: string;
    readonly error: string;
}

/** Success or failure result for one client command, discriminated by `success`. */
export type SessionWsResponseMessage =
    | {
          readonly type: "response";
          readonly id?: string;
          readonly command: SessionWsCommandName;
          readonly success: true;
          readonly data?: unknown;
      }
    | {
          readonly type: "response";
          readonly id?: string;
          readonly command: SessionWsCommandName;
          readonly success: false;
          readonly error: string;
      };

/** Protocol-level error, such as malformed JSON or an unknown command. */
export interface SessionWsErrorMessage {
    readonly type: "error";
    readonly code?: string;
    readonly message: string;
    /** Present when the rejected input carried a command id. */
    readonly id?: string;
}

/** Messages the server sends over `/ws/sessions/:id`. */
export type SessionWsServerMessage =
    | SessionWsSnapshotMessage
    | SessionWsReplayMessage
    | SessionWsEntriesAppendedMessage
    | SessionWsEventMessage
    | SessionWsExtensionUiRequestMessage
    | SessionWsExtensionUiResolvedMessage
    | SessionWsExtensionErrorMessage
    | SessionWsResponseMessage
    | SessionWsErrorMessage;
