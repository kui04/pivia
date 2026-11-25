import { describe, expect, it } from "vitest";

import { Formatter } from "./format";

describe("Formatter.duration", () => {
    it("formats milliseconds and tenths below one minute", () => {
        expect(Formatter.duration(0)).toBe("0ms");
        expect(Formatter.duration(12.4)).toBe("12ms");
        expect(Formatter.duration(999.6)).toBe("1.0s");
        expect(Formatter.duration(1_420)).toBe("1.4s");
        expect(Formatter.duration(11_200)).toBe("11.2s");
        expect(Formatter.duration(59_940)).toBe("59.9s");
    });

    it("formats minute and hour tiers without trailing zero seconds", () => {
        expect(Formatter.duration(60_000)).toBe("1m");
        expect(Formatter.duration(125_000)).toBe("2m 5s");
        expect(Formatter.duration(3_600_000)).toBe("1h 0m");
        expect(Formatter.duration(3_603_000)).toBe("1h 0m 3s");
        expect(Formatter.duration(7_380_000)).toBe("2h 3m");
        expect(Formatter.duration(7_383_000)).toBe("2h 3m 3s");
    });

    it("reads negative and non-finite input as zero", () => {
        expect(Formatter.duration(-5)).toBe("0ms");
        expect(Formatter.duration(Number.NaN)).toBe("0ms");
        expect(Formatter.duration(Number.POSITIVE_INFINITY)).toBe("0ms");
    });
});

describe("Formatter.byteSize", () => {
    it("formats bytes, kilobytes and megabytes matching pi-coding-agent", () => {
        expect(Formatter.byteSize(512)).toBe("512B");
        expect(Formatter.byteSize(50 * 1024)).toBe("50.0KB");
        expect(Formatter.byteSize(2 * 1024 * 1024)).toBe("2.0MB");
    });

    it("reads negative and non-finite input as zero bytes", () => {
        expect(Formatter.byteSize(-1)).toBe("0B");
        expect(Formatter.byteSize(Number.NaN)).toBe("0B");
    });
});

describe("Formatter.usdCost", () => {
    it("uses cents for larger amounts and significant digits for fractions", () => {
        expect(Formatter.usdCost(0.000456)).toBe("$0.00046");
        expect(Formatter.usdCost(0.025)).toBe("$0.03");
        expect(Formatter.usdCost(0)).toBe("$0.0");
        expect(Formatter.usdCost(-1)).toBe("$0.0");
    });
});

describe("Formatter.compactTokenCount", () => {
    it("formats token counts across unit, k, and M thresholds", () => {
        expect(Formatter.compactTokenCount(0)).toBe("0");
        expect(Formatter.compactTokenCount(999)).toBe("999");
        expect(Formatter.compactTokenCount(1_250)).toBe("1.3k");
        expect(Formatter.compactTokenCount(12_400)).toBe("12k");
        expect(Formatter.compactTokenCount(1_500_000)).toBe("1.5M");
        expect(Formatter.compactTokenCount(12_000_000)).toBe("12M");
    });

    it("reads negative and non-finite input as zero", () => {
        expect(Formatter.compactTokenCount(-1)).toBe("0");
        expect(Formatter.compactTokenCount(Number.NaN)).toBe("0");
    });
});

describe("Formatter.relativeAge", () => {
    it("formats compact ages across thresholds and clamps future timestamps to now", () => {
        const now = 1_000_000_000_000;
        expect(Formatter.relativeAge(now + 10_000, now)).toBe("now");
        expect(Formatter.relativeAge(now - 59_999, now)).toBe("now");
        expect(Formatter.relativeAge(now - 60_000, now)).toBe("1m");
        expect(Formatter.relativeAge(now - 3_599_999, now)).toBe("59m");
        expect(Formatter.relativeAge(now - 3_600_000, now)).toBe("1h");
        expect(Formatter.relativeAge(now - 86_400_000, now)).toBe("1d");
        expect(Formatter.relativeAge(now - 7 * 86_400_000, now)).toBe("1w");
        expect(Formatter.relativeAge(now - 365 * 86_400_000, now)).toBe("1y");
    });
});
