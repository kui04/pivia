import {
    type HighlightToken,
    type HighlightWorkerRequest,
    parseHighlightWorkerResponse,
    resolveLanguage,
} from "./highlight-protocol";

export type { HighlightToken } from "./highlight-protocol";
export { resolveLanguage } from "./highlight-protocol";

/** Options controlling cancellation of a queued {@link highlight} request. */
export interface HighlightOptions {
    /** Aborts a pending highlight when its CodeBlock unmounts or switches code/language. */
    readonly signal?: AbortSignal | undefined;
}

/** Strategy executing Shiki tokenization either in a Web Worker or directly as fallback. */
export interface HighlightExecutor {
    execute(
        code: string,
        grammarId: string,
        signal?: AbortSignal,
    ): Promise<readonly (readonly HighlightToken[])[] | undefined>;
    dispose?(): void;
}

/** Minimal Worker subset required by {@link createWorkerHighlightExecutor}. */
export interface HighlightWorkerPort {
    postMessage(message: HighlightWorkerRequest): void;
    addEventListener(type: "message", listener: (event: { readonly data: unknown }) => void): void;
    addEventListener(type: "error" | "messageerror", listener: () => void): void;
    removeEventListener?(type: "message", listener: (event: { readonly data: unknown }) => void): void;
    removeEventListener?(type: "error" | "messageerror", listener: () => void): void;
    terminate?(): void;
}

interface DirectHighlightJob {
    readonly code: string;
    readonly grammarId: string;
    readonly signal: AbortSignal | undefined;
    readonly resolve: (tokens: readonly (readonly HighlightToken[])[] | undefined) => void;
    readonly reject: (error: unknown) => void;
    readonly removeAbortListener: () => void;
}

interface AbortableJobHandle {
    readonly promise: Promise<readonly (readonly HighlightToken[])[] | undefined>;
    readonly resolve: (tokens: readonly (readonly HighlightToken[])[] | undefined) => void;
    readonly reject: (error: unknown) => void;
    readonly cleanup: () => void;
}

function createAbortableHighlightJob(
    signal: AbortSignal | undefined,
    onAbort: (resolve: (tokens: readonly (readonly HighlightToken[])[] | undefined) => void) => void,
): AbortableJobHandle {
    let resolveFn!: (tokens: readonly (readonly HighlightToken[])[] | undefined) => void;
    let rejectFn!: (error: unknown) => void;
    let settled = false;

    const finishResolve = (value: readonly (readonly HighlightToken[])[] | undefined): void => {
        if (settled) {
            return;
        }
        settled = true;
        resolveFn(value);
    };

    const finishReject = (error: unknown): void => {
        if (settled) {
            return;
        }
        settled = true;
        rejectFn(error instanceof Error ? error : new Error(String(error)));
    };

    const handleAbort = (): void => {
        onAbort(finishResolve);
    };

    const promise = new Promise<readonly (readonly HighlightToken[])[] | undefined>((resolve, reject) => {
        resolveFn = resolve;
        rejectFn = reject;
        if (signal !== undefined) {
            signal.addEventListener("abort", handleAbort, { once: true });
        }
    });

    return {
        promise,
        resolve: finishResolve,
        reject: finishReject,
        cleanup: () => {
            signal?.removeEventListener("abort", handleAbort);
        },
    };
}

/**
 * Fallback main-thread executor used in Node unit tests and if the dedicated
 * highlight Web Worker cannot start. Yields across macrotasks between queued jobs
 * so back-to-back blocks do not stack into one long main-thread task.
 */
function createDirectHighlightExecutor(scheduleTurn?: (flush: () => void) => void): HighlightExecutor {
    const queue: DirectHighlightJob[] = [];
    let draining = false;
    const schedule =
        scheduleTurn ??
        ((flush: () => void) => {
            setTimeout(flush, 0);
        });

    async function drain(): Promise<void> {
        if (draining) {
            return;
        }
        draining = true;
        try {
            while (queue.length > 0) {
                const job = queue.shift();
                if (job === undefined) {
                    continue;
                }
                if (job.signal?.aborted) {
                    job.removeAbortListener();
                    job.resolve(undefined);
                    continue;
                }
                try {
                    const engine = await import("./highlight-engine");
                    if (job.signal?.aborted) {
                        job.removeAbortListener();
                        job.resolve(undefined);
                        continue;
                    }
                    const grammar = await engine.prepareHighlightGrammar(job.grammarId);
                    if (job.signal?.aborted || grammar === undefined) {
                        job.removeAbortListener();
                        job.resolve(undefined);
                        continue;
                    }
                    const tokens = await engine.tokenizePreparedGrammar(job.code, grammar.id);
                    job.removeAbortListener();
                    job.resolve(job.signal?.aborted ? undefined : tokens);
                } catch (error: unknown) {
                    job.removeAbortListener();
                    if (job.signal?.aborted) {
                        job.resolve(undefined);
                    } else {
                        job.reject(error);
                    }
                }
                if (queue.length > 0) {
                    await new Promise<void>((resolve) => {
                        schedule(resolve);
                    });
                }
            }
        } finally {
            draining = false;
            if (queue.length > 0) {
                void drain();
            }
        }
    }

    return {
        execute(code, grammarId, signal) {
            if (signal?.aborted) {
                return Promise.resolve(undefined);
            }
            const job = createAbortableHighlightJob(signal, (finishResolve) => {
                finishResolve(undefined);
            });
            queue.push({
                code,
                grammarId,
                signal,
                resolve: job.resolve,
                reject: job.reject,
                removeAbortListener: job.cleanup,
            });
            void drain();
            return job.promise;
        },
        dispose() {
            while (queue.length > 0) {
                const job = queue.shift();
                if (job !== undefined) {
                    job.removeAbortListener();
                    job.resolve(undefined);
                }
            }
        },
    };
}

interface PendingWorkerJob {
    readonly id: number;
    readonly code: string;
    readonly grammarId: string;
    readonly signal: AbortSignal | undefined;
    readonly resolve: (tokens: readonly (readonly HighlightToken[])[] | undefined) => void;
    readonly reject: (error: unknown) => void;
    readonly cleanup: () => void;
}

/**
 * Runs Shiki tokenization inside a dedicated Web Worker with transparent failover
 * to `createFallback` if worker instantiation or communication fails.
 */
export function createWorkerHighlightExecutor(
    createWorker: () => HighlightWorkerPort,
    createFallback: () => HighlightExecutor = () => createDirectHighlightExecutor(),
): HighlightExecutor {
    let worker: HighlightWorkerPort | undefined;
    let fallback: HighlightExecutor | undefined;
    let workerFailed = false;
    let nextId = 1;
    const pending = new Map<number, PendingWorkerJob>();

    function getFallback(): HighlightExecutor {
        fallback ??= createFallback();
        return fallback;
    }

    function teardownWorker(): void {
        if (worker === undefined) {
            return;
        }
        worker.removeEventListener?.("message", onMessage);
        worker.removeEventListener?.("error", onWorkerFailure);
        worker.removeEventListener?.("messageerror", onWorkerFailure);
        worker.terminate?.();
        worker = undefined;
    }

    function failoverToFallback(): void {
        if (workerFailed) {
            return;
        }
        workerFailed = true;
        teardownWorker();
        const inFlight = [...pending.values()];
        pending.clear();
        const executor = getFallback();
        for (const job of inFlight) {
            job.cleanup();
            if (job.signal?.aborted) {
                job.resolve(undefined);
                continue;
            }
            executor.execute(job.code, job.grammarId, job.signal).then(job.resolve, job.reject);
        }
    }

    function onMessage(event: { readonly data: unknown }): void {
        const response = parseHighlightWorkerResponse(event.data);
        if (response === undefined) {
            return;
        }
        const job = pending.get(response.id);
        if (job === undefined) {
            return;
        }
        pending.delete(response.id);
        job.cleanup();

        switch (response.kind) {
            case "result":
                job.resolve(job.signal?.aborted ? undefined : response.tokens);
                return;
            case "cancelled":
                job.resolve(undefined);
                return;
            case "error":
                job.reject(new Error(response.message));
                return;
            default: {
                const unreachable: never = response;
                return unreachable;
            }
        }
    }

    function onWorkerFailure(): void {
        failoverToFallback();
    }

    function ensureWorker(): HighlightWorkerPort | undefined {
        if (workerFailed) {
            return undefined;
        }
        if (worker !== undefined) {
            return worker;
        }
        try {
            const instance = createWorker();
            instance.addEventListener("message", onMessage);
            instance.addEventListener("error", onWorkerFailure);
            instance.addEventListener("messageerror", onWorkerFailure);
            worker = instance;
            return worker;
        } catch {
            workerFailed = true;
            return undefined;
        }
    }

    return {
        execute(code, grammarId, signal) {
            if (signal?.aborted) {
                return Promise.resolve(undefined);
            }
            const activeWorker = ensureWorker();
            if (activeWorker === undefined) {
                return getFallback().execute(code, grammarId, signal);
            }

            const id = nextId;
            nextId += 1;
            const job = createAbortableHighlightJob(signal, (finishResolve) => {
                const entry = pending.get(id);
                if (entry === undefined) {
                    return;
                }
                pending.delete(id);
                entry.cleanup();
                if (!workerFailed && worker !== undefined) {
                    try {
                        worker.postMessage({ kind: "cancel", id });
                    } catch {
                        failoverToFallback();
                    }
                }
                finishResolve(undefined);
            });

            pending.set(id, {
                id,
                code,
                grammarId,
                signal,
                resolve: job.resolve,
                reject: job.reject,
                cleanup: job.cleanup,
            });

            try {
                activeWorker.postMessage({
                    kind: "highlight",
                    id,
                    code,
                    grammarId,
                });
            } catch {
                failoverToFallback();
            }
            return job.promise;
        },
        dispose() {
            teardownWorker();
            for (const job of pending.values()) {
                job.cleanup();
                job.resolve(undefined);
            }
            pending.clear();
            fallback?.dispose?.();
        },
    };
}

let defaultExecutor: HighlightExecutor | undefined;
let testExecutorOverride: HighlightExecutor | undefined;

function getHighlightExecutor(): HighlightExecutor {
    if (testExecutorOverride !== undefined) {
        return testExecutorOverride;
    }
    if (defaultExecutor !== undefined) {
        return defaultExecutor;
    }
    if (typeof Worker !== "undefined") {
        defaultExecutor = createWorkerHighlightExecutor(
            () => new Worker(new URL("./highlight.worker.ts", import.meta.url), { type: "module" }),
        );
    } else {
        defaultExecutor = createDirectHighlightExecutor();
    }
    return defaultExecutor;
}

/** Overrides the active {@link HighlightExecutor} inside unit tests. Pass `undefined` to restore defaults. */
export function setHighlightExecutorForTests(executor: HighlightExecutor | undefined): void {
    testExecutorOverride = executor;
}

/**
 * Tokenizes `code` for the light and dark themes at once. Every token carries
 * `--shiki-light` and `--shiki-dark`, so the caller paints it with the same
 * `color-scheme` and `data-theme` rules as the design tokens.
 *
 * Executes in a dedicated Web Worker in browsers and falls back to the direct
 * engine in workerless environments (such as Node unit tests) or on worker failure.
 */
export async function highlight(
    code: string,
    language: string,
    options?: HighlightOptions,
): Promise<readonly (readonly HighlightToken[])[] | undefined> {
    if (options?.signal?.aborted) {
        return undefined;
    }
    const grammar = resolveLanguage(language);
    if (grammar === undefined) {
        return undefined;
    }

    return getHighlightExecutor().execute(code, grammar.id, options?.signal);
}
