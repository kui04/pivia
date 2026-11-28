import type { FileEntry } from "@earendil-works/pi-coding-agent";

/** Token and cost totals for one session branch, mirroring the SDK's `getSessionStats()`. */
export interface SessionUsageTotals {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly cost: number;
    /** Cache hit percentage of the latest assistant prompt, or `null` before any prompt. */
    readonly cacheHitRate: number | null;
}

/** Message counts plus {@link SessionUsageTotals}, derived from the synced entries. */
export interface SessionStatsSummary extends SessionUsageTotals {
    readonly userMessages: number;
    readonly assistantMessages: number;
    readonly toolCalls: number;
    readonly toolResults: number;
    readonly totalMessages: number;
}

interface MutableTotals {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
}

function addUsage(
    totals: MutableTotals,
    usage: {
        readonly input: number;
        readonly output: number;
        readonly cacheRead: number;
        readonly cacheWrite: number;
        readonly cost: { readonly total: number };
    },
): void {
    totals.input += usage.input;
    totals.output += usage.output;
    totals.cacheRead += usage.cacheRead;
    totals.cacheWrite += usage.cacheWrite;
    totals.cost += usage.cost.total;
}

/**
 * Fold the synced entries into the totals the composer status strip shows.
 *
 * The session header is skipped because the server's `getSessionStats()` iterates the entry list
 * without it; counting it would make the client totals drift from the SDK by one message.
 */
export function summarizeSessionStats(entries: readonly FileEntry[]): SessionStatsSummary {
    const totals: MutableTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    let userMessages = 0;
    let assistantMessages = 0;
    let toolCalls = 0;
    let toolResults = 0;
    let totalMessages = 0;
    let cacheHitRate: number | null = null;

    for (const entry of entries) {
        if (entry.type === "session") {
            continue;
        }
        if (entry.type === "usage") {
            addUsage(totals, entry.usage);
            continue;
        }
        if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage !== undefined) {
            addUsage(totals, entry.usage);
            if (entry.type === "compaction") {
                continue;
            }
        }
        if (entry.type !== "message") {
            continue;
        }

        totalMessages += 1;
        const message = entry.message;
        if (message.role === "user") {
            userMessages += 1;
            continue;
        }
        if (message.role === "toolResult") {
            toolResults += 1;
            if (message.usage !== undefined) {
                addUsage(totals, message.usage);
            }
            continue;
        }
        if (message.role !== "assistant") {
            continue;
        }

        assistantMessages += 1;
        toolCalls += message.content.filter((block) => block.type === "toolCall").length;
        addUsage(totals, message.usage);
        const promptTokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
        cacheHitRate = promptTokens > 0 ? (message.usage.cacheRead / promptTokens) * 100 : null;
    }

    return {
        input: totals.input,
        output: totals.output,
        cacheRead: totals.cacheRead,
        cacheWrite: totals.cacheWrite,
        cost: totals.cost,
        cacheHitRate,
        userMessages,
        assistantMessages,
        toolCalls,
        toolResults,
        totalMessages,
    };
}
