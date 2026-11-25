/** Returns an element a story must have rendered, or throws with a readable message. */
export function requireElement<T extends Element>(element: T | null, name: string): T {
    if (element === null) {
        throw new Error(`The story did not render ${name}`);
    }
    return element;
}

/** Returns the ScrollArea viewport inside a story canvas, or throws. */
export function requireViewport(canvasElement: HTMLElement, name: string): HTMLElement {
    return requireElement(canvasElement.querySelector<HTMLElement>("[data-slot='scroll-area-viewport']"), name);
}
