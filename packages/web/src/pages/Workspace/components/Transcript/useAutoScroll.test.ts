import { describe, expect, it } from "vitest";

import {
    bottomOffset,
    edgesAfterWrite,
    measureScrollEdges,
    pinAfterJump,
    resolveScroll,
    type ScrollMetrics,
    type ScrollResolutionInput,
} from "./useAutoScroll";

/** Content taller than the viewport, scrolled to the top. */
const AT_TOP: ScrollMetrics = { scrollTop: 0, clientHeight: 200, scrollHeight: 500 };

/** The same content scrolled to the bottom edge. */
const AT_BOTTOM: ScrollMetrics = { scrollTop: 300, clientHeight: 200, scrollHeight: 500 };

/** Scrolled up 200px from the bottom, so the pin rules see real overflow above and below. */
const MID_SCROLL: ScrollMetrics = { scrollTop: 120, clientHeight: 200, scrollHeight: 520 };

function resolve(overrides: Partial<ScrollResolutionInput>): ReturnType<typeof resolveScroll> {
    return resolveScroll({
        signal: { kind: "layout" },
        pin: "pinned",
        metrics: AT_BOTTOM,
        streaming: true,
        initialBottom: false,
        settling: true,
        ...overrides,
    });
}

describe("measureScrollEdges", () => {
    it("hides fades when there is nothing to scroll", () => {
        expect(measureScrollEdges({ scrollTop: 40, clientHeight: 0, scrollHeight: 400 })).toEqual({
            fadeTop: false,
            fadeBottom: false,
            atBottom: true,
        });
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

describe("bottomOffset", () => {
    it("names the bottom edge of overflowing content", () => {
        expect(bottomOffset(AT_TOP)).toBe(300);
    });

    it("clamps to zero when the content is shorter than the viewport", () => {
        expect(bottomOffset({ clientHeight: 200, scrollHeight: 120 })).toBe(0);
    });
});

describe("resolveScroll attach", () => {
    it("pins and follows when streaming starts on a fresh viewport", () => {
        const resolution = resolve({
            signal: { kind: "attach" },
            pin: "released",
            metrics: AT_TOP,
            streaming: true,
        });

        expect(resolution.pin).toBe("pinned");
        expect(resolution.action).toEqual({ kind: "follow", top: 300 });
        expect(resolution.edges).toEqual({ fadeTop: true, fadeBottom: false, atBottom: true });
    });

    it("settles an idle viewport that asks for the initial bottom", () => {
        const resolution = resolve({
            signal: { kind: "attach" },
            pin: "released",
            metrics: AT_TOP,
            streaming: false,
            initialBottom: true,
        });

        expect(resolution.pin).toBe("settling");
        expect(resolution.action).toEqual({ kind: "follow", top: 300 });
    });

    it("re-attaches a settled viewport without re-entering the settling phase", () => {
        const resolution = resolve({
            signal: { kind: "attach" },
            pin: "released",
            metrics: AT_TOP,
            streaming: false,
            initialBottom: true,
            settling: false,
        });

        expect(resolution.pin).toBe("pinned");
        expect(resolution.action).toEqual({ kind: "follow", top: 300 });
    });

    it("adopts the current position of an idle viewport", () => {
        const atBottom = resolve({
            signal: { kind: "attach" },
            pin: "released",
            metrics: AT_BOTTOM,
            streaming: false,
        });
        expect(atBottom.pin).toBe("pinned");
        expect(atBottom.action).toEqual({ kind: "hold" });

        const atTop = resolve({
            signal: { kind: "attach" },
            pin: "pinned",
            metrics: AT_TOP,
            streaming: false,
        });
        expect(atTop.pin).toBe("released");
        expect(atTop.action).toEqual({ kind: "hold" });
    });
});

describe("resolveScroll stream-started", () => {
    it("re-pins a released viewport that sits at the bottom", () => {
        const resolution = resolve({
            signal: { kind: "stream-started" },
            pin: "released",
            metrics: AT_BOTTOM,
        });

        expect(resolution.pin).toBe("pinned");
        expect(resolution.action).toEqual({ kind: "follow", top: 300 });
    });

    it("keeps a reader who scrolled up released", () => {
        const resolution = resolve({
            signal: { kind: "stream-started" },
            pin: "released",
            metrics: AT_TOP,
        });

        expect(resolution.pin).toBe("released");
        expect(resolution.action).toEqual({ kind: "hold" });
    });

    it("takes over from a settling viewport and follows the run", () => {
        const resolution = resolve({
            signal: { kind: "stream-started" },
            pin: "settling",
            metrics: AT_TOP,
        });

        expect(resolution.pin).toBe("pinned");
        expect(resolution.action).toEqual({ kind: "follow", top: 300 });
    });
});

describe("resolveScroll settled", () => {
    it("closes the settling phase into pinned and holds the offset", () => {
        const resolution = resolve({ signal: { kind: "settled" }, pin: "settling", streaming: false });

        expect(resolution.pin).toBe("pinned");
        expect(resolution.action).toEqual({ kind: "hold" });
        expect(resolution.edges).toEqual({ fadeTop: true, fadeBottom: false, atBottom: true });
    });

    it("leaves a released viewport released", () => {
        const resolution = resolve({ signal: { kind: "settled" }, pin: "released", metrics: AT_TOP });

        expect(resolution.pin).toBe("released");
        expect(resolution.action).toEqual({ kind: "hold" });
    });
});

describe("resolveScroll layout", () => {
    it("follows content growth only while pinned and streaming", () => {
        const resolution = resolve({ signal: { kind: "layout" }, pin: "pinned", streaming: true });
        expect(resolution.action).toEqual({ kind: "follow", top: 300 });
        expect(resolution.edges.atBottom).toBe(true);
    });

    it("holds the offset once the run ends", () => {
        const resolution = resolve({ signal: { kind: "layout" }, pin: "pinned", streaming: false });
        expect(resolution.pin).toBe("pinned");
        expect(resolution.action).toEqual({ kind: "hold" });
    });

    it("follows the measuring passes of an idle settling viewport", () => {
        const resolution = resolve({ signal: { kind: "layout" }, pin: "settling", streaming: false });

        expect(resolution.pin).toBe("settling");
        expect(resolution.action).toEqual({ kind: "follow", top: 300 });
    });

    it("never moves a released viewport", () => {
        const resolution = resolve({ signal: { kind: "layout" }, pin: "released", metrics: AT_TOP });
        expect(resolution.pin).toBe("released");
        expect(resolution.action).toEqual({ kind: "hold" });
        expect(resolution.edges).toEqual({ fadeTop: false, fadeBottom: true, atBottom: false });
    });
});

describe("resolveScroll scroll", () => {
    it("pins when the reader reaches the bottom", () => {
        const resolution = resolve({
            signal: { kind: "scroll", previousScrollTop: 100 },
            pin: "released",
            metrics: AT_BOTTOM,
        });

        expect(resolution.pin).toBe("pinned");
        expect(resolution.action).toEqual({ kind: "hold" });
    });

    it("releases when the reader scrolls up", () => {
        const resolution = resolve({
            signal: { kind: "scroll", previousScrollTop: 120 },
            pin: "pinned",
            metrics: AT_TOP,
        });

        expect(resolution.pin).toBe("released");
        expect(resolution.action).toEqual({ kind: "hold" });
    });

    it("keeps settling when its own jump to the bottom reports a scroll", () => {
        const resolution = resolve({
            signal: { kind: "scroll", previousScrollTop: 0 },
            pin: "settling",
            metrics: AT_BOTTOM,
        });

        expect(resolution.pin).toBe("settling");
        expect(resolution.action).toEqual({ kind: "hold" });
    });

    it("releases a settling viewport when the reader scrolls up", () => {
        const resolution = resolve({
            signal: { kind: "scroll", previousScrollTop: 400 },
            pin: "settling",
            metrics: AT_TOP,
        });

        expect(resolution.pin).toBe("released");
        expect(resolution.action).toEqual({ kind: "hold" });
    });

    it("ignores drift smaller than the edge tolerance", () => {
        // The viewport must not sit at the bottom, otherwise the at-bottom rule answers first and
        // the move is never compared against the tolerance.
        expect(measureScrollEdges(MID_SCROLL).atBottom).toBe(false);

        const resolution = resolve({
            signal: { kind: "scroll", previousScrollTop: 121 },
            pin: "pinned",
            metrics: MID_SCROLL,
        });

        expect(resolution.pin).toBe("pinned");
    });

    it("releases once the upward move passes the edge tolerance", () => {
        const resolution = resolve({
            signal: { kind: "scroll", previousScrollTop: 123 },
            pin: "pinned",
            metrics: MID_SCROLL,
        });

        expect(resolution.pin).toBe("released");
    });

    it("keeps the pin when the upward move equals the edge tolerance", () => {
        const resolution = resolve({
            signal: { kind: "scroll", previousScrollTop: 122 },
            pin: "pinned",
            metrics: MID_SCROLL,
        });

        expect(resolution.pin).toBe("pinned");
    });

    it("keeps a released viewport released while the reader scrolls down", () => {
        const resolution = resolve({
            signal: { kind: "scroll", previousScrollTop: 80 },
            pin: "released",
            metrics: { ...AT_TOP, scrollTop: 140 },
        });

        expect(resolution.pin).toBe("released");
    });
});

describe("resolveScroll follow edges", () => {
    it("describes the viewport after the offset write", () => {
        const resolution = resolve({
            signal: { kind: "layout" },
            pin: "pinned",
            metrics: { scrollTop: 120, clientHeight: 200, scrollHeight: 500 },
        });

        expect(resolution.action).toEqual({ kind: "follow", top: 300 });
        expect(resolution.edges).toEqual({ fadeTop: true, fadeBottom: false, atBottom: true });
    });
});

describe("edgesAfterWrite", () => {
    it("keeps the planned edges when the browser applies the requested offset", () => {
        const metrics: ScrollMetrics = { scrollTop: 120, clientHeight: 200, scrollHeight: 500 };
        const resolution = resolve({ signal: { kind: "layout" }, pin: "pinned", metrics });

        expect(edgesAfterWrite(metrics, resolution, 300)).toBe(resolution.edges);
    });

    it("measures the achieved offset when the browser clamps the write", () => {
        const metrics: ScrollMetrics = { scrollTop: 120, clientHeight: 200, scrollHeight: 500 };
        const resolution = resolve({ signal: { kind: "layout" }, pin: "pinned", metrics });

        // The write asked for 300 but landed at 200, so the bottom edge is still hidden.
        expect(edgesAfterWrite(metrics, resolution, 200)).toEqual({
            fadeTop: true,
            fadeBottom: true,
            atBottom: false,
        });
    });

    it("never corrects a decision that does not move the offset", () => {
        const resolution = resolve({
            signal: { kind: "scroll", previousScrollTop: 400 },
            pin: "pinned",
            metrics: { ...AT_TOP, scrollTop: 120 },
        });

        expect(edgesAfterWrite({ ...AT_TOP, scrollTop: 120 }, resolution, 120)).toBe(resolution.edges);
    });
});

describe("pinAfterJump", () => {
    it("keeps following the measuring passes of a settling viewport", () => {
        expect(pinAfterJump(true)).toBe("settling");
    });

    it("pins a viewport that already settled", () => {
        expect(pinAfterJump(false)).toBe("pinned");
    });
});
