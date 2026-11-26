import { isRecord, parseSessionModelInfo, type SessionModelInfo } from "@pivia/protocol";

import { Fuzzy } from "@/lib";

/** Default TTL for cached `get_available_models` responses (5 minutes). */
export const MODEL_CATALOG_TTL_MS = 5 * 60 * 1000;

/** TTL cache entry storing a fetched model catalog snapshot. */
export interface CachedModelCatalog {
    readonly models: readonly SessionModelInfo[];
    readonly fetchedAtMs: number;
}

/** Session-keyed TTL cache interface for `get_available_models`. */
export interface ModelCatalogCache {
    get(cacheKey: string): readonly SessionModelInfo[] | null;
    set(cacheKey: string, models: readonly SessionModelInfo[]): void;
    invalidate(cacheKey?: string): void;
}

/** Create a TTL-backed {@link ModelCatalogCache} with injectable clock. */
export function createModelCatalogCache(
    options: {
        readonly ttlMs?: number | undefined;
        readonly nowMs?: (() => number) | undefined;
    } = {},
): ModelCatalogCache {
    const ttlMs = options.ttlMs ?? MODEL_CATALOG_TTL_MS;
    const nowMs = options.nowMs ?? (() => Date.now());
    const entries = new Map<string, CachedModelCatalog>();

    return {
        get(cacheKey) {
            const entry = entries.get(cacheKey);
            if (entry === undefined) {
                return null;
            }
            if (nowMs() - entry.fetchedAtMs >= ttlMs) {
                entries.delete(cacheKey);
                return null;
            }
            return entry.models;
        },
        set(cacheKey, models) {
            entries.set(cacheKey, {
                models,
                fetchedAtMs: nowMs(),
            });
        },
        invalidate(cacheKey) {
            if (cacheKey === undefined) {
                entries.clear();
                return;
            }
            entries.delete(cacheKey);
        },
    };
}

/** Boundary parser for the untrusted `data` payload returned by `get_available_models`. */
export function parseAvailableModelsData(data: unknown): readonly SessionModelInfo[] | null {
    if (!isRecord(data) || !Array.isArray(data.models)) {
        return null;
    }
    const models: SessionModelInfo[] = [];
    for (const item of data.models) {
        const parsed = parseSessionModelInfo(item);
        if (parsed === null) {
            return null;
        }
        models.push(parsed);
    }
    return models;
}

/** Boundary parser for the untrusted `data` payload returned by `set_model`. */
export function parseSetModelData(data: unknown): SessionModelInfo | null {
    return parseSessionModelInfo(data);
}

/** Stable identifier string (`provider/id`) for one {@link SessionModelInfo}. */
export function modelChoiceKey(model: SessionModelInfo): string {
    return `${model.provider}/${model.id}`;
}

/**
 * Order models when search is empty: active model first, then sorted by provider name.
 */
export function orderModelsByProvider(
    models: readonly SessionModelInfo[],
    activeKey: string | null,
): readonly SessionModelInfo[] {
    const rest = models
        .filter((model) => modelChoiceKey(model) !== activeKey)
        .sort((left, right) => left.provider.localeCompare(right.provider));
    const active = activeKey === null ? undefined : models.find((model) => modelChoiceKey(model) === activeKey);
    return active === undefined ? rest : [active, ...rest];
}

function modelSearchText(model: SessionModelInfo): string {
    const name = model.name.length > 0 ? ` ${model.name}` : "";
    return `${model.provider} ${model.provider}/${model.id} ${model.provider} ${model.id}${name}`;
}

/** Filter and rank models using pi's provider-first fuzzy search string. */
export function filterModels(models: readonly SessionModelInfo[], query: string): readonly SessionModelInfo[] {
    return Fuzzy.filter(models, query, modelSearchText);
}
