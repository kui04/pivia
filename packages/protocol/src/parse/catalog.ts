import {
    initialSyncSeq,
    nextSyncSeq,
    parseSyncEpoch,
    parseSyncSeq,
    type SyncCursor,
    type SyncEpoch,
    type SyncSeq,
} from "../sync/index.ts";

/** Identifier for one server `SessionRegistry` lifetime; changes whenever the server restarts. */
export type CatalogEpoch = SyncEpoch<"catalog">;

/** Non-negative safe integer sequence strictly monotonic within one {@link CatalogEpoch}. */
export type CatalogSeq = SyncSeq<"catalog">;

/** Logical clock cursor pairing a {@link CatalogEpoch} with its {@link CatalogSeq}. */
export type CatalogCursor = SyncCursor<"catalog">;

/** Initial zero catalog sequence before the first mutation. */
export const INITIAL_CATALOG_SEQ: CatalogSeq = initialSyncSeq<"catalog">();

/** Parse an untrusted value into a non-empty {@link CatalogEpoch}, or return `null` when invalid. */
export function parseCatalogEpoch(raw: unknown): CatalogEpoch | null {
    return parseSyncEpoch<"catalog">(raw);
}

/** Parse an untrusted value into a non-negative safe-integer {@link CatalogSeq}, or return `null`. */
export function parseCatalogSeq(raw: unknown): CatalogSeq | null {
    return parseSyncSeq<"catalog">(raw);
}

/** Advance a {@link CatalogSeq} by one, failing explicitly on safe-integer overflow. */
export function nextCatalogSeq(seq: CatalogSeq): CatalogSeq {
    return nextSyncSeq<"catalog">(seq);
}
