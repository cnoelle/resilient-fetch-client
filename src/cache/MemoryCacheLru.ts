import { LRUCache } from "lru-cache";
import { CachedObject, CacheFactory, CacheRequestOptions, ObjectCache } from "../cache.js";
import { CacheConfiguration, CacheControl, Seconds } from "../client.js";
import { CacheBase } from "./CacheBase.js";

export interface MemoryCacheLruConfig {

    /**
     * Maximum number of items to cache. Either maxItems or {@link ttl} 
     * must be specified.
     */
    maxItems?: number;
    /**
     * Time to live in seconds. Either {@link maxItems} or ttl must be specified.
     */
    ttl?: Seconds;
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

const cacheId: string = "memorylru";

export class MemoryCacheLruFactory implements CacheFactory<MemoryCacheLruConfig> {

    readonly #cloneItems?: boolean;
    readonly #deepCopy?: (object: any) => any;

    constructor(private readonly _config: CacheConfiguration) {
        this.#cloneItems = typeof(_config["cloneItems"]) === "boolean" ? _config["cloneItems"] : undefined;
        if (this.#cloneItems) {
            this.#deepCopy = typeof(_config["deepCopy"]) === "function" ? _config["deepCopy"] : globalThis.structuredClone;
            if (this.#deepCopy === undefined)
                throw new Error("structuredClone not available, please provide a deepCopy function");
        }
        if (typeof(_config.maxItems) !== "number" && typeof(_config["ttl"] !== "number") )
            throw new Error("Need to specify either maxItems or ttl as a numeric value for LRUCache");
    }

    cacheId(): string {
        return cacheId;
    }

    create<T>(table: string): Promise<ObjectCache<T, MemoryCacheLruConfig>> {
        const config: MemoryCacheLruConfig = {...this._config,
            cloneImtes: this.#cloneItems, deepCopy: this.#deepCopy} as any;
        return Promise.resolve(new MemoryCacheLru(table, config));
    }
    
}

class MemoryCacheLru<T> extends CacheBase<T, MemoryCacheLruConfig> {

    readonly #cache: LRUCache<string, CachedObject<T>>;
    readonly #maxItems?: number;
    readonly #ttl?: Seconds;
    readonly #deepCopy?: (object: any) => any;

    constructor(table: string, config: MemoryCacheLruConfig) {
        super(table, config, cacheId);
        this.#maxItems = config.maxItems! > 0 ? config.maxItems : undefined;
        this.#ttl = config.ttl! > 0 ? config.ttl : undefined;
        this.#deepCopy = config.cloneItems ? config.deepCopy : undefined;
        // @ts-ignore
        const options: LRUCache.Options<string, CachedObject<T>> = {
            max: this.#maxItems,
            ttl: this.#ttl
        };
        this.#cache = new LRUCache(options);
    }

    available(): boolean {
        return true;
    }

    keys(options?: CacheRequestOptions): ReadableStream<Array<string>> {
        const gen = this.#cache.keys();
        return new ReadableStream({
            pull(controller: ReadableStreamDefaultController<Array<string>>, strategy?: QueuingStrategy) {
                if (options?.signal?.aborted)
                    controller.error(options?.signal?.reason);
                const nextArray: Array<string> = [];
                const hwm = strategy?.highWaterMark || 100;
                for (let idx=0; idx < hwm; idx++) {
                    const next = gen.next();
                    if (next.done) {
                        if (nextArray.length > 0)
                            controller.enqueue(nextArray)
                        controller.close();
                        return;
                    }
                    nextArray.push(next.value);
                }
                controller.enqueue(nextArray);
            },
            cancel(reason?: any) {
                gen.return(reason);
            }
        });
    }

    allKeys(): Promise<Array<string>> {
        return Promise.resolve([...this.#cache.keys()]);
    }
    get(key: string): Promise<CachedObject<T> | undefined> {
        const value = this.#cache.get(key);
        if (value === undefined)
            return Promise.resolve(undefined);
        const value1 = this.#deepCopy ? 
            {...value, 
                value: this.#deepCopy(value.value), 
                headers: new Headers(value.headers), 
                cacheControl: value?.cacheControl ? {...value.cacheControl} : undefined } 
            : value;
        return Promise.resolve(value1);
    }
    set(key: string, value: T, headers: Headers, cacheControl?: CacheControl): Promise<boolean> {
        if (!key || value === undefined)
            return Promise.resolve(false);
        const value1 = this.#deepCopy ? this.#deepCopy(value) : value;
        this.#cache.set(key, {key: key, updated: Date.now(), value: value1, headers: new Headers(headers), cacheControl: cacheControl});
        return Promise.resolve(true);
    }
    delete(key: string): Promise<boolean> {
        return Promise.resolve(this.#cache.delete(key));
    }
    clear(): Promise<number> {
        const size: number = this.#cache.size;
        this.#cache.clear();
        return Promise.resolve(size);
    }

}
