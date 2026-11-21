import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";

import type {
    AssistantMessage,
    AuthLoginResponse,
    AuthLogoutResponse,
    AuthStatusResponse,
    CloseSessionResponse,
    CreateSessionResponse,
    FileEntry,
    HealthResponse,
    QueueMode,
    RpcExtensionUIRequest,
    SequencedSessionEvent,
    SessionDetailResponse,
    SessionListResponse,
    SessionModelInfo,
    SessionRuntimeState,
    SessionStateSnapshot,
    SessionSummary,
    WsCommandName,
    WsEntriesAppendedMessage,
    WsErrorMessage,
    WsEventMessage,
    WsExtensionErrorMessage,
    WsExtensionUiRequestMessage,
    WsExtensionUiResolvedMessage,
    WsReplayAppendedSlice,
    WsReplayMessage,
    WsResponseMessage,
    WsServerMessage,
    WsSnapshotMessage,
} from "../index.ts";
import { isRecord } from "./primitives.ts";
import { parseEntriesVersion, parseSessionId } from "./session.ts";
import { isThinkingLevel } from "./ws.ts";

/** Decoder function for validating untrusted JSON payloads at a trust boundary. */
export type JsonDecoder<T> = (raw: unknown) => T | null;

const SESSION_RUNTIME_STATES: Readonly<Record<SessionRuntimeState, true>> = {
    starting: true,
    idle: true,
    streaming: true,
    compacting: true,
    closing: true,
};

const QUEUE_MODES: Readonly<Record<QueueMode, true>> = {
    all: true,
    "one-at-a-time": true,
};

const WS_COMMAND_NAMES: Readonly<Record<WsCommandName, true>> = {
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

function isNonNegativeSafeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isSessionRuntimeState(value: unknown): value is SessionRuntimeState {
    return typeof value === "string" && Object.hasOwn(SESSION_RUNTIME_STATES, value);
}

function isQueueMode(value: unknown): value is QueueMode {
    return typeof value === "string" && Object.hasOwn(QUEUE_MODES, value);
}

function isWsCommandName(value: unknown): value is WsCommandName {
    return typeof value === "string" && Object.hasOwn(WS_COMMAND_NAMES, value);
}

/**
 * Narrow an untrusted value to a minimal SDK {@link FileEntry} record.
 *
 * Pre-migration v1 session entries on disk omit `id`, so only the object shape and string `type`
 * discriminant are required here.
 */
export function isFileEntryRecord(value: unknown): value is FileEntry {
    return isRecord(value) && typeof value.type === "string";
}

function parseFileEntryArray(raw: unknown): FileEntry[] | null {
    if (!Array.isArray(raw)) {
        return null;
    }
    const entries: FileEntry[] = [];
    for (const item of raw) {
        if (!isFileEntryRecord(item)) {
            return null;
        }
        entries.push(item);
    }
    return entries;
}

// Single-point SDK boundary guards: check the runtime discriminants consumed by the UI/stores
// without duplicating the entire upstream SDK AST schema.
function isAssistantMessage(raw: unknown): raw is AssistantMessage {
    return isRecord(raw) && raw.role === "assistant" && Array.isArray(raw.content);
}

function isJsonAgentSessionEvent(raw: unknown): raw is JsonAgentSessionEvent {
    return isRecord(raw) && typeof raw.type === "string";
}

function isSequencedSessionEvent(raw: unknown): raw is SequencedSessionEvent {
    return isRecord(raw) && isNonNegativeSafeInteger(raw.seq) && isJsonAgentSessionEvent(raw.event);
}

function isRpcExtensionUiRequest(raw: unknown): raw is RpcExtensionUIRequest {
    return (
        isRecord(raw) &&
        raw.type === "extension_ui_request" &&
        typeof raw.id === "string" &&
        typeof raw.method === "string"
    );
}

function parsePendingUiRequests(raw: unknown): RpcExtensionUIRequest[] | null {
    if (!Array.isArray(raw)) {
        return null;
    }
    const requests: RpcExtensionUIRequest[] = [];
    for (const item of raw) {
        if (!isRpcExtensionUiRequest(item)) {
            return null;
        }
        requests.push(item);
    }
    return requests;
}

/** Parse one {@link SessionSummary} payload, or return `null` when malformed. */
export function parseSessionSummary(raw: unknown): SessionSummary | null {
    if (!isRecord(raw)) {
        return null;
    }
    const id = parseSessionId(raw.id);
    if (
        id === null ||
        typeof raw.cwd !== "string" ||
        (raw.name !== null && typeof raw.name !== "string") ||
        typeof raw.firstMessage !== "string" ||
        !isNonNegativeSafeInteger(raw.messageCount) ||
        !isFiniteNumber(raw.createdAtMs) ||
        !isFiniteNumber(raw.modifiedAtMs) ||
        typeof raw.hasParent !== "boolean" ||
        !isSessionRuntimeState(raw.runtimeState) ||
        !isNonNegativeSafeInteger(raw.attachedClients)
    ) {
        return null;
    }
    return {
        id,
        cwd: raw.cwd,
        name: raw.name,
        firstMessage: raw.firstMessage,
        messageCount: raw.messageCount,
        createdAtMs: raw.createdAtMs,
        modifiedAtMs: raw.modifiedAtMs,
        hasParent: raw.hasParent,
        runtimeState: raw.runtimeState,
        attachedClients: raw.attachedClients,
    };
}

/** Parse one {@link SessionModelInfo} payload, or return `null` when malformed. */
export function parseSessionModelInfo(raw: unknown): SessionModelInfo | null {
    if (
        !isRecord(raw) ||
        typeof raw.provider !== "string" ||
        typeof raw.id !== "string" ||
        typeof raw.name !== "string"
    ) {
        return null;
    }
    return { provider: raw.provider, id: raw.id, name: raw.name };
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
    let model: SessionModelInfo | null;
    if (raw.model === null) {
        model = null;
    } else {
        const parsedModel = parseSessionModelInfo(raw.model);
        if (parsedModel === null) {
            return null;
        }
        model = parsedModel;
    }
    if (
        !isThinkingLevel(raw.thinkingLevel) ||
        typeof raw.isStreaming !== "boolean" ||
        typeof raw.isCompacting !== "boolean" ||
        !isQueueMode(raw.steeringMode) ||
        !isQueueMode(raw.followUpMode) ||
        typeof raw.autoCompactionEnabled !== "boolean" ||
        !isNonNegativeSafeInteger(raw.messageCount) ||
        !isNonNegativeSafeInteger(raw.pendingMessageCount) ||
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
        thinkingLevel: raw.thinkingLevel,
        isStreaming: raw.isStreaming,
        isCompacting: raw.isCompacting,
        steeringMode: raw.steeringMode,
        followUpMode: raw.followUpMode,
        autoCompactionEnabled: raw.autoCompactionEnabled,
        messageCount: raw.messageCount,
        pendingMessageCount: raw.pendingMessageCount,
        steeringMessages: raw.steeringMessages,
        followUpMessages: raw.followUpMessages,
    };
}

/** Parse a `GET /api/health` payload. */
export function parseHealthResponse(raw: unknown): HealthResponse | null {
    if (!isRecord(raw) || raw.status !== "ok" || typeof raw.version !== "string") {
        return null;
    }
    return { status: "ok", version: raw.version };
}

/** Parse a `GET /api/auth/status` payload. */
export function parseAuthStatusResponse(raw: unknown): AuthStatusResponse | null {
    if (!isRecord(raw) || typeof raw.authRequired !== "boolean" || typeof raw.authenticated !== "boolean") {
        return null;
    }
    return { authRequired: raw.authRequired, authenticated: raw.authenticated };
}

/** Parse a `POST /api/auth` payload. */
export function parseAuthLoginResponse(raw: unknown): AuthLoginResponse | null {
    return isRecord(raw) && raw.authenticated === true ? { authenticated: true } : null;
}

/** Parse a `POST /api/auth/logout` payload. */
export function parseAuthLogoutResponse(raw: unknown): AuthLogoutResponse | null {
    return isRecord(raw) && raw.authenticated === false ? { authenticated: false } : null;
}

/** Parse a `GET /api/sessions` payload. */
export function parseSessionListResponse(raw: unknown): SessionListResponse | null {
    if (!isRecord(raw) || !Array.isArray(raw.sessions) || !isFiniteNumber(raw.scannedAtMs)) {
        return null;
    }
    const sessions: SessionSummary[] = [];
    for (const item of raw.sessions) {
        const parsed = parseSessionSummary(item);
        if (parsed === null) {
            return null;
        }
        sessions.push(parsed);
    }
    return { sessions, scannedAtMs: raw.scannedAtMs };
}

/** Parse a `GET /api/sessions/:id` payload. */
export function parseSessionDetailResponse(raw: unknown): SessionDetailResponse | null {
    if (!isRecord(raw)) {
        return null;
    }
    const session = parseSessionSummary(raw.session);
    if (session === null || !isNonNegativeSafeInteger(raw.baseEntryCount)) {
        return null;
    }
    const entriesVersion = raw.entriesVersion === null ? null : parseEntriesVersion(raw.entriesVersion);
    if (raw.entriesVersion !== null && entriesVersion === null) {
        return null;
    }
    const entries = parseFileEntryArray(raw.entries);
    if (entries === null) {
        return null;
    }
    return {
        session,
        entriesVersion,
        baseEntryCount: raw.baseEntryCount,
        entries,
    };
}

/** Parse a `POST /api/sessions` payload. */
export function parseCreateSessionResponse(raw: unknown): CreateSessionResponse | null {
    if (!isRecord(raw)) {
        return null;
    }
    const session = parseSessionSummary(raw.session);
    return session === null ? null : { session };
}

/** Parse a `POST /api/sessions/:id/close` payload. */
export function parseCloseSessionResponse(raw: unknown): CloseSessionResponse | null {
    if (!isRecord(raw) || typeof raw.closed !== "boolean") {
        return null;
    }
    return { closed: raw.closed };
}

function parseLiveMessage(raw: unknown): AssistantMessage | null | undefined {
    if (raw === null) {
        return null;
    }
    return isAssistantMessage(raw) ? raw : undefined;
}

function parseSnapshotMessage(raw: Record<string, unknown>): WsSnapshotMessage | null {
    const sessionId = parseSessionId(raw.sessionId);
    const entriesVersion = parseEntriesVersion(raw.entriesVersion);
    const state = parseSessionStateSnapshot(raw.state);
    const liveMessage = parseLiveMessage(raw.liveMessage);
    const pendingUiRequests = parsePendingUiRequests(raw.pendingUiRequests);
    if (
        sessionId === null ||
        typeof raw.runtimeId !== "string" ||
        raw.runtimeId.length === 0 ||
        !isNonNegativeSafeInteger(raw.seq) ||
        entriesVersion === null ||
        !isNonNegativeSafeInteger(raw.baseEntryCount) ||
        state === null ||
        liveMessage === undefined ||
        pendingUiRequests === null
    ) {
        return null;
    }
    if (raw.entriesMode === "inline") {
        const entries = parseFileEntryArray(raw.entries);
        if (entries === null) {
            return null;
        }
        return {
            type: "snapshot",
            sessionId,
            runtimeId: raw.runtimeId,
            seq: raw.seq,
            entriesVersion,
            baseEntryCount: raw.baseEntryCount,
            entriesMode: "inline",
            entries,
            state,
            liveMessage,
            pendingUiRequests,
        };
    }
    if (raw.entriesMode === "http" && isNonNegativeSafeInteger(raw.entryCount)) {
        return {
            type: "snapshot",
            sessionId,
            runtimeId: raw.runtimeId,
            seq: raw.seq,
            entriesVersion,
            baseEntryCount: raw.baseEntryCount,
            entriesMode: "http",
            entryCount: raw.entryCount,
            state,
            liveMessage,
            pendingUiRequests,
        };
    }
    return null;
}

function parseReplayAppendedSlice(raw: unknown): WsReplayAppendedSlice | null {
    if (!isRecord(raw) || !isNonNegativeSafeInteger(raw.baseEntryCount)) {
        return null;
    }
    const entries = parseFileEntryArray(raw.entries);
    return entries === null ? null : { baseEntryCount: raw.baseEntryCount, entries };
}

function parseReplayMessage(raw: Record<string, unknown>): WsReplayMessage | null {
    const sessionId = parseSessionId(raw.sessionId);
    const entriesVersion = parseEntriesVersion(raw.entriesVersion);
    const state = parseSessionStateSnapshot(raw.state);
    const liveMessage = parseLiveMessage(raw.liveMessage);
    const pendingUiRequests = parsePendingUiRequests(raw.pendingUiRequests);
    if (
        sessionId === null ||
        typeof raw.runtimeId !== "string" ||
        raw.runtimeId.length === 0 ||
        !isNonNegativeSafeInteger(raw.seq) ||
        entriesVersion === null ||
        state === null ||
        !Array.isArray(raw.events) ||
        liveMessage === undefined ||
        pendingUiRequests === null
    ) {
        return null;
    }
    const events: SequencedSessionEvent[] = [];
    for (const item of raw.events) {
        if (!isSequencedSessionEvent(item)) {
            return null;
        }
        events.push(item);
    }
    let appendedSlice: WsReplayAppendedSlice | undefined;
    if (raw.appendedSlice !== undefined) {
        const parsedSlice = parseReplayAppendedSlice(raw.appendedSlice);
        if (parsedSlice === null) {
            return null;
        }
        appendedSlice = parsedSlice;
    }
    return {
        type: "replay",
        sessionId,
        runtimeId: raw.runtimeId,
        seq: raw.seq,
        entriesVersion,
        state,
        events,
        liveMessage,
        ...(appendedSlice === undefined ? {} : { appendedSlice }),
        pendingUiRequests,
    };
}

function parseEntriesAppendedMessage(raw: Record<string, unknown>): WsEntriesAppendedMessage | null {
    const sessionId = parseSessionId(raw.sessionId);
    const entriesVersion = parseEntriesVersion(raw.entriesVersion);
    if (sessionId === null || entriesVersion === null || !isNonNegativeSafeInteger(raw.baseEntryCount)) {
        return null;
    }
    if (raw.entriesMode === "inline") {
        const entries = parseFileEntryArray(raw.entries);
        if (entries === null) {
            return null;
        }
        return {
            type: "entries_appended",
            sessionId,
            entriesVersion,
            entriesMode: "inline",
            baseEntryCount: raw.baseEntryCount,
            entries,
        };
    }
    if (raw.entriesMode === "http" && isNonNegativeSafeInteger(raw.entryCount)) {
        return {
            type: "entries_appended",
            sessionId,
            entriesVersion,
            entriesMode: "http",
            baseEntryCount: raw.baseEntryCount,
            entryCount: raw.entryCount,
        };
    }
    return null;
}

function parseEventMessage(raw: Record<string, unknown>): WsEventMessage | null {
    const sessionId = parseSessionId(raw.sessionId);
    if (sessionId === null || !isNonNegativeSafeInteger(raw.seq) || !isJsonAgentSessionEvent(raw.event)) {
        return null;
    }
    return {
        type: "event",
        sessionId,
        seq: raw.seq,
        event: raw.event,
    };
}

function parseExtensionUiRequestMessage(raw: Record<string, unknown>): WsExtensionUiRequestMessage | null {
    const sessionId = parseSessionId(raw.sessionId);
    if (sessionId === null || !isRpcExtensionUiRequest(raw.request)) {
        return null;
    }
    return {
        type: "extension_ui_request",
        sessionId,
        request: raw.request,
    };
}

function parseExtensionUiResolvedMessage(raw: Record<string, unknown>): WsExtensionUiResolvedMessage | null {
    const sessionId = parseSessionId(raw.sessionId);
    if (sessionId === null || typeof raw.requestId !== "string") {
        return null;
    }
    return {
        type: "extension_ui_resolved",
        sessionId,
        requestId: raw.requestId,
    };
}

function parseExtensionErrorMessage(raw: Record<string, unknown>): WsExtensionErrorMessage | null {
    const sessionId = parseSessionId(raw.sessionId);
    if (
        sessionId === null ||
        typeof raw.extensionPath !== "string" ||
        typeof raw.event !== "string" ||
        typeof raw.error !== "string"
    ) {
        return null;
    }
    return {
        type: "extension_error",
        sessionId,
        extensionPath: raw.extensionPath,
        event: raw.event,
        error: raw.error,
    };
}

function parseResponseMessage(raw: Record<string, unknown>): WsResponseMessage | null {
    if (raw.id !== undefined && typeof raw.id !== "string") {
        return null;
    }
    if (!isWsCommandName(raw.command)) {
        return null;
    }
    const idField = typeof raw.id === "string" ? { id: raw.id } : {};
    if (raw.success === true) {
        return {
            type: "response",
            ...idField,
            command: raw.command,
            success: true,
            ...(raw.data === undefined ? {} : { data: raw.data }),
        };
    }
    if (raw.success === false && typeof raw.error === "string") {
        return {
            type: "response",
            ...idField,
            command: raw.command,
            success: false,
            error: raw.error,
        };
    }
    return null;
}

function parseErrorMessage(raw: Record<string, unknown>): WsErrorMessage | null {
    if (
        typeof raw.message !== "string" ||
        (raw.code !== undefined && typeof raw.code !== "string") ||
        (raw.id !== undefined && typeof raw.id !== "string")
    ) {
        return null;
    }
    return {
        type: "error",
        ...(typeof raw.code === "string" ? { code: raw.code } : {}),
        message: raw.message,
        ...(typeof raw.id === "string" ? { id: raw.id } : {}),
    };
}

/**
 * Parse one server-sent WebSocket message from untrusted JSON, or return `null` when malformed or
 * unknown.
 */
export function parseWsServerMessage(raw: unknown): WsServerMessage | null {
    if (!isRecord(raw) || typeof raw.type !== "string") {
        return null;
    }
    switch (raw.type) {
        case "snapshot":
            return parseSnapshotMessage(raw);
        case "replay":
            return parseReplayMessage(raw);
        case "entries_appended":
            return parseEntriesAppendedMessage(raw);
        case "event":
            return parseEventMessage(raw);
        case "extension_ui_request":
            return parseExtensionUiRequestMessage(raw);
        case "extension_ui_resolved":
            return parseExtensionUiResolvedMessage(raw);
        case "extension_error":
            return parseExtensionErrorMessage(raw);
        case "response":
            return parseResponseMessage(raw);
        case "error":
            return parseErrorMessage(raw);
        default:
            return null;
    }
}
