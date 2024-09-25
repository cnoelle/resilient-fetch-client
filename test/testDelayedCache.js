import test from "ava";
import {createFetchClient} from "../dist/client.js";
import { mockFetch, retriedError, waitForClock } from "./helpers/utils.js";
import { delayedCacheId, registerDelayedCache } from "./helpers/DelayedCache.js";

test.before(t => registerDelayedCache());

/**
 * Tests in this file use a delayed cache
 */
test("Delayed cache works with simple client and cacheFirst strategy", async t => {
    const expectedResult = {result: "cacheTest1Result"};
    const expectedStringified = JSON.stringify(expectedResult);
    const fetch = mockFetch({
        result: expectedStringified,
        headers: {"Content-Type": "application/json"},
        error: [undefined, new Error("2nd attempt fails, need cached value")],
    });
    const setDelay = 1;
    const client = await createFetchClient({
        cache: {id: delayedCacheId, maxItems: 5, setDelay: setDelay},
        fetch: fetch
    });
    const cacheRequestConfig = {useCache: {mode: "cacheControl", table: "Test", key: "a", defaultCacheControl: {maxAge: true}}};
    const result1 = await client.fetchJson("", cacheRequestConfig);
    t.deepEqual(result1.value, expectedResult);
    await new Promise(resolve => setTimeout(resolve, 15)); // ensure the cache value is set here from the first request
    // fetch is configured to fail here, but with the cacheFirst strategy we should simply retrieve the value from the cache
    const result2 = await client.fetchJson("", cacheRequestConfig);
    t.deepEqual(result2.value, expectedResult);
});


test("Delayed cache works with simple client and race strategy", async t => {
    const expectedResult = {result: "cacheTest2Result"};
    const expectedStringified = JSON.stringify(expectedResult);
    const fetch = mockFetch({
        result: expectedStringified,
        headers: {"Content-Type": "application/json"},
        error: [undefined, new Error("2nd attempt fails, need cached value")],
    });
    const client = await createFetchClient({
        cache: {id: delayedCacheId, maxItems: 5},
        fetch: fetch
    });
    const cacheRequestConfig = {useCache: {mode: "race", update: true, table: "Test", key: "a"}};
    const result1 = await client.fetchJson("", cacheRequestConfig);
    result1.update.catch(_ => undefined);
    t.deepEqual(result1?.value, expectedResult);
    // fetch is configured to fail here, but with the cacheFirst strategy we should simply retrieve the value from the cache
    const result2 = await client.fetchJson("", cacheRequestConfig);
    result2.update.catch(_ => undefined);
    t.deepEqual(result2?.value, expectedResult);
    await client.close();
});

test("Stale delayed cache result is returned in no-update race mode", async t => {
    const expectedResult1 = {result: "cacheTestResultStale1"};
    const expectedResult2 = {result: "cacheTestResultFresh1"};
    const expectedStringified1 = JSON.stringify(expectedResult1);
    const expectedFinalStringified = JSON.stringify(expectedResult2);
    const fetch = mockFetch({
        delay: 100,  // ensure the cached value is always returned first
        result: [expectedStringified1, expectedFinalStringified, expectedFinalStringified], // we return two different results, imitating the update of some resource
        headers: {"Content-Type": "application/json"}
    });
    const client = await createFetchClient({
        cache: {id: delayedCacheId, maxItems: 5},
        fetch: fetch
    });
    const cacheRequestConfig = {useCache: {mode: "race", update: false, table: "Test", key: "a"}};
    const result1 = await client.fetchJson("", cacheRequestConfig);
    t.deepEqual(result1.value, expectedResult1);
    // mow fetch will retrieve a different result, but it does not run to completion because the cache is faster
    const result2 = await client.fetchJson("", cacheRequestConfig);
    t.deepEqual(result2.value, expectedResult1);
    const result3 = await client.fetchJson(""); /* without using the cache */
    t.deepEqual(result3.value, expectedResult2);
    await client.close();
});

test("Delayed cache Cached result gets updated when fresh data is available in update race mode", async t => {
    const expectedResult1 = {result: "cacheTestResultStale2"};
    const expectedResult2 = {result: "cacheTestResultFresh2"};
    const expectedStringified1 = JSON.stringify(expectedResult1);
    const expectedFinalStringified = JSON.stringify(expectedResult2);
    const fetch = mockFetch({
        delay: 100,  // ensure the cached value is always returned first
        result: [expectedStringified1, expectedFinalStringified], // we return two different results, imitating the update of some resource
        headers: {"Content-Type": "application/json"}
    });
    const client = await createFetchClient({
        cache: {id: delayedCacheId, maxItems: 5},
        fetch: fetch
    });
    const cacheRequestConfig = {useCache: {mode: "race", update: true, table: "Test", key: "a"}};
    const result1 = await client.fetchJson("", cacheRequestConfig);
    result1.update.catch(_ => undefined);
    t.deepEqual(result1?.value, expectedResult1);
    // mow we'll retrieve a different result
    const result2 = await client.fetchJson("", cacheRequestConfig);
    // we expect this value to come from the stale cache
    let finalValue = result2;
    await result2.update.then(update => finalValue = update).catch(_ => undefined);
    t.deepEqual(finalValue.value, expectedResult2);
    await client.close();
});

test("Delayed cache Fresh result is returned in fetchFirst mode", async t => {
    const expectedResult1 = {result: "cacheTestResultStale1"};
    const expectedResult2 = {result: "cacheTestResultFresh1"};
    const expectedStringified1 = JSON.stringify(expectedResult1);
    const expectedFinalStringified = JSON.stringify(expectedResult2);
    const fetch = mockFetch({
        delay: 100,  // ensure the cached value is always returned first
        result: [expectedStringified1, expectedFinalStringified], // we return two different results, imitating the update of some resource
        headers: {"Content-Type": "application/json"}
    });
    const client = await createFetchClient({
        cache: {id: delayedCacheId, maxItems: 5},
        fetch: fetch
    });
    const cacheRequestConfig = {useCache: {mode: "fetchFirst", table: "Test", key: "a"}};
    const result1 = await client.fetchJson("", cacheRequestConfig);
    t.deepEqual(result1.value, expectedResult1);
    // mow fetch will retrieve a different result
    const result2 = await client.fetchJson("", cacheRequestConfig);
    t.deepEqual(result2.value, expectedResult2);
    await client.close();
});

test("Delayed cache return headers works with caching client and fetchFirst", async t => {
    const header = "X-Test";
    const expectedHeader = "expectedTestHeader3!";
    const expectedResult = {result: "testResultAlongHeader3"};
    const expectedResultStr = JSON.stringify(expectedResult);
    const fetch = mockFetch({
        headers: {[header]: expectedHeader, "Content-Type": "application/json"}, 
        result: expectedResultStr, 
        error: [undefined, new Error("2nd request fails")],
    }); 
    const client = await createFetchClient({fetch: fetch, cache: {id: delayedCacheId, maxItems: 5}});
    const cacheRequestConfig = {useCache: {mode: "fetchFirst", table: "Test", key: "a"}};
    await client.fetchJson("", cacheRequestConfig);
    // 2nd request: here the fetch fails, but we retrieve the results from the cache, including headers
    const resp2 = await client.fetchJson("", {...cacheRequestConfig});
    t.is(resp2?.headers?.get(header), expectedHeader);
    t.deepEqual(resp2?.value, expectedResult);
    await client.close();
});

test("Delayed cache return headers works with caching client and cacheFirst", async t => {
    const header = "X-Test";
    const expectedHeader = "expectedTestHeader3!";
    const expectedResult = {result: "testResultAlongHeader3"};
    const expectedResultStr = JSON.stringify(expectedResult);
    const fetch = mockFetch({
        headers: {[header]: expectedHeader, "Content-Type": "application/json"}, 
        result: expectedResultStr, 
        error: [undefined, new Error("2nd request fails")],
    }); 
    const client = await createFetchClient({fetch: fetch, cache: {id: delayedCacheId, maxItems: 5}});
    const cacheRequestConfig = {useCache: {mode: "cacheControl", table: "Test", key: "a", defaultCacheControl: {maxAge: true}}};
    await client.fetchJson("", cacheRequestConfig);
    // 2nd request: here the fetch fails, but we retrieve the results from the cache, including headers
    const resp2 = await client.fetchJson("", {...cacheRequestConfig});
    t.is(resp2?.headers?.get(header), expectedHeader);
    t.deepEqual(resp2?.value, expectedResult);
    await client.close();
});

test("Delayed cache return headers works with caching client and race", async t => {
    const header = "X-Test";
    const expectedHeader = "expectedTestHeader3!";
    const expectedResult = {result: "testResultAlongHeader3"};
    const expectedResultStr = JSON.stringify(expectedResult);
    const fetch = mockFetch({
        headers: {[header]: expectedHeader, "Content-Type": "application/json"}, 
        result: expectedResultStr, 
        error: [undefined, new Error("2nd request fails")],
    }); 
    const client = await createFetchClient({fetch: fetch, cache: {id: delayedCacheId, maxItems: 5}});
    const cacheRequestConfig = {useCache: {mode: "race", update: true, table: "Test", key: "a"}};
    (await client.fetchJson("", cacheRequestConfig))?.update?.catch(() => undefined);
    // 2nd request: here the fetch fails, but we retrieve the results from the cache, including headers
    const resp2 = await client.fetchJson("", {...cacheRequestConfig});
    t.is(resp2?.headers?.get(header), expectedHeader);
    t.deepEqual(resp2?.value, expectedResult);
    resp2.update?.catch(() => undefined);
    await client.close();
});

test("Delayed cache return headers works with caching client and race with actual update", async t => {
    const header = "X-Test";
    const expectedHeader = "expectedTestHeader4!";
    const expectedResult1 = {result: "testResultAlongHeader4"};
    const expectedResultStr1 = JSON.stringify(expectedResult1);
    const expectedResult2 = {result: "testResultAlongHeader5"};
    const expectedResultStr2 = JSON.stringify(expectedResult2);
    // first request times out, but second will be successful
    const fetch = mockFetch({
        headers: {[header]: expectedHeader, "Content-Type": "application/json"}, 
        result: [expectedResultStr1, expectedResultStr2], 
        delay: [0, 100]  // ensure the cached result comes first
    }); 
    const client = await createFetchClient({fetch: fetch, cache: {id: delayedCacheId, maxItems: 5}});
    const cacheRequestConfig = {useCache: {mode: "race", update: true, table: "Test", key: "a"}};
    (await client.fetchJson("", cacheRequestConfig))?.update?.catch(() => undefined);
    // 2nd request: here the fetch fails, but we retrieve the results from the cache, including headers
    const resp2 = await client.fetchJson("", {...cacheRequestConfig});
    t.is(resp2?.headers?.get(header), expectedHeader);
    t.deepEqual(resp2?.value, expectedResult1);
    const update = await resp2.update;
    t.is(update.headers?.get(header), expectedHeader);
    t.deepEqual(update.value, expectedResult2);
    await client.close();
});

test("Delayed cache Cache control no-store directive is respected", async t => {
    const expectedResult1 = {result: "cacheTestResultStale1"};
    const expectedResult2 = {result: "cacheTestResultFresh1"};
    const expectedStringified1 = JSON.stringify(expectedResult1);
    const expectedFinalStringified = JSON.stringify(expectedResult2);
    const fetch = mockFetch({
        delay: 100,  // ensure the cached value is always returned first
        result: [expectedStringified1, expectedFinalStringified], // we return two different results, imitating the update of some resource
        headers: {"Content-Type": "application/json", "Cache-Control": "no-store"}
    });
    const client = await createFetchClient({
        cache: {id: delayedCacheId, maxItems: 5},
        fetch: fetch
    });
    const cacheRequestConfig = {useCache: {table: "Test", key: "a"}};  // default mode: cacheControl, so evaluate headers
    const result1 = await client.fetchJson("", cacheRequestConfig);
    t.deepEqual(result1.value, expectedResult1);
    // mow fetch will retrieve a different result
    const result2 = await client.fetchJson("", cacheRequestConfig);
    t.deepEqual(result2.value, expectedResult2);
    await client.close();
});

test("Delayed cache Cache control no-cache directive is respected", async t => {
    const expectedResult1 = {result: "cacheTestResultStale1"};
    const expectedResult2 = {result: "cacheTestResultFresh1"};
    const expectedStringified1 = JSON.stringify(expectedResult1);
    const expectedFinalStringified = JSON.stringify(expectedResult2);
    const fetch = mockFetch({
        delay: 100,  // ensure the cached value is always returned first
        result: [expectedStringified1, expectedFinalStringified], // we return two different results, imitating the update of some resource
        headers: {"Content-Type": "application/json", "Cache-Control": "no-cache"}
    });
    const client = await createFetchClient({
        cache: {id: delayedCacheId, maxItems: 5},
        fetch: fetch
    });
    const cacheRequestConfig = {useCache: {table: "Test", key: "a"}};  // default mode: cacheControl, so evaluate headers
    const result1 = await client.fetchJson("", cacheRequestConfig);
    t.deepEqual(result1.value, expectedResult1);
    // mow fetch will retrieve a different result
    const result2 = await client.fetchJson("", cacheRequestConfig);
    t.deepEqual(result2.value, expectedResult2);
    await client.close();
});

test("Delayed cache Cache control max-age > 0 directive is respected", async t => {
    const expectedResult1 = {result: "cacheTestResultStale1"};
    const expectedResult2 = {result: "cacheTestResultFresh1"};
    const expectedStringified1 = JSON.stringify(expectedResult1);
    const expectedFinalStringified = JSON.stringify(expectedResult2);
    const fetch = mockFetch({
        delay: 100,  // ensure the cached value is always returned first
        result: [expectedStringified1, expectedFinalStringified], // we return two different results, imitating the update of some resource
        headers: {"Content-Type": "application/json", "Cache-Control": "max-age=120"}
    });
    const client = await createFetchClient({
        cache: {id: delayedCacheId, maxItems: 5},
        fetch: fetch
    });
    const cacheRequestConfig = {useCache: {table: "Test", key: "a"}};  // default mode: cacheControl, so evaluate headers  => result should be stored
    const result1 = await client.fetchJson("", cacheRequestConfig);
    t.deepEqual(result1.value, expectedResult1);
    // mow fetch will retrieve a different result
    const result2 = await client.fetchJson("", cacheRequestConfig);
    t.deepEqual(result2.value, expectedResult1);
    await client.close();
});

test("Delayed cache Cache control max-age = 0 directive is respected", async t => {
    const expectedResult1 = {result: "cacheTestResultStale1"};
    const expectedResult2 = {result: "cacheTestResultFresh1"};
    const expectedStringified1 = JSON.stringify(expectedResult1);
    const expectedFinalStringified = JSON.stringify(expectedResult2);
    const fetch = mockFetch({
        delay: 100,  // ensure the cached value is always returned first
        result: [expectedStringified1, expectedFinalStringified], // we return two different results, imitating the update of some resource
        headers: {"Content-Type": "application/json", "Cache-Control": "max-age=0"}
    });
    const client = await createFetchClient({
        cache: {id: delayedCacheId, maxItems: 5},
        fetch: fetch
    });
    const cacheRequestConfig = {useCache: {table: "Test2", key: "b"}};  // default mode: cacheControl, so evaluate headers  => result should be stored
    const result1 = await client.fetchJson("", cacheRequestConfig);
    t.deepEqual(result1.value, expectedResult1);
    await waitForClock();
    // mow fetch will retrieve a different result
    const result2 = await client.fetchJson("", cacheRequestConfig);
    t.deepEqual(result2.value, expectedResult2);
    await client.close();
});

test("Delayed cache Cache control stale-if-error directive is respected1", async t => {
    const expectedResult1 = {result: "cacheTestResultStale1"};
    const expectedResult2 = {result: "cacheTestResultFresh1"};
    const expectedStringified1 = JSON.stringify(expectedResult1);
    const expectedFinalStringified = JSON.stringify(expectedResult2);
    const fetch = mockFetch({
        delay: 100,  // ensure the cached value is always returned first
        result: [expectedStringified1, expectedFinalStringified], // we return two different results, imitating the update of some resource
        headers: {"Content-Type": "application/json", "Cache-Control": "max-age=0, stale-if-error=10"},
        error: [undefined, retriedError({status: 500})]
    });
    const client = await createFetchClient({
        cache: {id: delayedCacheId, maxItems: 5},
        fetch: fetch
    });
    const cacheRequestConfig = {useCache: {table: "Test", key: "a"}};  // default mode: cacheControl, so evaluate headers  => result should be stored
    const result1 = await client.fetchJson("", cacheRequestConfig);
    t.deepEqual(result1.value, expectedResult1);
    // mow fetch will retrieve a different result
    const result2 = await client.fetchJson("", cacheRequestConfig);
    t.deepEqual(result2.value, expectedResult1);
    await client.close();
});




