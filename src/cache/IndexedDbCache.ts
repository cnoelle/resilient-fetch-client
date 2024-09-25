import { createCacheIdb, LruCacheIndexedDB, LruIdbConfig } from "lru-cache-idb";
import { CachedObject, CacheFactory, ObjectCache } from "../cache.js";
import { CacheConfiguration, CacheControl, Milliseconds } from "../client.js";
import { CacheBase } from "./CacheBase.js";


interface IndexedDbCacheConfig {

    maxItems?: number;
    /**
     * Default: 10 (if 10 >= maxItems/2)
     */
    numItemsToPurge?: number;

    /**
     * Default: 15_000 = 15s
     */
    persistencePeriod?: Milliseconds;

    /**
     * Default: "ResilientFetchClient"
     */
    dbName?: string;
    /**
     * Initializing the tables might improve performance if they are many, since it 
     * avoids version updates of the underlying IndexedDB
     */
    tables?: Array<string>;

    /**
     * Default: 100. Set to 0 to disable memory layer.
     */
    maxItemsInMemory?: number;

    /**
     * Default: maxItemsInMemory/4
     */
    numMemoryItemsToPurge?: number;

    clearOnStart?: boolean;

    indexedDB?: {
        databaseFactory: IDBFactory;
        keyRange: /* Class<IDBKeyRange>*/ any;  // XXX can we really not avoid this?
    },
    /**
     * If true, items cached will be cloned on insertion and
     * retrieval. Default: false.
     */
    cloneItems?: boolean;
    /**
     * By default uses structuredClone
     * @param object 
     * @returns 
     */
    deepCopy?: (object: any) => any;
    

}

const cacheId: string = "indexeddb";
const defaultDbName: string = "ResilientFetchClient";

export class IndexedDbFactory implements CacheFactory<IndexedDbCacheConfig> {

    readonly #config: CacheConfiguration;
    readonly #maxItemsType: "number"|"undefined"|"object";

    constructor(config: CacheConfiguration) {
        config = {...config};
        this.#maxItemsType = typeof(config.maxItems) as any;
        if (!config.indexedDB) {
            if (!globalThis.indexedDB)
                throw new Error("IndexedDB not available, need to provide a custom implementation via the indexedDB config parameter");
            config.indexedDB = {
                databaseFactory: globalThis.indexedDB,
                keyRange: globalThis.IDBKeyRange
            }
        } else {
            config.indexedDB = {...config.indexedDB};
        }
        if (config.cloneItems) {
            config.deepCopy = typeof(config["deepCopy"]) === "function" ? config["deepCopy"] : globalThis.structuredClone;
            if (config.deepCopy === undefined)
                throw new Error("structuredClone not available, please provide a deepCopy function");
        } else {
            config.deepCopy = undefined;
        }
        if (config.maxItemsInMemory !== undefined && !(config.maxItemsInMemory > 0)) {
            config.maxItemsInMemory = 0;  // disable memory
        }
        this.#config = config;
    }

    cacheId(): string {
        return cacheId;
    }

    create<T>(table: string): Promise<ObjectCache<T, IndexedDbCacheConfig>> {
        const maxItems: number|undefined = this.#maxItemsType === "number" ? this.#config.maxItems as number 
                : this.#maxItemsType === "object" ? (this.#config.maxItems as Record<string, number>)[table]
                : undefined;
        const config: IndexedDbCacheConfig = { dbName: defaultDbName, ...this.#config, maxItems: maxItems };
        return Promise.resolve(new IndexedDbCache(table, config));
    }
    
}

export class IndexedDbCache<T> extends CacheBase<T, IndexedDbCacheConfig> {

    readonly #cache: LruCacheIndexedDB<CachedObject<T>>;
    readonly #visibilityListener: Function|undefined;
   
    constructor(table: string, config: IndexedDbCacheConfig) {
        super(table, config, cacheId);
        const cacheOptions: LruIdbConfig = {
            databaseName: config.dbName,
            tablePrefix: table,
            tablePrefixesUsed: config.tables,
            maxItems: config.maxItems,
            numItemsToPurge: config.numItemsToPurge,
            persistencePeriod: config.persistencePeriod,
            indexedDB: config.indexedDB,
            copyOnInsert: config.cloneItems,
            copyOnReturn: config.cloneItems,
            deepCopy: config.deepCopy
        };
        if (config.maxItemsInMemory !== 0) {
            cacheOptions.memoryConfig = {};
            const memConfig = cacheOptions.memoryConfig;
            if (config.maxItemsInMemory! > 0)
                memConfig.maxItemsInMemory = config.maxItemsInMemory;
            if (config.numMemoryItemsToPurge! > 0)
                memConfig.numMemoryItemsToPurge = config.numMemoryItemsToPurge;
        }
        this.#cache = createCacheIdb(cacheOptions);
        if (config.clearOnStart)
            this.#cache.clear().catch(e => console.log("Failed to clear IndexedDB on start", e));
        if (config.persistencePeriod! > 0 && globalThis.document) {
            this.#visibilityListener = () => {
                if (globalThis.document.visibilityState === "hidden") {
                    this.#cache.persist();
                }
            };
            globalThis.document?.addEventListener("visibilitychange", this.#visibilityListener as any);
        }
    }

    available(): boolean {
        return !!this.#cache;
    }
    keys() {
        return this.#cache.streamKeys();
    }
    allKeys(): Promise<Array<string>> {
        return this.#cache.getAllKeys();
    }
    get(key: string): Promise<CachedObject<T> | undefined> {
        return this.#cache.get(key).then(result => { return !result ? result : {...result, headers: new Headers(result?.headers)}; });
    }
    async set(key: string, value: T, headers: Headers, cacheControl?: CacheControl): Promise<boolean> {
        await this.#cache.set(key, 
            {key: key, value: value, headers: CacheBase.serializeHeaders(headers) as any, cacheControl: cacheControl, updated: Date.now()});
        return true;
    }
    async delete(key: string): Promise<boolean> {
        const result = await this.#cache.delete(key);
        return result > 0;
    }
    async clear(): Promise<number> {
        await this.#cache.clear();
        return 1; // XXX
    }

    close(): Promise<unknown> {
        globalThis.document?.removeEventListener("visibilitychange", this.#visibilityListener as any);
        return this.#cache.close();
    }


}
