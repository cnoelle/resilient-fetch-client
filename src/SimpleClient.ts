import { FetchClient, HttpError, JsonRequestOptions, JsonResult, MethodName, Milliseconds, RequestOptions } from "./client.js";

export class SimpleFetchClient implements FetchClient {

    readonly #baseUrl?: string;
    readonly #abortControllers: Array<AbortController> = [];
    readonly #defaultHeaders?: HeadersInit;
    readonly #defaultHeadersByMethod?: Record<MethodName, HeadersInit>;
    readonly #skipFailOnErrorCode?: boolean;
    readonly #fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    #closed: boolean = false;

    constructor(
            fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
            baseUrl?: string,
            defaultHeaders?: HeadersInit,
            defaultHeadersByMethod?: Record<MethodName, HeadersInit>,
            skipFailOnErrorCode?: boolean
        ) {
        this.#fetch = fetch || globalThis.fetch;
        this.#baseUrl = baseUrl;
        this.#defaultHeaders = defaultHeaders;
        this.#defaultHeadersByMethod = defaultHeadersByMethod;
        this.#skipFailOnErrorCode = skipFailOnErrorCode;
    }

    fetch(input: RequestInfo | URL, init?: RequestInit&RequestOptions): Promise<Response> {
        if (this.#closed)
            throw new Error("Client has been closed");
        const endpoint: string = SimpleFetchClient._endpointForInput(input);
        const url = SimpleFetchClient._concatPaths(this.#baseUrl, endpoint);
        const ctrl: AbortController = SimpleFetchClient._derivedSignalController(init?.signal || (input as Request)?.signal);
        this.#abortControllers.push(ctrl);
        init = init ? {...init} : {};  // do not modify the original init, it may be reused
        init.signal = ctrl.signal; 
        const result = this._fetchInternal((input instanceof Request) ? input : url, endpoint, init, this.#defaultHeaders, this.#defaultHeadersByMethod);
        result.finally(() => {
            const idx = this.#abortControllers.indexOf(ctrl);
            if (idx >= 0)
                this.#abortControllers.splice(idx, 1);
        }).catch(() => undefined);  // important for node => no uncaught error in promise
        return result;
    }

    /**
     * A convenience function for json calls.
     * @param endpoint 
     * @param init 
     * @returns 
     */
    async fetchJson<T>(input: RequestInfo | URL, init?: RequestInit&JsonRequestOptions): Promise<JsonResult<T>> {
        if (!init?.skipAcceptHeader && !SimpleFetchClient._acceptHeaderSpecified(input, init, this.#defaultHeaders, this.#defaultHeadersByMethod)) {
            init = init ? {...init} : {};  // do not modify the original init, it may be reused
            const copy: boolean = !!init.headers;
            init.headers = SimpleFetchClient._applyHeader("Accept", "application/json", init.headers || {}, copy);
        }
        const resp: Response = await this.fetch(input, init);
        if (!init?.skipContentTypeHeaderValidation) {
            const contentType = resp.headers.get("Content-Type") || undefined;
            if (!contentType || contentType.indexOf("application/") < 0 || contentType.indexOf("json") < 0) {
                throw new HttpError("Unexpected content type " + contentType, 
                    {cause: "contentType", endpoint: SimpleFetchClient._endpointForInput(input), method: init?.method || "GET", value: contentType, headers: resp.headers});
            }
        }
        const json = await resp.json();
        return {value: json, headers: resp.headers};
    }

    abortAll(reason?: any) {
        this.#abortControllers.forEach(a => a.abort(reason));
        this.#abortControllers.splice(0, this.#abortControllers.length);
    }

    baseUrl() {
        return this.#baseUrl;
    }

    async close(options?: { timeout?: Milliseconds; }): Promise<unknown> {
        this.#closed = true;
        if (options?.timeout === 0 || this.#abortControllers.length === 0) { 
            this.abortAll(new Error("Client closed"));
            return Promise.resolve();
        }
        // there is no promise we could wait for...
        const start: Milliseconds = Date.now();
        const step: Milliseconds = 50;
        for (let waited: Milliseconds=0;  options?.timeout !== undefined ? waited<options?.timeout! + step : true; waited = Date.now() - start) {
            await new Promise(resolve => setTimeout(resolve, step));
            if (this.#abortControllers.length === 0)
                return Promise.resolve();
        }
        this.abortAll(new Error("Client closed"));
        return Promise.resolve();
    }

    // note that at this point init has been copied, so we can safely modify it without causing unwanted side effects
    protected async _fetchInternal<T>(url: string | URL | Request, endpoint: string, 
                init: RequestInit&RequestOptions, defaultHeaders?: HeadersInit, defaultHeadersByMethod?: Record<MethodName, HeadersInit>, 
                skipThrowOnCodes?: Array<number>): Promise<Response> {
        if (defaultHeaders || defaultHeadersByMethod)
            SimpleFetchClient._applyDefaultHeaders(init, url, defaultHeaders, defaultHeadersByMethod);
        const resp = await this.#fetch(url, init);
        if (!resp.ok && !this.#skipFailOnErrorCode && !init?.skipFailOnErrorCode && !(skipThrowOnCodes?.indexOf(resp.status)! >= 0)) {
            await SimpleFetchClient._throwHttpError(endpoint, resp, init);
        }
        return resp;
    }

    // note: must be awaited!
    protected static async _throwHttpError(endpoint: string, resp: Response, init?: RequestInit) {
        throw new HttpError(await SimpleFetchClient._buildErrorMsg(endpoint, resp), 
            {cause: "responseStatus", endpoint: endpoint, method: init?.method || "GET", 
                status: resp.status, statusText: resp.statusText, headers: resp.headers});
    }

    private static _applyDefaultHeaders(init: RequestInit&RequestOptions, url: string | URL | Request,
        defaultHeaders?: HeadersInit, defaultHeadersByMethod?: Record<MethodName, HeadersInit>
    ) {
        const headersEmpty = !defaultHeaders || Object.keys(defaultHeaders).length === 0;
        const headersByMethodEmpty = !defaultHeadersByMethod || Object.keys(defaultHeadersByMethod).length === 0;
        const updates: Array<HeadersInit> = [];
        if (!headersEmpty)
            updates.push(defaultHeaders);
        if (!headersByMethodEmpty) {
            // find out method
            const method: MethodName = (init?.method || (url as Request)?.method || "GET")?.toUpperCase() as MethodName;
            if (method in defaultHeadersByMethod && Object.keys(defaultHeadersByMethod[method]).length > 0)
                updates.push(defaultHeadersByMethod[method]);
        }
        const headers = SimpleFetchClient._mergeHeaders(init.headers, updates);
        init.headers = headers;
    }

    private static _mergeHeaders(source: HeadersInit|undefined, updates: Array<HeadersInit>): HeadersInit|undefined {
        if (updates.length === 0)
            return source;
        const result = source ? new Headers(source) : new Headers();  // it is important to copy here, since we make only shallow copy of init objects
        for (const update of updates) {
          const newHeaders: Headers = update instanceof Headers ? update : new Headers(update);
          newHeaders.forEach((value, key) => {
            if ((value === undefined || value === "undefined"  || value === "")) {
                result.delete(key);
              } else {
                const existing = result.get(key);                
                if (existing && existing.split(",").find(entry => entry.trim().toLowerCase() === value.toLowerCase()) !== undefined)
                    return;
                result.append(key, value);
              }
          })
        }
        return result;
    }

    public static _acceptHeaderSpecified(input: RequestInfo | URL, init?: RequestInit, defaultHeaders?: HeadersInit, defaultHeadersByMethod?: Record<MethodName, HeadersInit>): boolean {
        if (SimpleFetchClient._hasHeader("Accept", init?.headers) || SimpleFetchClient._hasHeader("Accept", (input as Request).headers) 
                || SimpleFetchClient._hasHeader("Accept", defaultHeaders)) {
            return true;
        }
        if (!defaultHeadersByMethod)
            return false;
        const method: MethodName = (init?.method || (input as Request)?.method || "GET")?.toUpperCase() as MethodName;
        return SimpleFetchClient._hasHeader("Accept", defaultHeadersByMethod[method]);
    }

    private static _hasHeader(key: string, header?: HeadersInit): boolean {
        if (!header)
            return false;
        if (header instanceof Headers)
            return header.has(key);
        if (Array.isArray(header))
            return header.find(h => h[0] === key) !== undefined;
        return Object.keys(header).indexOf(key) >= 0;
    }

    public static _applyHeader(key: string, value: string, header: HeadersInit, copy?: boolean): HeadersInit {
        if (copy || header instanceof Headers) {
            if (copy)
                header = new Headers(header);
            (header as Headers).append(key, value);
            return header;
        }
        if (Array.isArray(header))
            header.push([key, value]);
        else
            header[key] = value;
        return header;
    }


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

    private static async _buildErrorMsg(endpoint: string, resp: Response): Promise<string> {
        const text = await resp.text();
        let msg = "Request to " + endpoint + " failed: " + resp.status;
        if (resp.statusText || text) {
            msg += " (";
            if (resp.statusText) {
                msg += resp.statusText;
                if (text)
                    msg += ", ";
            }
            if (text)
                msg += text;
            msg += ")";
        }
        return msg;
    }

    private static _concatPaths(s1: string|undefined, s2: string) {
        if (!s1)
            return s2;
        if (!s2)
            return s1;
        const endsWith = s1.endsWith("/");
        const startsWith = s2.startsWith("/");
        if (!endsWith && !startsWith)
            s1 = s1 + "/";
        else if (endsWith && startsWith)
            s2 = s2.substring(1);
        return s1 + s2;
    }

    private static _endpointForInput(input: RequestInfo | URL): string {
        return typeof(input) === "string" ? input : input instanceof Request ? input.url : input?.toString();
    }

}
