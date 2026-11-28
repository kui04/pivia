/**
 * Whole seconds left before an extension dialog times out.
 *
 * The server owns the timer and resolves the dialog with `ui_resolved`; this value only drives the
 * visible countdown. `timeoutMs` is `undefined` when the extension set no timeout, and `startedAtMs`
 * is when this client first saw the request, so a late attach can show a longer time than remains.
 */
export function remainingSeconds(timeoutMs: number | undefined, startedAtMs: number, nowMs: number): number | null {
    if (timeoutMs === undefined) {
        return null;
    }
    const remainingMs = startedAtMs + timeoutMs - nowMs;
    return Math.max(0, Math.ceil(remainingMs / 1000));
}
