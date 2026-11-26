import { describe, expect, it } from "vitest";

import { Fuzzy } from "./fuzzy";

describe("Fuzzy.match", () => {
    it("matches characters in order case-insensitively and rejects missing characters", () => {
        expect(Fuzzy.match("", "claude-sonnet-4")).toEqual({ matches: true, score: 0 });
        expect(Fuzzy.match("sonnet", "Anthropic Claude Sonnet").matches).toBe(true);
        expect(Fuzzy.match("cs4", "claude-sonnet-4").matches).toBe(true);
        expect(Fuzzy.match("z9", "claude-sonnet-4")).toEqual({ matches: false, score: 0 });
        expect(Fuzzy.match("longer-than-target", "short")).toEqual({ matches: false, score: 0 });
    });

    it("rewards contiguous occurrences over scattered greedy matches", () => {
        const contiguous = Fuzzy.match("opus", "openrouter/anthropic/claude-opus");
        const scattered = Fuzzy.match("opus", "openrouter/user/p-s");

        expect(contiguous.matches).toBe(true);
        expect(scattered.matches).toBe(true);
        expect(contiguous.score).toBeLessThan(scattered.score);
    });

    it("supports swapped alphanumeric tokens like gpt5 and 5gpt", () => {
        const swapped = Fuzzy.match("5gpt", "openai/gpt-5");
        const direct = Fuzzy.match("gpt5", "openai/gpt-5");

        expect(swapped.matches).toBe(true);
        expect(direct.matches).toBe(true);
        expect(direct.score).toBeLessThan(swapped.score);
    });
});

describe("Fuzzy.filter", () => {
    it("returns original order for blank queries and ranks multi-token matches best first", () => {
        const items = ["openrouter/openai/gpt-4o", "openai/gpt-4o", "anthropic/claude-sonnet-4"];

        expect(Fuzzy.filter(items, "   ", (item) => item)).toBe(items);
        expect(Fuzzy.filter(items, "openai/gpt", (item) => item)).toEqual([
            "openai/gpt-4o",
            "openrouter/openai/gpt-4o",
        ]);
        expect(Fuzzy.filter(items, "sonnet anthropic", (item) => item)).toEqual(["anthropic/claude-sonnet-4"]);
    });
});
