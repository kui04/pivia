import { describe, expect, it, vi } from "vitest";

import type { DropTargetRect } from "@/hooks";

import {
    ALL_DOCK_ZONES,
    computeDropDockZone,
    DEFAULT_DOCK_EDGE_THRESHOLD,
    getDragData,
    hasDragType,
    setCustomDragPreview,
    setDragData,
    startDragPayload,
    type ReadableDataTransfer,
    type StartDragDataTransfer,
    type WritableDataTransfer,
} from "./dnd";

const RECT_400X200: DropTargetRect = {
    left: 100,
    top: 50,
    width: 400,
    height: 200,
};

describe("computeDropDockZone", () => {
    it("returns null for non-positive dimensions or non-finite geometry", () => {
        expect(computeDropDockZone({ left: 0, top: 0, width: 0, height: 100 }, 0, 50)).toBeNull();
        expect(computeDropDockZone({ left: 0, top: 0, width: -20, height: 100 }, 0, 50)).toBeNull();
        expect(computeDropDockZone({ left: 0, top: 0, width: 100, height: 0 }, 50, 0)).toBeNull();
        expect(computeDropDockZone({ left: 0, top: 0, width: 100, height: -10 }, 50, 0)).toBeNull();
        expect(computeDropDockZone({ left: 0, top: 0, width: Number.NaN, height: 100 }, 50, 50)).toBeNull();
        expect(computeDropDockZone(RECT_400X200, Number.NaN, 150)).toBeNull();
        expect(computeDropDockZone(RECT_400X200, 300, Number.POSITIVE_INFINITY)).toBeNull();
    });

    it("returns null when the pointer is outside the rect", () => {
        expect(computeDropDockZone(RECT_400X200, 99, 150)).toBeNull();
        expect(computeDropDockZone(RECT_400X200, 501, 150)).toBeNull();
        expect(computeDropDockZone(RECT_400X200, 300, 49)).toBeNull();
        expect(computeDropDockZone(RECT_400X200, 300, 251)).toBeNull();
    });

    it("returns null when allowedZones is empty", () => {
        expect(computeDropDockZone(RECT_400X200, 300, 150, { allowedZones: [] })).toBeNull();
    });

    it("resolves left, right, top, bottom, and center for a 400x200 rect with default threshold", () => {
        expect(DEFAULT_DOCK_EDGE_THRESHOLD).toBe(0.28);

        expect(computeDropDockZone(RECT_400X200, 300, 150)).toBe("center");
        expect(computeDropDockZone(RECT_400X200, 220, 150)).toBe("center");

        expect(computeDropDockZone(RECT_400X200, 140, 150)).toBe("left");
        expect(computeDropDockZone(RECT_400X200, 460, 150)).toBe("right");
        expect(computeDropDockZone(RECT_400X200, 300, 70)).toBe("top");
        expect(computeDropDockZone(RECT_400X200, 300, 230)).toBe("bottom");

        expect(computeDropDockZone(RECT_400X200, 100, 150)).toBe("left");
        expect(computeDropDockZone(RECT_400X200, 500, 150)).toBe("right");
        expect(computeDropDockZone(RECT_400X200, 300, 50)).toBe("top");
        expect(computeDropDockZone(RECT_400X200, 300, 250)).toBe("bottom");
    });

    it("breaks corner ties by picking the closest normalized edge", () => {
        expect(computeDropDockZone(RECT_400X200, 120, 80)).toBe("left");
        expect(computeDropDockZone(RECT_400X200, 180, 60)).toBe("top");

        expect(computeDropDockZone(RECT_400X200, 480, 220)).toBe("right");
        expect(computeDropDockZone(RECT_400X200, 420, 240)).toBe("bottom");
    });

    it("respects allowedZones when center is excluded or only center is allowed", () => {
        expect(
            computeDropDockZone(RECT_400X200, 240, 150, {
                allowedZones: ["left", "right", "top", "bottom"],
            }),
        ).toBe("left");
        expect(
            computeDropDockZone(RECT_400X200, 300, 120, {
                allowedZones: ["left", "right", "top", "bottom"],
            }),
        ).toBe("top");

        expect(
            computeDropDockZone(RECT_400X200, 420, 60, {
                allowedZones: ["left", "right"],
            }),
        ).toBe("right");

        expect(computeDropDockZone(RECT_400X200, 102, 52, { allowedZones: ["center"] })).toBe("center");
        expect(computeDropDockZone(RECT_400X200, 498, 248, { allowedZones: ["center"] })).toBe("center");

        expect(computeDropDockZone(RECT_400X200, 120, 150, { allowedZones: ["center", "right"] })).toBe("center");
    });

    it("clamps extreme edgeThreshold values and falls back on non-finite thresholds", () => {
        const zeroRect: DropTargetRect = { left: 0, top: 0, width: 400, height: 200 };

        expect(computeDropDockZone(zeroRect, 15, 100, { edgeThreshold: 0 })).toBe("left");
        expect(computeDropDockZone(zeroRect, 25, 100, { edgeThreshold: 0 })).toBe("center");
        expect(computeDropDockZone(zeroRect, 15, 100, { edgeThreshold: -0.5 })).toBe("left");

        expect(computeDropDockZone(zeroRect, 170, 100, { edgeThreshold: 0.9 })).toBe("left");
        expect(computeDropDockZone(zeroRect, 190, 100, { edgeThreshold: 0.9 })).toBe("center");

        expect(computeDropDockZone(zeroRect, 105, 100, { edgeThreshold: Number.NaN })).toBe("left");
        expect(computeDropDockZone(zeroRect, 120, 100, { edgeThreshold: Number.NaN })).toBe("center");
        expect(computeDropDockZone(zeroRect, 105, 100, { edgeThreshold: Number.POSITIVE_INFINITY })).toBe("left");
    });
});

describe("typed drag payload helpers", () => {
    it("hasDragType reports whether mimeType is present in dataTransfer.types", () => {
        expect(hasDragType(null, "application/x-pivia-session")).toBe(false);
        expect(hasDragType(undefined, "application/x-pivia-session")).toBe(false);
        expect(hasDragType({ types: ["text/plain"] }, "application/x-pivia-session")).toBe(false);
        expect(
            hasDragType({ types: ["text/plain", "application/x-pivia-session"] }, "application/x-pivia-session"),
        ).toBe(true);
    });

    it("setDragData and getDragData round-trip payloads and return null for missing or empty data", () => {
        const store = new Map<string, string>();
        const transfer: WritableDataTransfer & ReadableDataTransfer = {
            get types() {
                return [...store.keys()];
            },
            setData(format, data) {
                store.set(format, data);
            },
            getData(format) {
                return store.get(format) ?? "";
            },
        };

        setDragData(transfer, "application/x-pivia-session", "session-42");

        expect(hasDragType(transfer, "application/x-pivia-session")).toBe(true);
        expect(getDragData(transfer, "application/x-pivia-session")).toBe("session-42");
        expect(getDragData(transfer, "application/x-missing")).toBeNull();
        expect(getDragData(null, "application/x-pivia-session")).toBeNull();
        expect(getDragData(undefined, "application/x-pivia-session")).toBeNull();

        store.set("application/x-empty", "");
        expect(getDragData(transfer, "application/x-empty")).toBeNull();
    });

    it("tolerates throwing setData and getData implementations", () => {
        const throwingTransfer: WritableDataTransfer & ReadableDataTransfer = {
            types: ["application/x-pivia-pane"],
            setData() {
                throw new Error("DataTransfer is read-only");
            },
            getData() {
                throw new Error("DataTransfer is protected");
            },
        };

        expect(() => {
            setDragData(throwingTransfer, "application/x-pivia-pane", "pane-1");
        }).not.toThrow();
        expect(getDragData(throwingTransfer, "application/x-pivia-pane")).toBeNull();
    });

    it("setCustomDragPreview tolerates Node environments or missing setDragImage without throwing", () => {
        expect(() => {
            setCustomDragPreview(null, "Alpha");
            setCustomDragPreview({}, "Alpha");
            setCustomDragPreview({ setDragImage: vi.fn() }, "Alpha");
        }).not.toThrow();
    });

    it("ALL_DOCK_ZONES enumerates all five zones and startDragPayload writes mime, plain text, and effectAllowed", () => {
        expect(ALL_DOCK_ZONES).toEqual(["left", "right", "top", "bottom", "center"]);

        const store = new Map<string, string>();
        const transfer: StartDragDataTransfer & ReadableDataTransfer = {
            effectAllowed: "none",
            get types() {
                return [...store.keys()];
            },
            setData(format, data) {
                store.set(format, data);
            },
            getData(format) {
                return store.get(format) ?? "";
            },
        };

        startDragPayload(transfer, "application/x-pivia-session", "session-9", "Alpha session");
        expect(transfer.effectAllowed).toBe("move");
        expect(getDragData(transfer, "application/x-pivia-session")).toBe("session-9");
        expect(getDragData(transfer, "text/plain")).toBe("Alpha session");
    });
});
