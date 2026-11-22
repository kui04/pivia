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
    SessionDelta,
    SessionEntriesHttpMeta,
    SessionRpcServerMessage,
    SessionSnapshot,
    SessionStatePatch,
    SessionStateSnapshot,
    SessionSyncFrame,
    SessionWsCommandName,
    SessionWsServerMessage,
} from "../session-ws.ts";
import { createSyncFrameParser, parseDelivery, type JsonDecoder } from "../sync/index.ts";
import type { CatalogDelta, CatalogSnapshot, SessionSummaryPatch, WorkspaceWsServerMessage } from "../workspace-ws.ts";
import { parseCatalogEpoch, parseCatalogSeq } from "./catalog.ts";
import { isRecord } from "./primitives.ts";
import { parseEntriesVersion, parseSessionId } from "./session.ts";
import { isThinkingLevel } from "./ws.ts";

export type { JsonDecoder };

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

function parseSessionEntriesHttpMeta(raw: unknown): SessionEntriesHttpMeta | null {
    if (!isRecord(raw) || !isNonNegativeSafeInteger(raw.entryCount)) {
        return null;
    }
    return { entryCount: raw.entryCount };
}

/** Parse one {@link SessionSnapshot} payload, or return `null` when malformed. */
export function parseSessionSnapshot(raw: unknown): SessionSnapshot | null {
    if (!isRecord(raw)) {
        return null;
    }
    const entriesVersion = parseEntriesVersion(raw.entriesVersion);
    const entries = parseDelivery(raw.entries, parseFileEntryArray, parseSessionEntriesHttpMeta);
    const state = parseSessionStateSnapshot(raw.state);
    const liveMessage = parseLiveMessage(raw.liveMessage);
    const pendingUiRequests = parsePendingUiRequests(raw.pendingUiRequests);
    if (
        entriesVersion === null ||
        !isNonNegativeSafeInteger(raw.baseEntryCount) ||
        entries === null ||
        state === null ||
        liveMessage === undefined ||
        pendingUiRequests === null
    ) {
        return null;
    }
    return {
        entriesVersion,
        baseEntryCount: raw.baseEntryCount,
        entries,
        state,
        liveMessage,
        pendingUiRequests,
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
        if (raw.model === null) {
            model = null;
        } else {
            const parsedModel = parseSessionModelInfo(raw.model);
            if (parsedModel === null) {
                return null;
            }
            model = parsedModel;
        }
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
            const entriesVersion = parseEntriesVersion(raw.entriesVersion);
            const entries = parseDelivery(raw.entries, parseFileEntryArray, parseSessionEntriesHttpMeta);
            if (entriesVersion === null || !isNonNegativeSafeInteger(raw.baseEntryCount) || entries === null) {
                return null;
            }
            return {
                kind: "entries_appended",
                entriesVersion,
                baseEntryCount: raw.baseEntryCount,
                entries,
            };
        }
        case "state_patched": {
            const patch = parseSessionStatePatch(raw.patch);
            return patch === null ? null : { kind: "state_patched", patch };
        }
        case "ui_request":
            return isRpcExtensionUiRequest(raw.request) ? { kind: "ui_request", request: raw.request } : null;
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

/** Parse one {@link CatalogSnapshot} payload, or return `null` when malformed. */
export function parseCatalogSnapshot(raw: unknown): CatalogSnapshot | null {
    if (!isRecord(raw) || !Array.isArray(raw.sessions) || !isFiniteNumber(raw.updatedAtMs)) {
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
    return { sessions, updatedAtMs: raw.updatedAtMs };
}

/** Parse one {@link CatalogDelta} payload, or return `null` when malformed. */
export function parseCatalogDelta(raw: unknown): CatalogDelta | null {
    if (!isRecord(raw) || typeof raw.op !== "string") {
        return null;
    }
    switch (raw.op) {
        case "upsert": {
            const item = parseSessionSummary(raw.item);
            return item === null ? null : { op: "upsert", item };
        }
        case "patch": {
            const id = parseSessionId(raw.id);
            const patch = parseSessionSummaryPatch(raw.patch);
            return id === null || patch === null ? null : { op: "patch", id, patch };
        }
        case "remove": {
            const id = parseSessionId(raw.id);
            return id === null ? null : { op: "remove", id };
        }
        default:
            return null;
    }
}

/**
 * Parse one server-sent `/ws/workspace` {@link WorkspaceWsServerMessage} from untrusted JSON, or
 * return `null` when malformed or unknown.
 */
export const parseWorkspaceWsServerMessage: JsonDecoder<WorkspaceWsServerMessage> = createSyncFrameParser<
    "catalog",
    CatalogSnapshot,
    CatalogDelta
>({
    parseSnapshot: parseCatalogSnapshot,
    parseDelta: parseCatalogDelta,
});
