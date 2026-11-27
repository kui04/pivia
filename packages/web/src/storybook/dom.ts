import { expect, spyOn, waitFor } from "storybook/test";

/** Returns an element a story must have rendered, or throws with a readable message. */
export function requireElement<T extends Element>(element: T | null | undefined, name: string): T {
    if (element === null || element === undefined) {
        throw new Error(`The story did not render ${name}`);
    }
    return element;
}

/** Returns the ScrollArea viewport inside a story canvas, or throws. */
export function requireViewport(canvasElement: HTMLElement, name: string): HTMLElement {
    return requireElement(canvasElement.querySelector<HTMLElement>("[data-slot='scroll-area-viewport']"), name);
}

/**
 * Stubs the clipboard write so a story can check its wiring.
 *
 * Headless Chromium denies the real write because the preview page is not focused, so the actual
 * write stays with the app and with a manual check. Call `restore()` when the story ends.
 */
export function mockClipboardSuccess() {
    const writeText = spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    return {
        /** Spy on the clipboard write, for assertions on the copied text. */
        writeText,
        /** Restores the real clipboard write. */
        restore: () => {
            writeText.mockRestore();
        },
    };
}

/** Fails both clipboard paths so a story can check the error state; call `restore()` at the end. */
export function mockClipboardFailure() {
    const writeText = spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("Clipboard denied"));
    const execCommand = spyOn(document, "execCommand").mockReturnValue(false);
    return {
        writeText,
        restore: () => {
            writeText.mockRestore();
            execCommand.mockRestore();
        },
    };
}

/** Waits until the theme decorator has applied `theme` to the document root. */
export async function waitForTheme(theme: "light" | "dark"): Promise<void> {
    await waitFor(() => expect(getComputedStyle(document.documentElement).colorScheme).toBe(theme));
}

/** Waits until the dark theme decorator has taken effect. */
export async function waitForDarkTheme(): Promise<void> {
    await waitForTheme("dark");
}
