import type { AssistantMessageDiagnostic } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

import {
    countDroppedThinkingBlocks,
    formatCacheWarmingText,
    formatSystemNoteMeta,
    formatThinkingDropNotice,
    readNonNegativeTokenCount,
    readSummaryBilling,
    readUsageTotalCostUsd,
} from "./transcript-meta";

describe("readNonNegativeTokenCount", () => {
    it("rejects negative, NaN, and non-numeric token counts", () => {
        expect(readNonNegativeTokenCount(42_100)).toBe(42_100);
        expect(readNonNegativeTokenCount(0)).toBe(0);
        expect(readNonNegativeTokenCount(-5)).toBeUndefined();
        expect(readNonNegativeTokenCount(Number.NaN)).toBeUndefined();
        expect(readNonNegativeTokenCount("42100")).toBeUndefined();
    });
});

describe("readSummaryBilling and formatSystemNoteMeta", () => {
    it("extracts token totals and omits costs below $0.01", () => {
        expect(
            readSummaryBilling({
                input: 1_000,
                output: 200,
                cacheRead: 2_000,
                cacheWrite: 0,
                totalTokens: 3_200,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.004 },
            }),
        ).toEqual({ billedTokens: 3_200, approxCostUsd: null });

        expect(
            readSummaryBilling({
                input: 1_500,
                output: 500,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2_000,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.024 },
            }),
        ).toEqual({ billedTokens: 2_000, approxCostUsd: 0.024 });

        expect(
            readSummaryBilling({
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                cost: { total: 0 },
            }),
        ).toBeUndefined();
        expect(readSummaryBilling(null)).toBeUndefined();
    });

    it("formats combined compaction tokensBefore and billing labels", () => {
        expect(
            formatSystemNoteMeta({
                tokensBefore: 42_100,
                billing: { billedTokens: 3_200, approxCostUsd: 0.024 },
            }),
        ).toBe("Compacted from 42,100 tokens · 3.2k tokens billed (~$0.02)");

        expect(
            formatSystemNoteMeta({
                billing: { billedTokens: 1_800, approxCostUsd: null },
            }),
        ).toBe("1.8k tokens billed");

        expect(formatSystemNoteMeta({ tokensBefore: -10 })).toBeNull();
        expect(formatSystemNoteMeta({ tokensBefore: Number.NaN })).toBeNull();
        expect(formatSystemNoteMeta({})).toBeNull();
    });
});

describe("cache_warm usage formatting", () => {
    it("reads usage costs safely and strips excess trailing zeros past 3 decimals", () => {
        expect(readUsageTotalCostUsd({ cost: { total: 0.0021 } })).toBe(0.0021);
        expect(readUsageTotalCostUsd({ cost: { total: -1 } })).toBeNull();
        expect(readUsageTotalCostUsd({})).toBeNull();

        expect(formatCacheWarmingText(0.0021, undefined)).toBe("Cache warmed: $0.0021");
        expect(formatCacheWarmingText(0, "idle refresh")).toBe("Cache warmed (idle refresh): $0.000");
        expect(formatCacheWarmingText(0.1234567, "  ")).toBe("Cache warmed: $0.123457");
    });
});

describe("Anthropic thinking_dropped diagnostics", () => {
    it("counts thinking_dropped entries across anthropic_input_transformations diagnostics", () => {
        const diagnostics: AssistantMessageDiagnostic[] = [
            {
                type: "anthropic_input_transformations",
                timestamp: 100,
                details: {
                    transformations: [
                        { type: "thinking_dropped", index: 0 },
                        { type: "cache_control_applied" },
                        { type: "thinking_dropped", index: 2 },
                    ],
                },
            },
            {
                type: "other_diagnostic",
                timestamp: 200,
                details: { transformations: [{ type: "thinking_dropped" }] },
            },
        ];

        expect(countDroppedThinkingBlocks(diagnostics)).toBe(2);
        expect(countDroppedThinkingBlocks(undefined)).toBe(0);
        expect(
            countDroppedThinkingBlocks([
                {
                    type: "anthropic_input_transformations",
                    timestamp: 300,
                    details: { transformations: "invalid" },
                },
                {
                    type: "anthropic_input_transformations",
                    timestamp: 400,
                    details: { transformations: [null, 42, { type: "thinking_dropped" }] },
                },
            ]),
        ).toBe(1);
        expect(formatThinkingDropNotice(1)).toBe("Anthropic dropped 1 thinking block");
        expect(formatThinkingDropNotice(2)).toBe("Anthropic dropped 2 thinking blocks");
    });
});
