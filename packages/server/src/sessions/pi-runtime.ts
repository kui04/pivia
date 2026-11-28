import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
    type AgentSession,
    type CompactionResult,
    type CreateAgentSessionRuntimeFactory,
    type CreateAgentSessionServicesOptions,
    createAgentSessionFromServices,
    createAgentSessionRuntime,
    createAgentSessionServices,
    createCodemodeExtension,
    createMcpExtension,
    createToolSearchExtension,
    getAgentDir,
    type PromptOptions,
    type SessionManager,
} from "@earendil-works/pi-coding-agent";

import { parseSessionId, type SessionId, type SessionModelInfo } from "@pivia/protocol";

import type {
    ManagedExtensionBindings,
    ManagedPromptOptions,
    ManagedSession,
    ManagedSessionState,
    RuntimeFactory,
    SessionRegistryLogger,
} from "./runtime.ts";

type ResourceLoaderOptions = NonNullable<CreateAgentSessionServicesOptions["resourceLoaderOptions"]>;

/** Options for {@link createPiRuntimeFactory}. */
export interface PiRuntimeFactoryOptions {
    /** Agent configuration directory (`PI_CODING_AGENT_DIR`); defaults to the SDK location. */
    readonly agentDir?: string | undefined;
    /** Destination for resource diagnostics and model fallback warnings. */
    readonly logger?: SessionRegistryLogger | undefined;
    /** Extra resource loader options; the server always appends the three SDK built-in extension factories. */
    readonly resourceLoaderOptions?: ResourceLoaderOptions | undefined;
}

/** Entry-appending `SessionManager` methods whose calls must reach the broadcast hook. */
export const SESSION_APPEND_METHODS = [
    "appendMessage",
    "appendThinkingLevelChange",
    "appendModelChange",
    "appendUsage",
    "appendCompaction",
    "appendCustomEntry",
    "appendSessionInfo",
    "appendCustomMessageEntry",
    "appendContextEdit",
    "appendLabelChange",
    "branchWithSummary",
] as const satisfies readonly (keyof SessionManager)[];

type SessionAppendMethodName = (typeof SESSION_APPEND_METHODS)[number];

/**
 * Wrap all 11 public entry-appending methods on `SessionManager` so silent SDK writes
 * (`setLabel`, `ctx.setModel`, `_recordModelSelection`, `_flushPendingBashMessages`, etc.) notify
 * listeners synchronously without missing writes that emit no `AgentSessionEvent`.
 */
export function observeSessionManagerAppends(sessionManager: SessionManager, onAppend: () => void): () => void {
    const target = sessionManager as unknown as Record<SessionAppendMethodName, (...args: unknown[]) => unknown>;
    const originals = new Map<SessionAppendMethodName, (...args: unknown[]) => unknown>();

    for (const methodName of SESSION_APPEND_METHODS) {
        const original = target[methodName];
        if (typeof original !== "function") {
            continue;
        }
        originals.set(methodName, original);
        target[methodName] = function (this: SessionManager, ...args: unknown[]): unknown {
            const result = original.apply(this, args);
            onAppend();
            return result;
        };
    }

    return () => {
        for (const [methodName, original] of originals) {
            target[methodName] = original;
        }
        originals.clear();
    };
}

function toModelInfo(model: SessionModelInfo): SessionModelInfo {
    return {
        provider: model.provider,
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        reasoning: model.reasoning,
    };
}

/**
 * Structural adapter between the SDK `AgentSession` and the narrow {@link ManagedSession}
 * interface used by the session registry.
 *
 * Keeping the adapter small lets tests substitute a fake session without constructing an SDK
 * session, while production keeps the complete SDK behavior.
 */
class AgentSessionAdapter implements ManagedSession {
    readonly sessionId: SessionId;
    private readonly session: AgentSession;

    constructor(session: AgentSession) {
        const sessionId = parseSessionId(session.sessionId);
        if (sessionId === null) {
            throw new Error(`Invalid SDK session id: ${session.sessionId}`);
        }
        this.sessionId = sessionId;
        this.session = session;
    }

    getName(): string | null {
        return this.session.sessionName ?? null;
    }

    getCwd(): string {
        return this.session.sessionManager.getCwd();
    }

    getEntries() {
        const header = this.session.sessionManager.getHeader();
        const entries = this.session.sessionManager.getEntries();
        return header === null ? entries : [header, ...entries];
    }

    getEntryCount(): number {
        const header = this.session.sessionManager.getHeader();
        return this.session.sessionManager.getEntryCount() + (header !== null ? 1 : 0);
    }

    onEntryAppended(listener: () => void): () => void {
        return observeSessionManagerAppends(this.session.sessionManager, listener);
    }

    getState(): ManagedSessionState {
        const model = this.session.model;
        const routed = this.session.routedModel;
        return {
            model: model === undefined ? null : toModelInfo(model),
            contextUsage: this.session.getContextUsage() ?? null,
            routedModel:
                routed === undefined
                    ? null
                    : {
                          model: toModelInfo(routed.model),
                          ...(routed.thinkingLevel === undefined ? {} : { thinkingLevel: routed.thinkingLevel }),
                      },
            thinkingLevel: this.session.thinkingLevel,
            isStreaming: this.session.isStreaming,
            isCompacting: this.session.isCompacting,
            steeringMode: this.session.steeringMode,
            followUpMode: this.session.followUpMode,
            autoCompactionEnabled: this.session.autoCompactionEnabled,
            messageCount: this.session.messages.length,
            steeringMessages: this.session.getSteeringMessages(),
            followUpMessages: this.session.getFollowUpMessages(),
        };
    }

    subscribe(listener: Parameters<ManagedSession["subscribe"]>[0]): () => void {
        return this.session.subscribe(listener);
    }

    async bindExtensions(bindings: ManagedExtensionBindings): Promise<void> {
        await this.session.bindExtensions({ ...bindings, mode: "rpc" });
    }

    async prompt(text: string, options: ManagedPromptOptions): Promise<void> {
        const promptOptions: PromptOptions = {
            source: "rpc",
            preflightResult: options.preflightResult,
            ...(options.images === undefined ? {} : { images: options.images }),
            ...(options.streamingBehavior === undefined ? {} : { streamingBehavior: options.streamingBehavior }),
        };
        await this.session.prompt(text, promptOptions);
    }

    async steer(text: string, images?: ImageContent[]) {
        return await this.session.steer(text, images, { source: "rpc" });
    }

    async followUp(text: string, images?: ImageContent[]) {
        return await this.session.followUp(text, images, { source: "rpc" });
    }

    async abort(): Promise<void> {
        await this.session.abort();
    }

    clearQueue() {
        return this.session.clearQueue();
    }

    async waitForIdle(): Promise<void> {
        await this.session.waitForIdle();
    }

    async reload(): Promise<void> {
        await this.session.reload();
    }

    getAvailableModels(): readonly SessionModelInfo[] {
        return this.session.modelRuntime.getAvailableSnapshot().map(toModelInfo);
    }

    async setModel(provider: string, modelId: string): Promise<SessionModelInfo> {
        const model = this.session.modelRuntime
            .getAvailableSnapshot()
            .find((candidate) => candidate.provider === provider && candidate.id === modelId);
        if (model === undefined) {
            throw new Error(`Model not found: ${provider}/${modelId}`);
        }
        await this.session.setModel(model);
        return toModelInfo(model);
    }

    getAvailableThinkingLevels(): readonly ThinkingLevel[] {
        return this.session.getAvailableThinkingLevels();
    }

    setThinkingLevel(level: ThinkingLevel): void {
        this.session.setThinkingLevel(level);
    }

    setSessionName(name: string): void {
        this.session.setSessionName(name);
    }

    async compact(customInstructions?: string): Promise<CompactionResult> {
        return customInstructions === undefined
            ? await this.session.compact()
            : await this.session.compact(customInstructions);
    }
}

/**
 * Create the production runtime factory.
 *
 * Each runtime owns one `AgentSessionRuntime` built from cwd-bound services. The SDK does not load
 * `codemode`, `tool_search`, or MCP for SDK sessions, so this factory appends those built-in
 * extension factories; the user's own `defaultTools` setting still decides whether they activate.
 */
export function createPiRuntimeFactory(options: PiRuntimeFactoryOptions = {}): RuntimeFactory {
    const agentDir = options.agentDir ?? getAgentDir();
    const logger = options.logger;

    const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
        const services = await createAgentSessionServices({
            cwd,
            agentDir,
            resourceLoaderOptions: {
                ...options.resourceLoaderOptions,
                extensionFactories: [
                    ...(options.resourceLoaderOptions?.extensionFactories ?? []),
                    createCodemodeExtension(),
                    createToolSearchExtension(),
                    createMcpExtension(),
                ],
            },
        });

        if (logger !== undefined) {
            for (const diagnostic of services.diagnostics) {
                if (diagnostic.type === "info") {
                    continue;
                }
                logger.warn(
                    { agentDir, cwd, diagnosticType: diagnostic.type },
                    `session resource diagnostic: ${diagnostic.message}`,
                );
            }
        }

        const result = await createAgentSessionFromServices({
            services,
            sessionManager,
            ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
        });
        if (logger !== undefined && result.modelFallbackMessage !== undefined) {
            logger.warn({ agentDir, cwd }, result.modelFallbackMessage);
        }

        return {
            ...result,
            services,
            diagnostics: services.diagnostics,
        };
    };

    return async ({ cwd, sessionManager }) => {
        const runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager });
        return {
            session: new AgentSessionAdapter(runtime.session),
            dispose: () => runtime.dispose(),
        };
    };
}
