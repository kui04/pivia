declare const CatalogEpochBrand: unique symbol;

/** Identifier for one server `SessionRegistry` lifetime; changes whenever the server restarts. */
export type CatalogEpoch = string & { readonly [CatalogEpochBrand]: "CatalogEpoch" };

declare const CatalogSeqBrand: unique symbol;

/** Non-negative safe integer sequence strictly monotonic within one {@link CatalogEpoch}. */
export type CatalogSeq = number & { readonly [CatalogSeqBrand]: "CatalogSeq" };

/** Logical clock cursor pairing a {@link CatalogEpoch} with its {@link CatalogSeq}. */
export interface CatalogCursor {
    readonly epoch: CatalogEpoch;
    readonly seq: CatalogSeq;
}

// 0 satisfies the non-negative safe-integer invariant of CatalogSeq.
export const INITIAL_CATALOG_SEQ: CatalogSeq = 0 as CatalogSeq;

/** Parse an untrusted value into a non-empty {@link CatalogEpoch}, or return `null` when invalid. */
export function parseCatalogEpoch(raw: unknown): CatalogEpoch | null {
    return typeof raw === "string" && raw.length > 0 ? (raw as CatalogEpoch) : null;
}

/** Parse an untrusted value into a non-negative safe-integer {@link CatalogSeq}, or return `null`. */
export function parseCatalogSeq(raw: unknown): CatalogSeq | null {
    return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? (raw as CatalogSeq) : null;
}

/** Advance a {@link CatalogSeq} by one, failing explicitly on safe-integer overflow. */
export function nextCatalogSeq(seq: CatalogSeq): CatalogSeq {
    const next = seq + 1;
    if (!Number.isSafeInteger(next)) {
        throw new RangeError("Catalog sequence overflow.");
    }
    // Safe integer increment preserves the non-negative safe-integer invariant of CatalogSeq.
    return next as CatalogSeq;
}
