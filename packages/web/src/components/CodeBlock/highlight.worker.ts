import { prepareHighlightGrammar, tokenizePreparedGrammar } from "./highlight-engine";
import { type HighlightWorkerResponse, parseHighlightWorkerRequest } from "./highlight-protocol";

interface QueuedHighlightJob {
    readonly id: number;
    readonly code: string;
    readonly grammarId: string;
}

const cancelledIds = new Set<number>();
const pendingJobs: QueuedHighlightJob[] = [];
let activeJobId: number | null = null;
let draining = false;

function postResponse(response: HighlightWorkerResponse): void {
    // DedicatedWorkerGlobalScope.postMessage accepts one argument; globalThis stays DOM-lib compatible.
    self.postMessage(response);
}

async function processJob(job: QueuedHighlightJob): Promise<void> {
    if (cancelledIds.delete(job.id)) {
        postResponse({ kind: "cancelled", id: job.id });
        return;
    }

    activeJobId = job.id;
    try {
        const grammar = await prepareHighlightGrammar(job.grammarId);
        if (cancelledIds.delete(job.id)) {
            postResponse({ kind: "cancelled", id: job.id });
            return;
        }
        if (grammar === undefined) {
            postResponse({ kind: "result", id: job.id, tokens: [] });
            return;
        }

        const tokens = await tokenizePreparedGrammar(job.code, grammar.id);
        if (cancelledIds.delete(job.id)) {
            postResponse({ kind: "cancelled", id: job.id });
            return;
        }
        postResponse({ kind: "result", id: job.id, tokens });
    } catch (error: unknown) {
        cancelledIds.delete(job.id);
        const message = error instanceof Error ? error.message : String(error);
        postResponse({ kind: "error", id: job.id, message });
    } finally {
        if (activeJobId === job.id) {
            activeJobId = null;
        }
        cancelledIds.delete(job.id);
    }
}

async function drainQueue(): Promise<void> {
    if (draining) {
        return;
    }
    draining = true;
    try {
        while (pendingJobs.length > 0) {
            const next = pendingJobs.shift();
            if (next === undefined) {
                continue;
            }
            await processJob(next);
            if (pendingJobs.length > 0) {
                // Yield between queued jobs so incoming cancel messages dequeue before tokenization.
                await new Promise<void>((resolve) => {
                    setTimeout(resolve, 0);
                });
            }
        }
    } finally {
        draining = false;
        if (pendingJobs.length > 0) {
            void drainQueue();
        }
    }
}

self.addEventListener("message", (event: MessageEvent<unknown>) => {
    const request = parseHighlightWorkerRequest(event.data);
    if (request === undefined) {
        return;
    }

    switch (request.kind) {
        case "cancel": {
            const queuedIndex = pendingJobs.findIndex((queued) => queued.id === request.id);
            if (queuedIndex !== -1) {
                pendingJobs.splice(queuedIndex, 1);
                postResponse({ kind: "cancelled", id: request.id });
                return;
            }
            // Only track cancellation for the currently awaiting job so already-finished ids never leak.
            if (activeJobId === request.id) {
                cancelledIds.add(request.id);
            }
            return;
        }
        case "highlight":
            pendingJobs.push({
                id: request.id,
                code: request.code,
                grammarId: request.grammarId,
            });
            void drainQueue();
            return;
        default: {
            const unreachable: never = request;
            return unreachable;
        }
    }
});
