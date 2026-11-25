/** Clipboard action for application code. */
export type Clipboard = {
    /** Writes plain text; rejects with a plain Error when both paths fail. */
    copy(text: string): Promise<void>;
};

/**
 * Writes plain text to the system clipboard.
 *
 * `navigator.clipboard.writeText` is the current API (MDN: Baseline widely
 * available since 2020), but it only runs in a secure context and rejects when
 * the document is unfocused or the permission is denied. `execCommand("copy")`
 * is deprecated, yet it is the only path left when the async API is missing or
 * rejects, so it runs second as a best-effort fallback.
 *
 * Rejects with a plain Error when both paths fail.
 */
async function copy(text: string): Promise<void> {
    if (typeof navigator.clipboard?.writeText === "function") {
        try {
            await navigator.clipboard.writeText(text);
            return;
        } catch {
            // Permission or focus errors still leave the legacy path available.
        }
    }

    if (!copyWithExecCommand(text)) {
        throw new Error("The clipboard is not available");
    }
}

/** The app-wide clipboard action. */
export const Clipboard: Clipboard = { copy };

/**
 * The legacy copy path. It needs user activation. When the async API is absent it
 * runs before any await; when the async API rejects, activation may already be gone,
 * so a false result is possible and the caller sees the copy as failed.
 */
function copyWithExecCommand(text: string): boolean {
    const previousFocus = document.activeElement;
    const textarea = document.createElement("textarea");

    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "0";
    textarea.style.opacity = "0";
    document.body.append(textarea);

    // Selecting explicitly is what iOS Safari (and some WebKit builds) need; it is
    // harmless everywhere else.
    textarea.select();
    textarea.setSelectionRange(0, text.length);

    try {
        return document.execCommand("copy");
    } catch {
        return false;
    } finally {
        textarea.remove();
        if (previousFocus instanceof HTMLElement) {
            previousFocus.focus({ preventScroll: true });
        }
    }
}
