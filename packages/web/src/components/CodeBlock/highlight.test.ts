import { describe, expect, it } from "vitest";

import { highlight, resolveLanguage } from "./highlight";

describe("resolveLanguage", () => {
    it("resolves grammar ids and aliases without case sensitivity", () => {
        expect(resolveLanguage("typescript")?.id).toBe("typescript");
        expect(resolveLanguage("TS")?.id).toBe("typescript");
        expect(resolveLanguage("tsx")?.id).toBe("tsx");
    });

    it("returns undefined for a grammar that Shiki does not ship", () => {
        expect(resolveLanguage("not-a-language")).toBeUndefined();
    });
});

describe("highlight", () => {
    it("returns undefined for an unknown grammar without loading the engine", async () => {
        await expect(highlight("const answer = 42;", "not-a-language")).resolves.toBeUndefined();
    });

    it("tokenizes code for both themes and preserves the source text", async () => {
        const code = "const answer: number = 42;\nconsole.log(answer);";
        const tokens = await highlight(code, "ts");

        expect(tokens).toBeDefined();

        const reconstructed = (tokens ?? []).map((line) => line.map((token) => token.content).join("")).join("\n");

        expect(reconstructed).toBe(code);
        expect(
            (tokens ?? []).flat().some((token) => {
                const style = token.htmlStyle ?? {};
                return "--shiki-light" in style && "--shiki-dark" in style;
            }),
        ).toBe(true);
    }, 15_000);
});
