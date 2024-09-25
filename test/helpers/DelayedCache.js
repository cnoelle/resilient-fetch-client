import { registerCacheProvider } from "../../dist/cache.js";
import { CacheBase } from "../../dist/cache/CacheBase.js";
import { MemoryCacheFactory } from "../../dist/cache/MemoryCache.js";

export const delayedCacheId = "test-delayed";

export class DelayedCacheFactory  {

    #setDelay;
    #getDelay;
    #delegate;
    #maxItems;

    constructor(_config) {
        this.#setDelay = _config["setDelay"] || 25;
        this.#getDelay = _config["getDelay"] || 25;
        this.#maxItems = _config["maxItems"];
        this.#delegate = new MemoryCacheFactory(_config);
    }

    cacheId() {
        return delayedCacheId;
    }

    async create(table) {
        const delegate = await this.#delegate.create(table);
        return new DelayedCache(table, {setDelay: this.#setDelay, getDelay: this.#getDelay, maxItems: this.#maxItems}, delegate);
    }
    
}

/**
 * A simple cache 
 */
export class DelayedCache extends CacheBase {

    #delegate;
    #getDelay;
    #setDelay;

    constructor(table, config, delegate) {
        super(table, config, delayedCacheId);
        this.#delegate = delegate;
        this.#getDelay = config.getDelay;
        this.#setDelay = config.setDelay;
        
    }

    async available() {
        await new Promise(resolve => setTimeout(resolve, this.#getDelay));
        return this.#delegate.available();
    }

    async allKeys() {
        await new Promise(resolve => setTimeout(resolve, this.#getDelay));
        return this.#delegate.keys();
    }
    async get(key) {
        await new Promise(resolve => setTimeout(resolve, this.#getDelay));
        return this.#delegate.get(key);
    }
    async set(key, value, headers, cacheControl) {
        await new Promise(resolve => setTimeout(resolve, this.#setDelay));
        return this.#delegate.set(key, value, headers, cacheControl);
    }
    async delete(key) {
        await new Promise(resolve => setTimeout(resolve, this.#setDelay));
        return this.#delegate.delete(key);
    }
    async clear() {
        await new Promise(resolve => setTimeout(resolve, this.#setDelay));
        return this.#delegate.clear();
    }

}

const factory = (options) => {
    return Promise.resolve(new DelayedCacheFactory(options));
};



export function registerDelayedCache() {
    registerCacheProvider(delayedCacheId, factory);
}