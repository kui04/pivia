import { useCallback, useEffect, useRef, useState } from "react";

import type { ComposerCommandSender, PickerCatalogState } from "../../types";

/** Cache contract shared by the picker catalogs. */
export interface PickerCatalogCache<T> {
    get(cacheKey: string): readonly T[] | null;
    set(cacheKey: string, items: readonly T[]): void;
    invalidate(cacheKey?: string): void;
}

export interface PickerCatalogOptions<T> {
    /** Scope key, typically the session id. */
    readonly cacheKey: string;
    readonly command: "get_available_models" | "get_available_thinking_levels";
    /** Boundary parser for the RPC response payload. */
    readonly parse: (data: unknown) => readonly T[] | null;
    /** Message shown when the payload does not parse. */
    readonly invalidDataMessage: string;
    /** Optional cache; a picker without one reloads on every mount. */
    readonly cache?: PickerCatalogCache<T> | undefined;
    readonly onSendCommand: ComposerCommandSender;
}

/**
 * Loads a picker catalog over RPC and keeps the loading, ready and error states.
 *
 * A cached catalog renders immediately and skips the request. `retry` drops the cache entry and
 * starts the request again. A response that lands after unmount or after a retry is dropped, so a
 * slow first request cannot overwrite the retried result.
 *
 * @param options.command RPC command name; the hook builds the command object so the effect keeps
 * a stable dependency.
 */
export function usePickerCatalog<T>({
    cacheKey,
    command,
    parse,
    invalidDataMessage,
    cache,
    onSendCommand,
}: PickerCatalogOptions<T>): {
    readonly catalog: PickerCatalogState<T>;
    readonly retry: () => void;
} {
    const [catalog, setCatalog] = useState<PickerCatalogState<T>>(() => {
        const cached = cache?.get(cacheKey) ?? null;
        return cached === null ? { kind: "loading" } : { kind: "ready", items: cached };
    });
    // Only the latest request may write state; a retry or an unmount advances the generation.
    const requestRef = useRef(0);

    const load = useCallback((): void => {
        requestRef.current += 1;
        const requestId = requestRef.current;
        const isCurrent = (): boolean => requestRef.current === requestId;

        void onSendCommand({ type: command })
            .then((response) => {
                if (!isCurrent()) {
                    return;
                }
                if (!response.success) {
                    setCatalog({ kind: "error", message: response.error });
                    return;
                }
                const items = parse(response.data);
                if (items === null) {
                    setCatalog({ kind: "error", message: invalidDataMessage });
                    return;
                }
                cache?.set(cacheKey, items);
                setCatalog({ kind: "ready", items });
            })
            .catch((cause: unknown) => {
                if (!isCurrent()) {
                    return;
                }
                setCatalog({
                    kind: "error",
                    message: cause instanceof Error ? cause.message : String(cause),
                });
            });
    }, [cache, cacheKey, command, invalidDataMessage, onSendCommand, parse]);

    useEffect(() => {
        if (cache?.get(cacheKey) != null) {
            return;
        }
        load();
        return () => {
            requestRef.current += 1;
        };
    }, [cache, cacheKey, load]);

    const retry = useCallback(() => {
        cache?.invalidate(cacheKey);
        setCatalog({ kind: "loading" });
        load();
    }, [cache, cacheKey, load]);

    return { catalog, retry };
}
