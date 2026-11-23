/** Omit keys `K` from `T`, requiring at compile time that every omitted key exists on `T`. */
export type StrictOmit<T, K extends keyof T> = Omit<T, K>;

/** Optional patch record derived from `T` for the mutable keys `K`. */
export type PatchOf<T, K extends keyof T> = {
    readonly [P in K]?: T[P] | undefined;
};

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
