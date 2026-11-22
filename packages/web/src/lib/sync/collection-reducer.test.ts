import type { CollectionDelta } from "@pivia/protocol";
import { describe, expect, it } from "vitest";

import { createCollectionSyncReducer } from "./collection-reducer";

interface Item {
    readonly id: string;
    readonly text: string;
}

describe("createCollectionSyncReducer", () => {
    it("applies snapshot, upsert, patch, and remove uniformly and preserves references on no-ops", () => {
        type ColDelta = CollectionDelta<string, Item, { readonly text?: string }>;
        const reducer = createCollectionSyncReducer<
            readonly Item[],
            { readonly rows: readonly Item[] },
            string,
            Item,
            { readonly text?: string }
        >({
            getItems: (s) => s.rows,
            getId: (i) => i.id,
            applyPatch: (i, p) => (p.text !== undefined && p.text !== i.text ? { ...i, text: p.text } : i),
            itemsEqual: (a, b) => a.text === b.text,
            fromItems: (_prev, items) => items,
            toItems: (state) => state,
        });

        const initial = reducer.applySnapshot([], { rows: [{ id: "a", text: "1" }] });
        const afterSameUpsert = reducer.applyDelta(initial, { op: "upsert", item: { id: "a", text: "1" } });
        expect(afterSameUpsert).toBe(initial);

        const afterUpsert = reducer.applyDelta(initial, { op: "upsert", item: { id: "b", text: "2" } });
        const afterNoopPatch = reducer.applyDelta(afterUpsert, { op: "patch", id: "a", patch: { text: "1" } });
        expect(afterNoopPatch).toBe(afterUpsert);

        const afterPatch = reducer.applyDelta(afterUpsert, { op: "patch", id: "a", patch: { text: "1b" } });
        const afterMissingRemove = reducer.applyDelta(afterPatch, { op: "remove", id: "missing" });
        expect(afterMissingRemove).toBe(afterPatch);

        const afterRemove = reducer.applyDelta(afterPatch, { op: "remove", id: "b" });
        expect(afterRemove).toEqual([{ id: "a", text: "1b" }]);
        void (null as unknown as ColDelta);
    });
});
