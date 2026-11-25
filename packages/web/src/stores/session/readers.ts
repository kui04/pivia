import { isFiniteNumber } from "@pivia/protocol";

/**
 * Reads a finite JSON number from an untrusted value.
 *
 * A session file or a socket frame can carry a missing, null, or non-finite value where a number
 * belongs, so every numeric field passes through here before it reaches the view. Numeric strings
 * stay invalid: a timestamp field must not accept text.
 */
export function readFiniteNumber(value: unknown): number | null {
    return isFiniteNumber(value) ? value : null;
}

/** Reads a finite non-negative number, or `null` when the value is negative or not numeric. */
export function readNonNegativeNumber(value: unknown): number | null {
    const parsed = readFiniteNumber(value);
    return parsed !== null && parsed >= 0 ? parsed : null;
}

/** Reads a positive number, or `undefined`; numeric strings count as numbers. */
export function readPositiveNumber(value: unknown): number | undefined {
    const parsed = readNumberLike(value);
    return parsed !== null && parsed > 0 ? parsed : undefined;
}

/** Reads a positive integer (`>= 1`), or `undefined`; numeric strings count as numbers. */
export function readPositiveInteger(value: unknown): number | undefined {
    const parsed = readNumberLike(value);
    return parsed !== null && Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

/** Reads a non-empty trimmed string, or `undefined` when the value is blank or not a string. */
export function readNonEmptyString(value: unknown): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
}

/** Numeric strings reach the view from legacy session files and hand-edited records. */
function readNumberLike(value: unknown): number | null {
    if (typeof value !== "string") {
        return readFiniteNumber(value);
    }
    const trimmed = value.trim();
    return trimmed === "" ? null : readFiniteNumber(Number(trimmed));
}
