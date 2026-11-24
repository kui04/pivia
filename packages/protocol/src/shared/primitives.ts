/** Omit keys `K` from `T`, requiring at compile time that every omitted key exists on `T`. */
export type StrictOmit<T, K extends keyof T> = Omit<T, K>;

/** Optional patch record derived from `T` for the mutable keys `K`. */
export type PatchOf<T, K extends keyof T> = {
    readonly [P in K]?: T[P] | undefined;
};

/** Decoder function for validating untrusted JSON payloads at a trust boundary. */
export type JsonDecoder<T> = (raw: unknown) => T | null;

/** Returns true when `value` is a non-null, non-array object record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns true when `value` is a non-negative safe integer (`>= 0`). */
export function isNonNegativeSafeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Returns true when `value` is a finite JavaScript number. */
export function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

/** Returns true when `value` is an array containing only strings. */
export function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
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
