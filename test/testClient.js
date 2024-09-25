import test from "ava";
import {createFetchClient, HttpError} from "../dist/client.js";
import {mockFetch, retriedError} from "./helpers/utils.js";

function assertIsTimeoutError(t, thrown) {
    const msg = thrown?.message?.toLowerCase();
    t.assert(msg?.indexOf("timed out") >= 0 || msg?.indexOf("timeout") >= 0, 
        "Timeout error expected, got " + (msg || thrown));
}

test("SimpleClient works with mock fetch", async t => {
    const expectedResult = "expectedTestResult~~!~~";
    const fetch = mockFetch({result: expectedResult});
    const response = await (await createFetchClient({fetch: fetch})).fetch("");
    const result = await response.text();
    t.is(result, expectedResult);
});

// mostly validating the test setup
test("SimpleClient fails on error", async t => {
    const fetch = mockFetch({error: new Error("Deliberate error")});
    await t.throwsAsync(() => createFetchClient({fetch: fetch}).then(cl => cl.fetch("")));
});

test("Timeout works", async t => {
    const fetch = mockFetch({delay: 5_000});
    const client = await createFetchClient({timeoutRequest: 10, fetch: fetch});
    const thrown = await t.throwsAsync(() => client.fetch(""));
    assertIsTimeoutError(t, thrown);
    await client.close();
});

test("Retry works with timeout", async t => {
    const expectedResult = "expectedRetryTimeoutTestResult~~!~~";
    const fetch = mockFetch({delay: [5_000, 1], result: expectedResult});
    const client = await createFetchClient({timeoutRequest: 200, retries: 2, fetch: fetch});
    const result = await (await client.fetch("")).text();
    t.is(result, expectedResult);
    await client.close();
});

test("Retry works with HTTP error", async t => {
    const expectedResult = "expectedRetryErrorTestResult~~!~~";
    const fetch = mockFetch({error: [new HttpError("First request fails", {
            cause: "responseStatus",
            endpoint: "test",
            status: 503,  // temporarily unavailable
            statusText: "",
            method: "GET"
        })], 
        result: expectedResult});
    const client = await createFetchClient({retries: 2, fetch: fetch});
    const result = await (await client.fetch("")).text();
    t.is(result, expectedResult);
    await client.close();
});

test("Abort works with client", async t => {
    const fetch = mockFetch({delay: 10_000});
    const client = await createFetchClient({retries: 2, timeoutRequest: 20_000, fetch: fetch});
    const ctrl = new AbortController();
    const result = client.fetch("", {signal: ctrl.signal});
    const reason = "testReason";
    ctrl.abort(new Error(reason));
    const thrown = await t.throwsAsync(async () => await result);
    t.assert(thrown?.message?.indexOf(reason) >= 0, 
        "Aborted request does not provide the reason; expected: " + reason + ", got " + thrown?.message);
    await client.close();
});

test("Abort all works with SimpleClient", async t => {
    const fetch = mockFetch({delay: 60_000});
    const client = await createFetchClient({fetch: fetch});
    const result = client.fetch("");
    const reason = "testReason";
    client.abortAll(new Error(reason));
    const thrown = await t.throwsAsync(async () => await result);
    t.assert(thrown?.message?.indexOf(reason) >= 0, 
        "Aborted request does not provide the reason; expected: " + reason + ", got " + thrown?.message);
    await client.close();
});

test("Abort all works with ResilientClient", async t => {
    const fetch = mockFetch({delay: 60_000});
    const client = await createFetchClient({retries: 2, timeoutRequest: 120_000, fetch: fetch});
    const result = client.fetch("");
    const reason = "testReason";
    client.abortAll(new Error(reason));
    const thrown = await t.throwsAsync(async () => await result);
    t.assert(thrown?.message?.indexOf(reason) >= 0, 
        "Aborted request does not provide the reason; expected: " + reason + ", got " + thrown?.message);
    await client.close();
});


test("Retry with Request object works", async t => {
    const expectedResult = "expectedRequestRetryTestResult";
    const fetch = mockFetch({error: [retriedError({method: "PUT"})], result: expectedResult});
    const client = await createFetchClient({retries: 2, timeoutRequest: 20_000, fetch: fetch});
    const body = "requestTestBody";
    const r = new Request("example://example.com", {method: "PUT", body: body});
    const result = await (await client.fetch(r)).text();
    t.is(result, expectedResult);
    await client.close();
});

test("Abort retry with Request object works", async t => {
    const fetch = mockFetch({delay: [1, 60_000], error: [retriedError({method: "PUT"})] });
    const client = await createFetchClient({retries: 1, timeoutRequest: 120_000, fetch: fetch});
    const body = "requestTestBody2";
    const r = new Request("example://example2.com", {method: "PUT", body: body});
    const result = client.fetch(r);
    const reason = "testReason7";
    // ensure that the first fetch request (which fails) gets completed, but the retried one does not
    await new Promise(resolve => setTimeout(resolve, 100));
    client.abortAll(new Error(reason));
    const thrown = await t.throwsAsync(async () => await result);
    t.assert(thrown?.message?.indexOf(reason) >= 0, 
        "Aborted request does not provide the reason; expected: " + reason + ", got " + thrown?.message);
    await client.close();
});

test("Circuit breaker works", async t => {
    // 2 errors followed by a successful request, but then the circuit breaker will be open
    const fetch = mockFetch({error: [retriedError({method: "PUT"}), retriedError({method: "PUT"})] });
    const client = await createFetchClient({
        retries: 3, 
        circuitBreaker: {openAfterFailedAttempts: 2, halfOpenAfter: 60_000}, 
        fetch: fetch
    });
    const result = client.fetch("");
    const thrown = await t.throwsAsync(async () => await result);
    t.assert(thrown.message.indexOf("circuit breaker") >= 0, 
        "Unexpected error; expected BrokenCircuitError, got " + thrown.message);
    await client.close();
});

test("Bulkhead works", async t => {
    // the second request could succeed in time, but it fails to execute due to the first one blocking the bulkhead
    const fetch = mockFetch({delay: [60_000, 1]});
    const client = await createFetchClient({
        parallelRequests: {maxParallelRequests: 1, maxQueuedRequests: 0},
        fetch: fetch
    });
    const ctrl = new AbortController();
    const req1 = client.fetch("", {signal: ctrl.signal});
    const req2 = client.fetch("", {signal: ctrl.signal});
    const thrown = await t.throwsAsync(async () => await req2);
    t.assert(thrown.message?.toLowerCase()?.indexOf("bulkhead") >=0,
        "Unexpected error, expected bulkhead capacity exceeded, got " + thrown.message);
    ctrl.abort();
    await client.close();
});

test("Global timeout works on success", async t => {
    const expectedResult = "expectedTestResultGlobalTimeout";
    const fetch = mockFetch({result: expectedResult});
    const client = await createFetchClient({
        timeoutTotal: 60_000,
        fetch: fetch
    });
    const resp = await client.fetch("");
    const result = await resp.text();
    t.is(result, expectedResult);
    await client.close();
});

test("Global timeout works", async t => {
    const fetch = mockFetch({delay: 200, error: [retriedError()]});
    const client = await createFetchClient({
        // accepts a single request to proceed, but since this fails with error
        // we will run into retry, then the global timeout setting should be hit
        timeoutTotal: 250,
        retries: 1,
        fetch: fetch
    });
    const thrown = await t.throwsAsync(async () => await client.fetch(""));
    assertIsTimeoutError(t, thrown);
    await client.close();
});


test("Retry after works", async t => {
    const expectedResult = "expectedTestResultRetryAfter";
    const fetch = mockFetch({
        status: [503],
        headers: [{"Retry-After": 0.4}], // 400ms
        result: expectedResult
    });
    const client = await createFetchClient({
        retries: {maxRetries: 1, initialDelay: 0, maxDelay: 100},
        fetch: fetch
    });
    const expectedRaceWinner = "raceWinner!";
    const raceWinner = new Promise(resolve => setTimeout(() => resolve(expectedRaceWinner), 200));
    const fetchResult = client.fetch("");
    const result = await Promise.race([raceWinner, fetchResult]);
    // validate that fetch with Retry-After header took longer than 200ms
    t.is(result, expectedRaceWinner); 
    const fetchResultFinal = await (await fetchResult).text();
    // validate that fetch with Retry-After header returned the correct result
    t.is(fetchResultFinal, expectedResult);
    await client.close();
});

test("Retry after works with global timeout", async t => {
    const expectedResult = "expectedTestResultRetryAfterGlobalTimeout";
    const fetch = mockFetch({
        delay: [300],             // the first request takes 300ms,
        // error on first request, the second one is successful. 503 is a retrieable code with Retry-After applicable.
        status: [503],  
        // 60s, longer than timeoutTotal, so that the request would fail 
        // if we adhered to the Retry-After recommendation
        headers: [{"Retry-After": 60}],  
        result: expectedResult
    });
    const client = await createFetchClient({
        timeoutTotal: 500,  // not enough for two consecutive requests
        retries: {maxRetries: 1, initialDelay: 0, maxDelay: 100},
        fetch: fetch
    });
    const resp = await client.fetch("");
    const result = await resp.text();
    t.is(result, expectedResult);
    await client.close();
});


test("Return headers works with simple client", async t => {
    const header = "X-Test";
    const expectedHeader = "expectedTestHeader!";
    const expectedResult = {result: "testResultAlongHeader"};
    const expectedResultStr = JSON.stringify(expectedResult);
    const fetch = mockFetch({headers: {[header]: expectedHeader, "Content-Type": "application/json"}, result: expectedResultStr});
    const client = await createFetchClient({fetch: fetch});
    const resp = await client.fetchJson("");
    t.is(resp?.headers?.get(header), expectedHeader);
    t.deepEqual(resp?.value, expectedResult);
    await client.close();
});

test("Return headers works with resilient client", async t => {
    const header = "X-Test";
    const expectedHeader = "expectedTestHeader2!";
    const expectedResult = {result: "testResultAlongHeader2"};
    const expectedResultStr = JSON.stringify(expectedResult);
    // first request times out, but second will be successful
    const fetch = mockFetch({headers: {[header]: expectedHeader, "Content-Type": "application/json"}, result: expectedResultStr, delay: [5_000]}); 
    const client = await createFetchClient({
        timeoutRequest: 100,
        retries: 1,
        fetch: fetch
    });
    const resp = await client.fetchJson("");
    t.is(resp?.headers?.get(header), expectedHeader);
    t.deepEqual(resp?.value, expectedResult);
    await client.close();
});

test("Default headers work with client", async t => {
    const reqHeader = "X-Test";
    const reqHeaderValue = "DefaultHeader";
    const respHeader = "X-Test-Response";
    const respHeaderValue = "DefaultTestHeaderResponse";
    // mock fetch will return the response header respHeader = respHeaderValue if the request has the header reqHeader = reqHeaderValue
    const fetch = mockFetch({headerReplies: [[[reqHeader, reqHeaderValue], [respHeader, respHeaderValue]]]}); 
    const client = await createFetchClient({
        defaultHeaders: {[reqHeader]: reqHeaderValue},
        fetch: fetch
    });
    const resp = await client.fetch("");
    t.is(resp?.headers?.get(respHeader), respHeaderValue);
    await client.close();
});

test("Default headers per method work with client", async t => {
    const reqHeader = "X-Test";
    const reqHeaderValue = "DefaultHeader";
    const respHeader = "X-Test-Response";
    const respHeaderValue = "DefaultTestHeaderResponse";
    // mock fetch will return the response header respHeader = respHeaderValue if the request has the header reqHeader = reqHeaderValue
    const fetch = mockFetch({headerReplies: [[[reqHeader, reqHeaderValue], [respHeader, respHeaderValue]]]}); 
    const client = await createFetchClient({
        defaultHeadersByMethod: {"POST": {[reqHeader]: reqHeaderValue}},
        fetch: fetch
    });
    const resp = await client.fetch("", {method: "POST"});
    t.is(resp?.headers?.get(respHeader), respHeaderValue);
    const resp2 = await client.fetch("");
    t.falsy(resp2.headers?.get(respHeader));
    await client.close();
});

test("Default headers work with resilient client", async t => {
    const reqHeader = "X-Test";
    const reqHeaderValue = "DefaultHeader";
    const respHeader = "X-Test-Response";
    const respHeaderValue = "DefaultTestHeaderResponse";
    // mock fetch will return the response header respHeader = respHeaderValue if the request has the header reqHeader = reqHeaderValue
    const fetch = mockFetch({headerReplies: [[[reqHeader, reqHeaderValue], [respHeader, respHeaderValue]]], error: [retriedError()]}); 
    const client = await createFetchClient({
        defaultHeaders: {[reqHeader]: reqHeaderValue},
        retries: 1,
        fetch: fetch
    });
    const resp = await client.fetch("");
    t.is(resp?.headers?.get(respHeader), respHeaderValue);
    await client.close();
});
