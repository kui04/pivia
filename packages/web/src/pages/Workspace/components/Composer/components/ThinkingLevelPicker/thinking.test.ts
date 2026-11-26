import { describe, expect, it } from "vitest";

import { parseAvailableThinkingLevelsData } from "./thinking";

describe("parseAvailableThinkingLevelsData", () => {
    it("parses valid thinking levels and rejects malformed entries", () => {
        expect(parseAvailableThinkingLevelsData({ levels: ["off", "medium", "high"] })).toEqual([
            "off",
            "medium",
            "high",
        ]);
        expect(parseAvailableThinkingLevelsData({ levels: ["off", "bogus"] })).toBeNull();
        expect(parseAvailableThinkingLevelsData({})).toBeNull();
    });
});
