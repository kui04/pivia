type ClassValue = string | false | null | undefined;

/**
 * Joins class names and drops the empty entries. The project has no Tailwind, so
 * there is no utility-conflict merging to do; a plain join is enough.
 */
export function cn(...values: ClassValue[]): string {
    return values.filter((value): value is string => Boolean(value)).join(" ");
}
