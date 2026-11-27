/**
 * True when a keyboard event belongs to an active IME composition.
 *
 * WebKit clears `isComposing` before the `keydown` that commits a candidate and reports the legacy
 * `keyCode` 229 instead, so both signals are read (https://bugs.webkit.org/show_bug.cgi?id=165004).
 */
export function isImeComposition(event: KeyboardEvent): boolean {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- Deliberate legacy read; see above.
    return event.isComposing || event.keyCode === 229;
}
