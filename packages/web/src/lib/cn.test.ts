import { describe, expect, it } from "vitest";

import { cn } from "./cn";

describe("cn", () => {
    it("joins class names in the order they are given", () => {
        expect(cn("button", "primary", "lg")).toBe("button primary lg");
    });

    it("drops false, null, undefined and empty entries", () => {
        expect(cn("button", false, null, undefined, "", "lg")).toBe("button lg");
    });

    it("returns an empty string when every entry is empty", () => {
        expect(cn(false, null, undefined, "")).toBe("");
        expect(cn()).toBe("");
    });

    it("keeps a single class unchanged", () => {
        expect(cn("icon")).toBe("icon");
    });
});
