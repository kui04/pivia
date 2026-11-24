import { describe, expect, it } from "vitest";

import { formatActivityLabel } from "./useActivityLabel";

describe("formatActivityLabel", () => {
    it("formats idle, working, compaction, branch summary, and retry labels", () => {
        expect(formatActivityLabel({ kind: "idle" })).toBeNull();
        expect(formatActivityLabel({ kind: "working" })).toBe("Working...");
        expect(formatActivityLabel({ kind: "compacting", reason: "manual" })).toBe("Compacting context...");
        expect(formatActivityLabel({ kind: "compacting", reason: null })).toBe("Compacting context...");
        expect(formatActivityLabel({ kind: "compacting", reason: "threshold" })).toBe("Auto-compacting context...");
        expect(formatActivityLabel({ kind: "compacting", reason: "overflow" })).toBe("Auto-compacting context...");
        expect(formatActivityLabel({ kind: "summarizingBranch" })).toBe("Summarizing branch...");
        expect(
            formatActivityLabel(
                { kind: "retrying", scope: "turn", attempt: 2, maxAttempts: 3, delayMs: 4_000, errorMessage: "429" },
                4,
            ),
        ).toBe("Retrying (2/3) in 4s...");
        expect(
            formatActivityLabel(
                { kind: "retrying", scope: "turn", attempt: 2, maxAttempts: 3, delayMs: 4_000, errorMessage: "429" },
                0,
            ),
        ).toBe("Retrying (2/3)...");
    });
});
