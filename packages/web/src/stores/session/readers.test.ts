import { describe, expect, it } from "vitest";

import {
    readFiniteNumber,
    readNonEmptyString,
    readNonNegativeNumber,
    readPositiveInteger,
    readPositiveNumber,
} from "./readers";

describe("readers", () => {
    it("reads finite and non-negative numbers and rejects invalid values", () => {
        expect(readFiniteNumber(12.5)).toBe(12.5);
        expect(readFiniteNumber("12.5")).toBeNull();
        expect(readFiniteNumber(Number.NaN)).toBeNull();
        expect(readNonNegativeNumber(0)).toBe(0);
        expect(readNonNegativeNumber(-1)).toBeNull();
        expect(readNonNegativeNumber(Number.POSITIVE_INFINITY)).toBeNull();
    });

    it("reads positive numbers and integers from numbers and numeric strings", () => {
        expect(readPositiveNumber(2.5)).toBe(2.5);
        expect(readPositiveNumber("2.5")).toBe(2.5);
        expect(readPositiveNumber(0)).toBeUndefined();
        expect(readPositiveInteger("10")).toBe(10);
        expect(readPositiveInteger(2.5)).toBeUndefined();
        expect(readPositiveInteger(0)).toBeUndefined();
    });

    it("trims non-empty strings and rejects blank values", () => {
        expect(readNonEmptyString("  value ")).toBe("value");
        expect(readNonEmptyString("   ")).toBeUndefined();
        expect(readNonEmptyString(42)).toBeUndefined();
    });
});
