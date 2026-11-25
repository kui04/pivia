import { isRecord } from "@pivia/protocol";

import { Log } from "../log";

import type { IndexedDbCoordinatorOptions, SnapshotCache } from "./types";

/** Object store declaration registered with {@link IndexedDbCoordinator}. */
export interface ObjectStoreSchema {
    readonly name: string;
    readonly options: IDBObjectStoreParameters;
}

/** Internal lifecycle hook implemented by each domain slice of an IndexedDB app cache. */
export interface CacheSlice {
    readonly schemas: readonly ObjectStoreSchema[];
    clearMemory(): void;
    /** Best-effort space reclamation invoked when another slice encounters `QuotaExceededError`. */
    freeSpace?(db: IDBDatabase): Promise<void>;
}

export function requestPromise<T>(request: IDBRequest<T>): Promise<unknown> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
    });
}

export function transactionDone(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
        transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted."));
    });
}

export function isQuotaExceededError(error: unknown): boolean {
    if (typeof DOMException !== "undefined" && error instanceof DOMException) {
        return error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED";
    }
    return error instanceof Error && error.name === "QuotaExceededError";
}

function isInvalidStateError(error: unknown): boolean {
    if (typeof DOMException !== "undefined" && error instanceof DOMException) {
        return error.name === "InvalidStateError";
    }
    return error instanceof Error && error.name === "InvalidStateError";
}

/**
 * Shared IndexedDB connection and memory-degradation coordinator across cache slices.
 *
 * Centralizing connection state and slice schemas keeps object-store creation, degradation
 * state, and atomic `clearAll` cleanup consistent across independent domain slices.
 */
export class IndexedDbCoordinator {
    readonly keyRange: typeof IDBKeyRange | undefined;
    readonly nowMs: () => number;

    private readonly dbName: string;
    private readonly dbVersion: number;
    private readonly idbFactory: IDBFactory | undefined;
    private readonly slices: CacheSlice[] = [];
    private readonly schemas: ObjectStoreSchema[] = [];

    private dbPromise: Promise<IDBDatabase | null> | null = null;
    private degradedToMemory = false;

    constructor(dbName: string, dbVersion: number, options: IndexedDbCoordinatorOptions = {}) {
        this.dbName = dbName;
        this.dbVersion = dbVersion;
        this.idbFactory =
            "indexedDB" in options
                ? options.indexedDB
                : typeof globalThis !== "undefined"
                  ? globalThis.indexedDB
                  : undefined;
        this.keyRange =
            "keyRange" in options
                ? options.keyRange
                : typeof globalThis !== "undefined"
                  ? globalThis.IDBKeyRange
                  : undefined;
        this.nowMs = options.nowMs ?? (() => Date.now());
        if (this.idbFactory === undefined || this.keyRange === undefined) {
            this.degradedToMemory = true;
        }
    }

    /** Register a slice and its object-store schemas before the database opens. */
    registerSlice<TSlice extends CacheSlice>(slice: TSlice): TSlice {
        if (this.dbPromise !== null) {
            throw new Error("Cannot register cache slices after IndexedDB connection has opened.");
        }
        this.slices.push(slice);
        for (const schema of slice.schemas) {
            if (!this.schemas.some((existing) => existing.name === schema.name)) {
                this.schemas.push(schema);
            }
        }
        return slice;
    }

    isDegraded(): boolean {
        return this.degradedToMemory;
    }

    degrade(): void {
        this.degradedToMemory = true;
    }

    async openDb(): Promise<IDBDatabase | null> {
        if (this.degradedToMemory || this.idbFactory === undefined) {
            return null;
        }
        if (this.dbPromise !== null) {
            return this.dbPromise;
        }
        const opening = this.openRawConnection(() => {
            if (this.dbPromise === opening) {
                this.dbPromise = null;
            }
        }).then((db) => {
            if (db === null) {
                this.degrade();
            }
            return db;
        });
        this.dbPromise = opening;
        return opening;
    }

    /**
     * Run a cleanup action against an active IndexedDB connection or an isolated temporary handle.
     *
     * Never mutates `degradedToMemory` or `dbPromise` for temporary cleanup connections so
     * concurrent reads/writes cannot observe a false non-degraded state.
     */
    async runCleanup(label: string, action: (db: IDBDatabase) => Promise<void>): Promise<void> {
        if (this.idbFactory === undefined) {
            return;
        }
        const pending = this.dbPromise;
        if (pending !== null) {
            const existing = await pending;
            if (existing !== null) {
                try {
                    await action(existing);
                    return;
                } catch (error) {
                    if (!isInvalidStateError(error)) {
                        Log.warn(`IndexedDB ${label} failed`, error);
                        return;
                    }
                    // Reset stale closed handle so cleanup can retry on a fresh connection.
                    if (this.dbPromise === pending) {
                        this.dbPromise = null;
                    }
                }
            }
        }

        const tempDb = await this.openRawConnection();
        if (tempDb === null) {
            return;
        }
        try {
            await action(tempDb);
        } catch (error) {
            Log.warn(`IndexedDB ${label} failed`, error);
        } finally {
            tempDb.close();
        }
    }

    async freeQuota(db: IDBDatabase, requester: CacheSlice): Promise<void> {
        for (const slice of this.slices) {
            if (slice !== requester && slice.freeSpace !== undefined) {
                await slice.freeSpace(db);
            }
        }
    }

    async clearAll(): Promise<void> {
        const storeNames: string[] = [];
        for (const slice of this.slices) {
            slice.clearMemory();
            for (const schema of slice.schemas) {
                if (!storeNames.includes(schema.name)) {
                    storeNames.push(schema.name);
                }
            }
        }
        if (storeNames.length === 0) {
            return;
        }
        await this.runCleanup("clearAll", async (db) => {
            const tx = db.transaction(storeNames, "readwrite");
            for (const name of storeNames) {
                await requestPromise(tx.objectStore(name).clear());
            }
            await transactionDone(tx);
        });
    }

    private openRawConnection(onClosed?: () => void): Promise<IDBDatabase | null> {
        const factory = this.idbFactory;
        if (factory === undefined) {
            return Promise.resolve(null);
        }
        const schemas = [...this.schemas];
        return new Promise<IDBDatabase | null>((resolve) => {
            try {
                const request = factory.open(this.dbName, this.dbVersion);
                request.onupgradeneeded = () => {
                    const db = request.result;
                    for (const schema of schemas) {
                        if (!db.objectStoreNames.contains(schema.name)) {
                            db.createObjectStore(schema.name, schema.options);
                        }
                    }
                };
                request.onsuccess = () => {
                    const db = request.result;
                    db.onversionchange = () => {
                        db.close();
                        onClosed?.();
                    };
                    db.onclose = () => {
                        onClosed?.();
                    };
                    resolve(db);
                };
                request.onerror = () => resolve(null);
                request.onblocked = () => resolve(null);
            } catch {
                resolve(null);
            }
        });
    }
}

/** Configuration for {@link IndexedDbSnapshotCache}. */
export interface IndexedDbSnapshotCacheConfig<TSnapshot> {
    readonly coordinator: IndexedDbCoordinator;
    readonly storeName: string;
    /** Parse an untrusted persisted value into the domain snapshot type, or `null` if invalid. */
    readonly parse: (raw: unknown) => TSnapshot | null;
    /** Primary key inside the object store (`keyPath: "key"`). Defaults to `"default"`. */
    readonly recordKey?: string | undefined;
}

/**
 * Reusable single-record IndexedDB snapshot cache with boundary validation and memory fallback.
 *
 * Persisted records wrap the domain snapshot as `{ key, value }` so the IndexedDB `keyPath`
 * never collides with or pollutes domain properties passed into `parse`.
 */
export class IndexedDbSnapshotCache<TSnapshot> implements SnapshotCache<TSnapshot>, CacheSlice {
    readonly schemas: readonly ObjectStoreSchema[];

    private readonly coordinator: IndexedDbCoordinator;
    private readonly storeName: string;
    private readonly parse: (raw: unknown) => TSnapshot | null;
    private readonly recordKey: string;
    private memSnapshot: TSnapshot | null = null;

    constructor(config: IndexedDbSnapshotCacheConfig<TSnapshot>) {
        this.coordinator = config.coordinator;
        this.storeName = config.storeName;
        this.schemas = [{ name: config.storeName, options: { keyPath: "key" } }];
        this.parse = config.parse;
        this.recordKey = config.recordKey ?? "default";
    }

    clearMemory(): void {
        this.memSnapshot = null;
    }

    async get(): Promise<TSnapshot | null> {
        const db = await this.coordinator.openDb();
        if (db === null) {
            return this.memSnapshot;
        }
        try {
            const tx = db.transaction([this.storeName], "readonly");
            const raw = await requestPromise(tx.objectStore(this.storeName).get(this.recordKey));
            await transactionDone(tx);
            if (raw === undefined) {
                this.memSnapshot = null;
                return null;
            }
            const parsed = isRecord(raw) && raw.key === this.recordKey ? this.parse(raw.value) : null;
            if (parsed === null) {
                this.memSnapshot = null;
                const cleanupTx = db.transaction([this.storeName], "readwrite");
                await requestPromise(cleanupTx.objectStore(this.storeName).delete(this.recordKey));
                await transactionDone(cleanupTx);
                return null;
            }
            this.memSnapshot = parsed;
            return parsed;
        } catch (error) {
            Log.warn(`IndexedDB ${this.storeName}.get failed, falling back to memory cache`, error);
            this.coordinator.degrade();
            return this.memSnapshot;
        }
    }

    async put(snapshot: TSnapshot): Promise<void> {
        const record = { key: this.recordKey, value: snapshot };
        const db = await this.coordinator.openDb();
        if (db === null) {
            this.memSnapshot = snapshot;
            return;
        }
        const writeOnce = async (): Promise<void> => {
            const tx = db.transaction([this.storeName], "readwrite");
            await requestPromise(tx.objectStore(this.storeName).put(record));
            await transactionDone(tx);
        };
        try {
            await writeOnce();
            this.memSnapshot = snapshot;
        } catch (error) {
            if (isQuotaExceededError(error)) {
                try {
                    await this.coordinator.freeQuota(db, this);
                    await writeOnce();
                    this.memSnapshot = snapshot;
                    return;
                } catch (retryError) {
                    Log.warn(`IndexedDB ${this.storeName}.put quota retry failed`, retryError);
                }
            } else {
                Log.warn(`IndexedDB ${this.storeName}.put failed`, error);
            }
            this.coordinator.degrade();
            this.memSnapshot = snapshot;
        }
    }
}
