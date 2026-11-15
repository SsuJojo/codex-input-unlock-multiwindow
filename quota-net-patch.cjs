/*
 * Network-layer quota patch for Codex Desktop.
 *
 * Codex derives the composer gate from the rate-limit state carried by the
 * account/usage payloads. Those payloads never reach the page through
 * window.fetch: the client builds every HTTP response with
 * `new Response(stream, { headers })` after its native httpFetch service
 * returns, so the patch hooks three surfaces and rewrites the same fields:
 *
 *   rate_limit.allowed        -> true
 *   rate_limit.limit_reached  -> false
 *   blocked_features          -> []
 *   premium_exhausted_at      -> null
 *
 *   - Response constructor: covers the native httpFetch transport (primary)
 *   - fetch: covers renderer code that fetches JSON itself
 *   - XMLHttpRequest: legacy escape hatch
 *   - TanStack Query publication on the "rate-limit-status" key: covers the
 *     push channel and any usage data cached before the patch attached
 *
 * Nothing here inspects minified bundle code, so chunk layout, module wiring
 * and identifier names can change with every client update without breaking
 * it. quota-gate.cjs stays available as an opt-in breakpoint fallback.
 */
(() => {
  const VERSION = 3;
  const WRAPPER_FLAG = "__codexQuotaNetWrapped";
  const MAX_INSPECT_BYTES = 4 * 1024 * 1024;
  const MAX_DEPTH = 8;
  const HINTS = ['"rate_limit"', '"rate_limits"', '"blocked_features"', '"premium_exhausted_at"'];

  const stats = {
    version: VERSION,
    rewrites: 0,
    inspected: 0,
    errors: 0,
    rateLimits: 0,
    blockedFeatures: 0,
    premiumExhausted: 0,
    byTransport: { fetch: 0, xhr: 0, response: 0, query: 0 },
    lastUrl: null,
    lastAt: null,
    responsePatched: false,
    fetchPatched: false,
    xhrPatched: false,
    queryPatched: false,
  };

  function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function newReport() {
    return { changed: false, rateLimits: 0, blockedFeatures: 0, premiumExhausted: 0 };
  }

  function assign(target, key, value) {
    try {
      target[key] = value;
      return target[key] === value;
    } catch {
      return false;
    }
  }

  function unlockRateLimit(rateLimit, report) {
    if (!isPlainObject(rateLimit)) return;
    if (rateLimit.allowed !== true && assign(rateLimit, "allowed", true)) {
      report.rateLimits += 1;
      report.changed = true;
    }
    if (rateLimit.limit_reached === true && assign(rateLimit, "limit_reached", false)) {
      report.rateLimits += 1;
      report.changed = true;
    }
  }

  function rewriteNode(node, depth, report) {
    if (node === null || typeof node !== "object" || depth > MAX_DEPTH) return;
    if (Array.isArray(node)) {
      for (const item of node) rewriteNode(item, depth + 1, report);
      return;
    }
    if (!isPlainObject(node)) return;
    if (isPlainObject(node.rate_limit)) unlockRateLimit(node.rate_limit, report);
    if (Array.isArray(node.rate_limits)) {
      for (const item of node.rate_limits) unlockRateLimit(item, report);
    }
    if (Array.isArray(node.blocked_features) && node.blocked_features.length > 0) {
      // Image generation keeps its own banner and quota; only the remaining
      // (send/composer) blocks are cleared.
      const kept = node.blocked_features.filter((entry) => /image/i.test(String(entry?.feature_name ?? entry?.featureName ?? "")));
      if (kept.length !== node.blocked_features.length && assign(node, "blocked_features", kept)) {
        report.blockedFeatures += 1;
        report.changed = true;
      }
    }
    if (typeof node.premium_exhausted_at === "string" && node.premium_exhausted_at.length > 0) {
      if (assign(node, "premium_exhausted_at", null)) {
        report.premiumExhausted += 1;
        report.changed = true;
      }
    }
    if (node.rate_limit_reached_type != null && assign(node, "rate_limit_reached_type", null)) {
      report.changed = true;
    }
    if (node.model_picker_upsell != null && assign(node, "model_picker_upsell", null)) {
      report.changed = true;
    }
    // The "usage exhausted" notice bar (title/description/CTAs) is driven by
    // rate_limit_upsell; a null value unmounts the banner.
    if (node.rate_limit_upsell != null && assign(node, "rate_limit_upsell", null)) {
      report.changed = true;
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (value !== null && typeof value === "object") rewriteNode(value, depth + 1, report);
    }
  }

  function rewritePayload(value) {
    const report = newReport();
    rewriteNode(value, 0, report);
    return report;
  }

  function looksRelevant(text) {
    for (const hint of HINTS) {
      if (text.includes(hint)) return true;
    }
    return false;
  }

  function rewriteJsonText(text) {
    if (typeof text !== "string" || text.length === 0 || text.length > MAX_INSPECT_BYTES) return null;
    if (!looksRelevant(text)) return null;
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
    const report = rewritePayload(value);
    if (!report.changed) return null;
    let rewritten;
    try {
      rewritten = JSON.stringify(value);
    } catch {
      return null;
    }
    return { text: rewritten, report };
  }

  function record(outcome, url, transport) {
    stats.rewrites += 1;
    stats.rateLimits += outcome.report.rateLimits;
    stats.blockedFeatures += outcome.report.blockedFeatures;
    stats.premiumExhausted += outcome.report.premiumExhausted;
    stats.byTransport[transport] = (stats.byTransport[transport] || 0) + 1;
    stats.lastUrl = typeof url === "string" ? url : null;
    stats.lastAt = new Date().toISOString();
  }

  function readHeader(headers, name) {
    if (!headers) return null;
    if (typeof headers.get === "function") return headers.get(name);
    if (Array.isArray(headers)) {
      for (const entry of headers) {
        if (Array.isArray(entry) && String(entry[0]).toLowerCase() === name) return String(entry[1]);
      }
      return null;
    }
    if (typeof headers === "object") {
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === name) return String(headers[key]);
      }
    }
    return null;
  }

  function isStreamBody(body) {
    return Boolean(body) && typeof body === "object" && typeof body.getReader === "function";
  }

  function concatChunks(host, chunks, size) {
    const bytes = new host.Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  function startsWithJson(head) {
    // A JSON body always opens with "{". Anything else (an SSE "data:" frame, a
    // protobuf/octet-stream payload, HTML) is streamed through untouched, so
    // long-lived event streams never get buffered behind this hook.
    for (const byte of head) {
      if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
      return byte === 0x7b || byte === 0x5b;
    }
    return true;
  }

  function rewriteStream(host, body, url) {
    const decoder = new host.TextDecoder();
    const encoder = new host.TextEncoder();
    return new host.ReadableStream({
      async start(controller) {
        const reader = body.getReader();
        const forward = async () => {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) return;
            if (value) controller.enqueue(value);
          }
        };
        let first;
        try {
          first = await reader.read();
        } catch {
          controller.close();
          return;
        }
        if (first.done) {
          controller.close();
          return;
        }
        const head = first.value || new host.Uint8Array(0);
        if (!startsWithJson(head)) {
          controller.enqueue(head);
          await forward();
          controller.close();
          return;
        }
        const chunks = [head];
        let size = head.byteLength;
        let overflow = false;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          chunks.push(value);
          size += value.byteLength;
          if (size > MAX_INSPECT_BYTES) overflow = true;
        }
        const bytes = concatChunks(host, chunks, size);
        let outcome = null;
        if (!overflow) {
          try {
            outcome = rewriteJsonText(decoder.decode(bytes));
          } catch {
            outcome = null;
          }
        }
        if (!outcome) {
          controller.enqueue(bytes);
          controller.close();
          return;
        }
        record(outcome, url, "response");
        controller.enqueue(encoder.encode(outcome.text));
        controller.close();
      },
    });
  }

  function patchResponse(host) {
    const Original = host.Response;
    if (typeof Original !== "function") return false;
    if (Original[WRAPPER_FLAG] === true) return true;
    const Patched = new Proxy(Original, {
      construct(target, args) {
        let [body, init] = args;
        try {
          const contentType = readHeader(init && init.headers, "content-type");
          if (isStreamBody(body) && (contentType === null || /json/i.test(contentType))) {
            stats.inspected += 1;
            body = rewriteStream(host, body, null);
            args = [body, init];
          }
        } catch {
          stats.errors += 1;
        }
        return Reflect.construct(target, args);
      },
    });
    Object.defineProperty(Original, WRAPPER_FLAG, { value: true });
    return assign(host, "Response", Patched);
  }

  function copyHeaders(host, headers) {
    const Headers = host.Headers;
    if (typeof Headers !== "function") return headers;
    const copy = new Headers();
    headers.forEach((value, key) => {
      const lower = String(key).toLowerCase();
      if (lower === "content-length" || lower === "content-encoding") return;
      copy.set(key, value);
    });
    return copy;
  }

  function shadowBody(host, response, text) {
    const write = (name, value) => Object.defineProperty(response, name, {
      configurable: true,
      writable: true,
      value,
    });
    try {
      write("text", () => Promise.resolve(text));
      write("json", () => Promise.resolve(JSON.parse(text)));
      if (typeof response.arrayBuffer === "function") {
        write("arrayBuffer", () => Promise.resolve(new host.TextEncoder().encode(text).buffer));
      }
      return response;
    } catch {
      const Response = host.Response;
      if (typeof Response !== "function") return null;
      try {
        return new Response(text, {
          status: response.status,
          statusText: response.statusText,
          headers: copyHeaders(host, response.headers),
        });
      } catch {
        return null;
      }
    }
  }

  function rewriteResponse(host, response, url) {
    return Promise.resolve().then(() => {
      if (!response || typeof response.clone !== "function") return null;
      if (response.type === "opaque" || response.type === "opaqueredirect") return null;
      if (response.status === 204 || response.status === 304) return null;
      const headers = response.headers;
      if (!headers || typeof headers.get !== "function") return null;
      const contentType = String(headers.get("content-type") || "");
      if (contentType && !/json/i.test(contentType)) return null;
      const declared = headers.get("content-length");
      if (declared && Number(declared) > MAX_INSPECT_BYTES) return null;
      stats.inspected += 1;
      return response.clone().text().then((text) => {
        const outcome = rewriteJsonText(text);
        if (!outcome) return null;
        const rewritten = shadowBody(host, response, outcome.text);
        if (!rewritten) return null;
        record(outcome, url, "fetch");
        return rewritten;
      });
    });
  }

  function patchFetch(host) {
    const current = host.fetch;
    if (typeof current !== "function") return false;
    if (current[WRAPPER_FLAG] === true) return true;
    const wrapped = function (input) {
      let url = null;
      if (typeof input === "string") url = input;
      else if (input && typeof input.url === "string") url = input.url;
      const pending = current.apply(this, arguments);
      if (!pending || typeof pending.then !== "function") return pending;
      return pending.then((response) => {
        if (!response || typeof response.clone !== "function") return response;
        return rewriteResponse(host, response, url)
          .then((rewritten) => rewritten || response)
          .catch(() => {
            stats.errors += 1;
            return response;
          });
      });
    };
    Object.defineProperty(wrapped, WRAPPER_FLAG, { value: true });
    return assign(host, "fetch", wrapped);
  }

  function patchXhr(host) {
    const Xhr = host.XMLHttpRequest;
    if (typeof Xhr !== "function" || !Xhr.prototype) return false;
    const proto = Xhr.prototype;
    if (proto[WRAPPER_FLAG] === true) return true;
    const originalOpen = proto.open;
    const originalSend = proto.send;
    if (typeof originalOpen !== "function" || typeof originalSend !== "function") return false;

    proto.open = function (method, url) {
      try {
        Object.defineProperty(this, "__codexQuotaNetUrl", {
          configurable: true,
          writable: true,
          value: typeof url === "string" ? url : null,
        });
      } catch {}
      return originalOpen.apply(this, arguments);
    };

    proto.send = function () {
      try {
        this.addEventListener("loadend", () => {
          try {
            const url = this.__codexQuotaNetUrl ?? null;
            const responseType = this.responseType;
            if (responseType === "" || responseType === "text") {
              stats.inspected += 1;
              const outcome = rewriteJsonText(this.responseText);
              if (!outcome) return;
              const text = outcome.text;
              Object.defineProperty(this, "responseText", { configurable: true, get: () => text });
              if (responseType === "") {
                Object.defineProperty(this, "response", { configurable: true, get: () => text });
              }
              record(outcome, url, "xhr");
              return;
            }
            if (responseType === "json") {
              stats.inspected += 1;
              const value = this.response;
              if (value === null || typeof value !== "object") return;
              const report = rewritePayload(value);
              if (!report.changed) return;
              record({ report }, url, "xhr");
            }
          } catch {
            stats.errors += 1;
          }
        });
      } catch {}
      return originalSend.apply(this, arguments);
    };

    Object.defineProperty(proto, WRAPPER_FLAG, { value: true });
    return true;
  }

  // ---- react-query publication hook -------------------------------------
  // /wham/usage reaches the composer over two transports: polling (GET
  // /wham/usage) and a push channel. Both publish through TanStack Query, so
  // hooking the publication point rewrites the payload whatever the transport
  // is, and also repairs usage data that was cached before this patch attached.
  const RATE_LIMIT_KEY = "rate-limit-status";

  function isRateLimitQueryKey(key) {
    if (!Array.isArray(key)) return false;
    const head = String(key[0] || "");
    if (head !== RATE_LIMIT_KEY && head !== `${RATE_LIMIT_KEY}-pending`) return false;
    return key[1] !== "image-generation";
  }

  function looksLikeQueryClient(value) {
    return Boolean(value)
      && typeof value.getQueryCache === "function"
      && typeof value.setQueryData === "function";
  }

  function queryClientFromFiber(start) {
    const seen = new Set();
    const stack = [start];
    let visited = 0;
    while (stack.length > 0 && visited < 8000) {
      const node = stack.pop();
      if (!node || typeof node !== "object" || seen.has(node)) continue;
      seen.add(node);
      visited += 1;
      const props = node.memoizedProps || node.pendingProps;
      if (looksLikeQueryClient(props?.client)) return props.client;
      if (looksLikeQueryClient(props?.value)) return props.value;
      if (looksLikeQueryClient(node.stateNode)) return node.stateNode;
      const state = node.memoizedState;
      if (state && typeof state === "object" && looksLikeQueryClient(state.memoizedState)) return state.memoizedState;
      if (node.child) stack.push(node.child);
      if (node.sibling) stack.push(node.sibling);
    }
    return null;
  }

  function findQueryClient(host) {
    const explicit = host.__REACT_QUERY_CLIENT__ || host.__codexQueryClient;
    if (looksLikeQueryClient(explicit)) return explicit;
    const doc = host.document;
    if (!doc) return null;
    const roots = [doc.getElementById?.("root"), doc.body, doc.documentElement].filter(Boolean);
    for (const root of roots) {
      let key = "";
      try {
        key = Object.keys(root).find((name) => name.startsWith("__reactContainer$") || name.startsWith("__reactFiber$")) || "";
      } catch {
        key = "";
      }
      if (!key) continue;
      let fiber = root[key];
      if (fiber?.stateNode?.current) fiber = fiber.stateNode.current;
      const client = queryClientFromFiber(fiber);
      if (client) return client;
    }
    return null;
  }

  function rewriteQueryData(data) {
    if (data === null || typeof data !== "object") return data;
    const report = rewritePayload(data);
    if (report.changed) record({ report }, RATE_LIMIT_KEY, "query");
    return data;
  }

  function rewriteCachedQueries(client, cache) {
    if (!cache || typeof cache.findAll !== "function") return false;
    let queries = [];
    try {
      queries = cache.findAll({ queryKey: [RATE_LIMIT_KEY] });
    } catch {
      queries = [];
    }
    let changed = false;
    for (const query of queries) {
      if (!isRateLimitQueryKey(query?.queryKey)) continue;
      const data = query.state?.data;
      if (data === null || typeof data !== "object") continue;
      const report = rewritePayload(data);
      if (!report.changed) continue;
      record({ report }, RATE_LIMIT_KEY, "query");
      changed = true;
    }
    if (changed && typeof client.invalidateQueries === "function") {
      // Subscribers already rendered the blocked snapshot; a refetch repaints
      // it from a payload this patch has rewritten.
      try {
        client.invalidateQueries({ queryKey: [RATE_LIMIT_KEY] });
      } catch {}
    }
    return changed;
  }

  function patchQueryClient(client) {
    let patched = false;
    const cache = typeof client.getQueryCache === "function" ? client.getQueryCache() : null;
    if (cache) {
      const listed = typeof cache.getAll === "function"
        ? cache.getAll()
        : (typeof cache.findAll === "function" ? cache.findAll({ queryKey: [RATE_LIMIT_KEY] }) : []);
      const sample = listed.find((item) => typeof Object.getPrototypeOf(item)?.setData === "function");
      if (sample) {
        const proto = Object.getPrototypeOf(sample);
        if (typeof proto.setData === "function" && proto.setData[WRAPPER_FLAG] === true) {
          patched = true;
        } else if (typeof proto.setData === "function") {
          const original = proto.setData;
          const wrapped = function (data, ...rest) {
            if (isRateLimitQueryKey(this?.queryKey)) rewriteQueryData(data);
            return original.call(this, data, ...rest);
          };
          Object.defineProperty(wrapped, WRAPPER_FLAG, { value: true });
          proto.setData = wrapped;
          patched = true;
        }
      }
    }
    if (typeof client.setQueryData === "function" && client.setQueryData[WRAPPER_FLAG] !== true
      && (!patched || typeof Object.getPrototypeOf(client).setQueryData !== "function")) {
      const original = client.setQueryData;
      const wrapped = function (queryKey, updater, ...rest) {
        const next = typeof updater === "function"
          ? (previous) => rewriteQueryData(updater(previous))
          : rewriteQueryData(updater);
        return original.call(this, queryKey, next, ...rest);
      };
      Object.defineProperty(wrapped, WRAPPER_FLAG, { value: true });
      client.setQueryData = wrapped;
    }
    if (cache && typeof cache.subscribe === "function" && cache[WRAPPER_FLAG] !== true) {
      Object.defineProperty(cache, WRAPPER_FLAG, { value: true, configurable: true });
      cache.subscribe((event) => {
        const query = event?.query;
        if (!query || !isRateLimitQueryKey(query.queryKey)) return;
        rewriteQueryData(query.state?.data);
      });
    }
    if (patched) rewriteCachedQueries(client, cache);
    return patched;
  }

  function attachQueryClient(host) {
    if (stats.queryPatched) return true;
    const client = findQueryClient(host);
    if (!client) return false;
    if (patchQueryClient(client)) stats.queryPatched = true;
    return stats.queryPatched;
  }

  function startQueryWatch(host) {
    if (host.__codexQuotaNetQueryWatch) return;
    const schedule = typeof host.setInterval === "function" ? host.setInterval.bind(host) : null;
    const cancel = typeof host.clearInterval === "function" ? host.clearInterval.bind(host) : null;
    if (!schedule || !cancel) {
      attachQueryClient(host);
      return;
    }
    let attempts = 0;
    const stop = () => {
      if (host.__codexQuotaNetQueryWatch !== null && host.__codexQuotaNetQueryWatch !== undefined) {
        cancel(host.__codexQuotaNetQueryWatch);
      }
      host.__codexQuotaNetQueryWatch = null;
    };
    const tick = () => {
      attempts += 1;
      if (attachQueryClient(host) || attempts > 80) stop();
    };
    host.__codexQuotaNetQueryWatch = schedule(tick, 1500);
    tick();
  }

  function install(host) {
    const target = host || globalThis;
    const existing = target.__codexExternalQuotaNet;
    if (existing && typeof existing.ensure === "function") {
      existing.ensure();
      return existing;
    }
    stats.responsePatched = patchResponse(target);
    stats.fetchPatched = patchFetch(target);
    stats.xhrPatched = patchXhr(target);
    startQueryWatch(target);
    const api = {
      version: VERSION,
      stats,
      rewritePayload,
      ensure() {
        stats.responsePatched = patchResponse(target);
        stats.fetchPatched = patchFetch(target);
        stats.xhrPatched = patchXhr(target);
        attachQueryClient(target);
        return {
          response: stats.responsePatched,
          fetch: stats.fetchPatched,
          xhr: stats.xhrPatched,
          query: stats.queryPatched,
        };
      },
      probe() {
        return {
          version: VERSION,
          responsePatched: stats.responsePatched,
          fetchPatched: stats.fetchPatched,
          xhrPatched: stats.xhrPatched,
          queryPatched: stats.queryPatched,
          rewrites: stats.rewrites,
          lastAt: stats.lastAt,
        };
      },
    };
    target.__codexExternalQuotaNet = api;
    target.__codexQuotaNetPatch = api;
    return api;
  }

  if (typeof module === "object" && module && module.exports) {
    module.exports = { version: VERSION, install, rewritePayload, rewriteJsonText, looksRelevant };
  } else {
    install(globalThis);
  }
})();
