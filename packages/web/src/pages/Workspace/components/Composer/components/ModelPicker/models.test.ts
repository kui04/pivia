import type { SessionModelInfo } from "@pivia/protocol";
import { describe, expect, it } from "vitest";

import {
    createModelCatalogCache,
    filterModels,
    modelChoiceKey,
    orderModelsByProvider,
    parseAvailableModelsData,
} from "./models";

const CLAUDE: SessionModelInfo = {
    provider: "anthropic",
    id: "claude-sonnet-4",
    name: "Claude Sonnet 4",
    contextWindow: 200_000,
    reasoning: true,
};
const GPT: SessionModelInfo = {
    provider: "openai",
    id: "gpt-5",
    name: "GPT-5",
    contextWindow: 272_000,
    reasoning: true,
};
const PROXY_GPT: SessionModelInfo = {
    provider: "openrouter",
    id: "openai/gpt-5",
    name: "GPT-5 (OpenRouter)",
    contextWindow: 272_000,
    reasoning: true,
};

describe("ModelPicker boundary parsers", () => {
    it("parses valid get_available_models payloads and rejects malformed data", () => {
        expect(parseAvailableModelsData({ models: [CLAUDE, GPT] })).toEqual([CLAUDE, GPT]);
        expect(parseAvailableModelsData({ models: [{ provider: "x" }] })).toBeNull();
        expect(parseAvailableModelsData(null)).toBeNull();
    });
});

describe("orderModelsByProvider and filterModels", () => {
    it("puts active model first and orders the rest by provider name", () => {
        expect(orderModelsByProvider([PROXY_GPT, GPT, CLAUDE], modelChoiceKey(GPT))).toEqual([GPT, CLAUDE, PROXY_GPT]);
    });

    it("ranks direct provider matches ahead of proxy models", () => {
        expect(filterModels([PROXY_GPT, GPT, CLAUDE], "openai gpt5")).toEqual([GPT, PROXY_GPT]);
    });
});

describe("createModelCatalogCache", () => {
    it("serves cached entries within TTL and expires or invalidates them cleanly", () => {
        let now = 1_000;
        const cache = createModelCatalogCache({ ttlMs: 5_000, nowMs: () => now });

        expect(cache.get("s1")).toBeNull();
        cache.set("s1", [CLAUDE, GPT]);
        expect(cache.get("s1")).toEqual([CLAUDE, GPT]);

        now = 6_000;
        expect(cache.get("s1")).toBeNull();

        cache.set("s1", [CLAUDE]);
        cache.invalidate("s1");
        expect(cache.get("s1")).toBeNull();
    });
});
