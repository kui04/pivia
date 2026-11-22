import type { QueueMode } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { FileEntry, JsonAgentSessionEvent, RpcExtensionUIRequest } from "@earendil-works/pi-coding-agent";

import type {
    AuthLoginResponse,
    AuthLogoutResponse,
    AuthStatusResponse,
    CloseSessionResponse,
    CreateSessionResponse,
    DirectoryListResponse,
    HealthResponse,
    SessionDetailResponse,
    SessionListResponse,
    SessionModelInfo,
    SessionRuntimeState,
    SessionSummary,
} from "../http.ts";
import type {
    SequencedSessionEvent,
    SessionStateSnapshot,
    SessionWsCommandName,
    SessionWsEntriesAppendedMessage,
    SessionWsErrorMessage,
    SessionWsEventMessage,
    SessionWsExtensionErrorMessage,
    SessionWsExtensionUiRequestMessage,
    SessionWsExtensionUiResolvedMessage,
    SessionWsReplayAppendedSlice,
    SessionWsReplayMessage,
    SessionWsResponseMessage,
    SessionWsServerMessage,
    SessionWsSnapshotMessage,
} from "../session-ws.ts";
import type { SessionSummaryPatch, WorkspaceWsServerMessage } from "../workspace-ws.ts";
import { parseCatalogEpoch, parseCatalogSeq } from "./catalog.ts";
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

function isSessionWsCommandName(value: unknown): value is SessionWsCommandName {
    return typeof value === "string" && Object.hasOwn(SESSION_WS_COMMAND_NAMES, value);
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

/**
 * Parse one {@link SessionSummaryPatch} payload, or return `null` when malformed or empty.
 *
 * Only mutable summary fields are accepted; unknown fields are ignored for forward compatibility,
 * and an empty patch with no recognized mutable fields is rejected.
 */
export function parseSessionSummaryPatch(raw: unknown): SessionSummaryPatch | null {
    if (!isRecord(raw)) {
        return null;
    }
    const patch: {
        name?: string | null;
        firstMessage?: string;
        messageCount?: number;
        modifiedAtMs?: number;
        runtimeState?: SessionRuntimeState;
        attachedClients?: number;
    } = {};
    let hasField = false;

    if (raw.name !== undefined) {
        if (raw.name !== null && typeof raw.name !== "string") {
            return null;
        }
        patch.name = raw.name;
        hasField = true;
    }
    if (raw.firstMessage !== undefined) {
        if (typeof raw.firstMessage !== "string") {
            return null;
        }
        patch.firstMessage = raw.firstMessage;
        hasField = true;
    }
    if (raw.messageCount !== undefined) {
        if (!isNonNegativeSafeInteger(raw.messageCount)) {
            return null;
        }
        patch.messageCount = raw.messageCount;
        hasField = true;
    }
    if (raw.modifiedAtMs !== undefined) {
        if (!isFiniteNumber(raw.modifiedAtMs)) {
            return null;
        }
        patch.modifiedAtMs = raw.modifiedAtMs;
        hasField = true;
    }
    if (raw.runtimeState !== undefined) {
        if (!isSessionRuntimeState(raw.runtimeState)) {
            return null;
        }
        patch.runtimeState = raw.runtimeState;
        hasField = true;
    }
    if (raw.attachedClients !== undefined) {
        if (!isNonNegativeSafeInteger(raw.attachedClients)) {
            return null;
        }
        patch.attachedClients = raw.attachedClients;
        hasField = true;
    }

    return hasField ? patch : null;
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
    const catalogEpoch = parseCatalogEpoch(raw.catalogEpoch);
    const catalogSeq = parseCatalogSeq(raw.catalogSeq);
    if (catalogEpoch === null || catalogSeq === null) {
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
    return { sessions, scannedAtMs: raw.scannedAtMs, catalogEpoch, catalogSeq };
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

/** Parse a `GET /api/fs/directories` payload. */
export function parseDirectoryListResponse(raw: unknown): DirectoryListResponse | null {
    if (
        !isRecord(raw) ||
        typeof raw.path !== "string" ||
        raw.path.length === 0 ||
        (raw.parent !== null && typeof raw.parent !== "string") ||
        !isStringArray(raw.directories) ||
        typeof raw.truncated !== "boolean"
    ) {
        return null;
    }
    return {
        path: raw.path,
        parent: raw.parent,
        directories: raw.directories,
        truncated: raw.truncated,
    };
}

function parseLiveMessage(raw: unknown): AssistantMessage | null | undefined {
    if (raw === null) {
        return null;
    }
    return isAssistantMessage(raw) ? raw : undefined;
}

function parseSnapshotMessage(raw: Record<string, unknown>): SessionWsSnapshotMessage | null {
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

function parseReplayAppendedSlice(raw: unknown): SessionWsReplayAppendedSlice | null {
    if (!isRecord(raw) || !isNonNegativeSafeInteger(raw.baseEntryCount)) {
        return null;
    }
    const entries = parseFileEntryArray(raw.entries);
    return entries === null ? null : { baseEntryCount: raw.baseEntryCount, entries };
}

function parseReplayMessage(raw: Record<string, unknown>): SessionWsReplayMessage | null {
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
    let appendedSlice: SessionWsReplayAppendedSlice | undefined;
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

function parseEntriesAppendedMessage(raw: Record<string, unknown>): SessionWsEntriesAppendedMessage | null {
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

function parseEventMessage(raw: Record<string, unknown>): SessionWsEventMessage | null {
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

function parseExtensionUiRequestMessage(raw: Record<string, unknown>): SessionWsExtensionUiRequestMessage | null {
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

function parseExtensionUiResolvedMessage(raw: Record<string, unknown>): SessionWsExtensionUiResolvedMessage | null {
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

function parseExtensionErrorMessage(raw: Record<string, unknown>): SessionWsExtensionErrorMessage | null {
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

function parseResponseMessage(raw: Record<string, unknown>): SessionWsResponseMessage | null {
    if (raw.id !== undefined && typeof raw.id !== "string") {
        return null;
    }
    if (!isSessionWsCommandName(raw.command)) {
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

function parseErrorMessage(raw: Record<string, unknown>): SessionWsErrorMessage | null {
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
 * Parse one server-sent `/ws/sessions/:id` WebSocket message from untrusted JSON, or return `null`
 * when malformed or unknown.
 */
export function parseSessionWsServerMessage(raw: unknown): SessionWsServerMessage | null {
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

/**
 * Parse one server-sent `/ws/workspace` message from untrusted JSON, or return `null` when
 * malformed or unknown.
 */
export function parseWorkspaceWsServerMessage(raw: unknown): WorkspaceWsServerMessage | null {
    if (!isRecord(raw) || typeof raw.type !== "string") {
        return null;
    }
    switch (raw.type) {
        case "catalog_snapshot": {
            if (!Array.isArray(raw.sessions) || !isFiniteNumber(raw.updatedAtMs)) {
                return null;
            }
            const catalogEpoch = parseCatalogEpoch(raw.catalogEpoch);
            const catalogSeq = parseCatalogSeq(raw.catalogSeq);
            if (catalogEpoch === null || catalogSeq === null) {
                return null;
            }
            const sessions: SessionSummary[] = [];
            for (const entry of raw.sessions) {
                const parsed = parseSessionSummary(entry);
                if (parsed === null) {
                    return null;
                }
                sessions.push(parsed);
            }
            return {
                type: "catalog_snapshot",
                sessions,
                updatedAtMs: raw.updatedAtMs,
                catalogEpoch,
                catalogSeq,
            };
        }
        case "session_upserted": {
            const catalogEpoch = parseCatalogEpoch(raw.catalogEpoch);
            const seq = parseCatalogSeq(raw.seq);
            const session = parseSessionSummary(raw.session);
            if (catalogEpoch === null || seq === null || session === null) {
                return null;
            }
            return {
                type: "session_upserted",
                catalogEpoch,
                seq,
                session,
            };
        }
        case "session_updated": {
            const catalogEpoch = parseCatalogEpoch(raw.catalogEpoch);
            const seq = parseCatalogSeq(raw.seq);
            const sessionId = parseSessionId(raw.sessionId);
            const patch = parseSessionSummaryPatch(raw.patch);
            if (catalogEpoch === null || seq === null || sessionId === null || patch === null) {
                return null;
            }
            return {
                type: "session_updated",
                catalogEpoch,
                seq,
                sessionId,
                patch,
            };
        }
        case "session_removed": {
            const catalogEpoch = parseCatalogEpoch(raw.catalogEpoch);
            const seq = parseCatalogSeq(raw.seq);
            const sessionId = parseSessionId(raw.sessionId);
            if (catalogEpoch === null || seq === null || sessionId === null) {
                return null;
            }
            return {
                type: "session_removed",
                catalogEpoch,
                seq,
                sessionId,
            };
        }
        default:
            return null;
    }
}
