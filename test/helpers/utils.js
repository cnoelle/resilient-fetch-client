import {HttpError} from "../../dist/client.js";

/**
 * Returns a fetch mock
 */
export function mockFetch(options) {
    const result = options?.result || "someString";
    const status = options?.status || 200;
    const statusText = options?.statusText || "ok";
    const error = options?.error;
    const headers = options?.headers;
    const delay = options?.delay;
    const headerReplies = options?.headerReplies;  // Array<[string, string], [string, string]> => pair (expected request header, response header)
    let cnt = 0;
    return async (url, init) => {
        const currentResult = Array.isArray(result) ? (result.length > cnt ? result[cnt] : "???") : result; 
        const currentStatusCode = Array.isArray(status) ? (status.length > cnt ? status[cnt] : 200) : status;
        const currentDelay = Array.isArray(delay) ? (delay.length > cnt ? delay[cnt] : 0) : delay;
        const currentError = Array.isArray(error) ? (error.length > cnt ? error[cnt] : undefined) : error;
        let currentHeaders = Array.isArray(headers) ? (headers.length > cnt ? headers[cnt] : undefined) : headers;
        cnt = cnt + 1;
        const signal = init?.signal;
        if (currentDelay > 0) { 
            // this is not interruptible!
            //await new Promise(resolve => setTimeout(resolve, currentDelay));
            const start = performance.now();
            let delayAgg = 0
            while (delayAgg < currentDelay) {
                if (signal?.aborted)
                    break;
                await new Promise(resolve => setTimeout(resolve, 50));
                delayAgg = performance.now() - start;
            }
        }
        if (url instanceof Request)
            consumeRequest(url);
        if (signal?.aborted)
            throw new Error(signal.reason);
        if (currentError)
            throw currentError;
        if (headerReplies && init?.headers) {  // note: for the time being this only evaluates headers in init, not a possible Request object url
            const headersReceived = new Headers(init?.headers);
            currentHeaders = new Headers(currentHeaders);
            for (const [reqKeyVal, respKeyVal] of headerReplies) {
                for (const [key, val] of headersReceived.entries()) {
                    if (key?.toLowerCase() === reqKeyVal[0]?.toLowerCase() && val?.toLowerCase() === reqKeyVal[1]?.toLowerCase()) {
                        currentHeaders.append(respKeyVal[0], respKeyVal[1]);
                        break;
                    }
                }
            }
        }

        const response = new Response(currentResult, {
            status: currentStatusCode, 
            statusText: statusText, 
            headers: currentHeaders
        });
        return response;
    };
}

async function consumeRequest(request) {
    if (!request || request.bodyUsed)
        return;
    const reader = request.body?.getReader();
    if (!reader)
        return;
    while (true) {
        const {done, value} = await reader.read();
        if (done)
            break;
    }
}

export function retriedError(options) {
    return new HttpError("Error that should cause a retry in default settings", {
        cause: "responseStatus",
        endpoint: options?.endpoint || "test",
        status: options?.statusCode || 503,  // temporarily unavailable
        statusText: options?.statusText || "",
        method: options?.method || "GET"
    })
}

export async function waitForClock() {
    const start = Date.now();
    let end = start;
    while (end <= start) {
        await new Promise(resolve => setTimeout(resolve, 1));
        end = Date.now();
    }
}
