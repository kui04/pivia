import { describe, expect, it } from "vitest";

import { formatByteSize, formatCompactTokenCount, formatDuration, formatRelativeAge, formatUsdCost } from "./format";

describe("formatDuration", () => {
    it("formats milliseconds and tenths below one minute", () => {
        expect(formatDuration(0)).toBe("0ms");
        expect(formatDuration(12.4)).toBe("12ms");
        expect(formatDuration(999.6)).toBe("1.0s");
        expect(formatDuration(1_420)).toBe("1.4s");
        expect(formatDuration(11_200)).toBe("11.2s");
        expect(formatDuration(59_940)).toBe("59.9s");
    });

    it("formats minute and hour tiers without trailing zero seconds", () => {
        expect(formatDuration(60_000)).toBe("1m");
        expect(formatDuration(125_000)).toBe("2m 5s");
        expect(formatDuration(3_600_000)).toBe("1h 0m");
        expect(formatDuration(3_603_000)).toBe("1h 0m 3s");
        expect(formatDuration(7_380_000)).toBe("2h 3m");
        expect(formatDuration(7_383_000)).toBe("2h 3m 3s");
    });

    it("reads negative and non-finite input as zero", () => {
        expect(formatDuration(-5)).toBe("0ms");
        expect(formatDuration(Number.NaN)).toBe("0ms");
        expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("0ms");
    });
});

describe("formatByteSize", () => {
    it("formats bytes, kilobytes and megabytes matching pi-coding-agent", () => {
        expect(formatByteSize(512)).toBe("512B");
        expect(formatByteSize(50 * 1024)).toBe("50.0KB");
        expect(formatByteSize(2 * 1024 * 1024)).toBe("2.0MB");
    });

    it("reads negative and non-finite input as zero bytes", () => {
        expect(formatByteSize(-1)).toBe("0B");
        expect(formatByteSize(Number.NaN)).toBe("0B");
    });
});

describe("formatUsdCost", () => {
    it("uses cents for larger amounts and significant digits for fractions", () => {
        expect(formatUsdCost(0.000456)).toBe("$0.00046");
        expect(formatUsdCost(0.025)).toBe("$0.03");
        expect(formatUsdCost(0)).toBe("$0.0");
        expect(formatUsdCost(-1)).toBe("$0.0");
    });
});

describe("formatCompactTokenCount", () => {
    it("formats token counts across unit, k, and M thresholds", () => {
        expect(formatCompactTokenCount(0)).toBe("0");
        expect(formatCompactTokenCount(999)).toBe("999");
        expect(formatCompactTokenCount(1_250)).toBe("1.3k");
        expect(formatCompactTokenCount(12_400)).toBe("12k");
        expect(formatCompactTokenCount(1_500_000)).toBe("1.5M");
        expect(formatCompactTokenCount(12_000_000)).toBe("12M");
    });

    it("reads negative and non-finite input as zero", () => {
        expect(formatCompactTokenCount(-1)).toBe("0");
        expect(formatCompactTokenCount(Number.NaN)).toBe("0");
    });
});

describe("formatRelativeAge", () => {
    it("formats compact ages across thresholds and clamps future timestamps to now", () => {
        const now = 1_000_000_000_000;
        expect(formatRelativeAge(now + 10_000, now)).toBe("now");
        expect(formatRelativeAge(now - 59_999, now)).toBe("now");
        expect(formatRelativeAge(now - 60_000, now)).toBe("1m");
        expect(formatRelativeAge(now - 3_599_999, now)).toBe("59m");
        expect(formatRelativeAge(now - 3_600_000, now)).toBe("1h");
        expect(formatRelativeAge(now - 86_400_000, now)).toBe("1d");
        expect(formatRelativeAge(now - 7 * 86_400_000, now)).toBe("1w");
        expect(formatRelativeAge(now - 365 * 86_400_000, now)).toBe("1y");
    });
});
