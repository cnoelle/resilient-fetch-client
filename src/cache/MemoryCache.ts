import { CachedObject, CacheFactory, ObjectCache } from "../cache.js";
import { CacheConfiguration, CacheControl } from "../client.js";
import { CacheBase } from "./CacheBase.js";

export interface MemoryCacheConfig {

    maxItems?: number;
    cloneItems?: boolean;
    /**
     * By default uses structuredClone
     * @param object 
     * @returns 
     */
    deepCopy?: (object: any) => any;

}

const cacheId: string = "memory";

export class MemoryCacheFactory implements CacheFactory<MemoryCacheConfig> {

    readonly #maxItemsType: "number"|"undefined"|"object";
    readonly #cloneItems?: boolean;
    readonly #deepCopy?: (object: any) => any;

    constructor(private readonly _config: CacheConfiguration) {
        this.#maxItemsType = typeof(_config.maxItems) as any;
        this.#cloneItems = typeof(_config["cloneItems"]) === "boolean" ? _config["cloneItems"] : undefined;
        if (this.#cloneItems) {
            this.#deepCopy = typeof(_config["deepCopy"]) === "function" ? _config["deepCopy"] : globalThis.structuredClone;
            if (this.#deepCopy === undefined)
                throw new Error("structuredClone not available, please provide a deepCopy function");
        }
    }

    cacheId(): string {
        return cacheId;
    }

    create<T>(table: string): Promise<ObjectCache<T, MemoryCacheConfig>> {
        const maxItems: number|undefined = this.#maxItemsType === "number" ? this._config.maxItems as number 
                : this.#maxItemsType === "object" ? (this._config.maxItems as Record<string, number>)[table]
                : undefined;
        const config: MemoryCacheConfig = {maxItems: maxItems, cloneItems: this.#cloneItems, deepCopy: this.#deepCopy};
        return Promise.resolve(new MemoryCache(table, config));
    }
    
}

/**
 * A simple cache 
 */
export class MemoryCache<T> extends CacheBase<T, MemoryCacheConfig> {

    readonly #cache: Map<string, CachedObject<T>> = new Map();
    readonly #maxItems?: number;
    readonly #deepCopy?: (object: any) => any;

    constructor(table: string, config: MemoryCacheConfig) {
        super(table, config, cacheId);
        this.#maxItems = config.maxItems! > 0 ? config.maxItems : undefined;
        this.#deepCopy = config.cloneItems ? config.deepCopy : undefined;
    }

    available(): boolean {
        return true;
    }

    keys(): ReadableStream<Array<string>> {
        const keys = Array.from(this.#cache.keys());
        // @ts-ignore
        if (ReadableStream.from)
            // @ts-ignore
            return ReadableStream.from([keys]);
        return new ReadableStream({
            start(controller: ReadableStreamDefaultController<Array<string>>) {
                controller.enqueue(keys);
                controller.close();
            },
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
        if (this.#maxItems && this.#cache.size >= this.#maxItems) {
            const firstKey = this.#cache.keys().next().value;
            this.#cache.delete(firstKey);
        }
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