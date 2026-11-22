import { assertNever, type CollectionDelta, type SyncReducer } from "@pivia/protocol";

/** Options for {@link createCollectionSyncReducer}. */
export interface CollectionSyncReducerOptions<TState, TSnapshot, TId extends string, TItem, TPatch> {
    getItems(snapshot: TSnapshot): readonly TItem[];
    getId(item: TItem): TId;
    applyPatch(item: TItem, patch: TPatch): TItem;
    itemsEqual?: ((existing: TItem, incoming: TItem) => boolean) | undefined;
    fromItems(prev: TState, items: readonly TItem[], snapshot?: TSnapshot): TState;
    toItems(state: TState): readonly TItem[];
}

/**
 * Create a {@link SyncReducer} for keyed entity collections driven by `CollectionDelta`.
 */
export function createCollectionSyncReducer<TState, TSnapshot, TId extends string, TItem, TPatch>(
    options: CollectionSyncReducerOptions<TState, TSnapshot, TId, TItem, TPatch>,
): SyncReducer<TState, TSnapshot, CollectionDelta<TId, TItem, TPatch>> {
    return {
        applySnapshot(prev, snapshot) {
            return options.fromItems(prev, options.getItems(snapshot), snapshot);
        },
        applyDelta(prev, delta) {
            const current = options.toItems(prev);
            switch (delta.op) {
                case "upsert": {
                    const id = options.getId(delta.item);
                    const index = current.findIndex((candidate) => options.getId(candidate) === id);
                    if (index !== -1) {
                        const existing = current[index];
                        if (existing !== undefined && options.itemsEqual?.(existing, delta.item)) {
                            return prev;
                        }
                    }
                    const next =
                        index === -1
                            ? [...current, delta.item]
                            : current.map((candidate, idx) => (idx === index ? delta.item : candidate));
                    return options.fromItems(prev, next);
                }
                case "patch": {
                    const index = current.findIndex((candidate) => options.getId(candidate) === delta.id);
                    if (index === -1) {
                        return prev;
                    }
                    const existing = current[index];
                    if (existing === undefined) {
                        return prev;
                    }
                    const patched = options.applyPatch(existing, delta.patch);
                    if (patched === existing) {
                        return prev;
                    }
                    const next = [...current];
                    next[index] = patched;
                    return options.fromItems(prev, next);
                }
                case "remove": {
                    const next = current.filter((candidate) => options.getId(candidate) !== delta.id);
                    return next.length === current.length ? prev : options.fromItems(prev, next);
                }
                default:
                    return assertNever(delta);
            }
        },
    };
}
