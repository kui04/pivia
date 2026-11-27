/** `DOM_DELTA_LINE` value from the WheelEvent specification. */
const DOM_DELTA_LINE = 1;

/** `DOM_DELTA_PAGE` value from the WheelEvent specification. */
const DOM_DELTA_PAGE = 2;

/**
 * Convert a wheel delta to pixels.
 *
 * A line-based delta multiplies by `lineSize`, a page-based one by `pageSize`, and a pixel delta
 * passes through unchanged. The numeric delta modes keep this helper usable outside a browser,
 * where the `WheelEvent` constants are absent.
 *
 * @returns The delta in pixels; the sign follows the input direction.
 */
export function normalizeWheelDelta(delta: number, deltaMode: number, pageSize: number, lineSize: number): number {
    switch (deltaMode) {
        case DOM_DELTA_LINE:
            return delta * lineSize;
        case DOM_DELTA_PAGE:
            return delta * pageSize;
        default:
            return delta;
    }
}
