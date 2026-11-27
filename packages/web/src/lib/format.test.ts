import { describe, expect, it } from "vitest";

import { Formatter } from "./format";

const NOW = 1_000_000_000_000;

describe("Formatter", () => {
    it.each([
        ["duration", 0, "0ms"],
        ["duration", 12.4, "12ms"],
        ["duration", 999.6, "1.0s"],
        ["duration", 1_420, "1.4s"],
        ["duration", 11_200, "11.2s"],
        ["duration", 59_940, "59.9s"],
        ["duration", 60_000, "1m"],
        ["duration", 125_000, "2m 5s"],
        ["duration", 3_600_000, "1h 0m"],
        ["duration", 3_603_000, "1h 0m 3s"],
        ["duration", 7_380_000, "2h 3m"],
        ["duration", 7_383_000, "2h 3m 3s"],
        ["byteSize", 512, "512B"],
        ["byteSize", 50 * 1024, "50.0KB"],
        ["byteSize", 2 * 1024 * 1024, "2.0MB"],
        ["usdCost", 0.000456, "$0.00046"],
        ["usdCost", 0.025, "$0.03"],
        ["usdCost", 0, "$0.0"],
        ["compactTokenCount", 0, "0"],
        ["compactTokenCount", 999, "999"],
        ["compactTokenCount", 1_250, "1.3k"],
        ["compactTokenCount", 12_400, "12k"],
        ["compactTokenCount", 1_500_000, "1.5M"],
        ["compactTokenCount", 12_000_000, "12M"],
    ] as const)("%s formats %d as %s", (method, value, expected) => {
        expect(Formatter[method](value)).toBe(expected);
    });

    it.each([
        [NOW + 10_000, "now"],
        [NOW - 59_999, "now"],
        [NOW - 60_000, "1m"],
        [NOW - 3_599_999, "59m"],
        [NOW - 3_600_000, "1h"],
        [NOW - 86_400_000, "1d"],
        [NOW - 7 * 86_400_000, "1w"],
        [NOW - 365 * 86_400_000, "1y"],
    ] as const)("relativeAge formats %d as %s", (timestamp, expected) => {
        expect(Formatter.relativeAge(timestamp, NOW)).toBe(expected);
    });

    it.each([
        ["duration", -5, "0ms"],
        ["duration", Number.POSITIVE_INFINITY, "0ms"],
        ["byteSize", Number.NaN, "0B"],
        ["usdCost", -1, "$0.0"],
        ["compactTokenCount", Number.NaN, "0"],
    ] as const)("%s reads invalid input %d as zero", (method, value, expected) => {
        expect(Formatter[method](value)).toBe(expected);
    });
});
