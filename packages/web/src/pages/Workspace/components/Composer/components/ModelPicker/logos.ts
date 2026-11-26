import { isRecord } from "@pivia/protocol";

/** Branded provider slug validated for `https://models.dev/logos/{provider}.svg`. */
declare const ProviderIdBrand: unique symbol;
export type ProviderId = string & { readonly [ProviderIdBrand]: "ProviderId" };

/** Default TTL for a resolved provider SVG logo (24 hours). */
export const PROVIDER_LOGO_TTL_MS = 24 * 60 * 60 * 1000;

/** Retry cooldown after a missing placeholder or failed fetch (30 minutes). */
export const PROVIDER_LOGO_RETRY_MS = 30 * 60 * 1000;

const PROVIDER_SLUG_RE = /^[A-Za-z0-9._-]+$/;
const STORAGE_PREFIX = "pivia.provider-logo.v1:";

/**
 * First path data fragment of models.dev's fallback sparkle icon returned with HTTP 200 when a
 * provider slug is unknown. Matching this path avoids displaying a generic sparkle for every
 * custom provider instead of our own fallback icon.
 */
const MODELS_DEV_PLACEHOLDER_PATH = "M9.8132 15.9038L9 18.75L8.1868 15.9038";

/** Resolved logo state returned by {@link ProviderLogoCache}. */
export type ProviderLogoState = { readonly kind: "svg"; readonly maskDataUrl: string } | { readonly kind: "missing" };

/** Dependencies injected into {@link createProviderLogoCache} for deterministic testing. */
export interface ProviderLogoCacheOptions {
    readonly fetch?: typeof globalThis.fetch | undefined;
    readonly nowMs?: (() => number) | undefined;
    readonly ttlMs?: number | undefined;
    readonly retryMs?: number | undefined;
    readonly storage?: Storage | null | undefined;
}

/** In-memory + TTL-cached provider logo loader backed by `https://models.dev/logos/{provider}.svg`. */
export interface ProviderLogoCache {
    getCached(provider: string): ProviderLogoState | null;
    load(provider: string): Promise<ProviderLogoState>;
    clear(): void;
}

type StoredLogoEntry =
    | { readonly kind: "svg"; readonly maskDataUrl: string; readonly expiresAtMs: number }
    | { readonly kind: "missing"; readonly expiresAtMs: number };

/** Parse and validate a provider slug (`[A-Za-z0-9._-]+`, rejecting `.` and `..`). */
export function parseProviderId(raw: string): ProviderId | null {
    if (raw.length === 0 || raw === "." || raw.includes("..") || !PROVIDER_SLUG_RE.test(raw)) {
        return null;
    }
    return raw as ProviderId;
}

/** Returns true when an SVG response matches models.dev's unknown-provider placeholder sparkle. */
export function isPlaceholderProviderSvg(svgText: string): boolean {
    return svgText.includes(MODELS_DEV_PLACEHOLDER_PATH);
}

function svgToMaskDataUrl(svgText: string): string {
    const bytes = new TextEncoder().encode(svgText);
    const chunks: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
    }
    return `data:image/svg+xml;base64,${btoa(chunks.join(""))}`;
}

function defaultStorage(): Storage | null {
    try {
        return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
    } catch {
        return null;
    }
}

function parseStoredEntry(raw: string | null): StoredLogoEntry | null {
    if (raw === null) {
        return null;
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!isRecord(parsed) || typeof parsed.expiresAtMs !== "number" || !Number.isFinite(parsed.expiresAtMs)) {
            return null;
        }
        if (parsed.kind === "missing") {
            return { kind: "missing", expiresAtMs: parsed.expiresAtMs };
        }
        if (
            parsed.kind === "svg" &&
            typeof parsed.maskDataUrl === "string" &&
            parsed.maskDataUrl.startsWith("data:image/svg+xml;base64,")
        ) {
            return { kind: "svg", maskDataUrl: parsed.maskDataUrl, expiresAtMs: parsed.expiresAtMs };
        }
        return null;
    } catch {
        return null;
    }
}

function toLogoState(entry: StoredLogoEntry): ProviderLogoState {
    return entry.kind === "svg" ? { kind: "svg", maskDataUrl: entry.maskDataUrl } : { kind: "missing" };
}

/** Create a TTL-backed {@link ProviderLogoCache} with concurrent fetch deduplication. */
export function createProviderLogoCache(options: ProviderLogoCacheOptions = {}): ProviderLogoCache {
    const fetchFn =
        options.fetch ?? (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null);
    const nowMs = options.nowMs ?? (() => Date.now());
    const ttlMs = options.ttlMs ?? PROVIDER_LOGO_TTL_MS;
    const retryMs = options.retryMs ?? PROVIDER_LOGO_RETRY_MS;
    const storage = options.storage === undefined ? defaultStorage() : options.storage;

    const memory = new Map<ProviderId, StoredLogoEntry>();
    const inFlight = new Map<ProviderId, Promise<ProviderLogoState>>();

    const readEntry = (id: ProviderId): ProviderLogoState | null => {
        const now = nowMs();
        const mem = memory.get(id);
        if (mem !== undefined) {
            if (now < mem.expiresAtMs) {
                return toLogoState(mem);
            }
            memory.delete(id);
        }

        if (storage !== null) {
            try {
                const stored = parseStoredEntry(storage.getItem(`${STORAGE_PREFIX}${id}`));
                if (stored !== null && now < stored.expiresAtMs) {
                    memory.set(id, stored);
                    return toLogoState(stored);
                }
                if (stored !== null) {
                    storage.removeItem(`${STORAGE_PREFIX}${id}`);
                }
            } catch {
                // Storage read failures degrade cleanly to memory/network.
            }
        }
        return null;
    };

    const writeEntry = (id: ProviderId, state: ProviderLogoState): void => {
        const expiresAtMs = nowMs() + (state.kind === "svg" ? ttlMs : retryMs);
        const entry: StoredLogoEntry =
            state.kind === "svg"
                ? { kind: "svg", maskDataUrl: state.maskDataUrl, expiresAtMs }
                : { kind: "missing", expiresAtMs };
        memory.set(id, entry);
        if (storage !== null) {
            try {
                storage.setItem(`${STORAGE_PREFIX}${id}`, JSON.stringify(entry));
            } catch {
                // Ignore storage quota errors; in-memory TTL remains active.
            }
        }
    };

    return {
        getCached(provider) {
            const id = parseProviderId(provider);
            if (id === null) {
                return { kind: "missing" };
            }
            return readEntry(id);
        },
        async load(provider) {
            const id = parseProviderId(provider);
            if (id === null) {
                return { kind: "missing" };
            }
            const cached = readEntry(id);
            if (cached !== null) {
                return cached;
            }
            const existing = inFlight.get(id);
            if (existing !== undefined) {
                return existing;
            }
            if (fetchFn === null) {
                return { kind: "missing" };
            }

            const promise = (async (): Promise<ProviderLogoState> => {
                try {
                    const response = await fetchFn(`https://models.dev/logos/${encodeURIComponent(id)}.svg`);
                    if (!response.ok) {
                        const missing: ProviderLogoState = { kind: "missing" };
                        writeEntry(id, missing);
                        return missing;
                    }
                    const svgText = await response.text();
                    if (!svgText.includes("<svg") || isPlaceholderProviderSvg(svgText)) {
                        const missing: ProviderLogoState = { kind: "missing" };
                        writeEntry(id, missing);
                        return missing;
                    }
                    const resolved: ProviderLogoState = {
                        kind: "svg",
                        maskDataUrl: svgToMaskDataUrl(svgText),
                    };
                    writeEntry(id, resolved);
                    return resolved;
                } catch {
                    const missing: ProviderLogoState = { kind: "missing" };
                    writeEntry(id, missing);
                    return missing;
                } finally {
                    inFlight.delete(id);
                }
            })();

            inFlight.set(id, promise);
            return promise;
        },
        clear() {
            memory.clear();
            if (storage !== null) {
                try {
                    const keysToRemove: string[] = [];
                    for (let index = 0; index < storage.length; index += 1) {
                        const key = storage.key(index);
                        if (key !== null && key.startsWith(STORAGE_PREFIX)) {
                            keysToRemove.push(key);
                        }
                    }
                    for (const key of keysToRemove) {
                        storage.removeItem(key);
                    }
                } catch {
                    // Ignore storage clearing failures.
                }
            }
        },
    };
}
