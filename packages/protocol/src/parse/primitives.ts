/** Returns true when `value` is a non-null, non-array object record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Exhaustiveness guard for closed discriminated unions.
 *
 * Calling this in a `default` branch makes the compiler reject unhandled variants even inside
 * `void`-returning `switch` statements.
 */
export function assertNever(value: never, message = "Unhandled discriminated union member"): never {
    throw new Error(`${message}: ${JSON.stringify(value)}`);
}
