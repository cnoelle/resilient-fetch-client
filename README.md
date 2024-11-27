# Resilient fetch client

A resilient HTTP client for Javascript based on native fetch and the [cockatiel](https://github.com/connor4312/cockatiel) library. 

Features on top of fetch:

* Timeout, configurable per individual request and/or with retries and everything included
* Circuit breaker (https://en.wikipedia.org/wiki/Circuit_breaker_design_pattern)
* Bulkhead (limited number of parallel requests, https://learn.microsoft.com/en-us/azure/architecture/patterns/bulkhead)
* Retry, with exponential backoff and jitter
* Cache functionality beyond browser-controlled HTTP caching (currently only for JSON data)

Convenience features:

* Method `abortAll()` to cancel all ongoing requests
* `fetch()` fails on status codes >= 400 by default
* Added `fetchJson()` method
* Add default headers to requests

Design principles:

* API close to native `fetch`, with small extensions where necessary (failing on status codes >= 400 being a major exception).
* Caching controlled by the user: while the lib aims to respect `Cache-Control` headers sent by the server, this behaviour can be overwritten. Furthermore, caching is possible for POST requests as well.
* Few, selected dependencies, imported dynamically on first use. No transitive dependencies.
* Written in Typescript and compiled to modern Javascript as ESM modules.
* Targeting mainly browsers, but should work in a recent NodeJS as well.

Installation: 

```bash
npm install resilient-fetch-client
```

Basic usage:

```javascript
import {createFetchClient} from "resilient-fetch-client";

const client = await createFetchClient({
    baseUrl: "/api/v1",
    timeoutRequest: 30_000 /* milliseconds */,
    parallelRequests: { maxParallelRequests: 4, maxQueuedRequests: 100},
    retries: 2,
    circuitBreaker: {openAfterFailedAttempts: 5, halfOpenAfter: 15_000 /* milliseconds */ },
    timeoutTotal: 60_000
});
const response = await client.fetch("items");
const items = await response.json();
console.log("Items", items.value);
```

API documentation: https://cnoelle.github.io/resilient-fetch-client

License: MIT

## Configuration

### Resilience features

The general resilience pipeline consists of per-request timeout, circuit breaker, bulkhead, retry, and global timeout. Every request passes through these gates in the mentioned order. Configuration of the gates is defined via a [`FetchClientOptions`](https://cnoelle.github.io/resilient-fetch-client/interfaces/FetchClientOptions.html) object.

Parameters: 

* `timeoutRequest` (positive integer, unit: milliseconds): the duration before a timeout is triggered. This is the timeout per request, it does not include retries.
* `circuitBreaker` (object of type [`CircuitBreakerConfig`](#circuitbreakerconfig)
* `parallelRequests` (object of type [`ParallelRequestsConfig`](#parallelrequestsconfig)): Defines the bulkhead settings, in particular the maximum number of parallel requests sent.
* `retries` (positive integer or object of type [`RetryConfig`](#retryconfig)): either the maximum number of retries, or a configuration object.
* `timeoutTotal` (positive integer: unit: milliseconds): the duration before a timeout is triggered, including retries and requests being queued in the bulkhead queue.

#### CircuitBreakerConfig

A circuit breaker can be in the `closed`, `open` or `half-open` state. Closed is the default, when everything works ok. After a series of failures, it enters the open state. When it is open, all requests tunneled through the circuit breaker immediately fail. After passing of a certain time-interval, it becomes half-open; in this state, some requests will be sent to the server again, if they succeed the closed state is entered again, otherwise it falls back to open.

`halfOpenAfter` is required, the other parameters are optional.

* `halfOpenAfter` (positive integer, unit: milliseconds): time interval after which requests are sent to the server again when the circuit breaker entered the open state.
* `methods` (Array<string>): default: all methods.
* `openAfterFailedAttempts` (positive integer): number of failed requests for the circuit breaker to trip.
* `statusCodes` (array of positive integers, HTTP status codes): status codes to consider as failed attempts for the purpose of the circuit breaker. Default: `[408, 420, 429, 500, 502, 503, 504]`.
* `triggerOnNetworkError` (boolean): Default: true.
* `triggerOnTimeout` (boolean): Default: true.

#### ParallelRequestsConfig

Both options are required:

* `maxParallelRequests` (positive integer)
* `maxQueuedRequests` (non-negative integer)

#### RetryConfig

`maxRetries` is mandatory, the other parameters are optional.

* `exponent` (number);
* `initialDelay` (number, unit: milliseconds);
* `maxDelay` (number, unit: milliseconds);
* `maxRetries` (positive integer);
* `retryNetworkErrors` (boolean);
* `retryPosts` (boolean);
* `retryStatusCodes`: number[]; 
* `retryTimeout` (boolean) 

### Convenience features

* `baseUrl` (string): base url to be prepended before all urls.
* `defaultSkipFailOnErrorCode` (boolean): if `true`, requests do not automatically fail on response status codes >= 400, restoring the default fetch behaviour. Default: `false`.
* `defaultHeaders` (an object of type `HeadersInit`, e.g. key value pairs representing headers): headers to be sent with every requests.
* `defaultHeadersByMethod` (an object with keys: method name, such as `"GET"`, `"POST"`, etc., values: object of type `HeadersInit`).

### Caching

Note that browsers implement powerful caching functionality for GET requests, controlled by the `Cache-Control` response header, so you may not need to do this at the application level. Sometimes, however, the browser caching model is too restrictive:
* It only works for GET, not POST, for instance
    * ALthough it is usually understood that POST requests modify the server resource (or, more generally, are not idempotent) and therefore should not be cached, there are many APIs using POSTs for sending complex search queries to the server (e.g. for [GraphQL](https://graphql.org/learn/serving-over-http/#post-request) or [Elastic](https://www.elastic.co/guide/en/elasticsearch/reference/current/search-search.html) queries, both of which support GET and POST). The reason for this is that GET does not allow for a body and therefore needs lengthy, unstructured query parameter strings for the same purpose. Caching POST responses can be a valid undertaking in such a scenario.
    * It is controlled by the server response. If the server/backend is not under control of the frontend developer, e.g., when using a 3rd party API, this can be problematic. The application requirements may differ from the expectations of the API provider, or the Cache-Control header may be missing altogether.
    * The `Cache-Cotrol` model does not allow to use a cached value initially, trigger an update and use the updated value subsequently. Although the [`stale-while-revalidate`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cache-Control#stale-while-revalidate) parameter accomplishes something similar, the browser does not report the updated value to the caller in this case. So one ends up with an updated cache but still using an outdated value in the application, or needs to trigger multiple fetches just in case. This library  supports an `update` parameter to the per request options, which makes the client return a cached value together with an `update` field that returns the result of the refresh call, or fails with `NoUpdateError` if none is available, respectively the result is unchanged.

Therefore, this client offers the option to cache server responses and to overwrite the server-provided cache settings for this purpose. So far, **this has been implemented only for the [`fetchJson()`](https://cnoelle.github.io/resilient-fetch-client/interfaces/FetchClientCaching.html#fetchJson.fetchJson-2) method**, but the goal is to enable caching for arbitrary [fetch](https://cnoelle.github.io/resilient-fetch-client/interfaces/FetchClientCaching.html#fetch.fetch-1) requests, well.

#### Provider configuration

Cache parameters for the client, passed to `createFetchClient` (see [`CacheConfiguration`](https://cnoelle.github.io/resilient-fetch-client/interfaces/CacheConfiguration.html)):

* `cache`: An object with properties (or array of objects):
    * `id` (required): id of the cache provider. `indexeddb`, `memorylru` or `memory`.
    * `maxItems` (non-negative integer): maximum number of items to keep in store. Note that not all implementations necessarily treat this as a hard limit, e.g. for the IndexedDB provider this is a soft limit that may be violated temporarily if the persistencePeriod is positive. Zero means no limit, the cache may grow without bounds. Default: 0.
    * `cloneItems` (boolean): flag that instructs the cache to only every return objects that are safe to manipulate by the caller. Default: `false`.
    * `deepCopy`  (function): if `cloneItems` is true this function can be used to replace the default deep copy function, which is the global [`structuredClone`](https://developer.mozilla.org/en-US/docs/Web/API/structuredClone)
    * More entries dependent on the cache provider. 

#### IndexedDB

A cache based on browser-storage technology [IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API), evicting items on a least-recently used (LRU) basis. All settings are optional. Cache provider id: `indexeddb`.

* `numItemsToPurge` (positive integer): Number of items to purge when the `maxItems` threshold is violated. Default: 10.
* `persistencePeriod` (non-negative integer, unit: milliseconds): If this is positive then items in the cache are persisted periodically to the IndexedDB storage. If zero, they are persisted immediately, which may impact performance. Default: 15_000 (15s).
* `dbName` (string): Database name. Default: `ResilientFetchClient`.
* `tables` (Array<string>): Optionally, one may specify all the tables to be used (a table must be specified per request). Initializing the tables via this parameter might improve performance if many different ones are used, since it  avoids version updates of the underlying IndexedDB.
* `maxItemsInMemory` (non-negative integer): if positive or not set, the most recently used items up to this limit are also stored in memory. Set to 0 to disable the memory layer. Default: 100
* `numMemoryItemsToPurge` (positive integer): if the memory layer is enabled, this setting controls how many items are evicted from memory when the `maxItemsInMemory` limit is hit. Default: `maxItemsInMemory/4`.

Implementation based on [lru-cache-idb](https://github.com/cnoelle/lru-cache-idb).
    
#### Memory cache LRU

A pure memory cache storing items on a least-recently used basis. Either `maxItems` or `ttl` must be specified. Cache provider id `memorylru`.

* `ttl` (positive integer, unit: seconds): Time-to-live. 

Implementation based on [lru-cache](https://github.com/isaacs/node-lru-cache).

#### Memory cache

A pure memory cache storing items on a first in first out (FIFO) basis. All settings are optional. Cache provider id: `memory`. No additional settings.


#### Per-request configuration

If caching shall be enabled for a request, at least one cache provider must have been enabled for the client, and in addition the parameter `useCache` must be provided as part of the 2nd fetch argument . The value of `useCache` is an object of type [`CachingRequestConfig`](https://cnoelle.github.io/resilient-fetch-client/types/CachingRequestConfig.html); see [GenericCacheConfig](https://cnoelle.github.io/resilient-fetch-client/interfaces/GenericCacheConfig.html) for the basic interface. Example:

```javascript
import {createFetchClient} from "resilient-fetch-client";

const client = await createFetchClient({
    baseUrl: "/api/v1",
    cache: {id: "memorylru", maxItems: 15}
});
const response = await client.fetch("items", {useCache: {key: "allitems"}});
const items = await response.json();
console.log("Items", items.value);
```

The `key` parameter is required, all others are optional.

* `key` (string): Specifies a key for the request under which the result shall be cached and looked up.
* `mode` ("cacheControl" | "fetchFirst" | "race"): Default: "cacheControl", which is similar to the browser `Cache-Control` caching model. The option `fetch-first` implies that a request is sent immediately and a potential cached value is only used in case of an error, wheras `race` means that cache and server are contacted simultaneously and the first one wins. Both `cacheControl` and `race` support the `update` parameter. 
* `table` (string): may be used to group items together. Default: "Cached"
* `defaultCacheControl` (object of type `CacheControl`): default cache settings. May be used if the server does not provide any Cache-Control header.
* `forcedCacheControl` (object of type `CacheControl`): overwrites the Cache-Control response header for the request.
* `activeCache` (string): may be used to select a cache provider
* `update` (boolean): if this flag is set (compatible with mode `cacheControl` and `race`), then the result will come with an additional `update` field, which returns a promise for another [`JsonResult`](https://cnoelle.github.io/resilient-fetch-client/interfaces/JsonResult.html). This promise fails if no update is available.

## Development

### Prerequisites

A current version of NodeJS. Clone the repository and run `npm install` in the base folder.

### Build:

```
npm run build
```

### Tests

Requires build first. Run all tests:

```
npm run test
```

Run a tests in a single file:

```
npx ava test/testClient.js
```

Inside a file one can use the `test.only` ava method to restrict the run to a specific test.


## Related libraries

* ky: https://github.com/sindresorhus/ky
* got: https://github.com/sindresorhus/got
* .NET resilient HTTP client: https://devblogs.microsoft.com/dotnet/building-resilient-cloud-services-with-dotnet-8/
    * this library tries to achieve similar resilience features as described in the blog post for the .NET client. The underlying resilience library *cockatiel* is even a port of Microsoft's *Polly* library to Javascript.
