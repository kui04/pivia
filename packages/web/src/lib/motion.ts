/**
 * Report whether the user asked the system to reduce motion.
 *
 * Returns false where `matchMedia` is absent, so Node code can call it without a DOM.
 */
export function prefersReducedMotion(): boolean {
    return (
        typeof window !== "undefined" &&
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
    );
}
