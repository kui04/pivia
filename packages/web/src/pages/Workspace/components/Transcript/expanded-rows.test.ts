import { describe, expect, it } from "vitest";

import type { TranscriptItem } from "@/stores/session";

import { orphansExpandedRows, removeMissingRows, rowShape } from "./expanded-rows";

function row(id: string): TranscriptItem {
    return { kind: "user", id, text: id, images: [] };
}

describe("rowShape", () => {
    it("records the count and the first row id", () => {
        expect(rowShape([row("a"), row("b")])).toEqual({ count: 2, firstId: "a" });
        expect(rowShape([])).toEqual({ count: 0, firstId: undefined });
    });
});

describe("orphansExpandedRows", () => {
    it("ignores appended rows", () => {
        expect(orphansExpandedRows({ count: 2, firstId: "a" }, { count: 3, firstId: "a" })).toBe(false);
    });

    it("detects a shrink after the list grew first", () => {
        // The list grew from 2 to 3 rows and then dropped one; comparing against the shape from
        // before the growth would miss the shrink.
        const grown = { count: 3, firstId: "a" };
        expect(orphansExpandedRows(grown, { count: 2, firstId: "a" })).toBe(true);
    });

    it("detects a new first row even when the length stays the same", () => {
        expect(orphansExpandedRows({ count: 2, firstId: "a" }, { count: 2, firstId: "c" })).toBe(true);
    });
});

describe("removeMissingRows", () => {
    it("keeps every id while the rows still exist", () => {
        const expanded = new Set(["a"]);
        expect(removeMissingRows(expanded, [row("a"), row("b")])).toBe(expanded);
    });

    it("drops ids whose row disappeared", () => {
        const expanded = new Set(["a", "b"]);
        const next = removeMissingRows(expanded, [row("b")]);

        expect([...next]).toEqual(["b"]);
        expect(expanded.has("a")).toBe(true);
    });

    it("returns the same empty set", () => {
        const expanded = new Set<string>();
        expect(removeMissingRows(expanded, [])).toBe(expanded);
    });
});
