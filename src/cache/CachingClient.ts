import isNetworkError from "is-network-error";
import { CachedObject, CacheFactory, CacheRequestOptions, ObjectCache } from "../cache.js";
import { CacheConfiguration, CacheControl, CachingRequestCacheFirstConfig, CachingRequestConfig, FetchClient, FetchClientCaching, 
        HttpError, JsonRequestOptions, JsonResult, Milliseconds, NoUpdateError, RequestOptions, Seconds} from "../client.js";        
import { SimpleFetchClient } from "../SimpleClient.js";


export class CachingClient implements FetchClientCaching {


    static readonly #DEFAULT_TABLE = "Cached";
    readonly #availableCaches: ReadonlyArray<string>;
    // keys: cache id
    readonly #cacheLoaders:Map<string, () => Promise<CacheFactory<any>>>;
    // intermediate storage for the loading promises
    // @deprecated
    readonly #cacheFactoryPromises: Map<string, Promise<CacheFactory<any>>> = new Map();
    readonly #cacheFactories: Map<string, CacheFactory<any>> = new Map();
    /** 
     * OUter key: cache id, inner key: table
     */
    readonly #caches: Map<string, Map<string, Promise<ObjectCache<any, any>>>> = new Map();
    

    constructor(
            private readonly _delegate: FetchClient, 
            cacheProvider: CacheConfiguration|Array<CacheConfiguration>
            ) {
        cacheProvider = Array.isArray(cacheProvider) ? cacheProvider : [cacheProvider];
        const nonExistentProvider = cacheProvider.find(p => !(p.id in factoryLoaders));
        if (nonExistentProvider)
            throw new Error("Unknown cache provider " + nonExistentProvider);
        this.#cacheLoaders = new Map(cacheProvider.map(provider => [provider.id, () => factoryLoaders[provider.id](provider)]));
        this.#availableCaches = Object.freeze(Array.from(this.#cacheLoaders.keys()));
    }

    // TODO support caching here as well
    fetch(input: RequestInfo | URL, init?: RequestInit & RequestOptions): Promise<Response> {
        return this._delegate.fetch(input, init);
    }

    // @ts-ignore
    async fetchJson<T>(input: RequestInfo | URL, init?: RequestInit & JsonRequestOptions & {useCache?: CachingRequestConfig<T>}): 
                    Promise<JsonResult<T>&{update?: Promise<JsonResult<T>>;}> {
        const cacheConfig: CachingRequestConfig<T>|undefined = init?.useCache;
        if (/*!cacheConfig?.mode*/ !cacheConfig?.key || cacheConfig?.forcedCacheControl?.noStore  || cacheConfig?.forcedCacheControl?.maxAge === false)
            return this._delegate.fetchJson(input, init);
        const table: string = cacheConfig.table || CachingClient.#DEFAULT_TABLE;
        const activeCaches = cacheConfig.activeCache ? (Array.isArray(cacheConfig.activeCache) ? cacheConfig.activeCache : [cacheConfig.activeCache]) : this.#availableCaches
        const cache: ObjectCache<T, any>|undefined = await this._getAvailableCache(activeCaches, table);
        if (!cache)
            return this._delegate.fetchJson(input, init);
        const init2: RequestInit = {...init};
        const signal0: AbortSignal|undefined = init?.signal || (input as Request)?.signal;
        const useCacheControl = cacheConfig.mode === "cacheControl" || cacheConfig.mode === undefined;
        const cacheAbort: AbortController = CachingClient._derivedSignalController(signal0);
        const cacheReqOptions: CacheRequestOptions = {signal: cacheAbort.signal};
        const update = (cacheConfig as CachingRequestCacheFirstConfig<T>).update;
        if (useCacheControl) {
            const cacheResult: CachedObject<any>|undefined = await cache.get(cacheConfig.key, 
                    {...cacheReqOptions, timeout: (cacheConfig as CachingRequestCacheFirstConfig<T>).cacheTimeout});
            const cachedAvailable: boolean = !!cacheResult?.value;
            let cacheState: CacheState = {state: CacheStateCore.DISABLED};
            if (cachedAvailable) {
                cacheState = CachingClient._cacheState(cacheResult!,
                              {defaultCacheControl: cacheConfig?.defaultCacheControl, forcedCacheControl: cacheConfig?.forcedCacheControl});
                if (cacheState.state === CacheStateCore.FRESH)
                    return update ? {...cacheResult!, update: Promise.reject(new NoUpdateError("Fresh cache result, no update needed.")) }: cacheResult!;
            }
            if (cacheState.state === CacheStateCore.DISABLED) {
                const resultPromise = this._delegate.fetchJson<T>(input, init2);
                resultPromise.then(f => this._updateCache(cacheConfig.key, f.value, f.headers, cache, cacheConfig)).catch(() => undefined);
                return update ? resultPromise.then(result => {return {...result, update: Promise.reject(new NoUpdateError("Cache disabled"))}}) : resultPromise;
            }
            // conditional request, if cache is STALE
            const useConditionalRequest = (cacheResult?.headers?.get("ETag") || cacheResult?.headers?.get("Last-Modified"));
            let resultPromise: Promise<JsonResult<T>&{update?: Promise<JsonResult<T>>}>;
            if (useConditionalRequest) {
                const lastMod = cacheResult!.headers.get("Last-Modified");
                const etag = cacheResult!.headers.get("ETag");
                const headers = new Headers(init2.headers || {});
                if (etag)
                    SimpleFetchClient._applyHeader("If-None-Match", etag, headers, false);
                else if (lastMod)
                    SimpleFetchClient._applyHeader("If-Modified-Since", lastMod, headers, false);
                init2.headers = headers;
                if (!SimpleFetchClient._acceptHeaderSpecified(input, init2, headers))
                    SimpleFetchClient._applyHeader("Accept", "application/json", headers, false);
                resultPromise = this._delegate.fetch(input, init2).then(async resp => {
                    if (resp.status === 304)  { // unchanged  // TODO update cache (new API method required?)
                        if (update)
                            throw new NoUpdateError("Cached value unchanged, no update required");
                        return cacheResult!;
                    }
                    // TODO perform proper json checks
                    const json = await resp.json();
                    this._updateCache(cacheConfig.key, json, resp.headers, cache, cacheConfig).catch(() => undefined);
                    return {value: json, headers: resp.headers};
                });
            } else { // final case: cache disabled or non-conditional request
                resultPromise = this._delegate.fetchJson<T>(input, init2);
                resultPromise.then(f => this._updateCache(cacheConfig.key, f.value, f.headers, cache, cacheConfig)).catch(() => undefined);
            }
            if ((cacheState as StaleCacheOptions).staleWhileRevalidate) {
                return update ? {...cacheResult!, update: resultPromise } : cacheResult!;
            }
            if ((cacheState as StaleCacheOptions).staleIfError) {
                // https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cache-Control#response_directives => stale-if-error
                resultPromise = resultPromise.catch(e => {
                    if ((e instanceof HttpError && (e.details.cause === "responseStatus" && e.details.status >= 500)) || isNetworkError(e))
                        return update ?  {...cacheResult!, update: Promise.reject(new NoUpdateError("Request failed, no update available.")) } : cacheResult!;
                    throw e;
                });
            }
            return resultPromise;
        }
        else if (cacheConfig.mode === "fetchFirst") {
            try {
                const resultPromise: Promise<{value: T, headers: Headers}> = this._delegate.fetchJson<T>(input, init2);
                resultPromise.then(f => this._updateCache(cacheConfig.key, f.value, f.headers, cache, cacheConfig)).catch(() => undefined);
                return await resultPromise;
            } catch (e) {
                try {
                    const cacheResult = await cache.get(cacheConfig.key, cacheReqOptions);
                    if (cacheResult) {
                        const cacheState: CacheState = CachingClient._cacheState(cacheResult!,
                            {defaultCacheControl: cacheConfig?.defaultCacheControl, forcedCacheControl: cacheConfig?.forcedCacheControl});
                        if (cacheState.state === CacheStateCore.FRESH || (cacheState as StaleCacheOptions).staleIfError)
                            return cacheResult;
                    }
                } catch (_) {
                }     
                throw e;
            } 
        } else if (cacheConfig.mode === "race") {
            const fetchAbort = !update ? CachingClient._derivedSignalController(signal0) : undefined; 
            if (fetchAbort) {
                init2.signal = fetchAbort.signal
            }
            const cacheResult: Promise<CachedObject<T>&CacheState|undefined> = cache.get(cacheConfig.key, cacheReqOptions).then(cached => {
                if (!cached)
                    return cached;
                return {...cached, ...CachingClient._cacheState(cached, {defaultCacheControl: cacheConfig?.defaultCacheControl, forcedCacheControl: cacheConfig?.forcedCacheControl})};
            });
            const fetchResult: Promise<{value: T, headers: Headers}> = this._delegate.fetchJson<T>(input, init2);
            const firstResult: Promise<{value: T, headers: Headers}|undefined> = Promise.race([cacheResult, fetchResult]);
            // FIXME only update cache if changed?
            fetchResult.then(f => this._updateCache(cacheConfig.key, f.value, f.headers, cache, cacheConfig)).catch(() => undefined);
            fetchResult.then(() => cacheAbort.abort(new Error("Fetch completed"))).catch(() => undefined);
            // @ts-ignore 
            return firstResult.catch(async _ => {
                    // if any of the requests fails we should go for the other
                    const results = await Promise.allSettled([cacheResult, fetchResult]);
                    // fetch failed, we return the cached result; note that if this is not available, we'll switch back to fetch in the following then
                    if (results[1].status === "rejected") {
                        const cachedResult = await cacheResult;
                        if (cachedResult) {
                            // evaluate if it is ok to return a stale cache result
                            if (cachedResult.state === CacheStateCore.FRESH || (cachedResult as StaleCacheOptions).staleWhileRevalidate
                                    || (cachedResult as StaleCacheOptions).staleIfError)
                                //return { value: cachedResult.value, headers: cachedResult.headers};
                                return cachedResult; // why not?
                        }
                    }
                    return fetchResult;
                    // @ts-ignore problem unclear
                }).then((r: JsonResult<T>|undefined) => {
                    // case 1: the first result is available, likely it is the cached one then
                    if (r !== undefined) {
                        let staleWhileRevalidate = false;
                        // check if it the cached one
                        if ((r as any as CacheState).state) {
                            // evaluate staleness
                            const cacheState = r as any as CacheState;
                            staleWhileRevalidate = (cacheState as StaleCacheOptions).staleWhileRevalidate!;
                            if (cacheState.state === CacheStateCore.STALE && !staleWhileRevalidate) {
                                const cacheUsableOnError = (cacheState as StaleCacheOptions).staleIfError;
                                const base = cacheUsableOnError ? fetchResult.catch(e => {
                                    if (e instanceof HttpError && (e.details.cause === "responseStatus" && e.details.status >= 500))
                                        return cacheResult!;
                                    if (isNetworkError(e))
                                        return cacheResult!;
                                    throw e;
                                }) : fetchResult;
                                return !update ? base :
                                    base.then(res => {return {value: res, headers: res!.headers, update: new NoUpdateError("Cache stale, no update")};});

                            }
                        }

                        if (!update) {
                            if (!staleWhileRevalidate) // cancel ongoing requests
                                fetchAbort!.abort(new NoUpdateError("Found cached result"));
                            return r;
                        }
                        // in "update" mode still wait for the fetch result and provide an update callback
                        const updatePromise = fetchResult.then(f => {
                            // TODO handle weak etags?
                            const resultEtag = f.headers.get("ETag");
                            let equal: boolean|undefined;
                            if (resultEtag) {
                                const cachedEtag = r.headers.get("ETag");
                                if (cachedEtag)
                                    equal = resultEtag === cachedEtag;
                            }
                            if (equal === undefined) {
                                const lastModified = f.headers.get("Last-Modified");
                                if (lastModified) {
                                    const cachedLastModified = r.headers.get("Last-Modified");
                                    if (cachedLastModified)
                                        equal = lastModified === cachedLastModified;
                                }
                            }
                            // @ts-ignore
                            const equalFunction: (t1: T, t2: T) => boolean = (cacheConfig as CachingRequestRaceConfig<T>).equal || deepEqual;
                            const equalResult = equal !== undefined ? equal : equalFunction(f.value, r.value);
                            if (equalResult)
                                throw new NoUpdateError("Cache and fetch returned equal results");
                            return f;
                        });
                        return {
                            value: r.value,
                            headers: r.headers, 
                            update: updatePromise
                        };
                    }
                    // case 2: the cache result returned undefined => provide only the fetched result and update the cache
                    return !update ? fetchResult : fetchResult.then(f => {
                        return {
                            value: f.value,
                            headers: f.headers,
                            update: Promise.reject(new NoUpdateError("No cached result available"))
                        };
                    });
                });

        } else {
            throw new Error("Invalid cache mode " + (cacheConfig as any).mode);
        }
        
    }
    
    async close(options?: { timeout?: Milliseconds; }): Promise<unknown> {
        await this._delegate.close(options);
        const tableCaches: Array<Promise<unknown>> = [];
        for (const tablesMap of this.#caches.values()) {
            for (const table of tablesMap.values()) {
                tableCaches.push(table.then(t => t.close()));
            }
        }
        return await Promise.all(tableCaches);
    }

    private async _getAvailableCache<T>(cacheIds: ReadonlyArray<string>, table: string): Promise<ObjectCache<T, any>|undefined> {
        for (const id of cacheIds) {
            try {
                const cache = await this._getCache<T>(id, table);
                if (cache?.available())
                    return cache;
            } catch (_) {}
        }
    }

    private _getCache<T>(id: string, table: string): Promise<ObjectCache<T, any>>|undefined {
        // case 1: the cache for the requested table already exists
        if (this.#caches.has(id) && this.#caches.get(id)?.has(table))
            return this.#caches.get(id)?.get(table)!;
        if (!this.#cacheLoaders.has(id))
            return undefined;
        const cachePromise = this._loadCache<T>(id, table);

        if (Array.from(this.#caches.keys()).indexOf(id) < 0)
            this.#caches.set(id, new Map());
        this.#caches.get(id)?.set(table, cachePromise);
        return cachePromise;
    }

    private _loadCache<T>(cacheId: string, table: string): Promise<ObjectCache<T, any>> {
        return this._loadCacheFactory(cacheId).then(factory => factory?.create<T>(table)!);
    }

    private async _loadCacheFactory(cacheId: string) {
         // case: factory not loaded yet
         if (!this.#cacheFactories.has(cacheId)) {
            const loader = this.#cacheLoaders.get(cacheId);
            if (!loader) // should not happen at this point, we checked before
                return undefined;
            let currentLoader: Promise<CacheFactory<any>>;
            const factoryLoaderCached: boolean = this.#cacheFactoryPromises.has(cacheId);
            if (factoryLoaderCached) {
                currentLoader = this.#cacheFactoryPromises.get(cacheId)!;
            } else {
                currentLoader = loader();
                // to avoid races we store the initial promise for reuse
                this.#cacheFactoryPromises.set(cacheId, currentLoader);
            }
            const factory = await currentLoader;
            this.#cacheFactories.set(cacheId, factory);
            if (!factoryLoaderCached)  // now it is stored in the #caches field and need not be loaded any more
                this.#cacheFactoryPromises.delete(cacheId);
        }
        const factory = this.#cacheFactories.get(cacheId)!;
        return factory;
    }

    /**
     * 
     * @param result 
     * @param options 
     * @returns [cache enabled at all (no-store not set), cache fresh, cache usable in case of fetch error]
     */
    private static _cacheState(result: {updated: Milliseconds; cacheControl?: CacheControl;}, options?: {defaultCacheControl?: CacheControl; forcedCacheControl?: CacheControl;} ): CacheState {
        const cacheControls: Array<CacheControl> = [];
        if (options?.defaultCacheControl)
            cacheControls.push(options.defaultCacheControl);
        cacheControls.push(result?.cacheControl!);
        if (options?.forcedCacheControl)
            cacheControls.push(options.forcedCacheControl);
        const effectiveCacheControl: CacheControl = Object.assign(Object.create(null), ...cacheControls);
        if (effectiveCacheControl.noStore)  // this effectively disables the cache
            return {state: CacheStateCore.DISABLED};
        const maxAge: Seconds|boolean|undefined = effectiveCacheControl.maxAge;
        // no-cache is equivalent to max-age = 0 + must-revalidate
        if ((maxAge === false || maxAge as number <= 0) && effectiveCacheControl.mustRevalidate)
            effectiveCacheControl.noCache = true;
        if (effectiveCacheControl.noCache)
            return {state: CacheStateCore.STALE, mustRevalidate: true }  // no-cache (applicable to all responses) implies must-revalidate (applicable to stale responses)
        if (maxAge === undefined || maxAge === true)
            return {state: CacheStateCore.FRESH};
        const now: Milliseconds = Date.now();
        const validUntil: Milliseconds = result.updated + (effectiveCacheControl.maxAge as Seconds) * 1000;
        if (now <= validUntil)
            return {state: CacheStateCore.FRESH};
        if (effectiveCacheControl.mustRevalidate)
            return {state: CacheStateCore.STALE, mustRevalidate: true }
        let staleWhileRevalidate: boolean|undefined = undefined;
        if (effectiveCacheControl.staleWhileRevalidate) {
            staleWhileRevalidate = typeof(effectiveCacheControl.staleWhileRevalidate) === "boolean" ? effectiveCacheControl.staleWhileRevalidate : 
                validUntil + (effectiveCacheControl.staleWhileRevalidate as Seconds) * 1000 >= now;
        }
        let staleIfError: boolean|undefined = undefined;
        if (effectiveCacheControl.staleIfError !== undefined) {
            staleIfError = typeof(effectiveCacheControl.staleIfError) === "boolean" ? effectiveCacheControl.staleIfError : 
                    validUntil + (effectiveCacheControl.staleIfError as Seconds) * 1000 >= now;
        }
        return {state: CacheStateCore.STALE, staleWhileRevalidate: staleWhileRevalidate, staleIfError: staleIfError};
    }

    private _updateCache<T>(key: string, value: T, headers: Headers, cache: ObjectCache<T, unknown>, cacheConfig: CachingRequestConfig<T>): Promise<boolean> {
        if (!value)
            return Promise.resolve(false);
        const cacheControl = CachingClient._evaluateCacheControl(headers);
        const cacheState = CachingClient._cacheState({updated: Date.now(), cacheControl: cacheControl}, 
            {defaultCacheControl: cacheConfig.defaultCacheControl, forcedCacheControl: cacheConfig.forcedCacheControl});
        if (cacheState.state === CacheStateCore.DISABLED)
            return Promise.resolve(false);
        return cache.set(key, value, headers, cacheControl)?.then(() => true).catch(e => {
            console.error("Failed to write object to cache for key", key, e);
            return false;
        });
    }

    clearCache(): Promise<unknown> {
        const promises = [];
        for (const db of this.#caches.values()) {
            for (const table of db.values()) {
                promises.push(table.then(t => t.clear()));
            }
        }
        return Promise.all(promises);
    }

    baseUrl(): string | undefined {
        return this._delegate.baseUrl();
    }
    abortAll(reason?: any): void {
        this._delegate.abortAll(reason);
    }

    // FIXME code copied from SimpleClient
    private static _derivedSignalController(signal?: AbortSignal): AbortController {
        const ctrl = new AbortController();
        if (signal) {
            if (signal.aborted)
                ctrl.abort(signal.reason);
            else
                signal.addEventListener("abort", () => ctrl.abort(signal.reason), {once: true});
        }
        return ctrl;
    }

    public static _evaluateCacheControl(headers: Headers): CacheControl|undefined {
        if (!headers.has("Cache-Control"))
            return CachingClient._parseExpireHeader(headers);
        const cacheControl: string = headers.get("Cache-Control")!;
        const directives: Record<string, string|boolean> = Object.fromEntries(
            cacheControl.toLowerCase()
                .split(",")
                .map(entry => entry.split("=").map(subEntry => subEntry.trim()) as [string]|[string, string])
                .filter(entry => entry.length <= 2)
                .map(entry => (entry.length === 1 ? [entry[0], true] : entry) as [string, string|boolean])
        );
        const result: CacheControl = {};
        if (directives["no-cache"])
            result.noCache = true;
        if (directives["no-store"])
            result.noStore = true;
        if (directives["must-revalidate"])
            result.mustRevalidate = true;
        if ("max-age" in directives) {
            let maxAge = parseInt(directives["max-age"] as string, 10);
            if (Number.isFinite(maxAge)) { 
                const age = parseInt(headers.get("Age")!, 10);
                if (Number.isFinite(age))
                    maxAge = maxAge - age;
                if (maxAge <= 0)
                    maxAge = 0;
                result.maxAge = maxAge;
            }
        } else {
            const expires = CachingClient._parseExpireHeader(headers);
            if (expires?.maxAge !== undefined)
                result.maxAge = expires.maxAge;
        }
        const staleWhileReval = parseInt(directives["stale-while-revalidate"] as string, 10);
        if (staleWhileReval > 0)
            result.staleWhileRevalidate = staleWhileReval;
        const staleIfError = parseInt(directives["stale-if-error"] as string, 10);
        if (staleIfError > 0)
            result.staleIfError = staleIfError;
        return result;
    }

    private static _parseExpireHeader(headers: Headers): CacheControl|undefined {
        if (!headers.has("Expires"))
            return undefined;
        const expiryDate = new Date(headers.get("Expires")!).getTime();
        if (!Number.isFinite(expiryDate))
            return undefined;
        const diffMillis = expiryDate - new Date().getTime();
        return {maxAge: Math.max(0, Math.round(diffMillis/1000))};
    }



}

/**
 * Load implementations lazily
 */
export const factoryLoaders: Record<string, (options: CacheConfiguration) => Promise<CacheFactory<any>>> = {
    "memory": async (options: CacheConfiguration) => new (await import("./MemoryCache.js")).MemoryCacheFactory(options),
    "memorylru": async (options: CacheConfiguration) => new (await import("./MemoryCacheLru.js")).MemoryCacheLruFactory(options),
};

{
    if (globalThis.indexedDB)
        factoryLoaders["indexeddb"] = async (options: CacheConfiguration) => new (await import("./IndexedDbCache.js")).IndexedDbFactory(options);
}

function deepEqual<T extends {}>(obj1: T, obj2: T) {
    if (obj1 === obj2)
        return true;
    if (!obj1 !== !obj2)  // e.g. one of them is undefined or null and the other is not
        return false;
    const t1 = typeof(obj1);
    if (t1 !== "object")  // we already compared primitives with === above; note we ignore function values here
        return false;
    const t2 = typeof(obj2);
    if (t2 !== "object")
        return false;
    if (Object.keys(obj1).length !== Object.keys(obj2).length)
        return false;
    for (const key in obj1) {
        if (!(key in obj2) || !deepEqual(obj1[key] as any, obj2[key] as any))
            return false;
    }
    return true;
}


enum CacheStateCore {

    DISABLED = 0,
    FRESH = 1,
    STALE = 2

}

interface StaleCacheOptions {

    /** 
     * must revalidate but not necessarily report the new value
     */
    staleWhileRevalidate?: boolean;
    /**
     * Need to at least send a conditional http request to validate the cached value
     */
    mustRevalidate?: boolean;
    /**
     * If true, the cached value may be used on an upstream error (500, 502, 503, 504).
     * If false, any error will be propagated immediately. If undefined => ?
     */
    staleIfError?: boolean;
    /*mustRevalidate: boolean;*/

}

type CacheState = ({state: CacheStateCore.STALE}&StaleCacheOptions)|{state: Omit<CacheStateCore, CacheStateCore.STALE>};


