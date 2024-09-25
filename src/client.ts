import { SimpleFetchClient } from "./SimpleClient.js";

export type Seconds = number;
export type Milliseconds = number;

/**
 * Options that can be passed to each request.
 */
export interface RequestOptions {
    /**
     * By default, status codes >= 400 are treated as errors, other than in standard fetch.
     * This can be disabled and the standard fetch behaviour restored, by setting this flag.
     */
    skipFailOnErrorCode?: boolean;
}

/**
 * Options for JSON requests.
 */
export interface JsonRequestOptions extends RequestOptions {
    /**
     * By default the header "Accept: application/json" is added to a JSON request, if no
     * Accept header is set. Set this flag to skip this.
     */
    skipAcceptHeader?: boolean;
    /**
     * By default response Content-Type header is checked to contain "application/json", and
     * an error is thrown if it is missing. Set this flag to skip this validation.
     */
    skipContentTypeHeaderValidation?: boolean;
}

/**
 * The result of a json request, returning the retrieved value plus headers.
 */
export interface JsonResult<T> {
    value: T;
    headers: Headers;
}


/**
 * Represents information retrieved from a cache-control response header,
 * plus potentially from Expired or Age headers.
 * See https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cache-Control,
 * https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cache-Control#response_directives,
 * https://bizcoder.com/caching-is-hard-draw-me-a-picture/
 */
export interface CacheControl {

    /**
     * Maximum freshness time of cached items in seconds. Alternatively, true is interpreted as infinite, false as 0.
     */
    maxAge?: Seconds|boolean; 
    // no-cache means "it can be stored but don't reuse before validating"; equivalent to max-age=0 + must-revalidate
    noCache?: boolean;
    // no-store is stronger than no-cache; indicate not to cache at all
    noStore?: boolean;
    /**
     * The must-revalidate response directive indicates that the response can be stored in caches and can be reused while fresh. 
     * If the response becomes stale, it must be validated with the origin server before reuse (otherwise the client is allowed to reuse the cached value on connection errors). Typically, must-revalidate is used with max-age.
     */
    mustRevalidate?: boolean;
    /**
     * The stale-while-revalidate response directive indicates that the cache could reuse a stale response while it revalidates it to a cache.
     */
    staleWhileRevalidate?: Seconds|boolean;
    /**
     * The stale-if-error response directive indicates that the cache can reuse a stale response when an upstream server generates an error, 
     * or when the error is generated locally. Here, an error is considered any response with a status code of 500, 502, 503, or 504.
     */
    staleIfError?: Seconds|boolean;
}


/**
 * Configuration for requests with caching enabled
 */
export interface GenericCacheConfig {
    /**
     * Specify the cache key for this particular request
     */
    key: string;
    /**
     * If more than one cache is configured the appropriate one can be selected via this property
     */
    /**
     * Specify a table name for the request; if none specified, a default is used.
     * This can be used to separate requests of different kinds.
     */
    table?: string;
    /**
     * Default: "cacheControl", i.e. evaluate response headers to determine max cache time etc., and try
     * to read from cache first before sending any request to the server. 
     */
    mode?: "cacheControl"|"fetchFirst"|"race";
    /**
     * These settings are applied if the respective headers are not set on the cached response.
     */
    defaultCacheControl?: CacheControl;
    /**
     * These settings overwrite the respective response headers.
     */
    forcedCacheControl?: CacheControl;

    /**
     * Specify specific cache(s) to use
     */
    activeCache?: string|Array<string>;

}


export interface CachingRequestCacheFirstConfig<T> extends GenericCacheConfig {
    mode?: "cacheControl"|"race";
    /**
     * Provide an updated fetched value later if a cached result is returned.
     * Note that if the cache is fresh this will not trigger and return a failed promise.
     * In order to force trigger it, provide a forcedCachControl: {maxAge: 0} argument as well (or no-cache directive?).
     * If the no-cache directive is set (always revalidate before re-use cached values) the returned promise 
     * will always fail as well.
     */
    update?: boolean;
    /**
     * Default is a structureClone comparison method
     * @param t1 
     * @param t2 
     * @returns 
     */
    equal?: (t1: T, t2: T) => boolean;
    cacheTimeout?: Milliseconds;
}

export type StandardCachingRequestConfig<T> = CachingRequestCacheFirstConfig<T>&{update?: false}|GenericCacheConfig&{mode: "fetchFirst"};
/**
 * Configuration for requests with caching enabled
 */
export type CachingRequestConfig<T> =CachingRequestCacheFirstConfig<T>&{update: true}|StandardCachingRequestConfig<T>;


export type ResponseErrorCause = {cause: "responseStatus"; status: number; statusText?: string;};
export type ContentTypeErrorCause = {cause: "contentType"; value?: string;}
export type HttpErrorCause = (ResponseErrorCause|ContentTypeErrorCause)&{
    method: string;
    endpoint: string;
    headers: Headers;
};

/**
 * This error is thrown if the server responds with a status code >= 400, and the
 * {@link RequestOptions.skipFailOnErrorCode} flag is not set.
 */
export class HttpError extends Error {

    constructor(message: string, readonly details: HttpErrorCause) {
        super(message, details);
    }

}

/**
 * A fetch client with added resilience features.
 */
export interface FetchClient {

    /**
     * Similar to the global fetch function, but if configured so, with retry, timeout, circuit breaker and bulkhead
     * capabilities. 
     * Unless the {@link RequestOptions.skipFailOnErrorCode init.skipFailOnErrorCode} flag is set, the promise will be rejected on status codes >= 400. This is different
     * from standard fetch behaviour. Otherwise the API is the same.
     * @param input 
     * @param init 
     */
    fetch(input: RequestInfo | URL, init?: RequestInit&RequestOptions): Promise<Response>;
    /**
     * A convenience function to retrieve JSON data + headers. See {@link fetch}.
     * @param input
     * @param init 
     */
    fetchJson<T>(input: RequestInfo | URL, init?: RequestInit&JsonRequestOptions): Promise<JsonResult<T>>;
    /**
     * Retrieve the base url/prefix for all requests. 
     */
    baseUrl(): string|undefined;
    /**
     * Abort all ongoing requests.
     */
    abortAll(reason?: any): void;
    /**
     * Close the client. It will not be possible to send new requests afterwards.
     * 
     * @param options if timeout is 0, all ongoing requests will be cancelled immediately. If timeout is > 0 and there are ongoing requests,
     * they will be cancelled after timeout milliseconds. If not specified, ongoing requests will be awaited for indefinitely before closing.
     */
    close(options?: {timeout?: Milliseconds;}): Promise<unknown>;
}

/**
 * An error often encountered with the {@link CachingRequestConfig.update} parameter = true together with 
 * {@link GenericCacheConfig.mode} = "cacheControl" or "race". In this case the {@link FetchClientCaching.fetchJson} methods return an additional 
 * update promise, which fails with this error if the updated response equals the cached one. 
 */
export class NoUpdateError extends Error {};

// TODO support cache on ordinary fetch() as well, not just fetchJson()
/**
 * A version of the {@link FetchClient} that supports caching responses (for the {@link FetchClientCaching.fetchJson} method, for now).
 */
export interface FetchClientCaching extends FetchClient {

    /**
     * Initiate a client request and at the same time lookup the value in the cache. The first returned value is reported as
     * initialValue. 
     * The update promise throws NoUpdateError if only a single value could be retrieved, if both values are equal, or if the result of the 
     * fetch operation is retrieved first.
     * If the result of the fetch operation comes in last and it differs from the cached result then it will reported via the update promise.
     * 
     * Note that the return signature differs from the fetchJson method without cache configuration or other caching modes, due to the need
     * to provide an update to the initially returned value.
     * @param input 
     * @param init 
     */
    fetchJson<T>(
        input: RequestInfo | URL, 
        init?: RequestInit
            &JsonRequestOptions
            &{useCache: CachingRequestCacheFirstConfig<T>&{update: true}}
        ): Promise<JsonResult<T>&{update: Promise<JsonResult<T>>}>;
    fetchJson<T>(
        input: RequestInfo | URL, 
        init?: RequestInit
            &JsonRequestOptions
            &{useCache?:StandardCachingRequestConfig<T>}
        ): Promise<JsonResult<T>>;

    clearCache(): Promise<unknown>;
}


export interface RetryConfig {
    maxRetries: number;
    /**
     * Default: true
     */
    retryNetworkErrors?: boolean;
    /**
     * Default: true
     */
    retryTimeout?: boolean;
    /**
     * Default: ["GET", "HEAD", "PUT", "DELETE", "OPTIONS", "TRACE"]
     * 
     */
    //httpMethods?: Array<string>; 
    /**
     * Retry POST requests? Note that in general POSTs are not expected to be idempotent and therefore
     * not safe to retry.
     * Default: false; TODO: allow for a callback too?
     */
    retryPosts?: boolean;  // TODO also PATCH
    /**
     * Default: [408, 420, 429, 500, 502, 503, 504]
     */
    retryStatusCodes?: Array<number>;

    /**
     * Maximum delay, in milliseconds. Defaults to 30s.
     */
    maxDelay?: Milliseconds;
    /**
     * Backoff exponent. Defaults to 2.
     */
    exponent?: number;
    /**
     * The initial, first delay of the backoff, in milliseconds.
     * Defaults to 128ms.
     */
    initialDelay?: Milliseconds;

}

export interface CircuitBreakerConfig {
    openAfterFailedAttempts: number; 
    /**
     * How long to wait before sending a request again after the circuit breaker opened.
     */
    halfOpenAfter: Milliseconds;

    /**
     * HTTP status codes that are counted as failed attempts for the circuit breaker.
     * Default: [408, 420, 429, 500, 502, 503, 504]
     */
    statusCodes?: Array<number>;
    /**
     * HTTP methods considered for opening the circuit breaker.
     * Note that all requests will be blocked, once the circuit breaker is open.
     * Default: all
     */
    methods?: Array<string>;

    /**
     * Default: true
     */
    triggerOnTimeout?: boolean;

    /**
     * Default: true
     */
    triggerOnNetworkError?: boolean;

}

export interface ParallelRequestsConfig {
    maxParallelRequests: number; 
    maxQueuedRequests: number;
}

export type MethodName = "GET"|"POST"|"PUT"|"HEAD"|"OPTIONS"|"DELETE"|"TRACE"|"PATCH";

/**
 * Resilience configuration for a fetch client
 */
export interface FetchClientOptions {
    baseUrl?: string;
    /**
     * By default, status codes >= 400 are treated as errors, other than in standard fetch.
     * This can be disabled and the standard fetch behaviour restored, by setting this flag.
     * Besides the client-wide setting, there is also the possibility to set skipFailOnErrorCode
     * per request. 
     */
    defaultSkipFailOnErrorCode?: boolean;
    /**
     * This is a per-request timeout not taking into account possible retries.
     * The total duration of a call to client.fetch() can therefore exceed this limit,
     * if retries are configured.
     */
    timeoutRequest?: Milliseconds;
    /**
     * This is an overall timeout after considering retries. The total duration of 
     * a fetch call should never exceed this limit.
     */
    timeoutTotal?: Milliseconds;
    parallelRequests?: ParallelRequestsConfig;
    retries?: number|RetryConfig;
    circuitBreaker?: CircuitBreakerConfig; 
    consoleLogHttpIssues?: boolean;

    /**
     * Set default headers for each request.
     */
    defaultHeaders?: HeadersInit;
    /**
     * Set default headers for each request of a specified method type. 
     * These are merged with defaultHeaders, if they are set as well. (set a header to undefined or "" to remove it)
     */
    defaultHeadersByMethod?: Record<MethodName, HeadersInit>;

    /**
     * Defaults to globalThis.fetch / window.fetch
     */
    fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

/**
 * Caching-related configuration for a fetch client
 */
export interface CacheConfiguration {
    /**
     * Unique id of the cache provider.
     */
    id: string;
    /**
     * A limit on the number of items kept in the cache. Note that this applies per table, if it is a number.
     * If an object is passed, keys should table ids and values limit per table.
     */
    maxItems?: number|Record<string, number>;
    /**
     * If true, the cache will only return instances that are safe to be modified by the caller. If false, the caller
     * should take care not to modify potentially cached items.
     * The function used to copy values is [`structuredClone`](https://developer.mozilla.org/en-US/docs/Web/API/structuredClone),
     * unless a custom {@link deepCopy} function is provided.
     * 
     * Default: false.
     */
    cloneItems?: boolean;
    /**
     * Only relevant if {@link cloneItems} is true.
     * By default it uses the global [`structuredClone`](https://developer.mozilla.org/en-US/docs/Web/API/structuredClone) function.
     * @param object 
     * @returns 
     */
    deepCopy?: (object: any) => any;
    
    [key: string]: any;  /* extensible... */
}

/**
 * Caching-related configuration for a fetch client
 */
export type ClientCacheOptions = CacheConfiguration|Array<CacheConfiguration>;

export function createFetchClient(options: {cache: ClientCacheOptions}&FetchClientOptions): Promise<FetchClientCaching>;
export function createFetchClient(options?: FetchClientOptions): Promise<FetchClient>;

/**
 * Create a new fetch client, providing configuration for resilience and caching behaviour.
 * @param options 
 * @returns 
 */
export function createFetchClient(options?: any): Promise<FetchClient> {
    const retries = typeof options?.retries === "number" ? options.retries : options?.retries?.maxRetries;
    const useSimpleClient: boolean = !(options?.timeoutRequest! > 0) && !(options?.parallelRequests?.maxParallelRequests! > 0) 
                && !(retries! > 0) && !(options?.circuitBreaker?.openAfterFailedAttempts! > 0);
    const clientPromise = useSimpleClient ? Promise.resolve(new SimpleFetchClient(options?.fetch, options?.baseUrl, options?.defaultHeaders, options?.defaultHeadersByMethod)) :
        import("./ResilientClient.js").then(module => new module.ResilientFetchClient(options));
    if (!options?.cache)
        return clientPromise;
    return Promise.all([clientPromise, import("./cache/CachingClient.js")]).then(([client, module]) => new module.CachingClient(client, options.cache));
}
