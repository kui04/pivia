import { useCallback, useMemo, useSyncExternalStore } from "react";

/**
 * Reports whether a media query matches, and re-renders when it changes.
 *
 * The snapshot reads `matches` off the list the subscription listens to, so it never parses the
 * query again and the value can never come from another list. The first paint is already correct,
 * so the layout never flashes the other shape. Pivia renders only in the browser, so the hook reads
 * `window` during render.
 */
export function useMediaQuery(query: string): boolean {
    const list = useMemo(() => window.matchMedia(query), [query]);

    return useSyncExternalStore(
        useCallback(
            (onChange: () => void) => {
                list.addEventListener("change", onChange);
                return () => {
                    list.removeEventListener("change", onChange);
                };
            },
            [list],
        ),
        useCallback(() => list.matches, [list]),
        () => false,
    );
}
