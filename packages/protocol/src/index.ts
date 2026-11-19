import type { QueueMode, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
    AgentSession,
    FileEntry,
    JsonAgentSessionEvent,
    RpcCommand,
    RpcExtensionUIRequest,
    RpcExtensionUIResponse,
    RpcResponse,
} from "@earendil-works/pi-coding-agent";

export type { QueueMode, ThinkingLevel } from "@earendil-works/pi-agent-core";
export type { ImageContent } from "@earendil-works/pi-ai";
export type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "@earendil-works/pi-coding-agent";

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
    readonly id: string;
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

/** Response payload returned by `GET /api/sessions/:id`. */
export interface SessionDetailResponse {
    readonly session: SessionSummary;
    /** Session entries with the header first; live sessions return in-memory entries. */
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
    readonly sessionId: string;
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

/** One session event with its monotonic replay sequence number. */
export interface SequencedSessionEvent {
    readonly seq: number;
    readonly event: JsonAgentSessionEvent;
}

/** Initial state sent after a connection cannot be replayed incrementally. */
export interface WsSnapshotMessage {
    readonly type: "snapshot";
    readonly sessionId: string;
    readonly seq: number;
    readonly state: SessionStateSnapshot;
    readonly entries: readonly FileEntry[];
    /** Dialog requests that are still waiting for a response. */
    readonly pendingUiRequests: readonly RpcExtensionUIRequest[];
}

/** Incremental resend after a reconnect that asks for events after `afterSeq`. */
export interface WsReplayMessage {
    readonly type: "replay";
    readonly sessionId: string;
    readonly seq: number;
    readonly state: SessionStateSnapshot;
    readonly events: readonly SequencedSessionEvent[];
    readonly pendingUiRequests: readonly RpcExtensionUIRequest[];
}

/** One live session event. */
export interface WsEventMessage {
    readonly type: "event";
    readonly sessionId: string;
    readonly seq: number;
    readonly event: JsonAgentSessionEvent;
}

/** A dialog or fire-and-forget notification from an extension. */
export interface WsExtensionUiRequestMessage {
    readonly type: "extension_ui_request";
    readonly sessionId: string;
    readonly request: RpcExtensionUIRequest;
}

/** Tells every client to dismiss a dialog that another client already answered. */
export interface WsExtensionUiResolvedMessage {
    readonly type: "extension_ui_resolved";
    readonly sessionId: string;
    readonly requestId: string;
}

/** An extension handler failed; the session continues running. */
export interface WsExtensionErrorMessage {
    readonly type: "extension_error";
    readonly sessionId: string;
    readonly extensionPath: string;
    readonly event: string;
    readonly error: string;
}

/** Success or failure result for one client command. */
export interface WsResponseMessage {
    readonly type: "response";
    readonly id?: string;
    readonly command: string;
    readonly success: boolean;
    readonly data?: unknown;
    readonly error?: string;
}

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
    | WsEventMessage
    | WsExtensionUiRequestMessage
    | WsExtensionUiResolvedMessage
    | WsExtensionErrorMessage
    | WsResponseMessage
    | WsErrorMessage;
