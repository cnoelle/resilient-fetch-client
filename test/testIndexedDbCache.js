import test from "ava";
import fakeIndexedDB, {IDBKeyRange} from "fake-indexeddb";
import {createFetchClient} from "../dist/client.js";
import { mockFetch, retriedError, waitForClock } from "./helpers/utils.js";
import { registerCacheProvider } from "../dist/cache.js";

test.before(t => 
    registerCacheProvider("indexeddb", async (options) => new (await import("../dist/cache/IndexedDbCache.js")).IndexedDbFactory(options))
);

// TODO it is unclear why some tests require separate databases... else there are more than obscure side effects
// related to db.close() in CacheImpl.ts.#initializeDb() => resolve with timeout in this methods resolves the problem, 
// but this might also be an issue with the fake-indexeddb used for testing (but not obviously so).

/**
 * All tests in here use the indexeddb cache
 */
test("IndexedDB cache works with simple client and cacheFirst strategy", async t => {
    const expectedResult = {result: "cacheTest1Result"};
    const expectedStringified = JSON.stringify(expectedResult);
    const fetch = mockFetch({
        result: expectedStringified,
        headers: {"Content-Type": "application/json"},
        error: [undefined, new Error("2nd attempt fails, need cached value")],
    });
    const client = await createFetchClient({
        cache: {id: "indexeddb", maxItems: 5, indexedDB: { databaseFactory: fakeIndexedDB, keyRange: IDBKeyRange}},
        fetch: fetch
    });
    const cacheRequestConfig = {useCache: {mode: "cacheControl", table: "TestSimple", key: "a1", defaultCacheControl: {maxAge: true}}};
    const result1 = await client.fetchJson("", cacheRequestConfig);
    t.deepEqual(result1.value, expectedResult);
    // fetch is configured to fail here, but with the cacheFirst strategy we should simply retrieve the value from the cache
    const result2 = await client.fetchJson("", cacheRequestConfig);
    t.deepEqual(result2.value, expectedResult);
    await client.close();
});

test("IndexedDB cache works with simple client and no specified table", async t => {
    const expectedResult = {result: "cacheTest1Result"};
    const expectedStringified = JSON.stringify(expectedResult);
    const fetch = mockFetch({
        result: expectedStringified,
        headers: {"Content-Type": "application/json"},
        error: [undefined, new Error("2nd attempt fails, need cached value")],
    });
    const client = await createFetchClient({
        cache: {id: "indexeddb", maxItems: 5, indexedDB: { databaseFactory: fakeIndexedDB, keyRange: IDBKeyRange}},
        fetch: fetch
    });
    const cacheRequestConfig = {useCache: {mode: "cacheControl", key: "a1", defaultCacheControl: {maxAge: true}}};
    const result1 = await client.fetchJson("", cacheRequestConfig);
    t.deepEqual(result1.value, expectedResult);
    // fetch is configured to fail here, but with the cacheFirst strategy we should simply retrieve the value from the cache
    const result2 = await client.fetchJson("", cacheRequestConfig);
    t.deepEqual(result2.value, expectedResult);
    await client.close();
});

test("IndexedDB cache works with simple client and race strategy", async t => {
    const expectedResult = {result: "cacheTest2Result"};
    const expectedStringified = JSON.stringify(expectedResult);
    const fetch = mockFetch({
        result: expectedStringified,
        headers: {"Content-Type": "application/json"},
        error: [undefined, new Error("2nd attempt fails, need cached value")],
    });
    const client = await createFetchClient({
        cache: {id: "indexeddb", maxItems: 5, dbName: "Test_SimpleRace", indexedDB: { databaseFactory: fakeIndexedDB, keyRange: IDBKeyRange}},
        fetch: fetch
    });
    const cacheRequestConfig = {useCache: {mode: "race", update: true, table: "Test_SimpleRace", key: "a"}};
    const result1 = await client.fetchJson("", cacheRequestConfig);
    result1.update.catch(_ => undefined);
    t.deepEqual(result1?.value, expectedResult);
    // fetch is configured to fail here, but with the cacheFirst strategy we should simply retrieve the value from the cache
    const result2 = await client.fetchJson("", cacheRequestConfig);
    result2.update.catch(_ => undefined);
    t.deepEqual(result2?.value, expectedResult);
    await client.close();
});

test("Stale IndexedDB cache result is returned in no-update race mode", async t => {
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
        cache: {id: "indexeddb", maxItems: 5, indexedDB: { databaseFactory: fakeIndexedDB, keyRange: IDBKeyRange}},
        fetch: fetch
    });
    const cacheRequestConfig = {useCache: {mode: "race", update: false, table: "Test_RaceStale", key: "a"}};
    const result1 = await client.fetchJson("", cacheRequestConfig);
    t.deepEqual(result1.value, expectedResult1);
    // mow fetch will retrieve a different result, but it does not run to completion because the cache is faster
    const result2 = await client.fetchJson("", cacheRequestConfig);
    t.deepEqual(result2.value, expectedResult1);
    const result3 = await client.fetchJson(""); // without using the cache 
    t.deepEqual(result3.value, expectedResult2);
    await client.close();
});

test("IndexedDB cached result gets updated when fresh data is available in update race mode", async t => {
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
        cache: {id: "indexeddb", maxItems: 5, indexedDB: { databaseFactory: fakeIndexedDB, keyRange: IDBKeyRange}},
        fetch: fetch
    });
    const cacheRequestConfig = {useCache: {mode: "race", update: true, table: "Test_Race", key: "a"}};
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

test("IndexedDB cache fresh result is returned in fetchFirst mode", async t => {
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
        cache: {id: "indexeddb", maxItems: 5, indexedDB: { databaseFactory: fakeIndexedDB, keyRange: IDBKeyRange}},
        fetch: fetch
    });
    const cacheRequestConfig = {useCache: {mode: "fetchFirst", table: "Test_FreshFetchFirst", key: "a"}};
    const result1 = await client.fetchJson("", cacheRequestConfig);
    t.deepEqual(result1.value, expectedResult1);
    // mow fetch will retrieve a different result
    const result2 = await client.fetchJson("", cacheRequestConfig);
    t.deepEqual(result2.value, expectedResult2);
    await client.close();
});

test("IndexedDB cache return headers works with caching client and fetchFirst", async t => {
    const header = "X-Test";
    const expectedHeader = "expectedTestHeader3!";
    const expectedResult = {result: "testResultAlongHeader3"};
    const expectedResultStr = JSON.stringify(expectedResult);
    const fetch = mockFetch({
        headers: {[header]: expectedHeader, "Content-Type": "application/json"}, 
        result: expectedResultStr, 
        error: [undefined, new Error("2nd request fails")],
    }); 
    const client = await createFetchClient({
        fetch: fetch, 
        cache: {id: "indexeddb", maxItems: 5, dbName: "Test_HeadersCachingFetch", indexedDB: { databaseFactory: fakeIndexedDB, keyRange: IDBKeyRange}}
    });
    const cacheRequestConfig = {useCache: {mode: "fetchFirst", table: "Test_HeadersCachingFetch", key: "a"}};
    await client.fetchJson("", cacheRequestConfig);
    await new Promise(r => setTimeout(r, 25)); // ensure the cache is set
    // 2nd request: here the fetch fails, but we retrieve the results from the cache, including headers
    const resp2 = await client.fetchJson("", {...cacheRequestConfig});
    t.is(resp2?.headers?.get(header), expectedHeader);
    t.deepEqual(resp2?.value, expectedResult);
    await client.close();
});


test("IndexedDB cache return headers works with caching client and cacheFirst", async t => {
    const header = "X-Test";
    const expectedHeader = "expectedTestHeader3!";
    const expectedResult = {result: "testResultAlongHeader3"};
    const expectedResultStr = JSON.stringify(expectedResult);
    const fetch = mockFetch({
        headers: {[header]: expectedHeader, "Content-Type": "application/json"}, 
        result: expectedResultStr, 
        error: [undefined, new Error("2nd request fails")],
    }); 
    const client = await createFetchClient({
        fetch: fetch, 
        cache: {id: "indexeddb", maxItems: 5, indexedDB: { databaseFactory: fakeIndexedDB, keyRange: IDBKeyRange}},
    });
    const cacheRequestConfig = {useCache: {mode: "cacheControl", table: "TestCacheFirst", key: "a", defaultCacheControl: {maxAge: true}}};
    await client.fetchJson("", cacheRequestConfig);
    // 2nd request: here the fetch fails, but we retrieve the results from the cache, including headers
    const resp2 = await client.fetchJson("", {...cacheRequestConfig});
    t.is(resp2?.headers?.get(header), expectedHeader);
    t.deepEqual(resp2?.value, expectedResult);
    await client.close();
});


test("IndexedDB cache return headers works with caching client and race", async t => {
    const header = "X-Test";
    const expectedHeader = "expectedTestHeader3!";
    const expectedResult = {result: "testResultAlongHeader3"};
    const expectedResultStr = JSON.stringify(expectedResult);
    const fetch = mockFetch({
        headers: {[header]: expectedHeader, "Content-Type": "application/json"}, 
        result: expectedResultStr, 
        error: [undefined, new Error("2nd request fails")],
    }); 
    const client = await createFetchClient({
        fetch: fetch, 
        cache: {id: "indexeddb", maxItems: 5, dbName: "Test_HeadersCachingRace", indexedDB: { databaseFactory: fakeIndexedDB, keyRange: IDBKeyRange}},
    });
    const cacheRequestConfig = {useCache: {mode: "race", update: true, table: "Test_HeadersCachingRace", key: "a"}};
    (await client.fetchJson("", cacheRequestConfig))?.update?.catch(() => undefined);
    // 2nd request: here the fetch fails, but we retrieve the results from the cache, including headers
    const resp2 = await client.fetchJson("", {...cacheRequestConfig});
    t.is(resp2?.headers?.get(header), expectedHeader);
    t.deepEqual(resp2?.value, expectedResult);
    resp2.update?.catch(() => undefined);
    await client.close();
});


test("IndexedDB cache return headers works with caching client and race with actual update", async t => {
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
    const client = await createFetchClient({
        fetch: fetch, 
        cache: {id: "indexeddb", maxItems: 5, dbName: "Test_CachingRaceUpdate", indexedDB: { databaseFactory: fakeIndexedDB, keyRange: IDBKeyRange}},
    });
    const cacheRequestConfig = {useCache: {mode: "race", update: true, table: "Test_CachingRaceUpdate", key: "a"}};
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

test("IndexedDB cache Cache control no-store directive is respected", async t => {
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
        cache: {id: "indexeddb", maxItems: 5, indexedDB: { databaseFactory: fakeIndexedDB, keyRange: IDBKeyRange}, clearOnStart: true},
        fetch: fetch
    });
    const cacheRequestConfig = {useCache: {table: "TestNoStore", key: "a"}};  // default mode: cacheControl, so evaluate headers
    const result1 = await client.fetchJson("", cacheRequestConfig);
    t.deepEqual(result1.value, expectedResult1);
    await waitForClock();
    // mow fetch will retrieve a different result
    const result2 = await client.fetchJson("", cacheRequestConfig);
    t.deepEqual(result2.value, expectedResult2);
    await client.close();
});

test("IndexedDB cache Cache control no-cache directive is respected", async t => {
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
        cache: {id: "indexeddb", maxItems: 5, indexedDB: { databaseFactory: fakeIndexedDB, keyRange: IDBKeyRange}},
        fetch: fetch
    });
    const cacheRequestConfig = {useCache: {table: "TestNoCache", key: "a"}};  // default mode: cacheControl, so evaluate headers
    const result1 = await client.fetchJson("", cacheRequestConfig);
    t.deepEqual(result1.value, expectedResult1);
    // mow fetch will retrieve a different result
    const result2 = await client.fetchJson("", cacheRequestConfig);
    t.deepEqual(result2.value, expectedResult2);
    await client.close();
});

test("IndexedDB cache Cache control max-age > 0 directive is respected", async t => {
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
        cache: {id: "indexeddb", maxItems: 5, indexedDB: { databaseFactory: fakeIndexedDB, keyRange: IDBKeyRange}},
        fetch: fetch
    });
    const cacheRequestConfig = {useCache: {table: "TestMaxAgeGt0", key: "a"}};  // default mode: cacheControl, so evaluate headers  => result should be stored
    const result1 = await client.fetchJson("", cacheRequestConfig);
    t.deepEqual(result1.value, expectedResult1);
    // mow fetch will retrieve a different result
    const result2 = await client.fetchJson("", cacheRequestConfig);
    t.deepEqual(result2.value, expectedResult1);
    await client.close();
});

test("IndexedDB cache Cache control max-age = 0 directive is respected", async t => {
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
        cache: {id: "indexeddb", dbName: "TestMaxAge", maxItems: 5, indexedDB: { databaseFactory: fakeIndexedDB, keyRange: IDBKeyRange}},
        fetch: fetch
    });
    const cacheRequestConfig = {useCache: {table: "TestMaxAge", key: "b"}};  // default mode: cacheControl, so evaluate headers  => result should be stored
    const result1 = await client.fetchJson("", cacheRequestConfig);
    t.deepEqual(result1.value, expectedResult1);
    await waitForClock();
    // now fetch will retrieve a different result
    const result2 = await client.fetchJson("", cacheRequestConfig);
    t.deepEqual(result2.value, expectedResult2);
    await client.close();
});

test("IndexedDB cache Cache control stale-if-error directive is respected1", async t => {
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
        cache: {id: "indexeddb", maxItems: 5, indexedDB: { databaseFactory: fakeIndexedDB, keyRange: IDBKeyRange}},
        fetch: fetch
    });
    const cacheRequestConfig = {useCache: {table: "TestStaleIfError", key: "a"}};  // default mode: cacheControl, so evaluate headers  => result should be stored
    const result1 = await client.fetchJson("", cacheRequestConfig);
    t.deepEqual(result1.value, expectedResult1);
    // mow fetch will retrieve a different result
    const result2 = await client.fetchJson("", cacheRequestConfig);
    t.deepEqual(result2.value, expectedResult1);
    await client.close();
});

test("IndexedDB cache works with multiple tables", async t => {
    const expectedResult1 = {result: "cacheResult1"};
    const expectedResult2 = {result: "cacheResult2"};
    const expectedStringified1 = JSON.stringify(expectedResult1);
    const expectedFinalStringified = JSON.stringify(expectedResult2);
    const fetch = mockFetch({
        delay: 10, 
        result: [expectedStringified1, expectedFinalStringified, "{}", "{}"], // we return two different results
        headers: {"Content-Type": "application/json", "Cache-Control": "max-age=1000"},
    });
    const client = await createFetchClient({
        cache: {id: "indexeddb", dbName: "TestMultiple", maxItems: 5, indexedDB: { databaseFactory: fakeIndexedDB, keyRange: IDBKeyRange}},
        fetch: fetch
    });
    const cacheRequestConfig1 = {useCache: {table: "TestMultiple1", key: "b"}}; 
    const result1 = await client.fetchJson("", cacheRequestConfig1);
    t.deepEqual(result1.value, expectedResult1);
    // now fetch will retrieve a different result
    const cacheRequestConfig2 = {useCache: {table: "TestMultiple2", key: "b"}}; 
    const result2 = await client.fetchJson("", cacheRequestConfig2);
    t.deepEqual(result2.value, expectedResult2);
    await new Promise(r => setTimeout(r, 10)); // ensure results are successfully cached
    const result1v2 = await client.fetchJson("", cacheRequestConfig1);
    const result2v2 = await client.fetchJson("", cacheRequestConfig2);
    t.deepEqual(result1v2.value, expectedResult1);
    t.deepEqual(result2v2.value, expectedResult2);
    await client.close();
});

test("IndexedDB cache works with multiple tables, pre-allocated", async t => {
    const expectedResult1 = {result: "cacheResult1"};
    const expectedResult2 = {result: "cacheResult2"};
    const expectedStringified1 = JSON.stringify(expectedResult1);
    const expectedFinalStringified = JSON.stringify(expectedResult2);
    const fetch = mockFetch({
        delay: 10, 
        result: [expectedStringified1, expectedFinalStringified, "{}", "{}"], // we return two different results
        headers: {"Content-Type": "application/json", "Cache-Control": "max-age=1000"},
    });
    const client = await createFetchClient({
        cache: {id: "indexeddb", dbName: "TestMultiple", tables: ["TestMultiple3", "TestMultiple4"], maxItems: 5, 
                    indexedDB: { databaseFactory: fakeIndexedDB, keyRange: IDBKeyRange}},
        fetch: fetch
    });
    const cacheRequestConfig1 = {useCache: {table: "TestMultiple3", key: "b"}}; 
    const result1 = await client.fetchJson("", cacheRequestConfig1);
    t.deepEqual(result1.value, expectedResult1);
    // now fetch will retrieve a different result
    const cacheRequestConfig2 = {useCache: {table: "TestMultiple4", key: "b"}}; 
    const result2 = await client.fetchJson("", cacheRequestConfig2);
    t.deepEqual(result2.value, expectedResult2);
    await new Promise(r => setTimeout(r, 10)); // ensure results are successfully cached
    const result1v2 = await client.fetchJson("", cacheRequestConfig1);
    const result2v2 = await client.fetchJson("", cacheRequestConfig2);
    t.deepEqual(result1v2.value, expectedResult1);
    t.deepEqual(result2v2.value, expectedResult2);
    await client.close();
});

test("cloneItems works with indexeddb cache and positive persistence period", async t => {
    const expectedResult = {result: "cacheTest1pResult"};
    const expectedStringified = JSON.stringify(expectedResult);
    const fetch = mockFetch({
        result: expectedStringified,
        headers: {"Content-Type": "application/json"},
        error: [undefined, new Error("2nd attempt fails, need cached value")],
    });
    const client = await createFetchClient({
        cache: {id: "indexeddb", cloneItems: true, persistencePeriod: 5_000, dbName: "TestCloneItems", maxItems: 5, 
            indexedDB: { databaseFactory: fakeIndexedDB, keyRange: IDBKeyRange}},
        fetch: fetch
    });
    const cacheRequestConfig = {useCache: {mode: "cacheControl", table: "Test", key: "a1", defaultCacheControl: {maxAge: true}}};
    const result1 = await client.fetchJson("", cacheRequestConfig);
    t.deepEqual(result1.value, expectedResult);
    result1.value.result = "this has been tampered with";
    // fetch is configured to fail here, but with the cacheFirst strategy we should simply retrieve the value from the cache
    const result2 = await client.fetchJson("", cacheRequestConfig);
    t.deepEqual(result2.value, expectedResult);
    await client.close();
});

test("cloneItems works with indexeddb cache, positive persistence period and memory disabled", async t => {
    const expectedResult = {result: "cacheTest1pResult"};
    const expectedStringified = JSON.stringify(expectedResult);
    const fetch = mockFetch({
        result: expectedStringified,
        headers: {"Content-Type": "application/json"},
        error: [undefined, new Error("2nd attempt fails, need cached value")],
    });
    const client = await createFetchClient({
        cache: {id: "indexeddb", cloneItems: true, persistencePeriod: 5_000, maxItemsInMemory: 0, dbName: "TestCloneItems", maxItems: 5, 
            indexedDB: { databaseFactory: fakeIndexedDB, keyRange: IDBKeyRange}},
        fetch: fetch
    });
    const cacheRequestConfig = {useCache: {mode: "cacheControl", table: "Test", key: "a1", defaultCacheControl: {maxAge: true}}};
    const result1 = await client.fetchJson("", cacheRequestConfig);
    t.deepEqual(result1.value, expectedResult);
    result1.value.result = "this has been tampered with";
    // fetch is configured to fail here, but with the cacheFirst strategy we should simply retrieve the value from the cache
    const result2 = await client.fetchJson("", cacheRequestConfig);
    t.deepEqual(result2.value, expectedResult);
    await client.close();
});