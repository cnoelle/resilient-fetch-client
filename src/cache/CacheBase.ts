import { CachedObject, CacheRequestOptions, ObjectCache } from "../cache.js";
import { CacheControl } from "../client.js";

export abstract class CacheBase<T, CacheConfig> implements ObjectCache<T, CacheConfig> {

    readonly #cacheId: string;
    readonly #table: string;
    readonly #config: CacheConfig;

    constructor(table: string, config: CacheConfig, cacheId: string) {
        this.#table = table;
        this.#config = config;
        this.#cacheId = cacheId;
    }

    cacheId(): string {
        return this.#cacheId;
    }

    tableId(): string {
        return this.#table;
    }

    config(): CacheConfig {
        return {...this.#config};  // deep copy?
    }

    abstract available(): boolean;
    abstract keys(options?: CacheRequestOptions): ReadableStream<Array<string>>;
    abstract allKeys(options?: CacheRequestOptions): Promise<Array<string>>;
    abstract get(key: string, options?: CacheRequestOptions): Promise<CachedObject<T>|undefined>;
    abstract set(key: string, value: T, headers: Headers, cacheControl?: CacheControl, options?: CacheRequestOptions): Promise<boolean>;
    abstract delete(key: string, options?: CacheRequestOptions): Promise<boolean>;
    abstract clear(): Promise<number>;

    close(): Promise<unknown> {
        return Promise.resolve();
    }

    public static serializeHeaders(headers: Headers): Record<string, string> {
        const result: Record<string, string> = {};
        headers.forEach((value, key) => {
            if (!key.startsWith("__"))  // no __proto__ etc
                result[key] = value;
        });
        return result;
    }

}
