import { describe, expect, it } from "vitest";

import { assertNever, isRecord } from "./primitives.ts";

describe("shared primitives", () => {
    it("isRecord accepts plain objects and rejects null, arrays, and primitives", () => {
        expect(isRecord({})).toBe(true);
        expect(isRecord({ a: 1 })).toBe(true);
        expect(isRecord(null)).toBe(false);
        expect(isRecord([])).toBe(false);
        expect(isRecord("text")).toBe(false);
        expect(isRecord(42)).toBe(false);
    });

    it("assertNever throws with the serialized value", () => {
        expect(() => assertNever("unexpected" as never, "Bad variant")).toThrow('Bad variant: "unexpected"');
    });
});
