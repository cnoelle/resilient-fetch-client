import { bulkhead, circuitBreaker, ConsecutiveBreaker, ExponentialBackoff, handleType, ICancellationContext, IPolicy, retry, RetryPolicy, TaskCancelledError, timeout, TimeoutStrategy, wrap } from "cockatiel";
import isNetworkError from "is-network-error";
import { SimpleFetchClient } from "./SimpleClient.js";
import { FetchClientOptions, HttpError, HttpErrorCause, MethodName, RequestOptions, ResponseErrorCause, RetryConfig } from "./client.js";

export class ResilientFetchClient extends SimpleFetchClient {

    // some frameworks include 501 - Not implemented, which may also send a Retry-After header. But this seems strange.
    private static readonly _DEFAULT_RETRY_CODES = [408, /*413,*/ 420, 429, 500, 502, 503, 504];    // 413 is content too large
    private static readonly _DEFAULT_RETRY_METHODS = ["GET", "HEAD", "PUT", "DELETE", "OPTIONS", "TRACE"]; // POST is usually not idempotent
    private static readonly _DEFAULT_CIRCUIT_BREAKER_CODES = [408, /*413,*/ 420, 429, 500, 502, 503, 504];
    // see https://github.com/sindresorhus/ky/blob/3ba40cc6333cf1847c02c51744e22ab7c04407f5/source/core/Ky.ts#L220
    // and https://github.com/sindresorhus/ky/issues/608
    private static readonly _DEFAULT_RETRY_AFTER_HEADERS = [
        "Retry-After", "RateLimit-Reset", "X-RateLimit-Reset", "X-Rate-Limit-Reset"
    ]; 
    readonly #policy: IPolicy<ICancellationContext>;
    readonly #retry: RetryPolicy|undefined;
    readonly #totalTimeoutMillis: number|undefined;
    readonly #retryAfterCodes: Array<number> = [429, 503]; // TODO configurable

    constructor(
            options?: FetchClientOptions
        ) {
        super(options?.fetch, options?.baseUrl, options?.defaultHeaders, options?.defaultHeadersByMethod);
        const retries = typeof options?.retries === "number" ? options.retries : options?.retries?.maxRetries;
        let circuitBrk = undefined;
        if (options?.circuitBreaker) {
            const statusCodes = options.circuitBreaker.statusCodes ? [...options.circuitBreaker.statusCodes] :
                [...ResilientFetchClient._DEFAULT_CIRCUIT_BREAKER_CODES];
            const methods: Array<string>|undefined = options.circuitBreaker.methods;
            let circuitHandler = handleType(HttpError, (err: HttpError) => {
                const cause = err.cause;
                switch (cause) {
                case "responseStatus":
                    const details = err.details as ResponseErrorCause&HttpErrorCause;
                    const code = statusCodes.indexOf(details.status) >= 0;  
                    if (!code)
                        return false;
                    return !methods || methods.indexOf(details.method) >= 0;
                case "contentType":
                    return false;
                default:
                    return false;
                }
                
            });
            if (options?.circuitBreaker.triggerOnTimeout !== false) {
                circuitHandler = circuitHandler.orType(TaskCancelledError, (err: TaskCancelledError) => {
                    const isTimeout: boolean = err.message?.indexOf("timed out") >= 0;
                    return isTimeout;
                });
            }
            if (options?.circuitBreaker.triggerOnNetworkError !== false) {
                circuitHandler = circuitHandler.orType(TypeError, isNetworkError);
            }
            circuitBrk = options?.circuitBreaker ? circuitBreaker(circuitHandler, 
                {breaker: new ConsecutiveBreaker(options.circuitBreaker.openAfterFailedAttempts), halfOpenAfter: options.circuitBreaker.halfOpenAfter}) : undefined;
        }
        const tout = options?.timeoutRequest! > 0 ? timeout(options!.timeoutRequest!, {strategy: TimeoutStrategy.Aggressive, abortOnReturn: false}) : undefined;
        const bulkhd = options?.parallelRequests ? bulkhead(options.parallelRequests.maxParallelRequests, options.parallelRequests.maxQueuedRequests) : undefined;
        const retryConfig: Partial<RetryConfig> = typeof options?.retries === "object" ? options.retries : {};
        let retryPolicy = undefined;
        if (retries! > 0) {
            const statusCodes = retryConfig?.retryStatusCodes ? [...retryConfig.retryStatusCodes] :
                    [...ResilientFetchClient._DEFAULT_RETRY_CODES];
            const methods = [...ResilientFetchClient._DEFAULT_RETRY_METHODS];
            if (retryConfig?.retryPosts)
                methods.push("POST");
            let retryHandler = handleType(HttpError, (err: HttpError) => {
                const cause = err.cause;
                switch (cause) {
                case "responseStatus":
                    const details = err.details as ResponseErrorCause&{method: string;};
                    return statusCodes.indexOf(details.status) >= 0 && methods.indexOf(details.method?.toUpperCase()) >= 0;  
                case "contentType":
                    return false;
                default:
                    return false;
                }
                
            });
            if (retryConfig?.retryTimeout !== false) {
                retryHandler = retryHandler.orType(TaskCancelledError, (err: TaskCancelledError) => {
                    const isTimeout: boolean = err.message?.indexOf("timed out") >= 0;
                    return isTimeout;
                });
            }
            if (retryConfig?.retryNetworkErrors !== false) {
                retryHandler = retryHandler.orType(TypeError, isNetworkError);
            }
            const retryBackoff = new ExponentialBackoff({maxDelay: retryConfig.maxDelay || 30_000, exponent: retryConfig.exponent || 2, 
                initialDelay: retryConfig.initialDelay !== undefined ? retryConfig.initialDelay : 128})
            retryPolicy = retry(retryHandler, { maxAttempts: retries, backoff: retryBackoff });
        }
        this.#retry = retryPolicy;
        this.#totalTimeoutMillis = options?.timeoutTotal;
        const globalTimeout = options?.timeoutTotal! > 0 ? timeout(options!.timeoutTotal!, TimeoutStrategy.Aggressive) : undefined;
        const policies: Array<IPolicy> = [];
        const addPolicy = (policy: IPolicy|undefined) => {
            if (policy)
                policies.push(policy);
        };
        addPolicy(globalTimeout);
        addPolicy(retryPolicy);
        addPolicy(bulkhd);
        addPolicy(circuitBrk);
        addPolicy(tout);
        this.#policy = wrap(...policies);
        if (options?.consoleLogHttpIssues) {
            tout?.onTimeout(() => console.log("TIMEOUT"));
            // @ts-ignore
            tout?.onFailure(data => console.log("Request failure", data))
            // @ts-ignore
            retryPolicy?.onRetry(evt => console.log("RETRY", evt));
            // @ts-ignore
            circuitBrk?.onBreak(evt => console.log("Circuit breaker opened", evt))
        }
    }

    /*
    * Regarding signal handling: the original signal is passed to the policy execution call, which in turn provides a new signal
    * to the actual fetch call. If the original signal is canceled, then so will be the derived one.
    */
    protected override async _fetchInternal<T>(url: string | URL | Request, endpoint: string, 
                init: RequestInit&RequestOptions, defaultHeaders?: HeadersInit, defaultHeadersByMethod?: Record<MethodName, HeadersInit>): Promise<Response> {
        const needsClone: boolean = url instanceof Request && !!this.#retry;
        const signal0 = init.signal!; // never null at this point
        delete init.signal;  // we have already created a copy of init, which we can safely modify
        const startTime = Date.now();
        // state remembered between retries of the fetch function
        let retryAfter: Date|undefined = undefined;
        let adaptedToRetryAfter: boolean = false;
        let clonedRequest: Request|undefined = undefined;
        // run
        const result = this.#policy.execute<Response>(async (context: {signal: AbortSignal}) => {
            let currentUrl = url;
            if (needsClone) {
                const base: Request = clonedRequest || url as Request; 
                const copy = base.clone();
                clonedRequest = copy;
                currentUrl = base;
            }
            init.signal = context.signal;
            if (retryAfter) {
                const now = Date.now();
                let diff = retryAfter.getTime() - now;
                if (diff > 0 && this.#totalTimeoutMillis! > 0 && !adaptedToRetryAfter) {
                    const millisSpent = Date.now() - startTime;
                    const millisAvailable = this.#totalTimeoutMillis! - millisSpent;
                    // otherwise we'd likely run into the global timeout // TODO configurable safety margin?
                    if (millisAvailable > 0 && millisAvailable - 5_000 < diff) {
                        const safetyMargin = millisAvailable > 5_000 ? 5_000 : millisAvailable;
                        diff = millisAvailable - safetyMargin;  
                        adaptedToRetryAfter = true;
                    }
                }
                retryAfter = undefined;
                if (diff > 0) {
                    await new Promise((resolve, reject) => {
                        const timeoutId = globalThis.setTimeout(resolve, diff);
                        context.signal.addEventListener("abort", () => {
                            globalThis.clearTimeout(timeoutId);
                            reject(context.signal.reason);
                        }, {once: true})
                    });
                }
            }
            const resp = await super._fetchInternal(currentUrl, endpoint, init, defaultHeaders, defaultHeadersByMethod, this.#retryAfterCodes);
            // avoid appending the same header multiple times
            defaultHeaders = undefined;
            defaultHeadersByMethod = undefined;
            if (this.#retryAfterCodes.indexOf(resp.status) >= 0) {
                retryAfter = ResilientFetchClient._parseRetryAfterHeader(resp);
                await SimpleFetchClient._throwHttpError(endpoint, resp, init);
            }
            return resp;
        }, signal0);
        if (needsClone) {
            result  // ensure any unneeded cloned Request is consumed
                .finally(() => new Promise(resolve => setTimeout(resolve, 250))
                    .finally(() => ResilientFetchClient._consumeRequest(clonedRequest))).catch(() => undefined);
        }
        // return result;
        // XXX this is a workaround for https://github.com/connor4312/cockatiel/issues/99
        // but maybe it would be good to replace all the TaskCancelledErrors from 
        // propagating to the user of this lib, and instead replace them by custom errors?
        return result.catch(e => {
            if (signal0.aborted && e instanceof TaskCancelledError)
                throw signal0.reason ?? new DOMException("The operation was aborted", "AbortError");
            throw e;
        });
    }

    private static _parseRetryAfterHeader(resp: Response): Date|undefined {
        const retryHeader = ResilientFetchClient._DEFAULT_RETRY_AFTER_HEADERS
            .find(h => resp.headers.get(h));
        if (!retryHeader)
            return undefined;
        const retryHeaderValue = resp.headers.get(retryHeader)!;
        const asNumber = parseFloat(retryHeaderValue);
        if (Number.isFinite(asNumber))  // seconds
            return new Date(Date.now() + asNumber * 1000);
        const dt = new Date(retryHeaderValue);
        return Number.isFinite(dt.getTime()) ? dt : undefined;
    }

    private static async _consumeRequest(r?: Request) {
        if (!r || r.bodyUsed)
            return;
        const reader = r.body?.getReader();
        if (!reader)
            return;
        while (true) {
            const {done, value} = await reader.read();
            if (done)
                break;
        }
    }

}

