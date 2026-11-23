import { describe, expect, it } from "vitest";

import { elapsedSince } from "./useLiveDuration";

describe("elapsedSince", () => {
    it("reports the elapsed wall-clock time", () => {
        expect(elapsedSince(1_000, 4_420)).toBe(3_420);
    });

    it("reports zero for a sample taken at the start", () => {
        expect(elapsedSince(1_000, 1_000)).toBe(0);
    });

    it("clamps a backwards clock to zero", () => {
        expect(elapsedSince(1_000, 985)).toBe(0);
    });
});
