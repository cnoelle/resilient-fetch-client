import { factoryLoaders } from "./cache/CachingClient.js";
import { CacheConfiguration, CacheControl, Milliseconds } from "./client.js";

// =========================================================================== //
// This file contains provider interfaces for cache functionality.             //
// Most users of this library should not need to import anything from here.    //
// =========================================================================== //


export interface CachedObject<T> {
    key: string;
    updated: number;
    value: T;
    headers: Headers;
    cacheControl?: CacheControl;
}

export interface CacheFactory<CacheConfig> {

    /**
     * Unique id of this cache factory.
     */
    cacheId(): string;
    /**
     * In case of unavailability of critical resources, such as some local storage technology
     * or connectivity to an external system, this method should return a rejected promise.
     */
    create<T>(table: string): Promise<ObjectCache<T, CacheConfig>>;

}

export interface CacheRequestOptions {
    timeout?: Milliseconds;
    signal?: AbortSignal;
}

/**
 * A key-value cache for storing objects of type T
 */
export interface ObjectCache<T, CacheConfig> {

    cacheId(): string;
    tableId(): string;
    config(): CacheConfig;
    available(): boolean;

    keys(options?: CacheRequestOptions): ReadableStream<Array<string>>;
    allKeys(options?: CacheRequestOptions): Promise<Array<string>>;
    get(key: string, options?: CacheRequestOptions): Promise<CachedObject<T>|undefined>;
    set(key: string, value: T, headers: Headers, cacheControl?: CacheControl, options?: CacheRequestOptions): Promise<boolean>;
    delete(key: string, options?: CacheRequestOptions): Promise<boolean>;
    clear(options?: CacheRequestOptions): Promise<number>;
    close(): Promise<unknown>;

}

/**
 * A plugin interface for adding new cache providers
 * @param providerId at most 64 characters, MUST start with an ASCII letter.
 * @param loader 
 * @returns 
 */
export function registerCacheProvider(providerId: string, loader: (options: CacheConfiguration) => Promise<CacheFactory<any>>) {
    if (!(/[a-zA-Z]/).test(providerId.charAt(0)))  // only letters allowed as first char, e.g. no "__proto__"
        throw new Error("Invalid character at position 0: " + providerId);
    if (providerId.length > 64)
        throw new Error("Provider id too long: " + providerId);
    if (providerId in factoryLoaders) {
        if (loader !== factoryLoaders[providerId])
            throw new Error("Cache provider with id " + providerId + " already registered");
        return;
    }
    factoryLoaders[providerId] = loader;
}
