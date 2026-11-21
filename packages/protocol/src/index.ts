import type { QueueMode, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type {
    AgentSession,
    FileEntry,
    JsonAgentSessionEvent,
    RpcCommand,
    RpcExtensionUIRequest,
    RpcExtensionUIResponse,
    RpcResponse,
} from "@earendil-works/pi-coding-agent";

import type { EntriesVersion, SessionId } from "./parse/index.ts";

export type { QueueMode, ThinkingLevel } from "@earendil-works/pi-agent-core";
export type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
export type { FileEntry, RpcExtensionUIRequest, RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";
export * from "./parse/index.ts";
export {
    projectSessionTranscript,
    type ProjectTranscriptOptions,
    type ProjectedTranscriptItem,
    type SessionTranscriptProjection,
} from "./projection.ts";

/** Health status payload returned by `GET /api/health`. */
export interface HealthResponse {
    readonly status: "ok";
    readonly version: string;
}

/** Machine-readable error codes returned by HTTP endpoints. */
export type ApiErrorCode =
    "invalid_request" | "unauthorized" | "invalid_credentials" | "rate_limited" | "not_found" | "internal_error";

/** Standard JSON error envelope returned by HTTP endpoints. */
export interface ApiErrorResponse {
    readonly error: ApiErrorCode;
    readonly message: string;
}

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

/** API endpoints that stay public so the login gate can be reached. */
export const PUBLIC_API_PATHS = ["/api/health", "/api/auth", "/api/auth/status", "/api/auth/logout"] as const;

/** Authentication state returned by `GET /api/auth/status`. */
export interface AuthStatusResponse {
    readonly authRequired: boolean;
    readonly authenticated: boolean;
}

/** Request payload accepted by `POST /api/auth`. */
export interface AuthLoginRequest {
    readonly password: string;
}

/** Response payload returned by `POST /api/auth` on success. */
export interface AuthLoginResponse {
    readonly authenticated: true;
}

/** Response payload returned by `POST /api/auth/logout`. */
export interface AuthLogoutResponse {
    readonly authenticated: false;
}

/**
 * Summary of one session, merged from disk discovery and any live runtime.
 *
 * `createdAtMs` and `modifiedAtMs` are finite Unix epoch milliseconds. The server uses
 * `modifiedAtMs` as the fallback when the stored creation timestamp cannot be parsed. Live
 * sessions override the disk fields with in-memory state, including sessions whose file has not
 * been written yet.
 */
export interface SessionSummary {
    readonly id: SessionId;
    /** Working directory recorded in the session header; empty for sessions from old versions. */
    readonly cwd: string;
    /** Latest display name set by the user, or `null` when the session has no name. */
    readonly name: string | null;
    /** First user message text, or the SDK placeholder when the session has no messages. */
    readonly firstMessage: string;
    /** Number of conversation messages; live sessions report the in-memory count. */
    readonly messageCount: number;
    readonly createdAtMs: number;
    readonly modifiedAtMs: number;
    /** True when the session header names a parent session (forked session). */
    readonly hasParent: boolean;
    /**
     * Live runtime state. `"starting"` while extensions bind, `"closing"` while resources are
     * released, and `"idle"` when the server has no open runtime for the session.
     */
    readonly runtimeState: SessionRuntimeState;
    /** Number of authenticated WebSocket clients attached to the session runtime. */
    readonly attachedClients: number;
}

/** Lifecycle state of one session runtime. */
export type SessionRuntimeState = "starting" | "idle" | "streaming" | "compacting" | "closing";

/** Public model identity sent to clients; never contains credentials. */
export type SessionModelInfo = Pick<Model<Api>, "provider" | "id" | "name">;

/** Response payload returned by `GET /api/sessions`. */
export interface SessionListResponse {
    readonly sessions: readonly SessionSummary[];
    /** Time the server finished the discovery pass, in Unix epoch milliseconds. */
    readonly scannedAtMs: number;
}

/**
 * Prefix anchor verified by both HTTP slice reads (`GET /api/sessions/:id`) and WS Tier 1/2
 * handshakes. `afterCount` includes the session header (`entries[0]`).
 */
export interface SessionPrefixAnchor {
    readonly entriesVersion: EntriesVersion;
    readonly afterCount: number;
    readonly afterEntryId: string;
}

/** Response payload returned by `GET /api/sessions/:id`. */
export interface SessionDetailResponse {
    readonly session: SessionSummary;
    /** Composite `${sessionVersion}:${sdkVersion}`, or `null` for unmigrated v1/v2 disk files. */
    readonly entriesVersion: EntriesVersion | null;
    /** Starting index in the session's `[header, ...entries]` array; `0` for a full response. */
    readonly baseEntryCount: number;
    /** Session entries (or slice from `baseEntryCount`) with header first on full responses. */
    readonly entries: readonly FileEntry[];
}

/** Request payload accepted by `POST /api/sessions`. */
export interface CreateSessionRequest {
    /** Existing absolute directory that becomes the new session working directory. */
    readonly cwd: string;
}

/** Response payload returned by `POST /api/sessions` on success. */
export interface CreateSessionResponse {
    readonly session: SessionSummary;
}

/** Response payload returned by `POST /api/sessions/:id/close`. */
export interface CloseSessionResponse {
    /** True when the server released an active runtime; false when the session was not open. */
    readonly closed: boolean;
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
export type WsClientCommand =
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

/** Discriminant names of client control commands that produce a `WsResponseMessage`. */
export type WsCommandName = Exclude<WsClientCommand, RpcExtensionUIResponse>["type"];

/** One session event with its monotonic replay sequence number. */
export interface SequencedSessionEvent {
    readonly seq: number;
    readonly event: JsonAgentSessionEvent;
}

/** Initial or Tier 2 incremental state sent when a connection cannot use hot event replay. */
export type WsSnapshotMessage =
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
export interface WsReplayAppendedSlice {
    readonly baseEntryCount: number;
    readonly entries: readonly FileEntry[];
}

/** Tier 1 hot replay after a reconnect that asks for events after `afterSeq`. */
export interface WsReplayMessage {
    readonly type: "replay";
    readonly sessionId: SessionId;
    readonly runtimeId: string;
    readonly seq: number;
    readonly entriesVersion: EntriesVersion;
    readonly state: SessionStateSnapshot;
    readonly events: readonly SequencedSessionEvent[];
    /** Authoritative streaming assistant message at `seq`, or `null` when none is streaming. */
    readonly liveMessage: AssistantMessage | null;
    readonly appendedSlice?: WsReplayAppendedSlice;
    readonly pendingUiRequests: readonly RpcExtensionUIRequest[];
}

/** Orthogonal persisted-entry notification; carries no `seq` and never enters `EventBuffer`. */
export type WsEntriesAppendedMessage =
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
export interface WsEventMessage {
    readonly type: "event";
    readonly sessionId: SessionId;
    readonly seq: number;
    readonly event: JsonAgentSessionEvent;
}

/** A dialog or fire-and-forget notification from an extension. */
export interface WsExtensionUiRequestMessage {
    readonly type: "extension_ui_request";
    readonly sessionId: SessionId;
    readonly request: RpcExtensionUIRequest;
}

/** Tells every client to dismiss a dialog that another client already answered. */
export interface WsExtensionUiResolvedMessage {
    readonly type: "extension_ui_resolved";
    readonly sessionId: SessionId;
    readonly requestId: string;
}

/** An extension handler failed; the session continues running. */
export interface WsExtensionErrorMessage {
    readonly type: "extension_error";
    readonly sessionId: SessionId;
    readonly extensionPath: string;
    readonly event: string;
    readonly error: string;
}

/** Success or failure result for one client command, discriminated by `success`. */
export type WsResponseMessage =
    | {
          readonly type: "response";
          readonly id?: string;
          readonly command: WsCommandName;
          readonly success: true;
          readonly data?: unknown;
      }
    | {
          readonly type: "response";
          readonly id?: string;
          readonly command: WsCommandName;
          readonly success: false;
          readonly error: string;
      };

/** Protocol-level error, such as malformed JSON or an unknown command. */
export interface WsErrorMessage {
    readonly type: "error";
    readonly code?: string;
    readonly message: string;
    /** Present when the rejected input carried a command id. */
    readonly id?: string;
}

/** Messages the server sends over `/ws/sessions/:id`. */
export type WsServerMessage =
    | WsSnapshotMessage
    | WsReplayMessage
    | WsEntriesAppendedMessage
    | WsEventMessage
    | WsExtensionUiRequestMessage
    | WsExtensionUiResolvedMessage
    | WsExtensionErrorMessage
    | WsResponseMessage
    | WsErrorMessage;
