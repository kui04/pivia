import { describe, expect, it } from "vitest";

import { isImeComposition } from "./ime";

/** Builds only the fields the helper reads, because the Node test project has no DOM. */
function keyEvent(fields: { isComposing?: boolean; keyCode?: number }): KeyboardEvent {
    return { isComposing: false, keyCode: 0, ...fields } as unknown as KeyboardEvent;
}

describe("isImeComposition", () => {
    it("detects an active composition", () => {
        expect(isImeComposition(keyEvent({ isComposing: true, keyCode: 13 }))).toBe(true);
    });

    it("detects the WebKit commit keydown that reports keyCode 229 without isComposing", () => {
        expect(isImeComposition(keyEvent({ isComposing: false, keyCode: 229 }))).toBe(true);
    });

    it("passes a plain key", () => {
        expect(isImeComposition(keyEvent({ isComposing: false, keyCode: 13 }))).toBe(false);
    });
});
