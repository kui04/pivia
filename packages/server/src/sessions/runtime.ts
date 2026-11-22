import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import {
    type AgentSessionEvent,
    type ExtensionCommandContextActions,
    type ExtensionError,
    type ExtensionUIContext,
    type FileEntry,
    getAgentDir,
    type JsonAgentSessionEvent,
    type PromptOptions,
    SessionManager,
} from "@earendil-works/pi-coding-agent";

import {
    assertNever,
    INITIAL_CATALOG_SEQ,
    nextCatalogSeq,
    parseCatalogEpoch,
    parseSessionId,
    SESSION_CLOSE_CODE,
} from "@pivia/protocol";
import type {
    AssistantMessage,
    CatalogEpoch,
    CatalogSeq,
    EntriesVersion,
    ImageContent,
    SessionCloseCode,
    SessionDetailResponse,
    SessionId,
    SessionListResponse,
    SessionModelInfo,
    SessionPrefixAnchor,
    SessionQueuedInputDisposition,
    SessionRuntimeState,
    SessionStateSnapshot,
    SessionSummary,
    SessionSummaryPatch,
    SessionWsClientCommand,
    SessionWsCommandName,
    SessionWsEntriesAppendedMessage,
    SessionWsReplayMessage,
    SessionWsResponseMessage,
    SessionWsServerMessage,
    SessionWsSnapshotMessage,
    ThinkingLevel,
    WorkspaceWsCatalogEvent,
} from "@pivia/protocol";

import { SessionUiBridge } from "./extension-ui.ts";
import { createLogger } from "../logger.ts";
import { createPiRuntimeFactory } from "./pi-runtime.ts";
import { SessionEventBuffer, toWireSessionEvent } from "./events.ts";
import { defaultProjectSessionDir, sliceEntriesForAnchor, type SessionCatalog } from "./catalog.ts";

/** Maximum inline WebSocket payload size before offloading entries to compressed HTTP. */
export const MAX_WS_INLINE_ENTRIES_BYTES = 512 * 1024;

/** Short-circuit threshold on entry count to avoid serializing huge sessions over WS. */
export const MAX_WS_INLINE_ENTRY_COUNT = 1000;

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

/** Options for {@link SessionRegistry.createSession}. */
export interface CreateSessionOptions {
    /** When true, creates the target working directory recursively if it does not exist. */
    readonly createDirectory?: boolean | undefined;
}

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
export type ManagedSessionState = Omit<SessionStateSnapshot, "sessionId" | "cwd" | "name">;

/** Options for one managed prompt. */
export interface ManagedPromptOptions {
    readonly images?: PromptOptions["images"];
    readonly streamingBehavior?: PromptOptions["streamingBehavior"];
    /** Called once the prompt is accepted, queued, or handled; not called when the prompt is rejected. */
    readonly preflightResult: NonNullable<PromptOptions["preflightResult"]>;
}

/** Extension bindings the registry installs on every managed session. */
export interface ManagedExtensionBindings {
    readonly uiContext: ExtensionUIContext;
    readonly commandContextActions: ExtensionCommandContextActions;
    readonly shutdownHandler: () => void;
    readonly onError: (error: ExtensionError) => void;
}

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
    subscribe(listener: (event: AgentSessionEvent) => void): () => void;
    bindExtensions(bindings: ManagedExtensionBindings): Promise<void>;
    prompt(text: string, options: ManagedPromptOptions): Promise<void>;
    steer(text: string, images?: ImageContent[]): Promise<SessionQueuedInputDisposition>;
    followUp(text: string, images?: ImageContent[]): Promise<SessionQueuedInputDisposition>;
    abort(): Promise<void>;
    clearQueue(): { readonly steering: readonly string[]; readonly followUp: readonly string[] };
    waitForIdle(): Promise<void>;
    reload(): Promise<void>;
    getAvailableModels(): readonly SessionModelInfo[];
    /** Returns the selected model, or throws when the model is unknown or has no credentials. */
    setModel(provider: string, modelId: string): Promise<SessionModelInfo>;
    getAvailableThinkingLevels(): readonly ThinkingLevel[];
    setThinkingLevel(level: ThinkingLevel): void;
    setSessionName(name: string): void;
    compact(customInstructions?: string): Promise<unknown>;
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
export interface SessionAttachOptions {
    /** Replay events after this sequence; omit or send an out-of-range value to skip Tier 1. */
    readonly afterSeq?: number | undefined;
    /** Runtime id held by the client; must match the active runtime for Tier 1 replay. */
    readonly runtimeId?: string | undefined;
    /** Client's persisted prefix anchor for Tier 1 append slicing and Tier 2 patch matching. */
    readonly prefixAnchor?: SessionPrefixAnchor | undefined;
}

/** One attached client's command channel. */
export interface SessionAttachment {
    readonly sessionId: SessionId;
    handleCommand(command: SessionWsClientCommand): Promise<void>;
    detach(): void;
}

/** Incremental catalog events emitted by {@link SessionRegistry.subscribeCatalog}. */
export type WorkspaceCatalogEvent = WorkspaceWsCatalogEvent;

/** Listener invoked when a session summary changes or an unflushed session is removed. */
export type WorkspaceCatalogListener = (event: WorkspaceCatalogEvent) => void;

type ActiveSessionLifecycle =
    | { readonly phase: "starting" }
    | { readonly phase: "open" }
    | { readonly phase: "closing"; readonly closePromise: Promise<void> };

interface ActiveSession {
    readonly sessionId: SessionId;
    readonly runtimeId: string;
    readonly cwd: string;
    readonly runtime: ManagedRuntime;
    readonly buffer: SessionEventBuffer;
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
    flushScheduled: boolean;
    liveMessage: AssistantMessage | null;
    diskSizeBytes: number | undefined;
    readonly createdAtMs: number;
    readonly hasParent: boolean;
    firstMessage: string | null;
    lastSummary: SessionSummary | null;
}

interface HandshakeFallbackContext {
    readonly seq: number;
    readonly entriesVersion: EntriesVersion;
    readonly entryCount: number;
    readonly state: SessionStateSnapshot;
    readonly pendingUiRequests: readonly SessionWsSnapshotMessage["pendingUiRequests"][number][];
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
    private readonly catalogListeners = new Set<WorkspaceCatalogListener>();
    private readonly catalogEpoch: CatalogEpoch;
    private catalogSeq: CatalogSeq = INITIAL_CATALOG_SEQ;
    private disposed = false;

    constructor(options: SessionRegistryOptions) {
        this.catalog = options.catalog;
        this.agentDir = options.agentDir ?? getAgentDir();
        this.logger = options.logger ?? createLogger();
        this.nowMs = options.nowMs ?? (() => Date.now());
        const catalogEpoch = parseCatalogEpoch(randomUUID());
        if (catalogEpoch === null) {
            throw new Error("Generated invalid catalog epoch.");
        }
        this.catalogEpoch = catalogEpoch;

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
                await active.lifecycle.closePromise;
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
                this.closeClients(entry, closeCode, closeReason);
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
                this.closeClients(entry, closeCode, closeReason);
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
            const hadDiskFile = entry.diskSizeBytes !== undefined;
            entry.uiBridge.dispose();
            entry.unsubscribe();
            entry.unsubscribeEntries();
            this.closeClients(entry, closeCode, closeReason);
            this.active.delete(entry.sessionId);
            void this.emitSessionClosed(entry.sessionId, hadDiskFile);
        }
    }

    /** Dispose every in-flight registration and every active runtime. Safe to call more than once. */
    async disposeAll(): Promise<void> {
        if (this.disposed) {
            return;
        }
        this.disposed = true;

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

    /** Merge disk discovery with live runtimes, including new sessions that have not flushed a file. */
    async list(): Promise<SessionListResponse> {
        const disk = await this.catalog.list();
        const active = [...this.active.values()].map((entry) => this.summarizeEntry(entry));
        const activeById = new Map(active.map((summary) => [summary.id, summary]));
        const merged = disk.sessions.map((summary) => activeById.get(summary.id) ?? summary);
        const mergedIds = new Set(merged.map((summary) => summary.id));
        const missing = active.filter((summary) => !mergedIds.has(summary.id));
        const sessions = [...merged, ...missing].sort((left, right) => right.modifiedAtMs - left.modifiedAtMs);
        return {
            sessions,
            scannedAtMs: disk.scannedAtMs,
            catalogEpoch: this.catalogEpoch,
            catalogSeq: this.catalogSeq,
        };
    }

    /** Subscribe to incremental catalog changes emitted by open runtimes. */
    subscribeCatalog(listener: WorkspaceCatalogListener): () => void {
        this.catalogListeners.add(listener);
        let active = true;
        return () => {
            if (!active) {
                return;
            }
            active = false;
            this.catalogListeners.delete(listener);
        };
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

        // Build the initial payload before adding the client so a failed snapshot cannot leak a
        // client that no attachment can detach.
        const state = this.buildState(entry);
        const pendingUiRequests = entry.uiBridge.pendingRequests();

        entry.clients.add(client);
        this.clearIdleTimer(entry);
        this.sendHandshakeWithSizeGuard(entry, client, state, pendingUiRequests, options);
        this.emitSessionUpdated(entry);

        let attached = true;
        return {
            sessionId,
            handleCommand: async (command) => {
                await this.handleCommand(entry, client, command);
            },
            detach: () => {
                if (!attached) {
                    return;
                }
                attached = false;
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

        const ready = Promise.withResolvers<void>();
        const uiBridge = new SessionUiBridge(sessionId, (message) => this.broadcastById(sessionId, message), {
            onPendingChange: () => {
                this.handlePendingChange(sessionId);
            },
            nowMs: this.nowMs,
        });
        const now = this.nowMs();
        const initialEntries = session.getEntries();
        const header = initialEntries[0]?.type === "session" ? initialEntries[0] : null;
        const parsedCreatedAtMs = header === null ? Number.NaN : Date.parse(header.timestamp);
        const entry: ActiveSession = {
            sessionId,
            runtimeId: randomUUID(),
            cwd: session.getCwd(),
            runtime,
            buffer: new SessionEventBuffer(),
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
                    this.broadcastById(entry.sessionId, {
                        type: "extension_error",
                        sessionId: entry.sessionId,
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
        entry.unsubscribe();
        entry.unsubscribeEntries();
        entry.uiBridge.dispose();
        const hadDiskFile = entry.diskSizeBytes !== undefined;
        this.closeClients(entry, SESSION_CLOSE_CODE.internalError, "Session failed to initialize");
        this.active.delete(entry.sessionId);
        try {
            await entry.runtime.dispose();
        } catch (disposeError) {
            this.logger.warn(
                { err: disposeError, sessionId: entry.sessionId },
                "failed to dispose runtime after bind failure",
            );
        } finally {
            void this.emitSessionClosed(entry.sessionId, hadDiskFile);
            closing.resolve();
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
            reload: () => entry.runtime.session.reload(),
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

    private async handleCommand(
        entry: ActiveSession,
        client: SessionClient,
        command: SessionWsClientCommand,
    ): Promise<void> {
        if (command.type === "extension_ui_response") {
            const result = entry.uiBridge.handleResponse(command);
            if (!result.ok && result.reason === "mismatched") {
                this.sendError(client, "invalid_request", `Response does not match pending dialog ${command.id}.`);
            }
            return;
        }

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
        const message: SessionWsResponseMessage = {
            type: "response",
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
            type: "response",
            command,
            success: false,
            ...(id === undefined ? {} : { id }),
            error,
        });
    }

    private sendError(client: SessionClient, code: string, message: string, id?: string): void {
        this.sendClient(client, { type: "error", code, message, ...(id === undefined ? {} : { id }) });
    }

    private sendClientRaw(client: SessionClient, raw: string, fallbackMessage: SessionWsServerMessage): void {
        try {
            if (client.sendRaw !== undefined) {
                client.sendRaw(raw);
            } else {
                client.send(fallbackMessage);
            }
        } catch (error) {
            this.logger.warn({ err: error }, "failed to send raw websocket message");
        }
    }

    private sendHttpSnapshot(
        entry: ActiveSession,
        client: SessionClient,
        baseEntryCount: number,
        context: HandshakeFallbackContext,
    ): void {
        this.sendClient(client, {
            type: "snapshot",
            sessionId: entry.sessionId,
            runtimeId: entry.runtimeId,
            seq: context.seq,
            entriesVersion: context.entriesVersion,
            baseEntryCount,
            entriesMode: "http",
            entryCount: context.entryCount,
            state: context.state,
            liveMessage: entry.liveMessage,
            pendingUiRequests: context.pendingUiRequests,
        });
    }

    private sendHandshakeOrHttpFallback(
        entry: ActiveSession,
        client: SessionClient,
        message: SessionWsReplayMessage | SessionWsSnapshotMessage,
        baseEntryCount: number,
        context: HandshakeFallbackContext,
    ): void {
        const raw = JSON.stringify(message);
        if (Buffer.byteLength(raw, "utf8") <= MAX_WS_INLINE_ENTRIES_BYTES) {
            this.sendClientRaw(client, raw, message);
            return;
        }
        this.sendHttpSnapshot(entry, client, baseEntryCount, context);
    }

    private sendHandshakeWithSizeGuard(
        entry: ActiveSession,
        client: SessionClient,
        state: SessionStateSnapshot,
        pendingUiRequests: readonly SessionWsSnapshotMessage["pendingUiRequests"][number][],
        options: SessionAttachOptions,
    ): void {
        const entriesVersion = this.catalog.entriesVersion;
        const entries = entry.runtime.session.getEntries();
        const totalCount = entries.length;
        const replay = entry.buffer.since(options.afterSeq);
        const fallback: HandshakeFallbackContext = {
            seq: replay.seq,
            entriesVersion,
            entryCount: totalCount,
            state,
            pendingUiRequests,
        };

        if (options.runtimeId === entry.runtimeId && replay.kind === "replay") {
            if (options.prefixAnchor === undefined) {
                const replayMsg: SessionWsReplayMessage = {
                    type: "replay",
                    sessionId: entry.sessionId,
                    runtimeId: entry.runtimeId,
                    seq: replay.seq,
                    entriesVersion,
                    state,
                    events: replay.events,
                    liveMessage: entry.liveMessage,
                    pendingUiRequests,
                };
                this.sendHandshakeOrHttpFallback(entry, client, replayMsg, 0, fallback);
                return;
            }

            const sliced = sliceEntriesForAnchor(entry.sessionId, entries, entriesVersion, options.prefixAnchor);
            if (sliced.prefixMatched) {
                if (sliced.entries.length > MAX_WS_INLINE_ENTRY_COUNT) {
                    this.sendHttpSnapshot(entry, client, sliced.baseEntryCount, fallback);
                    return;
                }
                const replayMsg: SessionWsReplayMessage = {
                    type: "replay",
                    sessionId: entry.sessionId,
                    runtimeId: entry.runtimeId,
                    seq: replay.seq,
                    entriesVersion,
                    state,
                    events: replay.events,
                    liveMessage: entry.liveMessage,
                    ...(sliced.entries.length > 0
                        ? { appendedSlice: { baseEntryCount: sliced.baseEntryCount, entries: sliced.entries } }
                        : {}),
                    pendingUiRequests,
                };
                this.sendHandshakeOrHttpFallback(entry, client, replayMsg, sliced.baseEntryCount, fallback);
                return;
            }
        }

        const sliced =
            options.prefixAnchor !== undefined
                ? sliceEntriesForAnchor(entry.sessionId, entries, entriesVersion, options.prefixAnchor)
                : { baseEntryCount: 0, entries, prefixMatched: false };

        const overDiskHint =
            sliced.baseEntryCount === 0 &&
            entry.diskSizeBytes !== undefined &&
            entry.diskSizeBytes > MAX_WS_INLINE_ENTRIES_BYTES;
        if (sliced.entries.length > MAX_WS_INLINE_ENTRY_COUNT || overDiskHint) {
            this.sendHttpSnapshot(entry, client, sliced.baseEntryCount, fallback);
            return;
        }

        const inlineSnapshot: SessionWsSnapshotMessage = {
            type: "snapshot",
            sessionId: entry.sessionId,
            runtimeId: entry.runtimeId,
            seq: replay.seq,
            entriesVersion,
            baseEntryCount: sliced.baseEntryCount,
            entriesMode: "inline",
            entries: sliced.entries,
            state,
            liveMessage: entry.liveMessage,
            pendingUiRequests,
        };
        this.sendHandshakeOrHttpFallback(entry, client, inlineSnapshot, sliced.baseEntryCount, fallback);
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
            if (appended.length === 0 || entry.clients.size === 0) {
                return;
            }
            this.sendEntriesAppendedWithSizeGuard(entry, baseEntryCount, appended, allEntries.length);
        });
    }

    private sendEntriesAppendedWithSizeGuard(
        entry: ActiveSession,
        baseEntryCount: number,
        appended: readonly FileEntry[],
        totalCount: number,
    ): void {
        const entriesVersion = this.catalog.entriesVersion;
        if (appended.length > MAX_WS_INLINE_ENTRY_COUNT) {
            this.broadcastSession(entry, {
                type: "entries_appended",
                sessionId: entry.sessionId,
                entriesVersion,
                entriesMode: "http",
                baseEntryCount,
                entryCount: totalCount,
            });
            return;
        }

        const inlineMsg: SessionWsEntriesAppendedMessage = {
            type: "entries_appended",
            sessionId: entry.sessionId,
            entriesVersion,
            entriesMode: "inline",
            baseEntryCount,
            entries: appended,
        };
        const raw = JSON.stringify(inlineMsg);
        if (Buffer.byteLength(raw, "utf8") <= MAX_WS_INLINE_ENTRIES_BYTES) {
            for (const client of [...entry.clients]) {
                this.sendClientRaw(client, raw, inlineMsg);
            }
            return;
        }

        this.broadcastSession(entry, {
            type: "entries_appended",
            sessionId: entry.sessionId,
            entriesVersion,
            entriesMode: "http",
            baseEntryCount,
            entryCount: totalCount,
        });
    }

    private sendClient(client: SessionClient, message: SessionWsServerMessage): void {
        try {
            client.send(message);
        } catch (error) {
            this.logger.warn({ err: error }, "failed to send websocket message");
        }
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

        const sequenced = entry.buffer.push(wire);
        entry.lastActivityMs = this.nowMs();
        this.broadcastSession(entry, {
            type: "event",
            sessionId: entry.sessionId,
            seq: sequenced.seq,
            event: wire,
        });

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

    private broadcastById(sessionId: SessionId, message: SessionWsServerMessage): void {
        const entry = this.active.get(sessionId);
        if (entry !== undefined) {
            this.broadcastSession(entry, message);
        }
    }

    private broadcastSession(entry: ActiveSession, message: SessionWsServerMessage): void {
        for (const client of [...entry.clients]) {
            this.sendClient(client, message);
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

    private emitCatalogEvent(event: WorkspaceCatalogEvent): void {
        for (const listener of [...this.catalogListeners]) {
            try {
                listener(event);
            } catch (error) {
                this.logger.warn({ err: error }, "workspace catalog listener failed");
            }
        }
    }

    private emitSessionUpserted(entry: ActiveSession, session: SessionSummary): void {
        if (this.active.get(entry.sessionId) !== entry) {
            return;
        }
        this.catalogSeq = nextCatalogSeq(this.catalogSeq);
        if (this.catalogListeners.size === 0) {
            return;
        }
        this.emitCatalogEvent({
            type: "session_upserted",
            catalogEpoch: this.catalogEpoch,
            seq: this.catalogSeq,
            session,
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
        this.catalogSeq = nextCatalogSeq(this.catalogSeq);
        if (this.catalogListeners.size === 0) {
            return;
        }
        this.emitCatalogEvent({
            type: "session_updated",
            catalogEpoch: this.catalogEpoch,
            seq: this.catalogSeq,
            sessionId: entry.sessionId,
            patch,
        });
    }

    private async emitSessionClosed(sessionId: SessionId, hadDiskFile: boolean): Promise<void> {
        if (this.disposed) {
            return;
        }
        if (this.catalogListeners.size === 0) {
            if (!this.active.has(sessionId)) {
                this.catalogSeq = nextCatalogSeq(this.catalogSeq);
            }
            return;
        }
        let persisted = hadDiskFile;
        try {
            const resolution = await this.catalog.resolveById(sessionId);
            switch (resolution.kind) {
                case "found":
                case "oversized":
                    persisted = true;
                    break;
                case "missing":
                    persisted = false;
                    break;
                default:
                    assertNever(resolution);
            }
        } catch (error) {
            this.logger.warn({ err: error, sessionId }, "failed to check disk session after runtime close");
        }
        if (this.disposed || this.active.has(sessionId)) {
            return;
        }
        this.catalogSeq = nextCatalogSeq(this.catalogSeq);
        if (this.catalogListeners.size === 0) {
            return;
        }
        if (persisted) {
            this.emitCatalogEvent({
                type: "session_updated",
                catalogEpoch: this.catalogEpoch,
                seq: this.catalogSeq,
                sessionId,
                patch: {
                    runtimeState: "idle",
                    attachedClients: 0,
                },
            });
            return;
        }
        this.emitCatalogEvent({
            type: "session_removed",
            catalogEpoch: this.catalogEpoch,
            seq: this.catalogSeq,
            sessionId,
        });
    }

    private closeClients(entry: ActiveSession, code: SessionCloseCode, reason: string): void {
        for (const client of [...entry.clients]) {
            try {
                client.close?.(code, reason);
            } catch (error) {
                this.logger.warn({ err: error, sessionId: entry.sessionId }, "failed to close websocket client");
            }
        }
        entry.clients.clear();
    }
}
