import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import {
    type AgentSession,
    type AgentSessionEvent,
    type ExtensionCommandContextActions,
    type FileEntry,
    getAgentDir,
    type JsonAgentSessionEvent,
    type PromptOptions,
    SessionManager,
} from "@earendil-works/pi-coding-agent";

import {
    assertNever,
    parseSessionId,
    parseSessionWsServerMessage,
    parseSyncEpoch,
    SESSION_CLOSE_CODE,
    WS_CLOSE_CODE,
} from "@pivia/protocol";
import type {
    CatalogDelta,
    CatalogSnapshot,
    CreateSessionOptions,
    SessionCloseCode,
    SessionDelta,
    SessionDetailResponse,
    SessionHandshake,
    SessionId,
    SessionListResponse,
    SessionModelInfo,
    SessionPrefixAnchor,
    SessionQueuedInputDisposition,
    SessionRpcCommand,
    SessionRpcServerMessage,
    SessionRuntimeState,
    SessionSnapshot,
    SessionStateSnapshot,
    SessionSummary,
    SessionSummaryPatch,
    SessionWsClientMessage,
    SessionWsCommandName,
    SessionWsServerMessage,
    StrictOmit,
    SyncHandshake,
} from "@pivia/protocol";

import { SessionUiBridge } from "./extension-ui.ts";
import { createLogger } from "../logger.ts";
import {
    MAX_WS_INLINE_ENTRIES_BYTES,
    ReplayRingBuffer,
    shouldOffloadPayload,
    SyncStreamHost,
    type SyncSnapshotResult,
    type SyncTransportClient,
} from "../sync/index.ts";
import { createPiRuntimeFactory } from "./pi-runtime.ts";
import { toWireSessionEvent } from "./events.ts";
import { defaultProjectSessionDir, sliceEntriesForAnchor, type SessionCatalog } from "./catalog.ts";

/** Maximum retries for `list()` when a concurrent session close changes `closeVersion` mid-scan. */
const MAX_LIST_RETRIES = 2;

/** How long an open runtime without clients is kept before it is reclaimed. */
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

/** Default grace period for a `session_shutdown` dialog while clients are still attached. */
const DEFAULT_SHUTDOWN_UI_TIMEOUT_MS = 5_000;

/** Structured logger contract used by {@link SessionRegistry}. */
export interface SessionRegistryLogger {
    warn(record: Record<string, unknown>, message: string): void;
}

/** Error codes that HTTP and WebSocket routes map to client-visible responses. */
export type SessionRegistryErrorCode = "invalid_request" | "not_found" | "directory_not_found";

export type { CreateSessionOptions };

/** Raised for request-level failures that the routes translate into protocol errors. */
export class SessionRegistryError extends Error {
    readonly code: SessionRegistryErrorCode;

    constructor(code: SessionRegistryErrorCode, message: string) {
        super(message);
        this.name = "SessionRegistryError";
        this.code = code;
    }
}

/** State exposed by a managed session runtime. */
export type ManagedSessionState = StrictOmit<SessionStateSnapshot, "sessionId" | "cwd" | "name">;

/** Options for one managed prompt, derived from the SDK {@link PromptOptions}. */
export type ManagedPromptOptions = Readonly<
    Pick<PromptOptions, "images" | "streamingBehavior"> & Required<Pick<PromptOptions, "preflightResult">>
>;

type SdkExtensionBindings = Parameters<AgentSession["bindExtensions"]>[0];

/** Extension bindings the registry installs on every managed session. */
export type ManagedExtensionBindings = Readonly<
    Required<Pick<SdkExtensionBindings, "uiContext" | "commandContextActions" | "shutdownHandler" | "onError">>
>;

/**
 * Minimal session surface owned by the registry.
 *
 * `getEntries()` includes the session header as its first entry so summaries and detail responses
 * can be built from memory, including new sessions that have not flushed a file yet.
 */
export interface ManagedSession {
    readonly sessionId: SessionId;
    getName(): string | null;
    getCwd(): string;
    getEntries(): readonly FileEntry[];
    /** Total entries including the session header, computed in O(1) when supported. */
    getEntryCount(): number;
    /** Subscribe to synchronous `SessionManager` entry appends for microtask catch-up broadcasts. */
    onEntryAppended?(listener: () => void): () => void;
    getState(): ManagedSessionState;
    subscribe: AgentSession["subscribe"];
    bindExtensions(bindings: ManagedExtensionBindings): Promise<void>;
    prompt(text: string, options: ManagedPromptOptions): Promise<void>;
    steer(text: string, images?: ImageContent[]): Promise<SessionQueuedInputDisposition>;
    followUp(text: string, images?: ImageContent[]): Promise<SessionQueuedInputDisposition>;
    abort: AgentSession["abort"];
    clearQueue: AgentSession["clearQueue"];
    waitForIdle: AgentSession["waitForIdle"];
    reload(): Promise<void>;
    getAvailableModels(): readonly SessionModelInfo[];
    /** Returns the selected model, or throws when the model is unknown or has no credentials. */
    setModel(provider: string, modelId: string): Promise<SessionModelInfo>;
    getAvailableThinkingLevels(): readonly ThinkingLevel[];
    setThinkingLevel(level: ThinkingLevel): void;
    setSessionName: AgentSession["setSessionName"];
    compact: AgentSession["compact"];
}

/** One runtime and its session. `dispose()` must emit `session_shutdown` before releasing resources. */
export interface ManagedRuntime {
    readonly session: ManagedSession;
    dispose(): Promise<void>;
}

/** Input for {@link RuntimeFactory}. */
export interface RuntimeFactoryInput {
    readonly cwd: string;
    readonly agentDir: string;
    readonly sessionManager: SessionManager;
    /** Session directory for a custom layout, or the per-project directory of the default layout. */
    readonly sessionDir: string | undefined;
}

/** Creates one managed runtime for an opened or newly created session. */
export type RuntimeFactory = (input: RuntimeFactoryInput) => Promise<ManagedRuntime>;

/** Transport that receives one session's server messages. */
export interface SessionClient {
    /** Deliver one message. A backlogged transport must close itself; the close handler detaches it. */
    send(message: SessionWsServerMessage): void;
    /** Optional pre-serialized send path to avoid double `JSON.stringify` after size measurement. */
    sendRaw?(raw: string): void;
    /** Close the transport because the session runtime went away. */
    close?(code: SessionCloseCode, reason: string): void;
}

/** Options for {@link SessionRegistryOptions}. */
export interface SessionRegistryOptions {
    /** Catalog used to discover and open sessions from disk. */
    readonly catalog: SessionCatalog;
    readonly logger?: SessionRegistryLogger | undefined;
    /** Agent configuration directory; defaults to `getAgentDir()`. */
    readonly agentDir?: string | undefined;
    /** Runtime factory; defaults to the in-process pi `AgentSessionRuntime` factory. */
    readonly runtimeFactory?: RuntimeFactory | undefined;
    /** Idle reclamation timeout in milliseconds; `0` disables reclamation. Defaults to 15 minutes. */
    readonly idleTimeoutMs?: number | undefined;
    /**
     * Grace period for `session_shutdown` dialogs while a client is still attached.
     * `0` disposes the bridge immediately. Defaults to 5 seconds.
     */
    readonly shutdownUiTimeoutMs?: number | undefined;
    /**
     * How long a pending UI dialog may keep an open session alive without clients.
     * `null` (default) waits indefinitely for a reconnecting user; a number is a fallback timeout.
     */
    readonly pendingUiTimeoutMs?: number | null | undefined;
    /** Clock used for summary and pending-dialog timestamps; defaults to `Date.now`. */
    readonly nowMs?: (() => number) | undefined;
}

/** Open runtime handle returned by {@link SessionRegistry.open} and `createSession`. */
export interface ActiveSessionHandle {
    readonly sessionId: SessionId;
    readonly cwd: string;
    /** Managed session for host extensions and tests. */
    readonly session: ManagedSession;
    /** Current summary, including live state and attached client count. */
    summarize(): SessionSummary;
}

/** Options for {@link SessionRegistry.closeSession}. */
export interface CloseSessionOptions {
    /** Dispose dialogs and close clients immediately instead of waiting for the shutdown grace period. */
    readonly force?: boolean;
    /** Close code sent to every attached client. Defaults to `sessionClosed`. */
    readonly closeCode?: SessionCloseCode;
    /** Human-readable close reason sent to every attached client. Defaults to "Session closed". */
    readonly closeReason?: string;
}

/** Options for {@link SessionRegistry.attach}. */
export type SessionAttachOptions = SessionHandshake;

/** One attached client's RPC command channel. */
export interface SessionAttachment {
    readonly sessionId: SessionId;
    handleMessage(message: SessionWsClientMessage): Promise<void>;
    detach(): void;
}

type ActiveSessionLifecycle =
    | { readonly phase: "starting" }
    | { readonly phase: "open" }
    | { readonly phase: "closing"; readonly closePromise: Promise<void> };

interface ActiveSession {
    readonly sessionId: SessionId;
    readonly cwd: string;
    readonly runtime: ManagedRuntime;
    readonly syncHost: SyncStreamHost<"session", SessionSnapshot, SessionDelta, SessionPrefixAnchor, SessionCloseCode>;
    readonly clients: Set<SessionClient>;
    readonly uiBridge: SessionUiBridge;
    readonly readyPromise: Promise<void>;
    unsubscribe: () => void;
    unsubscribeEntries: () => void;
    lifecycle: ActiveSessionLifecycle;
    lastActivityMs: number;
    lastClientDetachMs: number | undefined;
    idleTimer: NodeJS.Timeout | undefined;
    lastBroadcastEntryCount: number;
    lastTrackedState: {
        -readonly [
            K in "messageCount" | "steeringMode" | "followUpMode" | "autoCompactionEnabled"
        ]: SessionStateSnapshot[K];
    };
    flushScheduled: boolean;
    liveMessage: AssistantMessage | null;
    diskSizeBytes: number | undefined;
    readonly createdAtMs: number;
    readonly hasParent: boolean;
    firstMessage: string | null;
    lastSummary: SessionSummary | null;
}

function toRuntimeState(state: ManagedSessionState): SessionRuntimeState {
    if (state.isCompacting) {
        return "compacting";
    }
    if (state.isStreaming) {
        return "streaming";
    }
    return "idle";
}

function extractUserMessageText(content: string | readonly { type: string; text?: string }[]): string | null {
    if (typeof content === "string") {
        return content.length > 0 ? content : null;
    }
    const text = content
        .filter(
            (block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
        )
        .map((block) => block.text)
        .join(" ");
    return text.length > 0 ? text : null;
}

/** First user message text, matching the SDK session list placeholder rules. */
function firstUserMessageText(entries: readonly FileEntry[]): string | null {
    for (const entry of entries) {
        if (entry.type !== "message" || entry.message.role !== "user") {
            continue;
        }
        const text = extractUserMessageText(entry.message.content);
        if (text !== null) {
            return text;
        }
    }
    return null;
}

function diffSessionSummary(previous: SessionSummary, next: SessionSummary): SessionSummaryPatch | null {
    const patch: {
        name?: string | null;
        firstMessage?: string;
        messageCount?: number;
        modifiedAtMs?: number;
        runtimeState?: SessionRuntimeState;
        attachedClients?: number;
    } = {};
    let changed = false;

    if (previous.name !== next.name) {
        patch.name = next.name;
        changed = true;
    }
    if (previous.firstMessage !== next.firstMessage) {
        patch.firstMessage = next.firstMessage;
        changed = true;
    }
    if (previous.messageCount !== next.messageCount) {
        patch.messageCount = next.messageCount;
        changed = true;
    }
    if (previous.modifiedAtMs !== next.modifiedAtMs) {
        patch.modifiedAtMs = next.modifiedAtMs;
        changed = true;
    }
    if (previous.runtimeState !== next.runtimeState) {
        patch.runtimeState = next.runtimeState;
        changed = true;
    }
    if (previous.attachedClients !== next.attachedClients) {
        patch.attachedClients = next.attachedClients;
        changed = true;
    }

    return changed ? patch : null;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isEnoentError(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** Resolve and validate a working directory for a new session. */
async function resolveSessionCwd(
    cwd: string,
    createDirectory: boolean,
    logger: SessionRegistryLogger,
): Promise<string> {
    if (cwd.trim() === "" || !isAbsolute(cwd)) {
        throw new SessionRegistryError("invalid_request", "Session cwd must be an absolute directory path.");
    }
    let realCwd: string;
    try {
        realCwd = await realpath(cwd);
    } catch (error) {
        if (isEnoentError(error)) {
            if (!createDirectory) {
                throw new SessionRegistryError("directory_not_found", "Session cwd does not exist.");
            }
            try {
                await mkdir(cwd, { recursive: true });
                realCwd = await realpath(cwd);
            } catch (mkdirError) {
                logger.warn({ err: mkdirError, cwd }, "failed to create session cwd");
                throw new SessionRegistryError("invalid_request", "Failed to create session cwd.");
            }
        } else {
            logger.warn({ err: error, cwd }, "session cwd is not accessible");
            throw new SessionRegistryError("invalid_request", "Session cwd is not accessible.");
        }
    }
    let stats: Stats;
    try {
        stats = await stat(realCwd);
    } catch (error) {
        logger.warn({ err: error, cwd: realCwd }, "failed to stat session cwd");
        throw new SessionRegistryError("invalid_request", "Session cwd is not accessible.");
    }
    if (!stats.isDirectory()) {
        throw new SessionRegistryError("invalid_request", "Session cwd is not a directory.");
    }
    return realCwd;
}

/**
 * Owns every open `AgentSessionRuntime` on this host.
 *
 * Opening the same session concurrently shares one in-flight promise, so two clients can never
 * create two runtimes for one session file. Sessions without clients are reclaimed after the idle
 * timeout; pending dialogs pause reclamation unless `pendingUiTimeoutMs` sets a fallback.
 * `disposeAll()` force-releases everything when the server closes.
 */
export class SessionRegistry {
    private readonly catalog: SessionCatalog;
    private readonly logger: SessionRegistryLogger;
    private readonly agentDir: string;
    private readonly runtimeFactory: RuntimeFactory;
    private readonly idleTimeoutMs: number;
    private readonly shutdownUiTimeoutMs: number;
    private readonly pendingUiTimeoutMs: number | null;
    private readonly nowMs: () => number;
    private readonly active = new Map<SessionId, ActiveSession>();
    private readonly opening = new Map<SessionId, Promise<ActiveSessionHandle>>();
    private readonly pendingRegistrations = new Set<Promise<unknown>>();
    private readonly catalogBuffer: ReplayRingBuffer<"catalog", CatalogDelta>;
    private readonly catalogHost: SyncStreamHost<"catalog", CatalogSnapshot, CatalogDelta>;
    private closeVersion = 0;
    private disposed = false;

    constructor(options: SessionRegistryOptions) {
        this.catalog = options.catalog;
        this.agentDir = options.agentDir ?? getAgentDir();
        this.logger = options.logger ?? createLogger();
        this.nowMs = options.nowMs ?? (() => Date.now());
        const catalogEpoch = parseSyncEpoch<"catalog">(randomUUID());
        if (catalogEpoch === null) {
            throw new Error("Generated invalid catalog epoch.");
        }
        this.catalogBuffer = new ReplayRingBuffer<"catalog", CatalogDelta>({ epoch: catalogEpoch });
        this.catalogHost = new SyncStreamHost<"catalog", CatalogSnapshot, CatalogDelta>({
            buffer: this.catalogBuffer,
            getSnapshot: () => this.getCatalogSnapshot(),
            logger: this.logger,
        });

        const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
        if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs < 0) {
            throw new Error("idleTimeoutMs must be a non-negative finite number.");
        }
        this.idleTimeoutMs = idleTimeoutMs;

        const shutdownUiTimeoutMs = options.shutdownUiTimeoutMs ?? DEFAULT_SHUTDOWN_UI_TIMEOUT_MS;
        if (!Number.isFinite(shutdownUiTimeoutMs) || shutdownUiTimeoutMs < 0) {
            throw new Error("shutdownUiTimeoutMs must be a non-negative finite number.");
        }
        this.shutdownUiTimeoutMs = shutdownUiTimeoutMs;

        const pendingUiTimeoutMs = options.pendingUiTimeoutMs ?? null;
        if (pendingUiTimeoutMs !== null && (!Number.isFinite(pendingUiTimeoutMs) || pendingUiTimeoutMs < 0)) {
            throw new Error("pendingUiTimeoutMs must be null or a non-negative finite number.");
        }
        this.pendingUiTimeoutMs = pendingUiTimeoutMs;

        this.runtimeFactory =
            options.runtimeFactory ??
            createPiRuntimeFactory({
                agentDir: this.agentDir,
                logger: this.logger,
            });
    }

    /** Number of active runtimes, including sessions that are still starting or closing. */
    get activeSessionCount(): number {
        return this.active.size;
    }

    /**
     * Open one session from disk or return the already open runtime.
     *
     * A session that is still `starting` is returned immediately; its commands wait for
     * `bindExtensions`. A session in `closing` is awaited, then reopened from disk so two
     * runtimes never share one session file.
     *
     * @throws SessionRegistryError with code `"not_found"` when the session is unknown or its file
     * fails the catalog containment checks.
     */
    async open(id: SessionId): Promise<ActiveSessionHandle> {
        this.assertUsable();
        const registration = this.openHandle(id);
        this.pendingRegistrations.add(registration);
        try {
            return await registration;
        } finally {
            this.pendingRegistrations.delete(registration);
        }
    }

    private async openHandle(id: SessionId): Promise<ActiveSessionHandle> {
        for (;;) {
            this.assertUsable();
            const active = this.active.get(id);
            if (active !== undefined) {
                if (active.lifecycle.phase !== "closing") {
                    return this.createHandle(active);
                }
                try {
                    await active.lifecycle.closePromise;
                } catch (error) {
                    this.logger.warn({ err: error, sessionId: id }, "waited on failed session close before reopening");
                }
                continue;
            }

            const inFlight = this.opening.get(id);
            if (inFlight !== undefined) {
                return inFlight;
            }

            const promise = this.openInternal(id);
            this.opening.set(id, promise);
            void promise.then(
                () => {
                    this.opening.delete(id);
                },
                () => {
                    this.opening.delete(id);
                },
            );
            return promise;
        }
    }

    /**
     * Create and register a new session runtime for `cwd`.
     *
     * Returns while extensions are still binding; commands wait for `readyPromise` and the
     * `starting` phase lets a client attach and answer `session_start` dialogs.
     *
     * @throws SessionRegistryError with code `"invalid_request"` when `cwd` is not an existing
     * directory with an absolute path.
     */
    async createSession(cwd: string, options: CreateSessionOptions = {}): Promise<ActiveSessionHandle> {
        this.assertUsable();
        const registration = this.createSessionInternal(cwd, options.createDirectory === true);
        this.pendingRegistrations.add(registration);
        try {
            return await registration;
        } finally {
            this.pendingRegistrations.delete(registration);
        }
    }

    private async createSessionInternal(cwd: string, createDirectory: boolean): Promise<ActiveSessionHandle> {
        const realCwd = await resolveSessionCwd(cwd, createDirectory, this.logger);
        const root = this.catalog.resolveRoot();
        const sessionDir = root.isCustom ? root.dir : defaultProjectSessionDir(root.dir, realCwd);
        const sessionManager = SessionManager.create(realCwd, sessionDir);
        const runtime = await this.runtimeFactory({
            cwd: realCwd,
            agentDir: this.agentDir,
            sessionManager,
            sessionDir,
        });
        const rawSessionId = sessionManager.getSessionId();
        const sessionId = parseSessionId(rawSessionId);
        if (sessionId === null) {
            await runtime.dispose().catch((error: unknown) => {
                this.logger.warn({ err: error, sessionId: rawSessionId }, "failed to dispose runtime with invalid id");
            });
            throw new Error(`Invalid SDK session id: ${rawSessionId}`);
        }
        return this.registerRuntime(sessionId, runtime);
    }

    /**
     * Dispose one open runtime and close its clients.
     *
     * While clients are attached, a `session_shutdown` dialog gets `shutdownUiTimeoutMs` to be
     * answered. Forced closes and sessions without clients dispose the bridge immediately.
     * Concurrent calls share one close operation. Returns false when the session is not open.
     */
    async closeSession(id: SessionId, options: CloseSessionOptions = {}): Promise<boolean> {
        const entry = this.active.get(id);
        if (entry === undefined) {
            return false;
        }
        const closeCode = options.closeCode ?? SESSION_CLOSE_CODE.sessionClosed;
        const closeReason = options.closeReason ?? "Session closed";

        if (entry.lifecycle.phase === "closing") {
            if (options.force === true) {
                entry.uiBridge.dispose();
                entry.syncHost.dispose(closeCode, closeReason);
                entry.clients.clear();
            }
            await entry.lifecycle.closePromise;
            return true;
        }

        const wasStarting = entry.lifecycle.phase === "starting";
        const closing = Promise.withResolvers<void>();
        entry.lifecycle = { phase: "closing", closePromise: closing.promise };
        this.emitSessionUpdated(entry);
        void this.closeSessionInternal(entry, wasStarting, options.force === true, closeCode, closeReason).then(
            closing.resolve,
            closing.reject,
        );
        await closing.promise;
        return true;
    }

    private async closeSessionInternal(
        entry: ActiveSession,
        wasStarting: boolean,
        force: boolean,
        closeCode: SessionCloseCode,
        closeReason: string,
    ): Promise<void> {
        this.clearIdleTimer(entry);

        if (wasStarting) {
            // Unblock a session_start dialog so bindExtensions can finish. A forced close or a
            // session without clients can settle dialogs without notifying anyone.
            if (force || entry.clients.size === 0 || this.shutdownUiTimeoutMs <= 0) {
                entry.uiBridge.dispose();
            } else {
                entry.uiBridge.cancelPending();
            }
            await entry.readyPromise.catch(() => {});
            if (this.active.get(entry.sessionId) !== entry) {
                // The bind failure path already disposed and removed the runtime.
                return;
            }
        }

        const immediate = force || entry.clients.size === 0 || this.shutdownUiTimeoutMs <= 0;
        let graceTimer: NodeJS.Timeout | undefined;

        try {
            if (immediate) {
                entry.uiBridge.dispose();
                entry.syncHost.dispose(closeCode, closeReason);
                entry.clients.clear();
            } else {
                // Keep clients and the bridge alive so session_shutdown can still ask the user.
                // The timeout and a last-client detach both dispose the bridge to unblock dispose().
                graceTimer = setTimeout(() => {
                    entry.uiBridge.dispose();
                }, this.shutdownUiTimeoutMs);
                graceTimer.unref();
            }

            try {
                await entry.runtime.dispose();
            } catch (error) {
                this.logger.warn({ err: error, sessionId: entry.sessionId }, "failed to dispose session runtime");
            }
        } finally {
            if (graceTimer !== undefined) {
                clearTimeout(graceTimer);
            }
            await this.finalizeClosedEntry(entry, closeCode, closeReason);
        }
    }

    /** Dispose every in-flight registration and every active runtime. Safe to call more than once. */
    async disposeAll(): Promise<void> {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.catalogHost.dispose(WS_CLOSE_CODE.goingAway, "Server going away");

        // Force-close current entries first so an open() waiting on closePromise cannot keep
        // disposeAll blocked behind a shutdown dialog.
        const firstCloses = this.forceCloseAll();
        await Promise.allSettled([...this.opening.values(), ...this.pendingRegistrations]);
        const remainingCloses = this.forceCloseAll();
        await Promise.all([...firstCloses, ...remainingCloses]);
    }

    private forceCloseAll(): Array<Promise<void>> {
        return [...this.active.keys()].map((id) =>
            this.closeSession(id, {
                force: true,
                closeCode: SESSION_CLOSE_CODE.goingAway,
                closeReason: "Server going away",
            }).then(
                () => {},
                (error: unknown) => {
                    this.logger.warn({ err: error, sessionId: id }, "failed to close session during shutdown");
                },
            ),
        );
    }

    private async getCatalogSnapshot(): Promise<SyncSnapshotResult<"catalog", CatalogSnapshot>> {
        for (let attempt = 0; attempt <= MAX_LIST_RETRIES; attempt += 1) {
            const versionBefore = this.closeVersion;
            const disk = await this.catalog.list();
            if (this.closeVersion !== versionBefore && attempt < MAX_LIST_RETRIES) {
                continue;
            }
            if (this.closeVersion !== versionBefore) {
                this.logger.warn(
                    { retries: MAX_LIST_RETRIES },
                    "catalog snapshot observed concurrent session close across max retries",
                );
            }
            const active = [...this.active.values()].map((entry) => this.summarizeEntry(entry));
            const activeById = new Map(active.map((summary) => [summary.id, summary]));
            const merged = disk.sessions.map((summary) => activeById.get(summary.id) ?? summary);
            const mergedIds = new Set(merged.map((summary) => summary.id));
            const missing = active.filter((summary) => !mergedIds.has(summary.id));
            const sessions = [...merged, ...missing].sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);
            return {
                cursor: this.catalogBuffer.currentCursor,
                snapshot: {
                    sessions,
                    updatedAtMs: disk.updatedAtMs,
                },
            };
        }
        throw new Error("Unreachable catalog snapshot retry exit.");
    }

    /** Merge disk discovery with live runtimes, including new sessions that have not flushed a file. */
    async list(): Promise<SessionListResponse> {
        const { cursor, snapshot } = await this.getCatalogSnapshot();
        return {
            ...snapshot,
            cursor,
        };
    }

    /** Attach a WebSocket client transport to the workspace catalog stream. */
    attachCatalog(client: SyncTransportClient, handshake: SyncHandshake<"catalog"> = {}): () => void {
        return this.catalogHost.attach(client, handshake);
    }

    /** Prefer live runtime entries over the disk copy so an unflushed new session is readable. */
    async getById(id: SessionId, sliceAnchor?: SessionPrefixAnchor): Promise<SessionDetailResponse | null> {
        const entry = this.active.get(id);
        if (entry !== undefined) {
            const entries = entry.runtime.session.getEntries();
            const sliced = sliceAnchor
                ? sliceEntriesForAnchor(id, entries, this.catalog.entriesVersion, sliceAnchor)
                : { baseEntryCount: 0, entries, prefixMatched: false };
            return {
                session: this.summarizeEntry(entry),
                entriesVersion: this.catalog.entriesVersion,
                baseEntryCount: sliced.baseEntryCount,
                entries: sliced.entries,
            };
        }
        return this.catalog.getById(id, sliceAnchor);
    }

    /**
     * Register one transport for a session and send its initial Tier 1 replay or Tier 2/3 snapshot.
     *
     * Attach is allowed while the session is `starting` so startup dialogs can reach a client.
     * It is rejected in `closing`.
     *
     * @throws SessionRegistryError with code `"not_found"` when the runtime is not open.
     */
    attach(sessionId: SessionId, client: SessionClient, options: SessionAttachOptions = {}): SessionAttachment {
        const entry = this.active.get(sessionId);
        if (entry === undefined) {
            throw new SessionRegistryError("not_found", "Session is not open.");
        }
        if (entry.lifecycle.phase === "closing") {
            throw new SessionRegistryError("not_found", "Session is closing.");
        }

        const transport: SyncTransportClient<SessionCloseCode> = {
            sendRaw: (raw) => {
                if (client.sendRaw !== undefined) {
                    client.sendRaw(raw);
                } else {
                    const parsed = parseSessionWsServerMessage(JSON.parse(raw) as unknown);
                    if (parsed !== null) {
                        client.send(parsed);
                    }
                }
            },
            close: (code, reason) => {
                client.close?.(code, reason);
            },
        };

        entry.clients.add(client);
        this.clearIdleTimer(entry);
        const detachSync = entry.syncHost.attach(transport, options);
        this.emitSessionUpdated(entry);

        let attached = true;
        return {
            sessionId,
            handleMessage: async (message) => {
                await this.handleMessage(entry, client, message);
            },
            detach: () => {
                if (!attached) {
                    return;
                }
                attached = false;
                detachSync();
                entry.clients.delete(client);
                this.emitSessionUpdated(entry);
                if (entry.clients.size > 0) {
                    return;
                }
                entry.lastClientDetachMs = this.nowMs();
                if (entry.lifecycle.phase === "closing") {
                    // A closing session no longer has anyone who can answer a shutdown dialog.
                    entry.uiBridge.dispose();
                } else if (entry.lifecycle.phase === "open") {
                    this.touch(entry);
                }
            },
        };
    }

    private assertUsable(): void {
        if (this.disposed) {
            throw new Error("Session registry is disposed.");
        }
    }

    private isClosing(entry: ActiveSession): boolean {
        return entry.lifecycle.phase === "closing";
    }

    private async openInternal(id: SessionId): Promise<ActiveSessionHandle> {
        const resolution = await this.catalog.resolveById(id);
        switch (resolution.kind) {
            case "found": {
                const resolved = resolution.session;
                const sessionDir = resolved.root.isCustom ? resolved.root.dir : undefined;
                const sessionManager = SessionManager.open(resolved.realPath, sessionDir);
                const runtime = await this.runtimeFactory({
                    cwd: sessionManager.getCwd(),
                    agentDir: this.agentDir,
                    sessionManager,
                    sessionDir,
                });
                return this.registerRuntime(id, runtime, resolved.sizeBytes);
            }
            case "oversized":
                this.logger.warn(
                    { sessionId: id, size: resolution.sizeBytes },
                    "refused to open an oversized session file",
                );
                throw new SessionRegistryError("not_found", "Session not found.");
            case "missing":
                throw new SessionRegistryError("not_found", "Session not found.");
            default:
                return assertNever(resolution);
        }
    }

    private async registerRuntime(
        sessionId: SessionId,
        runtime: ManagedRuntime,
        diskSizeBytes?: number,
    ): Promise<ActiveSessionHandle> {
        if (this.disposed) {
            await runtime.dispose().catch((error: unknown) => {
                this.logger.warn({ err: error, sessionId }, "failed to dispose runtime after shutdown");
            });
            throw new Error("Session registry is disposed.");
        }

        const session = runtime.session;
        if (session.sessionId !== sessionId) {
            await runtime.dispose().catch((error: unknown) => {
                this.logger.warn({ err: error, sessionId }, "failed to dispose mismatched runtime");
            });
            throw new Error(`Session id mismatch: expected ${sessionId}, runtime reported ${session.sessionId}.`);
        }

        const runtimeId = parseSyncEpoch<"session">(randomUUID());
        if (runtimeId === null) {
            throw new Error("Generated invalid session runtime id.");
        }
        const ready = Promise.withResolvers<void>();
        const buffer = new ReplayRingBuffer<"session", SessionDelta>({ epoch: runtimeId });
        const uiBridge = new SessionUiBridge(sessionId, (delta) => this.publishSessionDelta(sessionId, delta), {
            onPendingChange: () => {
                this.handlePendingChange(sessionId);
            },
            nowMs: this.nowMs,
        });
        const now = this.nowMs();
        const initialEntries = session.getEntries();
        const initialState = session.getState();
        const header = initialEntries[0]?.type === "session" ? initialEntries[0] : null;
        const parsedCreatedAtMs = header === null ? Number.NaN : Date.parse(header.timestamp);
        const syncHost = new SyncStreamHost<
            "session",
            SessionSnapshot,
            SessionDelta,
            SessionPrefixAnchor,
            SessionCloseCode
        >({
            buffer,
            getSnapshot: (hint) => this.buildSessionSnapshot(sessionId, hint),
            logger: this.logger,
        });
        const entry: ActiveSession = {
            sessionId,
            cwd: session.getCwd(),
            runtime,
            syncHost,
            clients: new Set(),
            uiBridge,
            readyPromise: ready.promise,
            unsubscribe: () => {},
            unsubscribeEntries: () => {},
            lifecycle: { phase: "starting" },
            lastActivityMs: now,
            lastClientDetachMs: undefined,
            idleTimer: undefined,
            lastBroadcastEntryCount: initialEntries.length,
            lastTrackedState: {
                messageCount: initialState.messageCount,
                steeringMode: initialState.steeringMode,
                followUpMode: initialState.followUpMode,
                autoCompactionEnabled: initialState.autoCompactionEnabled,
            },
            flushScheduled: false,
            liveMessage: null,
            diskSizeBytes,
            createdAtMs: Number.isFinite(parsedCreatedAtMs) ? parsedCreatedAtMs : now,
            hasParent: header?.parentSession !== undefined && header.parentSession.length > 0,
            firstMessage: firstUserMessageText(initialEntries),
            lastSummary: null,
        };
        const initialSummary = this.summarizeEntry(entry);
        entry.lastSummary = initialSummary;

        // The entry is visible while extensions bind so clients can answer session_start dialogs.
        // Commands other than extension_ui_response wait for readyPromise in handleCommand().
        this.active.set(sessionId, entry);
        this.emitSessionUpserted(entry, initialSummary);
        entry.unsubscribe = session.subscribe((event) => {
            this.handleSessionEvent(entry, event);
        });
        entry.unsubscribeEntries =
            session.onEntryAppended?.(() => {
                this.scheduleFlushAppendedEntries(entry);
            }) ?? (() => {});
        void ready.promise.catch(() => {
            // Commands and closeSession await the original promise; this only prevents an
            // unhandled rejection from the background bind task.
        });
        void this.bindRuntime(entry, ready);
        return this.createHandle(entry);
    }

    private async bindRuntime(entry: ActiveSession, ready: PromiseWithResolvers<void>): Promise<void> {
        let shutdownRequested = false;
        try {
            await entry.runtime.session.bindExtensions({
                uiContext: entry.uiBridge.context,
                commandContextActions: this.createCommandContextActions(entry),
                shutdownHandler: () => {
                    // An extension shutdown request closes this session only; the server keeps serving.
                    shutdownRequested = true;
                    if (this.active.get(entry.sessionId) === entry && entry.lifecycle.phase === "open") {
                        void this.closeSession(entry.sessionId).catch((error: unknown) => {
                            this.logger.warn(
                                { err: error, sessionId: entry.sessionId },
                                "failed to close session after shutdown request",
                            );
                        });
                    }
                },
                onError: (error) => {
                    this.logger.warn(
                        {
                            err: error,
                            sessionId: entry.sessionId,
                            event: error.event,
                            extensionPath: error.extensionPath,
                        },
                        "extension handler failed",
                    );
                    this.publishSessionDelta(entry.sessionId, {
                        kind: "extension_error",
                        extensionPath: error.extensionPath,
                        event: error.event,
                        error: error.error,
                    });
                },
            });
        } catch (error) {
            await this.failRuntime(entry, error);
            ready.reject(error);
            return;
        }

        if (entry.lifecycle.phase === "starting") {
            entry.lifecycle = { phase: "open" };
            ready.resolve();
            this.touch(entry);
            this.emitSessionUpdated(entry);
            if (shutdownRequested) {
                void this.closeSession(entry.sessionId).catch((error: unknown) => {
                    this.logger.warn(
                        { err: error, sessionId: entry.sessionId },
                        "failed to close session after startup shutdown request",
                    );
                });
            }
            return;
        }

        // closeSession() set the phase to closing while binding; let it continue.
        ready.resolve();
    }

    private async failRuntime(entry: ActiveSession, error: unknown): Promise<void> {
        this.logger.warn({ err: error, sessionId: entry.sessionId }, "failed to bind session extensions");
        const closing = Promise.withResolvers<void>();
        entry.lifecycle = { phase: "closing", closePromise: closing.promise };
        this.clearIdleTimer(entry);
        const hadDiskFile = entry.diskSizeBytes !== undefined;
        try {
            await entry.runtime.dispose();
        } catch (disposeError) {
            this.logger.warn(
                { err: disposeError, sessionId: entry.sessionId },
                "failed to dispose runtime after bind failure",
            );
        } finally {
            await this.finalizeClosedEntry(
                entry,
                SESSION_CLOSE_CODE.internalError,
                "Session failed to initialize",
                hadDiskFile,
            );
            closing.resolve();
        }
    }

    private runSafeTeardownStep(sessionId: SessionId, label: string, fn: () => void): void {
        try {
            fn();
        } catch (error) {
            this.logger.warn({ err: error, sessionId }, label);
        }
    }

    private async finalizeClosedEntry(
        entry: ActiveSession,
        closeCode: SessionCloseCode,
        closeReason: string,
        hadDiskFile = entry.diskSizeBytes !== undefined,
    ): Promise<void> {
        this.runSafeTeardownStep(entry.sessionId, "failed to dispose ui bridge on close", () => {
            entry.uiBridge.dispose();
        });
        this.runSafeTeardownStep(entry.sessionId, "failed to unsubscribe session events on close", () => {
            entry.unsubscribe();
        });
        this.runSafeTeardownStep(entry.sessionId, "failed to unsubscribe entry appends on close", () => {
            entry.unsubscribeEntries();
        });
        this.runSafeTeardownStep(entry.sessionId, "failed to dispose session sync host on close", () => {
            entry.syncHost.dispose(closeCode, closeReason);
        });
        entry.clients.clear();
        // Keep the closing entry in `this.active` while checking disk persistence so concurrent
        // open() calls continue waiting on `closePromise`, then delete and publish atomically.
        const persisted = await this.resolvePersistedOnClose(entry.sessionId, hadDiskFile);
        if (this.active.get(entry.sessionId) === entry) {
            this.active.delete(entry.sessionId);
            this.closeVersion += 1;
            this.runSafeTeardownStep(entry.sessionId, "failed to publish session close catalog delta", () => {
                this.publishSessionClosed(entry.sessionId, persisted);
            });
        }
    }

    private createCommandContextActions(entry: ActiveSession): ExtensionCommandContextActions {
        const unsupported = () => Promise.resolve({ cancelled: true });
        return {
            waitForIdle: () => entry.runtime.session.waitForIdle(),
            newSession: unsupported,
            fork: unsupported,
            navigateTree: unsupported,
            switchSession: unsupported,
            reload: async () => {
                await entry.runtime.session.reload();
                this.emitTrackedStateDiff(entry);
            },
        };
    }

    private createHandle(entry: ActiveSession): ActiveSessionHandle {
        return {
            sessionId: entry.sessionId,
            cwd: entry.cwd,
            session: entry.runtime.session,
            summarize: () => this.summarizeEntry(entry),
        };
    }

    private summarizeEntry(entry: ActiveSession): SessionSummary {
        const session = entry.runtime.session;
        const state = session.getState();
        const runtimeState: SessionRuntimeState =
            entry.lifecycle.phase === "starting"
                ? "starting"
                : entry.lifecycle.phase === "closing"
                  ? "closing"
                  : toRuntimeState(state);

        return {
            id: entry.sessionId,
            cwd: entry.cwd,
            name: session.getName(),
            firstMessage: entry.firstMessage ?? "(no messages)",
            messageCount: state.messageCount,
            createdAtMs: entry.createdAtMs,
            modifiedAtMs: entry.lastActivityMs,
            hasParent: entry.hasParent,
            runtimeState,
            attachedClients: entry.clients.size,
        };
    }

    private buildState(entry: ActiveSession): SessionStateSnapshot {
        return {
            sessionId: entry.sessionId,
            cwd: entry.cwd,
            name: entry.runtime.session.getName(),
            ...entry.runtime.session.getState(),
        };
    }

    private async handleMessage(
        entry: ActiveSession,
        client: SessionClient,
        message: SessionWsClientMessage,
    ): Promise<void> {
        switch (message.type) {
            case "rpc:ui_response": {
                const result = entry.uiBridge.handleResponse(message.response);
                if (!result.ok && result.reason === "mismatched") {
                    this.sendError(
                        client,
                        "invalid_request",
                        `Response does not match pending dialog ${message.response.id}.`,
                        message.response.id,
                    );
                }
                return;
            }
            case "rpc:command":
                await this.handleCommand(entry, client, message.command);
                return;
            default:
                assertNever(message);
        }
    }

    private async handleCommand(
        entry: ActiveSession,
        client: SessionClient,
        command: SessionRpcCommand,
    ): Promise<void> {
        if (entry.lifecycle.phase === "closing") {
            this.sendFailure(client, command.id, command.type, "Session is closing.");
            return;
        }

        if (entry.lifecycle.phase === "starting") {
            try {
                await entry.readyPromise;
            } catch {
                this.sendFailure(client, command.id, command.type, "Session failed to initialize.");
                return;
            }
            if (this.isClosing(entry)) {
                this.sendFailure(client, command.id, command.type, "Session is closing.");
                return;
            }
        }

        try {
            switch (command.type) {
                case "prompt": {
                    // prompt() resolves after the whole run; acknowledge acceptance as soon as the
                    // SDK reports its preflight disposition, and report preflight rejections.
                    let preflightSucceeded = false;
                    const promise = entry.runtime.session.prompt(command.message, {
                        preflightResult: (disposition) => {
                            preflightSucceeded = true;
                            this.sendSuccess(client, command.id, "prompt", { disposition });
                        },
                        ...(command.images === undefined ? {} : { images: command.images }),
                        ...(command.streamingBehavior === undefined
                            ? {}
                            : { streamingBehavior: command.streamingBehavior }),
                    });
                    void promise
                        .catch((error: unknown) => {
                            if (!preflightSucceeded) {
                                this.sendFailure(client, command.id, "prompt", errorMessage(error));
                                return;
                            }
                            this.logger.warn(
                                { err: error, sessionId: entry.sessionId },
                                "prompt failed after it was accepted",
                            );
                        })
                        .finally(() => {
                            this.touch(entry);
                        });
                    return;
                }
                case "steer": {
                    const disposition = await entry.runtime.session.steer(command.message, command.images);
                    this.sendSuccess(client, command.id, "steer", { disposition });
                    return;
                }
                case "follow_up": {
                    const disposition = await entry.runtime.session.followUp(command.message, command.images);
                    this.sendSuccess(client, command.id, "follow_up", { disposition });
                    return;
                }
                case "abort": {
                    await entry.runtime.session.abort();
                    this.sendSuccess(client, command.id, "abort");
                    return;
                }
                case "clear_queue": {
                    this.sendSuccess(client, command.id, "clear_queue", entry.runtime.session.clearQueue());
                    return;
                }
                case "get_state": {
                    this.sendSuccess(client, command.id, "get_state", this.buildState(entry));
                    return;
                }
                case "set_model": {
                    const model = await entry.runtime.session.setModel(command.provider, command.modelId);
                    this.publishSessionDelta(entry.sessionId, {
                        kind: "state_patched",
                        patch: { model },
                    });
                    this.sendSuccess(client, command.id, "set_model", model);
                    return;
                }
                case "get_available_models": {
                    this.sendSuccess(client, command.id, "get_available_models", {
                        models: entry.runtime.session.getAvailableModels(),
                    });
                    return;
                }
                case "set_thinking_level": {
                    entry.runtime.session.setThinkingLevel(command.level);
                    this.sendSuccess(client, command.id, "set_thinking_level", {
                        level: entry.runtime.session.getState().thinkingLevel,
                    });
                    return;
                }
                case "get_available_thinking_levels": {
                    this.sendSuccess(client, command.id, "get_available_thinking_levels", {
                        levels: entry.runtime.session.getAvailableThinkingLevels(),
                    });
                    return;
                }
                case "set_session_name": {
                    const name = command.name.trim();
                    if (name.length === 0) {
                        this.sendFailure(client, command.id, "set_session_name", "Session name cannot be empty.");
                        return;
                    }
                    entry.runtime.session.setSessionName(name);
                    this.emitSessionUpdated(entry);
                    this.sendSuccess(client, command.id, "set_session_name");
                    return;
                }
                case "compact": {
                    const result =
                        command.customInstructions === undefined
                            ? await entry.runtime.session.compact()
                            : await entry.runtime.session.compact(command.customInstructions);
                    this.sendSuccess(client, command.id, "compact", result);
                    return;
                }
                default:
                    return assertNever(command);
            }
        } catch (error) {
            this.sendFailure(client, command.id, command.type, errorMessage(error));
        }
    }

    private sendSuccess(
        client: SessionClient,
        id: string | undefined,
        command: SessionWsCommandName,
        data?: unknown,
    ): void {
        const message: SessionRpcServerMessage = {
            type: "rpc:response",
            command,
            success: true,
            ...(id === undefined ? {} : { id }),
            ...(data === undefined ? {} : { data }),
        };
        this.sendClient(client, message);
    }

    private sendFailure(
        client: SessionClient,
        id: string | undefined,
        command: SessionWsCommandName,
        error: string,
    ): void {
        this.sendClient(client, {
            type: "rpc:response",
            command,
            success: false,
            ...(id === undefined ? {} : { id }),
            error,
        });
    }

    private sendError(client: SessionClient, code: string, message: string, id?: string): void {
        this.sendClient(client, { type: "rpc:error", code, message, ...(id === undefined ? {} : { id }) });
    }

    private buildSessionSnapshot(
        sessionId: SessionId,
        hint: SessionPrefixAnchor | undefined,
    ): SyncSnapshotResult<"session", SessionSnapshot> {
        const entry = this.active.get(sessionId);
        if (entry === undefined) {
            throw new SessionRegistryError("not_found", "Session is not open.");
        }
        const entriesVersion = this.catalog.entriesVersion;
        const entries = entry.runtime.session.getEntries();
        const totalCount = entries.length;
        const state = this.buildState(entry);
        const pendingUiRequests = entry.uiBridge.pendingRequests();
        const cursor = entry.syncHost.buffer.currentCursor;

        const sliced =
            hint !== undefined
                ? sliceEntriesForAnchor(entry.sessionId, entries, entriesVersion, hint)
                : { baseEntryCount: 0, entries, prefixMatched: false };

        const overDiskHint =
            sliced.baseEntryCount === 0 &&
            entry.diskSizeBytes !== undefined &&
            entry.diskSizeBytes > MAX_WS_INLINE_ENTRIES_BYTES;
        if (shouldOffloadPayload({ itemCount: sliced.entries.length }) || overDiskHint) {
            return {
                cursor,
                snapshot: {
                    entriesVersion,
                    baseEntryCount: sliced.baseEntryCount,
                    entries: { mode: "http", meta: { entryCount: totalCount } },
                    state,
                    liveMessage: entry.liveMessage,
                    pendingUiRequests,
                },
            };
        }

        const inlineSnapshot: SessionSnapshot = {
            entriesVersion,
            baseEntryCount: sliced.baseEntryCount,
            entries: { mode: "inline", data: sliced.entries },
            state,
            liveMessage: entry.liveMessage,
            pendingUiRequests,
        };
        const serializedBytes = Buffer.byteLength(JSON.stringify(inlineSnapshot), "utf8");
        if (shouldOffloadPayload({ serializedBytes })) {
            return {
                cursor,
                snapshot: {
                    entriesVersion,
                    baseEntryCount: sliced.baseEntryCount,
                    entries: { mode: "http", meta: { entryCount: totalCount } },
                    state,
                    liveMessage: entry.liveMessage,
                    pendingUiRequests,
                },
            };
        }
        return { cursor, snapshot: inlineSnapshot };
    }

    private scheduleFlushAppendedEntries(entry: ActiveSession): void {
        if (entry.lifecycle.phase === "closing" || entry.flushScheduled) {
            return;
        }
        entry.flushScheduled = true;
        queueMicrotask(() => {
            entry.flushScheduled = false;
            if (entry.lifecycle.phase === "closing" || this.active.get(entry.sessionId) !== entry) {
                return;
            }
            const currentCount = entry.runtime.session.getEntryCount();
            if (currentCount <= entry.lastBroadcastEntryCount) {
                return;
            }
            const allEntries = entry.runtime.session.getEntries();
            const baseEntryCount = entry.lastBroadcastEntryCount;
            const appended = allEntries.slice(baseEntryCount);
            entry.lastBroadcastEntryCount = allEntries.length;
            if (entry.firstMessage === null && appended.length > 0) {
                entry.firstMessage = firstUserMessageText(appended);
            }
            if (appended.length === 0) {
                return;
            }
            this.publishEntriesAppendedWithSizeGuard(entry, baseEntryCount, appended, allEntries.length);
        });
    }

    private publishEntriesAppendedWithSizeGuard(
        entry: ActiveSession,
        baseEntryCount: number,
        appended: readonly FileEntry[],
        totalCount: number,
    ): void {
        const entriesVersion = this.catalog.entriesVersion;
        if (shouldOffloadPayload({ itemCount: appended.length })) {
            entry.syncHost.publish({
                kind: "entries_appended",
                entriesVersion,
                baseEntryCount,
                entries: { mode: "http", meta: { entryCount: totalCount } },
            });
            return;
        }

        const inlineDelta: SessionDelta = {
            kind: "entries_appended",
            entriesVersion,
            baseEntryCount,
            entries: { mode: "inline", data: appended },
        };
        const serializedBytes = Buffer.byteLength(JSON.stringify(inlineDelta), "utf8");
        if (!shouldOffloadPayload({ serializedBytes })) {
            entry.syncHost.publish(inlineDelta, serializedBytes);
            return;
        }

        entry.syncHost.publish({
            kind: "entries_appended",
            entriesVersion,
            baseEntryCount,
            entries: { mode: "http", meta: { entryCount: totalCount } },
        });
    }

    private sendClient(client: SessionClient, message: SessionWsServerMessage): void {
        try {
            if (client.sendRaw !== undefined) {
                client.sendRaw(JSON.stringify(message));
            } else {
                client.send(message);
            }
        } catch (error) {
            this.logger.warn({ err: error }, "failed to send websocket message");
        }
    }

    private emitTrackedStateDiff(entry: ActiveSession): void {
        const state = entry.runtime.session.getState();
        const prev = entry.lastTrackedState;
        const patch: {
            messageCount?: number;
            steeringMode?: SessionStateSnapshot["steeringMode"];
            followUpMode?: SessionStateSnapshot["followUpMode"];
            autoCompactionEnabled?: boolean;
        } = {};
        let changed = false;
        if (state.messageCount !== prev.messageCount) {
            patch.messageCount = state.messageCount;
            prev.messageCount = state.messageCount;
            changed = true;
        }
        if (state.steeringMode !== prev.steeringMode) {
            patch.steeringMode = state.steeringMode;
            prev.steeringMode = state.steeringMode;
            changed = true;
        }
        if (state.followUpMode !== prev.followUpMode) {
            patch.followUpMode = state.followUpMode;
            prev.followUpMode = state.followUpMode;
            changed = true;
        }
        if (state.autoCompactionEnabled !== prev.autoCompactionEnabled) {
            patch.autoCompactionEnabled = state.autoCompactionEnabled;
            prev.autoCompactionEnabled = state.autoCompactionEnabled;
            changed = true;
        }
        if (changed) {
            entry.syncHost.publish({ kind: "state_patched", patch });
        }
    }

    private publishSessionDelta(sessionId: SessionId, delta: SessionDelta): void {
        const entry = this.active.get(sessionId);
        if (entry === undefined) {
            return;
        }
        entry.syncHost.publish(delta);
    }

    private handleSessionEvent(entry: ActiveSession, event: AgentSessionEvent): void {
        if (event.type === "message_start") {
            entry.liveMessage = event.message.role === "assistant" ? event.message : null;
        } else if (event.type === "message_update") {
            if (event.message.role === "assistant") {
                entry.liveMessage = event.message;
            }
        } else if (event.type === "message_end") {
            if (event.message.role === "assistant") {
                entry.liveMessage = null;
            } else if (event.message.role === "user" && entry.firstMessage === null) {
                entry.firstMessage = extractUserMessageText(event.message.content);
            }
        } else if (event.type === "agent_settled") {
            entry.liveMessage = null;
        }

        let wire: JsonAgentSessionEvent;
        try {
            wire = toWireSessionEvent(event);
        } catch (error) {
            this.logger.warn({ err: error, sessionId: entry.sessionId }, "failed to convert session event");
            return;
        }

        entry.syncHost.publish({ kind: "agent_event", event: wire });
        entry.lastActivityMs = this.nowMs();
        this.emitTrackedStateDiff(entry);

        if (
            event.type === "agent_start" ||
            event.type === "agent_end" ||
            event.type === "agent_settled" ||
            event.type === "message_end" ||
            event.type === "compaction_start" ||
            event.type === "compaction_end"
        ) {
            this.emitSessionUpdated(entry);
        }

        if (event.type === "agent_settled" || event.type === "compaction_end") {
            this.touch(entry);
        }
    }

    /** Restart the idle countdown when the last dialog resolves and no client is attached. */
    private handlePendingChange(sessionId: SessionId): void {
        const entry = this.active.get(sessionId);
        if (entry !== undefined && entry.lifecycle.phase === "open" && entry.clients.size === 0) {
            this.touch(entry);
        }
    }

    private pendingUiRemainingMs(entry: ActiveSession): number | undefined {
        if (!entry.uiBridge.hasPending() || this.pendingUiTimeoutMs === null) {
            return undefined;
        }
        const anchor = Math.max(entry.lastClientDetachMs ?? 0, entry.uiBridge.lastPendingAtMs ?? 0);
        return Math.max(0, anchor + this.pendingUiTimeoutMs - this.nowMs());
    }

    /**
     * Schedule idle reclamation, or keep the runtime alive while a client is attached.
     * Pending dialogs pause idle reclamation; with a finite `pendingUiTimeoutMs`, the timer is
     * shortened to the remaining dialog grace period even when the run reports streaming.
     */
    private touch(entry: ActiveSession): void {
        if (this.idleTimeoutMs <= 0 || this.disposed || entry.lifecycle.phase !== "open") {
            return;
        }
        this.clearIdleTimer(entry);
        if (entry.clients.size > 0) {
            return;
        }

        let delay = this.idleTimeoutMs;
        const pendingRemaining = this.pendingUiRemainingMs(entry);
        if (pendingRemaining !== undefined) {
            delay = Math.min(delay, pendingRemaining);
        }

        const timer = setTimeout(() => {
            entry.idleTimer = undefined;
            this.reapIdle(entry);
        }, delay);
        timer.unref();
        entry.idleTimer = timer;
    }

    private reapIdle(entry: ActiveSession): void {
        if (
            this.disposed ||
            this.active.get(entry.sessionId) !== entry ||
            entry.lifecycle.phase !== "open" ||
            entry.clients.size > 0
        ) {
            return;
        }

        // Evaluate finite pending-dialog timeouts before checking streaming state: a tool blocked on
        // a dialog keeps `isStreaming` true while waiting for the user.
        if (this.pendingUiRemainingMs(entry) === 0) {
            void this.closeSession(entry.sessionId).catch((error: unknown) => {
                this.logger.warn(
                    { err: error, sessionId: entry.sessionId },
                    "failed to reclaim session with expired pending dialog",
                );
            });
            return;
        }

        const state = entry.runtime.session.getState();
        if (state.isStreaming || state.isCompacting || entry.uiBridge.hasPending()) {
            this.touch(entry);
            return;
        }

        void this.closeSession(entry.sessionId).catch((error: unknown) => {
            this.logger.warn({ err: error, sessionId: entry.sessionId }, "failed to reclaim idle session");
        });
    }

    private clearIdleTimer(entry: ActiveSession): void {
        if (entry.idleTimer === undefined) {
            return;
        }
        clearTimeout(entry.idleTimer);
        entry.idleTimer = undefined;
    }

    private emitSessionUpserted(entry: ActiveSession, session: SessionSummary): void {
        if (this.active.get(entry.sessionId) !== entry) {
            return;
        }
        this.catalogHost.publish({
            op: "upsert",
            item: session,
        });
    }

    private emitSessionUpdated(entry: ActiveSession): void {
        if (this.active.get(entry.sessionId) !== entry) {
            return;
        }
        const previous = entry.lastSummary;
        const next = this.summarizeEntry(entry);
        entry.lastSummary = next;
        if (previous === null) {
            return;
        }
        const patch = diffSessionSummary(previous, next);
        if (patch === null) {
            return;
        }
        this.catalogHost.publish({
            op: "patch",
            id: entry.sessionId,
            patch,
        });
    }

    private async resolvePersistedOnClose(sessionId: SessionId, hadDiskFile: boolean): Promise<boolean> {
        if (this.disposed) {
            return hadDiskFile;
        }
        try {
            const resolution = await this.catalog.resolveById(sessionId);
            switch (resolution.kind) {
                case "found":
                case "oversized":
                    return true;
                case "missing":
                    return false;
                default:
                    return assertNever(resolution);
            }
        } catch (error) {
            this.logger.warn({ err: error, sessionId }, "failed to check disk session after runtime close");
            return hadDiskFile;
        }
    }

    private publishSessionClosed(sessionId: SessionId, persisted: boolean): void {
        if (this.disposed) {
            return;
        }
        if (persisted) {
            this.catalogHost.publish({
                op: "patch",
                id: sessionId,
                patch: {
                    runtimeState: "idle",
                    attachedClients: 0,
                },
            });
            return;
        }
        this.catalogHost.publish({
            op: "remove",
            id: sessionId,
        });
    }
}
