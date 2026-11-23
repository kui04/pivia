import { describe, expect, it } from "vitest";

import { measureScrollEdges } from "./useAutoScroll";

describe("measureScrollEdges", () => {
    it("hides fades when the viewport is collapsed or unmeasured", () => {
        expect(measureScrollEdges({ scrollTop: 40, clientHeight: 0, scrollHeight: 400 })).toEqual({
            fadeTop: false,
            fadeBottom: false,
            atBottom: true,
        });
    });

    it("hides fades when the content fits inside the viewport", () => {
        expect(measureScrollEdges({ scrollTop: 0, clientHeight: 200, scrollHeight: 200 })).toEqual({
            fadeTop: false,
            fadeBottom: false,
            atBottom: true,
        });
    });

    it("shows only the bottom fade at the top of overflowing content", () => {
        expect(measureScrollEdges({ scrollTop: 0, clientHeight: 200, scrollHeight: 500 })).toEqual({
            fadeTop: false,
            fadeBottom: true,
            atBottom: false,
        });
    });

    it("shows both fades in the middle of overflowing content", () => {
        expect(measureScrollEdges({ scrollTop: 120, clientHeight: 200, scrollHeight: 500 })).toEqual({
            fadeTop: true,
            fadeBottom: true,
            atBottom: false,
        });
    });

    it("absorbs sub-pixel rounding near the top and bottom edges", () => {
        expect(measureScrollEdges({ scrollTop: 1.5, clientHeight: 200, scrollHeight: 500 })).toEqual({
            fadeTop: false,
            fadeBottom: true,
            atBottom: false,
        });

        expect(measureScrollEdges({ scrollTop: 298.5, clientHeight: 200, scrollHeight: 500 })).toEqual({
            fadeTop: true,
            fadeBottom: false,
            atBottom: true,
        });
    });
});
