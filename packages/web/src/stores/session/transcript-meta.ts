import type { AssistantMessageDiagnostic } from "@earendil-works/pi-ai";
import { isRecord } from "@pivia/protocol";

import { Formatter } from "@/lib";

import { readNonNegativeNumber } from "./readers";

/** Billed token and cost metadata extracted from compaction or branch-summary usage. */
export type TranscriptSummaryBilling = {
    /** Total billed tokens (`input + output + cacheRead + cacheWrite`), non-negative. */
    readonly billedTokens: number;
    /** Billed USD cost when at least `$0.01`, matching pi TUI's threshold; otherwise `null`. */
    readonly approxCostUsd: number | null;
};

/** Compact, non-collapsible inline notice rendered directly in the transcript column (e.g. `cache_warm`). */
export type TranscriptNoticeItem = {
    readonly kind: "notice";
    readonly id: string;
    readonly text: string;
};

const COMPACTION_COST_NOTICE_MIN_USD = 0.01;

/**
 * Validates `CompactionEntry.tokensBefore` at the session boundary.
 *
 * Returns `undefined` when missing, non-finite, or negative so legacy/corrupt records omit the
 * token count rather than displaying invalid numbers.
 */
export function readNonNegativeTokenCount(value: unknown): number | undefined {
    const parsed = readNonNegativeNumber(value);
    return parsed === null ? undefined : Math.round(parsed);
}

/**
 * Extracts billing totals from `CompactionEntry.usage` or `BranchSummaryEntry.usage`.
 *
 * Returns `undefined` when neither positive token counts nor `$0.01+` cost are reported.
 */
export function readSummaryBilling(usage: unknown): TranscriptSummaryBilling | undefined {
    if (!isRecord(usage)) {
        return undefined;
    }
    const billedTokens = Math.round(
        (readNonNegativeNumber(usage.input) ?? 0) +
            (readNonNegativeNumber(usage.output) ?? 0) +
            (readNonNegativeNumber(usage.cacheRead) ?? 0) +
            (readNonNegativeNumber(usage.cacheWrite) ?? 0),
    );
    const totalCost = isRecord(usage.cost) ? (readNonNegativeNumber(usage.cost.total) ?? 0) : 0;
    const approxCostUsd = totalCost >= COMPACTION_COST_NOTICE_MIN_USD ? totalCost : null;
    if (billedTokens <= 0 && approxCostUsd === null) {
        return undefined;
    }
    return { billedTokens, approxCostUsd };
}

/** Formats the subtitle line shown beneath a compaction or branch-summary `SystemNote`. */
export function formatSystemNoteMeta(note: {
    readonly tokensBefore?: number | undefined;
    readonly billing?: TranscriptSummaryBilling | undefined;
}): string | null {
    const parts: string[] = [];
    const tokensBefore = readNonNegativeTokenCount(note.tokensBefore);
    if (tokensBefore !== undefined) {
        parts.push(`Compacted from ${tokensBefore.toLocaleString("en-US")} tokens`);
    }
    if (note.billing !== undefined) {
        const costSuffix = note.billing.approxCostUsd !== null ? ` (~$${note.billing.approxCostUsd.toFixed(2)})` : "";
        parts.push(`${Formatter.compactTokenCount(note.billing.billedTokens)} tokens billed${costSuffix}`);
    }
    return parts.length > 0 ? parts.join(" · ") : null;
}

/** Extracts `cost.total` from a `UsageEntry`, returning `null` if invalid or negative. */
export function readUsageTotalCostUsd(usage: unknown): number | null {
    if (!isRecord(usage) || !isRecord(usage.cost)) {
        return null;
    }
    return readNonNegativeNumber(usage.cost.total);
}

/** Normalizes optional `UsageEntry.note` so adjacent `cache_warm` collapsing uses exact parity. */
export function normalizeUsageNote(note: unknown): string | undefined {
    if (typeof note !== "string") {
        return undefined;
    }
    const trimmed = note.trim();
    return trimmed === "" ? undefined : trimmed;
}

/**
 * Formats one or more collapsed `cache_warm` usage entries matching `pi-coding-agent`
 * (`Cache warmed (<note>): $0.0012`).
 */
export function formatCacheWarmingText(totalCostUsd: number, note: string | undefined): string {
    const safeCost = readNonNegativeNumber(totalCostUsd) ?? 0;
    const formattedCost = safeCost.toFixed(6).replace(/(\.\d{3}\d*?)0+$/, "$1");
    const normalizedNote = normalizeUsageNote(note);
    const noteSuffix = normalizedNote !== undefined ? ` (${normalizedNote})` : "";
    return `Cache warmed${noteSuffix}: $${formattedCost}`;
}

/**
 * Counts Anthropic `thinking_dropped` input transformations reported on one assistant message,
 * matching `InteractiveMode.countDroppedThinkingBlocks`.
 */
export function countDroppedThinkingBlocks(diagnostics: readonly AssistantMessageDiagnostic[] | undefined): number {
    if (!Array.isArray(diagnostics)) {
        return 0;
    }
    let count = 0;
    for (const diagnostic of diagnostics) {
        if (!isRecord(diagnostic) || diagnostic.type !== "anthropic_input_transformations") {
            continue;
        }
        const details = diagnostic.details;
        if (!isRecord(details) || !Array.isArray(details.transformations)) {
            continue;
        }
        for (const transformation of details.transformations) {
            if (isRecord(transformation) && transformation.type === "thinking_dropped") {
                count += 1;
            }
        }
    }
    return count;
}

/** Formats the user-visible notice when Anthropic dropped thinking blocks in a turn. */
export function formatThinkingDropNotice(droppedCount: number): string {
    const noun = droppedCount === 1 ? "thinking block" : "thinking blocks";
    return `Anthropic dropped ${droppedCount} ${noun}`;
}
