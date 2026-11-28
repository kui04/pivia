import type { QueueMode, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import type {
    AgentSession,
    ContextUsage,
    ExtensionError,
    FileEntry,
    JsonAgentSessionEvent,
    RpcCommand,
    RpcExtensionUIRequest,
    RpcExtensionUIResponse,
    RpcSessionState,
} from "@earendil-works/pi-coding-agent";

import {
    isFiniteNumber,
    isNonNegativeSafeInteger,
    isRecord,
    isStringArray,
    type JsonDecoder,
    type PatchOf,
    type StrictOmit,
} from "../shared/primitives.ts";
import { WS_CLOSE_CODE } from "../shared/ws.ts";
import {
    createSyncFrameParser,
    encodeSyncHandshakeQuery,
    parseDelivery,
    parseSyncHandshakeQuery,
    type Delivery,
    type SyncCursor,
    type SyncFrame,
    type SyncHandshake,
} from "../sync/index.ts";
import { parseFileEntryArray } from "./http.ts";
import {
    appendSessionPrefixAnchor,
    parseEntriesVersion,
    parseSessionId,
    parseSessionPrefixAnchor,
    type EntriesVersion,
    type SessionId,
    type SessionPrefixAnchor,
} from "./ids.ts";
import { parseSessionModelInfo, type SessionModelInfo } from "./summary.ts";

/** Logical clock cursor for one session stream. */
export type SessionCursor = SyncCursor<"session">;

/** Handshake parameters sent on `/ws/sessions/:id` connect and reconnect. */
export type SessionHandshake = SyncHandshake<"session", SessionPrefixAnchor>;

/** WebSocket close codes used by the session route (standard codes plus session-specific 44xx codes). */
export const SESSION_CLOSE_CODE = {
    ...WS_CLOSE_CODE,
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
/** Physical model and thinking level of the latest response under a virtual model selection. */
export interface SessionRoutedModel {
    readonly model: SessionModelInfo;
    readonly thinkingLevel?: ThinkingLevel | undefined;
}

export interface SessionStateSnapshot extends Readonly<
    StrictOmit<RpcSessionState, "model" | "sessionFile" | "sessionId" | "sessionName" | "pendingMessageCount">
> {
    readonly sessionId: SessionId;
    readonly cwd: string;
    readonly name: string | null;
    readonly model: SessionModelInfo | null;
    /** Estimated context tokens and percentage, or `null` when the SDK has no estimate yet. */
    readonly contextUsage: ContextUsage | null;
    /** Physical model behind the latest virtual-model response, or `null` for a direct selection. */
    readonly routedModel: SessionRoutedModel | null;
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
/** One extension status line set through `ctx.ui.setStatus`. */
export interface SessionUiStatus {
    readonly key: string;
    readonly text: string;
}

/** One extension widget set through `ctx.ui.setWidget`; lines render verbatim. */
export interface SessionUiWidget {
    readonly key: string;
    readonly lines: readonly string[];
    readonly placement: "aboveEditor" | "belowEditor";
}

/** Extension-owned chrome that stays with the session across reconnects. */
export interface SessionUiState {
    readonly statuses: readonly SessionUiStatus[];
    readonly widgets: readonly SessionUiWidget[];
    /** Window title set through `ctx.ui.setTitle`, or `null` when the extension set none. */
    readonly title: string | null;
}

/** Empty chrome for a session whose extensions set nothing yet. */
export const EMPTY_SESSION_UI_STATE: SessionUiState = {
    statuses: [],
    widgets: [],
    title: null,
};

/** Full or prefix-anchored session snapshot replicated over the Sync lane. */
export interface SessionSnapshot extends SessionEntrySlice {
    readonly state: SessionStateSnapshot;
    readonly liveMessage: AssistantMessage | null;
    /** Dialog requests that are still waiting for a response. */
    readonly pendingUiRequests: readonly ExtensionDialogRequest[];
    /** Extension chrome needed by late clients; the same changes also arrive as `ui_request` deltas. */
    readonly uiState: SessionUiState;
}

/**
 * Incremental patch for {@link SessionStateSnapshot} fields mutated outside `AgentSessionEvent`
 * (such as `set_model` or message count updates).
 */
export type SessionStatePatch = PatchOf<
    SessionStateSnapshot,
    | "model"
    | "messageCount"
    | "autoCompactionEnabled"
    | "steeringMode"
    | "followUpMode"
    | "contextUsage"
    | "routedModel"
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

const THINKING_LEVELS: Readonly<Record<ThinkingLevel, true>> = {
    off: true,
    minimal: true,
    low: true,
    medium: true,
    high: true,
    xhigh: true,
    max: true,
};

const QUEUE_MODES: Readonly<Record<QueueMode, true>> = {
    all: true,
    "one-at-a-time": true,
};

const SESSION_WS_COMMAND_NAMES: Readonly<Record<SessionWsCommandName, true>> = {
    prompt: true,
    steer: true,
    follow_up: true,
    abort: true,
    clear_queue: true,
    get_state: true,
    set_model: true,
    get_available_models: true,
    set_thinking_level: true,
    get_available_thinking_levels: true,
    set_session_name: true,
    compact: true,
};

function isQueueMode(value: unknown): value is QueueMode {
    return typeof value === "string" && Object.hasOwn(QUEUE_MODES, value);
}

function isSessionWsCommandName(value: unknown): value is SessionWsCommandName {
    return typeof value === "string" && Object.hasOwn(SESSION_WS_COMMAND_NAMES, value);
}

/** Returns true when `value` is a base64 image block matching the SDK {@link ImageContent} shape. */
export function isImageContent(value: unknown): value is ImageContent {
    return (
        isRecord(value) &&
        value.type === "image" &&
        typeof value.data === "string" &&
        typeof value.mimeType === "string"
    );
}

function isValidImages(value: unknown): value is ImageContent[] {
    return Array.isArray(value) && value.every(isImageContent);
}

/** Returns true when `value` is one of the known SDK {@link ThinkingLevel} literals. */
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
    return typeof value === "string" && Object.hasOwn(THINKING_LEVELS, value);
}

function withId(fields: Record<string, unknown>): { readonly id?: string } {
    return typeof fields.id === "string" ? { id: fields.id } : {};
}

/** Read a command or UI request id from unvalidated input so protocol errors can still be correlated. */
export function commandIdOf(value: unknown): string | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    if (value.type === "rpc:command" && isRecord(value.command) && typeof value.command.id === "string") {
        return value.command.id;
    }
    if (value.type === "rpc:ui_response" && isRecord(value.response) && typeof value.response.id === "string") {
        return value.response.id;
    }
    return typeof value.id === "string" ? value.id : undefined;
}

/** Parse one `extension_ui_response` payload, or return `null` when the shape is invalid. */
export function parseExtensionUiResponse(value: unknown): RpcExtensionUIResponse | null {
    if (!isRecord(value) || value.type !== "extension_ui_response" || typeof value.id !== "string") {
        return null;
    }
    if (value.cancelled === true) {
        return { type: "extension_ui_response", id: value.id, cancelled: true };
    }
    if (typeof value.confirmed === "boolean") {
        return { type: "extension_ui_response", id: value.id, confirmed: value.confirmed };
    }
    if (typeof value.value === "string") {
        return { type: "extension_ui_response", id: value.id, value: value.value };
    }
    return null;
}

/** Parse one control command payload for `rpc:command`, or return `null` when invalid. */
export function parseSessionRpcCommand(value: unknown): SessionRpcCommand | null {
    if (!isRecord(value) || typeof value.type !== "string") {
        return null;
    }
    if (value.id !== undefined && typeof value.id !== "string") {
        return null;
    }
    const id = withId(value);

    switch (value.type) {
        case "prompt": {
            if (typeof value.message !== "string" || (value.images !== undefined && !isValidImages(value.images))) {
                return null;
            }
            if (
                value.streamingBehavior !== undefined &&
                value.streamingBehavior !== "steer" &&
                value.streamingBehavior !== "followUp"
            ) {
                return null;
            }
            return {
                type: "prompt",
                ...id,
                message: value.message,
                ...(value.images === undefined ? {} : { images: value.images }),
                ...(value.streamingBehavior === undefined ? {} : { streamingBehavior: value.streamingBehavior }),
            };
        }
        case "steer":
        case "follow_up": {
            if (typeof value.message !== "string" || (value.images !== undefined && !isValidImages(value.images))) {
                return null;
            }
            const base = {
                ...id,
                message: value.message,
                ...(value.images === undefined ? {} : { images: value.images }),
            };
            return value.type === "steer" ? { type: "steer", ...base } : { type: "follow_up", ...base };
        }
        case "abort":
            return { type: "abort", ...id };
        case "clear_queue":
            return { type: "clear_queue", ...id };
        case "get_state":
            return { type: "get_state", ...id };
        case "get_available_models":
            return { type: "get_available_models", ...id };
        case "get_available_thinking_levels":
            return { type: "get_available_thinking_levels", ...id };
        case "set_model": {
            if (typeof value.provider !== "string" || typeof value.modelId !== "string") {
                return null;
            }
            return { type: "set_model", ...id, provider: value.provider, modelId: value.modelId };
        }
        case "set_thinking_level": {
            if (!isThinkingLevel(value.level)) {
                return null;
            }
            return { type: "set_thinking_level", ...id, level: value.level };
        }
        case "set_session_name": {
            if (typeof value.name !== "string") {
                return null;
            }
            return { type: "set_session_name", ...id, name: value.name };
        }
        case "compact": {
            if (value.customInstructions !== undefined && typeof value.customInstructions !== "string") {
                return null;
            }
            return {
                type: "compact",
                ...id,
                ...(value.customInstructions === undefined ? {} : { customInstructions: value.customInstructions }),
            };
        }
        default:
            return null;
    }
}

/**
 * Validate and normalize one client RPC frame (`rpc:command` or `rpc:ui_response`) from parsed JSON.
 *
 * Returns `null` for unknown types, missing fields, and invalid payloads.
 */
export function parseSessionWsClientMessage(value: unknown): SessionWsClientMessage | null {
    if (!isRecord(value) || typeof value.type !== "string") {
        return null;
    }
    if (value.type === "rpc:command") {
        const command = parseSessionRpcCommand(value.command);
        return command === null ? null : { type: "rpc:command", command };
    }
    if (value.type === "rpc:ui_response") {
        const response = parseExtensionUiResponse(value.response);
        return response === null ? null : { type: "rpc:ui_response", response };
    }
    return null;
}

/**
 * Parse `/ws/sessions/:id` handshake query parameters (`epoch`, `afterSeq`, and optional
 * `SessionPrefixAnchor`). Missing or malformed fields degrade cleanly so the server falls back to
 * a full snapshot.
 */
export function parseSessionWsHandshakeQuery(query: unknown): SessionHandshake {
    return parseSyncHandshakeQuery<"session", SessionPrefixAnchor>(query, parseSessionPrefixAnchor);
}

/** Encode `/ws/sessions/:id` handshake parameters symmetric with {@link parseSessionWsHandshakeQuery}. */
export function encodeSessionWsHandshakeQuery(handshake?: SessionHandshake): URLSearchParams {
    return encodeSyncHandshakeQuery(handshake, appendSessionPrefixAnchor);
}

function isAssistantMessage(raw: unknown): raw is AssistantMessage {
    return isRecord(raw) && raw.role === "assistant" && Array.isArray(raw.content);
}

function isJsonAgentSessionEvent(raw: unknown): raw is JsonAgentSessionEvent {
    return isRecord(raw) && typeof raw.type === "string";
}

const NOTIFY_TYPES: Readonly<Record<"info" | "warning" | "error", true>> = {
    info: true,
    warning: true,
    error: true,
};

function isNotifyType(value: unknown): value is "info" | "warning" | "error" {
    return typeof value === "string" && Object.hasOwn(NOTIFY_TYPES, value);
}

function parseOptionalWidgetPlacement(raw: unknown): "aboveEditor" | "belowEditor" | undefined | null {
    if (raw === undefined) {
        return undefined;
    }
    if (raw === "aboveEditor" || raw === "belowEditor") {
        return raw;
    }
    return null;
}

/** Parse one {@link RpcExtensionUIRequest} from untrusted JSON, or return `null` when malformed. */
export function parseRpcExtensionUiRequest(raw: unknown): RpcExtensionUIRequest | null {
    if (!isRecord(raw) || raw.type !== "extension_ui_request" || typeof raw.id !== "string") {
        return null;
    }
    switch (raw.method) {
        case "select":
        case "confirm":
        case "input":
        case "editor":
            return parseExtensionDialogRequest(raw);
        case "notify": {
            if (typeof raw.message !== "string" || (raw.notifyType !== undefined && !isNotifyType(raw.notifyType))) {
                return null;
            }
            return {
                type: "extension_ui_request",
                id: raw.id,
                method: "notify",
                message: raw.message,
                ...(raw.notifyType === undefined ? {} : { notifyType: raw.notifyType }),
            };
        }
        case "setStatus": {
            if (
                typeof raw.statusKey !== "string" ||
                (raw.statusText !== undefined && typeof raw.statusText !== "string")
            ) {
                return null;
            }
            return {
                type: "extension_ui_request",
                id: raw.id,
                method: "setStatus",
                statusKey: raw.statusKey,
                statusText: raw.statusText,
            };
        }
        case "setWidget": {
            if (
                typeof raw.widgetKey !== "string" ||
                (raw.widgetLines !== undefined && !isStringArray(raw.widgetLines))
            ) {
                return null;
            }
            const placement = parseOptionalWidgetPlacement(raw.widgetPlacement);
            if (placement === null) {
                return null;
            }
            return {
                type: "extension_ui_request",
                id: raw.id,
                method: "setWidget",
                widgetKey: raw.widgetKey,
                widgetLines: raw.widgetLines,
                ...(placement === undefined ? {} : { widgetPlacement: placement }),
            };
        }
        case "setTitle": {
            if (typeof raw.title !== "string") {
                return null;
            }
            return {
                type: "extension_ui_request",
                id: raw.id,
                method: "setTitle",
                title: raw.title,
            };
        }
        case "set_editor_text": {
            if (typeof raw.text !== "string") {
                return null;
            }
            return {
                type: "extension_ui_request",
                id: raw.id,
                method: "set_editor_text",
                text: raw.text,
            };
        }
        default:
            return null;
    }
}

function parsePendingUiRequests(raw: unknown): ExtensionDialogRequest[] | null {
    if (!Array.isArray(raw)) {
        return null;
    }
    const requests: ExtensionDialogRequest[] = [];
    for (const item of raw) {
        const dialog = parseExtensionDialogRequest(item);
        if (dialog === null) {
            return null;
        }
        requests.push(dialog);
    }
    return requests;
}

/**
 * Extension UI request that blocks its extension until a client answers.
 *
 * Derived from the SDK union so the dialog fields stay in step with the installed SDK. The wire
 * parser accepts every request method because the sync lane also carries notifications and status
 * updates; a dialog renders only these four.
 */
export type ExtensionDialogRequest = Extract<
    RpcExtensionUIRequest,
    { readonly method: "select" | "confirm" | "input" | "editor" }
>;

/** Decode one dialog request from an untrusted sync payload, or return `null` when malformed. */
export function parseExtensionDialogRequest(raw: unknown): ExtensionDialogRequest | null {
    if (!isRecord(raw) || raw.type !== "extension_ui_request" || typeof raw.id !== "string") {
        return null;
    }
    const timeout = raw.timeout;
    if (timeout !== undefined && (!isFiniteNumber(timeout) || timeout < 0)) {
        return null;
    }
    const withTimeout = timeout === undefined ? {} : { timeout };
    switch (raw.method) {
        case "select": {
            if (typeof raw.title !== "string" || !isStringArray(raw.options)) {
                return null;
            }
            return {
                type: "extension_ui_request",
                id: raw.id,
                method: "select",
                title: raw.title,
                options: raw.options,
                ...withTimeout,
            };
        }
        case "confirm": {
            if (typeof raw.title !== "string" || typeof raw.message !== "string") {
                return null;
            }
            return {
                type: "extension_ui_request",
                id: raw.id,
                method: "confirm",
                title: raw.title,
                message: raw.message,
                ...withTimeout,
            };
        }
        case "input": {
            if (
                typeof raw.title !== "string" ||
                (raw.placeholder !== undefined && typeof raw.placeholder !== "string")
            ) {
                return null;
            }
            return {
                type: "extension_ui_request",
                id: raw.id,
                method: "input",
                title: raw.title,
                ...(raw.placeholder === undefined ? {} : { placeholder: raw.placeholder }),
                ...withTimeout,
            };
        }
        case "editor": {
            if (typeof raw.title !== "string" || (raw.prefill !== undefined && typeof raw.prefill !== "string")) {
                return null;
            }
            // The SDK editor dialog has no timeout field, so an extra one is dropped instead of forwarded.
            return {
                type: "extension_ui_request",
                id: raw.id,
                method: "editor",
                title: raw.title,
                ...(raw.prefill === undefined ? {} : { prefill: raw.prefill }),
            };
        }
        default:
            return null;
    }
}

/** Decoded extension chrome command from the UI lane. */
export type SessionUiChromeRequest =
    | { readonly kind: "status"; readonly key: string; readonly text: string | undefined }
    | {
          readonly kind: "widget";
          readonly key: string;
          readonly lines: readonly string[] | undefined;
          readonly placement: "aboveEditor" | "belowEditor";
      }
    | { readonly kind: "title"; readonly title: string };

/** Decode one `setStatus`, `setWidget`, or `setTitle` request, or return `null`. */
export function parseSessionUiChromeRequest(raw: unknown): SessionUiChromeRequest | null {
    if (!isRecord(raw) || raw.type !== "extension_ui_request" || typeof raw.id !== "string") {
        return null;
    }
    switch (raw.method) {
        case "setStatus":
            if (
                typeof raw.statusKey !== "string" ||
                (raw.statusText !== undefined && typeof raw.statusText !== "string")
            ) {
                return null;
            }
            return { kind: "status", key: raw.statusKey, text: raw.statusText };
        case "setWidget": {
            if (
                typeof raw.widgetKey !== "string" ||
                (raw.widgetLines !== undefined && !isStringArray(raw.widgetLines))
            ) {
                return null;
            }
            const placement = parseOptionalWidgetPlacement(raw.widgetPlacement);
            if (placement === null) {
                return null;
            }
            return {
                kind: "widget",
                key: raw.widgetKey,
                lines: raw.widgetLines,
                placement: placement ?? "aboveEditor",
            };
        }
        case "setTitle":
            if (typeof raw.title !== "string") {
                return null;
            }
            return { kind: "title", title: raw.title };
        default:
            return null;
    }
}

/** Editor text command carried by the sync lane; it replaces the composer draft. */
export interface SetEditorTextRequest {
    readonly text: string;
}

/** Decode one `set_editor_text` command, or return `null` when the shape is invalid. */
export function parseSetEditorTextRequest(raw: unknown): SetEditorTextRequest | null {
    if (
        !isRecord(raw) ||
        raw.type !== "extension_ui_request" ||
        typeof raw.id !== "string" ||
        raw.method !== "set_editor_text" ||
        typeof raw.text !== "string"
    ) {
        return null;
    }
    return { text: raw.text };
}

function isNullableNonNegativeFinite(raw: unknown): raw is number | null {
    return raw === null || (isFiniteNumber(raw) && raw >= 0);
}

function parseNullableModelInfo(raw: unknown): SessionModelInfo | null | undefined {
    if (raw === null) {
        return null;
    }
    const parsed = parseSessionModelInfo(raw);
    return parsed === null ? undefined : parsed;
}

function parseContextUsage(raw: unknown): ContextUsage | null | undefined {
    if (raw === null) {
        return null;
    }
    if (
        !isRecord(raw) ||
        !isNullableNonNegativeFinite(raw.tokens) ||
        !isFiniteNumber(raw.contextWindow) ||
        raw.contextWindow < 0 ||
        !isNullableNonNegativeFinite(raw.percent)
    ) {
        return undefined;
    }
    return { tokens: raw.tokens, contextWindow: raw.contextWindow, percent: raw.percent };
}

function parseSessionRoutedModel(raw: unknown): SessionRoutedModel | null | undefined {
    if (raw === null) {
        return null;
    }
    if (!isRecord(raw)) {
        return undefined;
    }
    const model = parseSessionModelInfo(raw.model);
    if (model === null || (raw.thinkingLevel !== undefined && !isThinkingLevel(raw.thinkingLevel))) {
        return undefined;
    }
    return { model, ...(raw.thinkingLevel === undefined ? {} : { thinkingLevel: raw.thinkingLevel }) };
}

/** Parse one {@link SessionStateSnapshot} payload, or return `null` when malformed. */
export function parseSessionStateSnapshot(raw: unknown): SessionStateSnapshot | null {
    if (!isRecord(raw)) {
        return null;
    }
    const sessionId = parseSessionId(raw.sessionId);
    if (sessionId === null || typeof raw.cwd !== "string" || (raw.name !== null && typeof raw.name !== "string")) {
        return null;
    }
    const model = parseNullableModelInfo(raw.model);
    const contextUsage = parseContextUsage(raw.contextUsage);
    const routedModel = parseSessionRoutedModel(raw.routedModel);
    if (
        model === undefined ||
        contextUsage === undefined ||
        routedModel === undefined ||
        !isThinkingLevel(raw.thinkingLevel) ||
        typeof raw.isStreaming !== "boolean" ||
        typeof raw.isCompacting !== "boolean" ||
        !isQueueMode(raw.steeringMode) ||
        !isQueueMode(raw.followUpMode) ||
        typeof raw.autoCompactionEnabled !== "boolean" ||
        !isNonNegativeSafeInteger(raw.messageCount) ||
        !isStringArray(raw.steeringMessages) ||
        !isStringArray(raw.followUpMessages)
    ) {
        return null;
    }
    return {
        sessionId,
        cwd: raw.cwd,
        name: raw.name,
        model,
        contextUsage,
        routedModel,
        thinkingLevel: raw.thinkingLevel,
        isStreaming: raw.isStreaming,
        isCompacting: raw.isCompacting,
        steeringMode: raw.steeringMode,
        followUpMode: raw.followUpMode,
        autoCompactionEnabled: raw.autoCompactionEnabled,
        messageCount: raw.messageCount,
        steeringMessages: raw.steeringMessages,
        followUpMessages: raw.followUpMessages,
    };
}

function parseLiveMessage(raw: unknown): AssistantMessage | null | undefined {
    if (raw === null) {
        return null;
    }
    return isAssistantMessage(raw) ? raw : undefined;
}

function parseSessionEntriesHttpMeta(raw: unknown): SessionEntriesHttpMeta | null {
    if (!isRecord(raw) || !isNonNegativeSafeInteger(raw.entryCount)) {
        return null;
    }
    return { entryCount: raw.entryCount };
}

function parseSessionEntrySlice(raw: Record<string, unknown>): SessionEntrySlice | null {
    const entriesVersion = parseEntriesVersion(raw.entriesVersion);
    const entries = parseDelivery(raw.entries, parseFileEntryArray, parseSessionEntriesHttpMeta);
    if (entriesVersion === null || !isNonNegativeSafeInteger(raw.baseEntryCount) || entries === null) {
        return null;
    }
    return {
        entriesVersion,
        baseEntryCount: raw.baseEntryCount,
        entries,
    };
}

function parseSessionUiStatus(raw: unknown): SessionUiStatus | null {
    if (!isRecord(raw) || typeof raw.key !== "string" || typeof raw.text !== "string") {
        return null;
    }
    return { key: raw.key, text: raw.text };
}

function parseSessionUiWidget(raw: unknown): SessionUiWidget | null {
    if (!isRecord(raw) || typeof raw.key !== "string" || !isStringArray(raw.lines)) {
        return null;
    }
    const placement = parseOptionalWidgetPlacement(raw.placement);
    if (placement === null) {
        return null;
    }
    return {
        key: raw.key,
        lines: raw.lines,
        placement: placement ?? "aboveEditor",
    };
}

/** Parse one {@link SessionUiState} payload, or return `null` when malformed. */
export function parseSessionUiState(raw: unknown): SessionUiState | null {
    if (!isRecord(raw) || !Array.isArray(raw.statuses) || !Array.isArray(raw.widgets)) {
        return null;
    }
    if (raw.title !== null && typeof raw.title !== "string") {
        return null;
    }
    const statuses: SessionUiStatus[] = [];
    for (const item of raw.statuses) {
        const status = parseSessionUiStatus(item);
        if (status === null) {
            return null;
        }
        statuses.push(status);
    }
    const widgets: SessionUiWidget[] = [];
    for (const item of raw.widgets) {
        const widget = parseSessionUiWidget(item);
        if (widget === null) {
            return null;
        }
        widgets.push(widget);
    }
    return { statuses, widgets, title: raw.title };
}

/** Parse one {@link SessionSnapshot} payload, or return `null` when malformed. */
export function parseSessionSnapshot(raw: unknown): SessionSnapshot | null {
    if (!isRecord(raw)) {
        return null;
    }
    const slice = parseSessionEntrySlice(raw);
    const state = parseSessionStateSnapshot(raw.state);
    const liveMessage = parseLiveMessage(raw.liveMessage);
    const pendingUiRequests = parsePendingUiRequests(raw.pendingUiRequests);
    const uiState = parseSessionUiState(raw.uiState);
    if (
        slice === null ||
        state === null ||
        liveMessage === undefined ||
        pendingUiRequests === null ||
        uiState === null
    ) {
        return null;
    }
    return {
        ...slice,
        state,
        liveMessage,
        pendingUiRequests,
        uiState,
    };
}

/** Parse one {@link SessionStatePatch} payload, or return `null` when malformed or empty. */
export function parseSessionStatePatch(raw: unknown): SessionStatePatch | null {
    if (!isRecord(raw)) {
        return null;
    }
    let hasField = false;
    let model: SessionModelInfo | null | undefined;
    if (raw.model !== undefined) {
        const parsed = parseNullableModelInfo(raw.model);
        if (parsed === undefined) {
            return null;
        }
        model = parsed;
        hasField = true;
    }
    let contextUsage: ContextUsage | null | undefined;
    if (raw.contextUsage !== undefined) {
        const parsed = parseContextUsage(raw.contextUsage);
        if (parsed === undefined) {
            return null;
        }
        contextUsage = parsed;
        hasField = true;
    }
    let routedModel: SessionRoutedModel | null | undefined;
    if (raw.routedModel !== undefined) {
        const parsed = parseSessionRoutedModel(raw.routedModel);
        if (parsed === undefined) {
            return null;
        }
        routedModel = parsed;
        hasField = true;
    }
    let messageCount: number | undefined;
    if (raw.messageCount !== undefined) {
        if (!isNonNegativeSafeInteger(raw.messageCount)) {
            return null;
        }
        messageCount = raw.messageCount;
        hasField = true;
    }
    let autoCompactionEnabled: boolean | undefined;
    if (raw.autoCompactionEnabled !== undefined) {
        if (typeof raw.autoCompactionEnabled !== "boolean") {
            return null;
        }
        autoCompactionEnabled = raw.autoCompactionEnabled;
        hasField = true;
    }
    let steeringMode: QueueMode | undefined;
    if (raw.steeringMode !== undefined) {
        if (!isQueueMode(raw.steeringMode)) {
            return null;
        }
        steeringMode = raw.steeringMode;
        hasField = true;
    }
    let followUpMode: QueueMode | undefined;
    if (raw.followUpMode !== undefined) {
        if (!isQueueMode(raw.followUpMode)) {
            return null;
        }
        followUpMode = raw.followUpMode;
        hasField = true;
    }
    if (!hasField) {
        return null;
    }
    return {
        ...(model === undefined ? {} : { model }),
        ...(contextUsage === undefined ? {} : { contextUsage }),
        ...(routedModel === undefined ? {} : { routedModel }),
        ...(messageCount === undefined ? {} : { messageCount }),
        ...(autoCompactionEnabled === undefined ? {} : { autoCompactionEnabled }),
        ...(steeringMode === undefined ? {} : { steeringMode }),
        ...(followUpMode === undefined ? {} : { followUpMode }),
    };
}

/** Parse one {@link SessionDelta} payload, or return `null` when malformed. */
export function parseSessionDelta(raw: unknown): SessionDelta | null {
    if (!isRecord(raw) || typeof raw.kind !== "string") {
        return null;
    }
    switch (raw.kind) {
        case "agent_event":
            return isJsonAgentSessionEvent(raw.event) ? { kind: "agent_event", event: raw.event } : null;
        case "entries_appended": {
            const slice = parseSessionEntrySlice(raw);
            return slice === null ? null : { kind: "entries_appended", ...slice };
        }
        case "state_patched": {
            const patch = parseSessionStatePatch(raw.patch);
            return patch === null ? null : { kind: "state_patched", patch };
        }
        case "ui_request": {
            const request = parseRpcExtensionUiRequest(raw.request);
            return request === null ? null : { kind: "ui_request", request };
        }
        case "ui_resolved":
            return typeof raw.requestId === "string" && raw.requestId.length > 0
                ? { kind: "ui_resolved", requestId: raw.requestId }
                : null;
        case "extension_error":
            if (
                typeof raw.extensionPath !== "string" ||
                typeof raw.event !== "string" ||
                typeof raw.error !== "string"
            ) {
                return null;
            }
            return {
                kind: "extension_error",
                extensionPath: raw.extensionPath,
                event: raw.event,
                error: raw.error,
            };
        default:
            return null;
    }
}

function parseRpcResponseMessage(raw: Record<string, unknown>): SessionRpcServerMessage | null {
    if (raw.id !== undefined && typeof raw.id !== "string") {
        return null;
    }
    if (!isSessionWsCommandName(raw.command)) {
        return null;
    }
    const idField = typeof raw.id === "string" ? { id: raw.id } : {};
    if (raw.success === true) {
        return {
            type: "rpc:response",
            ...idField,
            command: raw.command,
            success: true,
            ...(raw.data === undefined ? {} : { data: raw.data }),
        };
    }
    if (raw.success === false && typeof raw.error === "string") {
        return {
            type: "rpc:response",
            ...idField,
            command: raw.command,
            success: false,
            error: raw.error,
        };
    }
    return null;
}

function parseRpcErrorMessage(raw: Record<string, unknown>): SessionRpcServerMessage | null {
    if (
        typeof raw.message !== "string" ||
        (raw.code !== undefined && typeof raw.code !== "string") ||
        (raw.id !== undefined && typeof raw.id !== "string")
    ) {
        return null;
    }
    return {
        type: "rpc:error",
        ...(typeof raw.code === "string" ? { code: raw.code } : {}),
        message: raw.message,
        ...(typeof raw.id === "string" ? { id: raw.id } : {}),
    };
}

/** Decoder for {@link SessionSyncFrame} envelopes on the `/ws/sessions/:id` Sync lane. */
export const parseSessionSyncFrame: JsonDecoder<SessionSyncFrame> = createSyncFrameParser<
    "session",
    SessionSnapshot,
    SessionDelta
>({
    parseSnapshot: parseSessionSnapshot,
    parseDelta: parseSessionDelta,
});

/**
 * Parse one server-sent `/ws/sessions/:id` WebSocket message from untrusted JSON, or return `null`
 * when malformed or unknown.
 */
export function parseSessionWsServerMessage(raw: unknown): SessionWsServerMessage | null {
    if (!isRecord(raw) || typeof raw.type !== "string") {
        return null;
    }
    if (raw.type.startsWith("sync:")) {
        return parseSessionSyncFrame(raw);
    }
    switch (raw.type) {
        case "rpc:response":
            return parseRpcResponseMessage(raw);
        case "rpc:error":
            return parseRpcErrorMessage(raw);
        default:
            return null;
    }
}
