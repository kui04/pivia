import { describe, expect, it } from "vitest";

import { remainingSeconds } from "./countdown";

describe("remainingSeconds", () => {
    it("returns null when the extension set no timeout", () => {
        expect(remainingSeconds(undefined, 0, 0)).toBeNull();
    });

    it("rounds partial seconds up so a fresh dialog shows its full budget", () => {
        expect(remainingSeconds(999, 0, 0)).toBe(1);
        expect(remainingSeconds(1000, 0, 0)).toBe(1);
        expect(remainingSeconds(1001, 0, 0)).toBe(2);
        expect(remainingSeconds(5000, 0, 4000)).toBe(1);
        expect(remainingSeconds(5000, 0, 4999)).toBe(1);
    });

    it("never reports a negative countdown after the server deadline passed", () => {
        expect(remainingSeconds(5000, 0, 5000)).toBe(0);
        expect(remainingSeconds(5000, 0, 6000)).toBe(0);
    });
});
