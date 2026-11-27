/**
 * Installs an in-memory `localStorage` on `globalThis` for Node tests.
 *
 * Returns the backing map so a test can seed or clear it. Node has no `localStorage`, and
 * Zustand's persist middleware reads it when a persisted store is created.
 *
 * Call this at module scope or in `beforeEach`, never inside `vi.hoisted`: Vitest hoists that call
 * above the static imports, so this module is not initialized yet.
 */
export function installMemoryLocalStorage(): Map<string, string> {
    const entries = new Map<string, string>();
    const memoryStorage: Storage = {
        get length() {
            return entries.size;
        },
        clear() {
            entries.clear();
        },
        getItem(key) {
            return entries.get(key) ?? null;
        },
        key(index) {
            return [...entries.keys()][index] ?? null;
        },
        removeItem(key) {
            entries.delete(key);
        },
        setItem(key, value) {
            entries.set(key, value);
        },
    };
    Object.defineProperty(globalThis, "localStorage", {
        value: memoryStorage,
        configurable: true,
        writable: true,
    });
    return entries;
}
