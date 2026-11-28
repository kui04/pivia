import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSessionEvent, CompactionResult, FileEntry, SessionManager } from "@earendil-works/pi-coding-agent";

import { parseSessionId, type SessionId, type SessionModelInfo } from "@pivia/protocol";

import type {
    ManagedExtensionBindings,
    ManagedPromptOptions,
    ManagedRuntime,
    ManagedSession,
    ManagedSessionState,
    RuntimeFactory,
    RuntimeFactoryInput,
    SessionRegistryLogger,
} from "../sessions/runtime.ts";
import { observeSessionManagerAppends } from "../sessions/pi-runtime.ts";

/** Handler installed by a test to control `prompt()` timing and failures. */
export type FakePromptHandler = (text: string, options: ManagedPromptOptions) => Promise<void>;

function defaultState(): ManagedSessionState {
    return {
        model: {
            provider: "fake",
            id: "fake-model",
            name: "Fake Model",
            contextWindow: 200_000,
            reasoning: true,
        },
        contextUsage: null,
        routedModel: null,
        thinkingLevel: "medium",
        isStreaming: false,
        isCompacting: false,
        steeringMode: "one-at-a-time",
        followUpMode: "one-at-a-time",
        autoCompactionEnabled: true,
        messageCount: 0,
        steeringMessages: [],
        followUpMessages: [],
    };
}

/** In-memory session used by registry and route tests instead of a real SDK session. */
export class FakeSession implements ManagedSession {
    readonly sessionId: SessionId;
    bindings: ManagedExtensionBindings | undefined;
    bindExtensionsHandler: (bindings: ManagedExtensionBindings) => Promise<void> = (bindings) => {
        this.bindings = bindings;
        return Promise.resolve();
    };
    promptHandler: FakePromptHandler = (_text, options) => {
        options.preflightResult("started");
        return Promise.resolve();
    };
    setModelHandler: (provider: string, modelId: string) => SessionModelInfo = (provider, modelId) => ({
        provider,
        id: modelId,
        name: `${provider}/${modelId}`,
        contextWindow: 200_000,
        reasoning: true,
    });
    readonly promptCalls: Array<{ readonly text: string; readonly options: ManagedPromptOptions }> = [];
    readonly steerCalls: Array<{ readonly text: string; readonly images: unknown }> = [];
    readonly followUpCalls: Array<{ readonly text: string; readonly images: unknown }> = [];
    readonly compactCalls: Array<string | undefined> = [];
    abortCalls = 0;
    reloadCalls = 0;
    disposed = false;
    unsubscribeCalls = 0;

    private readonly cwd: string;
    private readonly sessionManager: SessionManager;
    private name: string | null = null;
    private state: ManagedSessionState = defaultState();
    private readonly listeners = new Set<(event: AgentSessionEvent) => void>();

    constructor(options: { sessionId: string; cwd: string; sessionManager: SessionManager }) {
        const parsedId = parseSessionId(options.sessionId);
        if (parsedId === null) {
            throw new Error(`Invalid fake session id: ${options.sessionId}`);
        }
        this.sessionId = parsedId;
        this.cwd = options.cwd;
        this.sessionManager = options.sessionManager;
    }

    setState(patch: Partial<ManagedSessionState>): void {
        this.state = { ...this.state, ...patch };
    }

    emit(event: AgentSessionEvent): void {
        for (const listener of this.listeners) {
            listener(event);
        }
    }

    getName(): string | null {
        return this.name;
    }

    getCwd(): string {
        return this.cwd;
    }

    getEntries(): readonly FileEntry[] {
        const header = this.sessionManager.getHeader();
        const entries = this.sessionManager.getEntries();
        return header === null ? entries : [header, ...entries];
    }

    getEntryCount(): number {
        const header = this.sessionManager.getHeader();
        return this.sessionManager.getEntryCount() + (header !== null ? 1 : 0);
    }

    onEntryAppended(listener: () => void): () => void {
        return observeSessionManagerAppends(this.sessionManager, listener);
    }

    appendUserMessage(text: string): string {
        return this.sessionManager.appendMessage({
            role: "user",
            content: text,
            timestamp: Date.now(),
        });
    }

    getState(): ManagedSessionState {
        return this.state;
    }

    subscribe(listener: (event: AgentSessionEvent) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    bindExtensions(bindings: ManagedExtensionBindings): Promise<void> {
        return this.bindExtensionsHandler(bindings);
    }

    async prompt(text: string, options: ManagedPromptOptions): Promise<void> {
        this.promptCalls.push({ text, options });
        await this.promptHandler(text, options);
    }

    steer(text: string, images?: ImageContent[]): Promise<"handled" | "queued"> {
        this.steerCalls.push({ text, images });
        return Promise.resolve("queued");
    }

    followUp(text: string, images?: ImageContent[]): Promise<"handled" | "queued"> {
        this.followUpCalls.push({ text, images });
        return Promise.resolve("handled");
    }

    abort(): Promise<void> {
        this.abortCalls += 1;
        return Promise.resolve();
    }

    clearQueue(): { steering: string[]; followUp: string[] } {
        const steering = [...this.state.steeringMessages];
        const followUp = [...this.state.followUpMessages];
        this.setState({ steeringMessages: [], followUpMessages: [] });
        return { steering, followUp };
    }

    waitForIdle(): Promise<void> {
        return Promise.resolve();
    }

    reload(): Promise<void> {
        this.reloadCalls += 1;
        return Promise.resolve();
    }

    getAvailableModels(): readonly SessionModelInfo[] {
        return [this.state.model].filter((model): model is SessionModelInfo => model !== null);
    }

    setModel(provider: string, modelId: string): Promise<SessionModelInfo> {
        const model = this.setModelHandler(provider, modelId);
        this.setState({ model });
        return Promise.resolve(model);
    }

    getAvailableThinkingLevels(): readonly ThinkingLevel[] {
        return ["off", "minimal", "low", "medium", "high"];
    }

    setThinkingLevel(level: ThinkingLevel): void {
        this.setState({ thinkingLevel: level });
    }

    setSessionName(name: string): void {
        this.name = name;
    }

    compact(customInstructions?: string): Promise<CompactionResult> {
        this.compactCalls.push(customInstructions);
        return Promise.resolve({
            summary: "fake compaction",
            firstKeptEntryId: "entry-0",
            tokensBefore: 1000,
            details: undefined,
        });
    }
}

/** Managed runtime wrapper that records disposal. */
export class FakeRuntime implements ManagedRuntime {
    readonly session: FakeSession;
    disposeCalls = 0;
    /** Optional hook that simulates work a real runtime does during `session_shutdown`. */
    disposeHandler: ((session: FakeSession) => Promise<void>) | undefined;

    constructor(session: FakeSession) {
        this.session = session;
    }

    async dispose(): Promise<void> {
        if (this.disposeHandler !== undefined) {
            await this.disposeHandler(this.session);
        }
        this.disposeCalls += 1;
        this.session.disposed = true;
    }
}

/** Fake factory plus the runtimes it created. */
export interface FakeRuntimeHarness {
    readonly factory: RuntimeFactory;
    readonly runtimes: FakeRuntime[];
    readonly sessions: FakeSession[];
    readonly inputs: RuntimeFactoryInput[];
    find(sessionId: string): FakeRuntime | undefined;
}

/** Options for {@link createFakeRuntimeHarness}. */
export interface FakeRuntimeHarnessOptions {
    /** Delay before a runtime is returned, to widen the concurrent-open window. */
    readonly delayMs?: number | undefined;
    /** Called after a session is constructed, before the runtime is returned. */
    readonly onCreate?: ((session: FakeSession, input: RuntimeFactoryInput) => void) | undefined;
}

/** Build a runtime factory that never contacts a model. */
export function createFakeRuntimeHarness(options: FakeRuntimeHarnessOptions = {}): FakeRuntimeHarness {
    const runtimes: FakeRuntime[] = [];
    const sessions: FakeSession[] = [];
    const inputs: RuntimeFactoryInput[] = [];

    const factory: RuntimeFactory = async (input) => {
        inputs.push(input);
        if (options.delayMs !== undefined && options.delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, options.delayMs));
        }
        const session = new FakeSession({
            sessionId: input.sessionManager.getSessionId(),
            cwd: input.sessionManager.getCwd(),
            sessionManager: input.sessionManager,
        });
        options.onCreate?.(session, input);
        sessions.push(session);
        const runtime = new FakeRuntime(session);
        runtimes.push(runtime);
        return runtime;
    };

    return {
        factory,
        runtimes,
        sessions,
        inputs,
        find: (sessionId) => runtimes.find((runtime) => runtime.session.sessionId === sessionId),
    };
}

/** Logger that records warnings so tests can assert diagnostics without writing to stderr. */
export interface RecordingLogger {
    readonly logger: SessionRegistryLogger;
    readonly warnings: Array<{ readonly record: Record<string, unknown>; readonly message: string }>;
}

export function createRecordingLogger(): RecordingLogger {
    const warnings: Array<{ readonly record: Record<string, unknown>; readonly message: string }> = [];
    return {
        warnings,
        logger: {
            warn(record, message) {
                warnings.push({ record, message });
            },
        },
    };
}

/** Message fixture used to build session JSONL files without invoking the SDK. */
export interface SessionFixtureMessage {
    readonly role: "user" | "assistant";
    readonly text: string;
}

/** Options for {@link writeSessionFixture}. */
export interface SessionFixtureOptions {
    readonly cwd?: string;
    /** ISO timestamp for the header and every entry; defaults to `2026-04-01T00:00:00.000Z`. */
    readonly timestamp?: string;
    readonly messages?: readonly SessionFixtureMessage[];
    readonly name?: string;
}

/** Write one v3 session file that `SessionCatalog` and `SessionManager.open` accept. */
export function writeSessionFixture(filePath: string, id: string, options: SessionFixtureOptions = {}): void {
    const timestamp = options.timestamp ?? "2026-04-01T00:00:00.000Z";
    const lines: string[] = [
        JSON.stringify({
            type: "session",
            version: 3,
            id,
            timestamp,
            cwd: options.cwd ?? "/tmp/pivia-fake-project",
        }),
    ];

    let parentId: string | null = null;
    let index = 0;
    for (const message of options.messages ?? []) {
        const entryId = `entry-${index}`;
        lines.push(
            JSON.stringify({
                type: "message",
                id: entryId,
                parentId,
                timestamp,
                message: {
                    role: message.role,
                    content: message.text,
                    timestamp: Date.parse(timestamp),
                },
            }),
        );
        parentId = entryId;
        index += 1;
    }

    if (options.name !== undefined) {
        lines.push(
            JSON.stringify({
                type: "session_info",
                id: `entry-${index}`,
                parentId,
                timestamp,
                name: options.name,
            }),
        );
    }

    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

/** Build a realistic assistant `message_update` event with cumulative snapshots attached. */
export function createTextDeltaEvent(delta: string, cumulativeText: string): AgentSessionEvent {
    const usage = {
        input: 10,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 12,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const message = {
        role: "assistant",
        content: [{ type: "text", text: cumulativeText }],
        api: "fake",
        provider: "fake",
        model: "fake-model",
        usage,
        stopReason: "stop",
        timestamp: 1,
    };
    return {
        type: "message_update",
        message,
        assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta,
            partial: { ...message, content: [{ type: "text", text: delta }] },
        },
    } as unknown as AgentSessionEvent;
}
