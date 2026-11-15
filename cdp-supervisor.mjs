import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) result[key] = true;
    else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

let atomicSequence = 0;

function writeJsonAtomic(filePath, value) {
  if (!filePath) return;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // Unique temp name: several targets report concurrently, and a fixed
    // `${pid}.tmp` name lets one writer delete another writer's rename source.
    const temp = `${filePath}.${process.pid}.${atomicSequence += 1}.tmp`;
    try {
      fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      fs.rmSync(filePath, { force: true });
      fs.renameSync(temp, filePath);
    } finally {
      fs.rmSync(temp, { force: true });
    }
  } catch (error) {
    // Never let a transient filesystem error (e.g. ENOSPC) kill supervision;
    // the previously published status stays readable for the launcher.
    process.stderr.write(`[status-write] ${error?.message || error}\n`);
  }
}

function status(state, extra = {}) {
  writeJsonAtomic(args.status, {
    state,
    pid: process.pid,
    updatedAt: new Date().toISOString(),
    ...extra,
  });
}

function validatePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid CDP port: ${value}`);
  }
  return port;
}

function validateWebSocketUrl(value, expectedPort) {
  const parsed = new URL(value);
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(`unexpected websocket scheme: ${parsed.protocol}`);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error(`CDP websocket is not loopback-only: ${parsed.hostname}`);
  }
  if (Number(parsed.port) !== expectedPort) {
    throw new Error(`CDP websocket port mismatch: ${parsed.port}`);
  }
  return parsed.toString();
}

async function fetchJson(url, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function targetRank(target) {
  if (target?.type !== "page") return -1;
  const url = String(target.url || "");
  if (url === "app://-/index.html") return 100;
  if (url.startsWith("app://")) return 80;
  return -1;
}

// Return EVERY patchable app:// page target, not just the highest-ranked one.
// Codex Desktop creates a separate BrowserWindow (and therefore a separate CDP
// page target + separate React Query cache) for the global-hotkey "small window"
// and for detached windows. Patching only one target leaves those windows with
// the untouched rate-limit payload, so the composer stays locked there.
async function discoverTargets(port) {
  let targets;
  try {
    targets = await fetchJson(`http://127.0.0.1:${port}/json`);
  } catch (firstError) {
    try {
      targets = await fetchJson(`http://[::1]:${port}/json`);
    } catch {
      throw firstError;
    }
  }
  if (!Array.isArray(targets)) throw new Error("CDP target list is not an array");
  const ranked = targets
    .map((target) => ({ target, rank: targetRank(target) }))
    .filter((entry) => entry.rank >= 0 && entry.target.webSocketDebuggerUrl)
    .sort((left, right) => right.rank - left.rank);
  return ranked.flatMap(({ target, rank }) => {
    try {
      return [{
        ...target,
        rank,
        webSocketDebuggerUrl: validateWebSocketUrl(target.webSocketDebuggerUrl, port),
      }];
    } catch (error) {
      // One malformed websocket URL must not block injection into every other
      // window (they have separate quota state and would stay locked).
      process.stderr.write(`[skip ${target.id}] ${error?.message || error}\n`);
      return [];
    }
  });
}

class CdpSession {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.eventHandlers = new Map();
  }

  async connect(timeoutMs = 5000) {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      const timer = setTimeout(() => {
        try { this.socket?.close(); } catch {}
        finish(reject, new Error("CDP websocket open timed out"));
      }, timeoutMs);
      this.socket.addEventListener("open", () => finish(resolve), { once: true });
      this.socket.addEventListener("error", () => {
        try { this.socket?.close(); } catch {}
        finish(reject, new Error("CDP websocket failed to open"));
      }, { once: true });
    });
    this.socket.addEventListener("message", (event) => void this.onMessage(event.data));
    this.socket.addEventListener("close", () => this.rejectPending(new Error("CDP websocket closed")));
  }

  async onMessage(data) {
    let text;
    if (typeof data === "string") text = data;
    else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString("utf8");
    else if (ArrayBuffer.isView(data)) text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
    else if (typeof data?.text === "function") text = await data.text();
    else return;

    let message;
    try { message = JSON.parse(text); } catch { return; }
    if (!message.id) {
      if (message.method) {
        for (const handler of this.eventHandlers.get(message.method) || []) {
          try { handler(message.params || {}); } catch {}
        }
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
    else pending.resolve(message.result || {});
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  send(method, params = {}, timeoutMs = 7000) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP websocket is not open"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, handler) {
    if (!this.eventHandlers.has(method)) this.eventHandlers.set(method, new Set());
    this.eventHandlers.get(method).add(handler);
    return () => this.eventHandlers.get(method)?.delete(handler);
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error("renderer evaluation failed");
    return result.result?.value;
  }

  close() {
    try { this.socket?.close(); } catch {}
  }
}

function buildBootstrap(location, bundleUrl) {
  const serializedLocation = JSON.stringify({ ...location, condition: location.condition });
  const serializedBundleUrl = JSON.stringify(bundleUrl);
  return `(() => {
    globalThis.__codexInputUnlockState = {
      status: "located",
      bundleUrl: ${serializedBundleUrl},
      breakpoint: ${serializedLocation},
    };
    globalThis.__codexExternalPatchState = globalThis.__codexInputUnlockState;
  })();`;
}

async function installScripts(session, combinedSource) {
  await session.send("Runtime.enable");
  await session.send("Page.enable");
  let installed;
  try {
    installed = await session.send("Page.addScriptToEvaluateOnNewDocument", { source: combinedSource, runImmediately: true });
  } catch {
    installed = await session.send("Page.addScriptToEvaluateOnNewDocument", { source: combinedSource });
  }
  await session.evaluate(combinedSource);
  const verified = await session.evaluate("Boolean(globalThis.__codexExternalQuotaGate && (globalThis.__codexInputUnlockState?.breakpoint || globalThis.__codexExternalPatchState?.breakpoint))");
  if (verified !== true) throw new Error("renderer runtime injection did not verify");
  return installed.identifier || null;
}

async function installNetPatch(session, source) {
  await session.send("Runtime.enable");
  await session.send("Page.enable");
  let installed;
  try {
    installed = await session.send("Page.addScriptToEvaluateOnNewDocument", { source, runImmediately: true });
  } catch {
    installed = await session.send("Page.addScriptToEvaluateOnNewDocument", { source });
  }
  await session.evaluate(source);
  const probe = await session.evaluate(
    "(() => { const net = globalThis.__codexExternalQuotaNet; if (!net || typeof net.ensure !== 'function') return null; net.ensure(); return net.probe(); })()",
  );
  if (!probe || (probe.responsePatched !== true && probe.fetchPatched !== true && probe.xhrPatched !== true)) {
    throw new Error("renderer network patch did not verify");
  }
  return { identifier: installed?.identifier || null, probe };
}

async function netProbe(session) {
  return session.evaluate(
    "(() => { const net = globalThis.__codexExternalQuotaNet; if (!net || typeof net.ensure !== 'function') return null; net.ensure(); const gate = globalThis.__codexExternalQuotaGate; const state = globalThis.__codexInputUnlockState ?? globalThis.__codexExternalPatchState ?? null; return { net: { active: true, stats: net.stats, probe: net.probe() }, gate: gate ? { breakpoint: state?.breakpoint ?? null, stats: gate.stats ?? null } : null }; })()",
  );
}

async function armLegacyGate(session, gateSource, gateApi, timeoutMs) {
  const script = await waitForQuotaScript(session, gateApi, timeoutMs);
  const primary = script.breakpoints[0];
  const bootstrap = buildBootstrap({ ...primary.location, condition: primary.condition }, script.url);
  const documentScriptId = await installScripts(session, `${gateSource}\n${bootstrap}`);
  const armed = [];
  for (const candidate of script.breakpoints) {
    try {
      const actualLocation = await resolveBreakpointLocation(session, script.scriptId, candidate.location);
      const breakpoint = await session.send("Debugger.setBreakpoint", {
        location: actualLocation,
        condition: candidate.condition,
      });
      if (!breakpoint.breakpointId || !breakpoint.actualLocation) continue;
      armed.push({
        mode: candidate.location.mode,
        breakpointId: breakpoint.breakpointId,
        requestedLocation: {
          lineNumber: candidate.location.lineNumber,
          columnNumber: candidate.location.columnNumber,
        },
        actualLocation: breakpoint.actualLocation,
      });
    } catch (error) {
      process.stderr.write(`[skip-breakpoint] ${candidate.location.mode}: ${error.message}\n`);
    }
  }
  if (armed.length === 0) throw new Error("Debugger.setBreakpoint did not resolve an actual location");
  return { scriptId: script.scriptId, url: script.url, documentScriptId, breakpoints: armed };
}

function isCandidateScriptUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "app:" && parsed.pathname.endsWith(".js");
  } catch {
    return false;
  }
}

async function waitForQuotaScript(session, gateApi, timeoutMs = 20000) {
  let removeHandler = null;
  let settled = false;
  let parsedScripts = 0;
  let candidateScripts = 0;
  let lastProbe = null;
  try {
    const scriptPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const detail = JSON.stringify({ parsedScripts, candidateScripts, lastProbe });
        reject(new Error(`quota bundle discovery timed out (${detail})`));
      }, timeoutMs);
      removeHandler = session.on("Debugger.scriptParsed", (params) => {
        parsedScripts += 1;
        if (settled || !params.scriptId || !isCandidateScriptUrl(params.url)) return;
        candidateScripts += 1;
        void (async () => {
          try {
            const sourceResult = await session.send("Debugger.getScriptSource", { scriptId: params.scriptId }, 15000);
            const source = sourceResult.scriptSource;
            if (typeof source !== "string" || source.length === 0) return;
            let breakpoints = [];
            if (typeof gateApi.locateAll === "function") {
              breakpoints = gateApi.locateAll(source, params.url).slice(0, 4);
            } else {
              const location = gateApi.locate(source, params.url);
              const condition = gateApi.condition(location);
              if (location && condition) breakpoints = [{ location, condition }];
            }
            if (breakpoints.length === 0) {
              if (typeof gateApi.explain === "function") {
                try { lastProbe = { url: params.url, ...gateApi.explain(source, params.url) }; } catch {}
              }
              return;
            }
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ scriptId: params.scriptId, url: params.url, breakpoints });
          } catch {}
        })();
      });
    });
    await session.send("Debugger.enable", {}, timeoutMs);
    return await scriptPromise;
  } finally {
    removeHandler?.();
  }
}

async function resolveBreakpointLocation(session, scriptId, desired) {
  if (Number.isInteger(desired.endLineNumber) && Number.isInteger(desired.endColumnNumber)) {
    const start = {
      scriptId,
      lineNumber: desired.lineNumber,
      columnNumber: desired.columnNumber,
    };
    const end = {
      scriptId,
      lineNumber: desired.endLineNumber,
      columnNumber: desired.endColumnNumber,
    };
    const result = await session.send("Debugger.getPossibleBreakpoints", { start, end, restrictToFunction: true });
    const candidates = (result.locations || [])
      .filter((item) => {
        if (item.scriptId !== scriptId) return false;
        if (item.lineNumber < start.lineNumber || item.lineNumber > end.lineNumber) return false;
        if (item.lineNumber === start.lineNumber && item.columnNumber < start.columnNumber) return false;
        if (item.lineNumber === end.lineNumber && item.columnNumber > end.columnNumber) return false;
        return true;
      })
      .sort((left, right) => left.lineNumber - right.lineNumber || left.columnNumber - right.columnNumber);
    if (candidates.length > 0) return candidates[0];
    throw new Error(
      `no executable breakpoint inside quota expression ${start.lineNumber}:${start.columnNumber}-${end.lineNumber}:${end.columnNumber}`,
    );
  }
  for (const radius of [300, 2000]) {
    const start = {
      scriptId,
      lineNumber: desired.lineNumber,
      columnNumber: Math.max(0, desired.columnNumber - 100),
    };
    const end = {
      scriptId,
      lineNumber: desired.lineNumber,
      columnNumber: desired.columnNumber + radius,
    };
    const result = await session.send("Debugger.getPossibleBreakpoints", { start, end, restrictToFunction: true });
    const candidates = (result.locations || [])
      .filter((item) => item.scriptId === scriptId && item.lineNumber === desired.lineNumber && item.columnNumber >= desired.columnNumber)
      .sort((left, right) => left.columnNumber - right.columnNumber);
    if (candidates.length > 0) return candidates[0];
  }
  throw new Error(`no executable breakpoint location at or after ${desired.lineNumber}:${desired.columnNumber}`);
}

async function superviseTarget(target, options) {
  const { patchSource, gateSource, gateApi, legacyGate, legacyTimeoutMs, port, onReady, onStatus, shouldStop } = options;
  const report = typeof onStatus === "function" ? onStatus : status;
  const session = new CdpSession(target.webSocketDebuggerUrl);
  const armedBreakpoints = [];
  const documentScriptIds = [];
  let removeReloadHandler = null;
  try {
    await session.connect();
    let netPatchProbe = null;
    if (patchSource) {
      const installed = await installNetPatch(session, patchSource);
      if (installed.identifier) documentScriptIds.push(installed.identifier);
      netPatchProbe = installed.probe;
    }
    const readyDetails = {
      port,
      targetId: target.id,
      targetUrl: target.url,
      mode: patchSource ? "network-rewrite" : "breakpoint",
      netPatch: netPatchProbe,
      breakpoints: [],
      legacyGate: null,
    };
    if (legacyGate && gateSource && gateApi) {
      try {
        const legacy = await armLegacyGate(session, gateSource, gateApi, legacyTimeoutMs);
        if (legacy.documentScriptId) documentScriptIds.push(legacy.documentScriptId);
        armedBreakpoints.push(...legacy.breakpoints);
        readyDetails.breakpoints = legacy.breakpoints;
        readyDetails.legacyGate = {
          bundleUrl: legacy.url,
          breakpointId: legacy.breakpoints[0].breakpointId,
          modes: legacy.breakpoints.map((breakpoint) => breakpoint.mode),
        };
      } catch (error) {
        readyDetails.legacyGate = { error: error.message };
        process.stderr.write(`[legacy-gate] ${error.message}\n`);
      }
    }
    if (!patchSource && armedBreakpoints.length === 0) {
      throw new Error(readyDetails.legacyGate?.error || "no unlock mechanism became active");
    }
    report("ready", readyDetails);
    onReady?.();

    let reloadDetected = false;
    removeReloadHandler = session.on("Runtime.executionContextsCleared", () => { reloadDetected = true; });
    while (true) {
      await sleep(2000);
      if (shouldStop?.()) return;
      if (reloadDetected) return;
      const probe = await netProbe(session);
      if (patchSource && probe?.net?.active !== true) return;
      if (!patchSource && !probe?.gate?.breakpoint) return;
      report("ready", {
        ...readyDetails,
        netPatch: probe?.net?.probe ?? readyDetails.netPatch,
        netStats: probe?.net?.stats ?? null,
        gateStats: probe?.gate?.stats ?? null,
      });
    }
  } finally {
    removeReloadHandler?.();
    for (const armed of armedBreakpoints) {
      try { await session.send("Debugger.removeBreakpoint", { breakpointId: armed.breakpointId }, 2000); } catch {}
    }
    for (const identifier of documentScriptIds) {
      try {
        await session.send("Page.removeScriptToEvaluateOnNewDocument", { identifier }, 2000);
      } catch {}
    }
    session.close();
  }
}

async function selfTest() {
  const gatePath = path.resolve(String(args.gate || ""));
  const bundlePath = path.resolve(String(args.bundle || ""));
  if (!fs.existsSync(gatePath)) throw new Error(`gate file missing: ${gatePath}`);
  if (!fs.existsSync(bundlePath)) throw new Error(`bundle file missing: ${bundlePath}`);
  delete require.cache[gatePath];
  const gate = require(gatePath);
  const source = fs.readFileSync(bundlePath, "utf8");
  const sourceUrl = `app://-/assets/${path.basename(bundlePath)}`;
  const location = gate.locate(source, sourceUrl);
  const condition = gate.condition(location);
  const explain = typeof gate.explain === "function" ? gate.explain(source, sourceUrl) : null;
  if (!location || !condition) {
    throw new Error(`quota gate did not uniquely locate the current bundle: ${JSON.stringify(explain)}`);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, location, condition, explain })}\n`);
}

async function selfTestNet() {
  const patchPath = path.resolve(String(args["net-patch"] || ""));
  if (!fs.existsSync(patchPath)) throw new Error(`net patch file missing: ${patchPath}`);
  const source = fs.readFileSync(patchPath, "utf8");
  if (!source.includes("__codexExternalQuotaNet")) throw new Error("net patch source does not expose __codexExternalQuotaNet");
  delete require.cache[patchPath];
  const patch = require(patchPath);
  const payload = {
    rate_limit: { allowed: false, limit_reached: true },
    rate_limit_reached_type: "primary_window",
    additional_rate_limits: [{ limit_name: "gpt-reserve", rate_limit: { allowed: false } }],
    blocked_features: [{ feature_name: "tpp_send" }, { feature_name: "image_gen" }],
    model_picker_upsell: { banner_type: "limit_reached" },
    premium_exhausted_at: "2026-01-01T00:00:00.000Z",
  };
  const report = patch.rewritePayload(payload);
  if (!report?.changed) throw new Error("net patch did not rewrite a blocked usage payload");
  if (payload.rate_limit.allowed !== true || payload.rate_limit.limit_reached !== false) {
    throw new Error("net patch left the primary quota block in place");
  }
  if (payload.rate_limit_reached_type !== null) throw new Error("net patch left rate_limit_reached_type set");
  if (payload.model_picker_upsell !== null) throw new Error("net patch left model_picker_upsell set");
  if (payload.additional_rate_limits[0].rate_limit.allowed !== true) {
    throw new Error("net patch left an additional quota block in place");
  }
  if (!Array.isArray(payload.blocked_features) || payload.blocked_features.length !== 1) {
    throw new Error("net patch did not clear the send block from blocked_features");
  }
  if (payload.blocked_features[0].feature_name !== "image_gen") {
    throw new Error("net patch dropped an image generation block it must leave alone");
  }
  if (payload.premium_exhausted_at !== null) throw new Error("net patch did not clear premium_exhausted_at");
  if (patch.rewriteJsonText(JSON.stringify({ message: "ok" })) !== null) {
    throw new Error("net patch rewrote an unrelated payload");
  }
  const host = {
    Response: globalThis.Response,
    Headers: globalThis.Headers,
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
    ReadableStream: globalThis.ReadableStream,
    Uint8Array: globalThis.Uint8Array,
    fetch: null,
  };
  const instance = patch.install(host);
  if (instance.probe().responsePatched !== true) {
    throw new Error("net patch did not hook the Response constructor");
  }
  const stream = new globalThis.ReadableStream({
    start(controller) {
      controller.enqueue(new globalThis.TextEncoder().encode(JSON.stringify({
        rate_limit: { allowed: false, limit_reached: true },
        blocked_features: [{ feature_name: "tpp_send" }],
      })));
      controller.close();
    },
  });
  const streamed = new host.Response(stream, { status: 200, headers: { "content-type": "application/json" } });
  const streamedBody = await streamed.json();
  if (streamedBody?.rate_limit?.allowed !== true || streamedBody?.blocked_features?.length !== 0) {
    throw new Error("net patch did not rewrite a streamed JSON response");
  }
  if (!(streamed instanceof globalThis.Response)) throw new Error("patched Response broke instanceof checks");
  const sseFrame = 'data: {"rate_limit":{"allowed":false}}\n\n';
  const sseStream = new globalThis.ReadableStream({
    start(controller) {
      controller.enqueue(new globalThis.TextEncoder().encode(sseFrame));
      controller.close();
    },
  });
  const sseResponse = new host.Response(sseStream, { status: 200, headers: {} });
  if (await sseResponse.text() !== sseFrame) {
    throw new Error("net patch buffered or rewrote an event stream");
  }
  function FakeQuery(queryKey) {
    this.queryKey = queryKey;
    this.state = { data: null };
  }
  FakeQuery.prototype.setData = function setData(data) {
    this.state.data = data;
    return data;
  };
  const query = new FakeQuery(["rate-limit-status", "user", "account"]);
  const fakeClient = {
    getQueryCache: () => ({
      getAll: () => [query],
      findAll: () => [query],
      subscribe: () => {},
    }),
    setQueryData: (queryKey, data) => query.setData(data),
  };
  const queryHost = {
    Response: globalThis.Response,
    Headers: globalThis.Headers,
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
    ReadableStream: globalThis.ReadableStream,
    Uint8Array: globalThis.Uint8Array,
    __REACT_QUERY_CLIENT__: fakeClient,
  };
  const queryApi = patch.install(queryHost);
  if (queryApi.probe().queryPatched !== true) {
    throw new Error("net patch did not hook the react-query publication point");
  }
  query.setData({ rate_limit: { allowed: false, limit_reached: true } });
  if (query.state.data?.rate_limit?.allowed !== true) {
    throw new Error("net patch did not rewrite published usage data");
  }
  if (query.state.data?.rate_limit?.limit_reached !== false) {
    throw new Error("net patch left limit_reached set on published usage data");
  }
  process.stdout.write(`${JSON.stringify({ ok: true, report, payload, transports: instance.stats.byTransport })}\n`);
}

async function main() {
  if (args["self-test"]) {
    await selfTest();
    return;
  }
  if (args["self-test-net"]) {
    await selfTestNet();
    return;
  }

  const port = validatePort(args.port);
  if (!args.status) throw new Error("--status is required");
  const patchPath = args["net-patch"] ? path.resolve(String(args["net-patch"])) : null;
  const gatePath = args.gate ? path.resolve(String(args.gate)) : null;
  if (!patchPath && !gatePath) throw new Error("--net-patch or --gate is required");
  const patchSource = patchPath ? fs.readFileSync(patchPath, "utf8") : null;
  let gateSource = null;
  let gateApi = null;
  if (gatePath) {
    gateSource = fs.readFileSync(gatePath, "utf8");
    delete require.cache[gatePath];
    gateApi = require(gatePath);
  }
  const legacyGate = Boolean(args["legacy-gate"]) && Boolean(gateApi);
  if (Boolean(args["legacy-gate"]) && !gateApi) {
    process.stderr.write("[legacy-gate] ignored: --legacy-gate needs --gate\n");
  }
  const startupTimeoutMs = Number(args["startup-timeout"] || 60) * 1000;
  const legacyTimeoutMs = Number(args["legacy-timeout"] || 8) * 1000;
  const deadline = Date.now() + startupTimeoutMs;
  const pollIntervalMs = Number(args["poll-interval"] || 1000);
  const vanishGraceMs = 20000;
  let everReady = false;
  let missingSince = null;
  let lastRetryError = null;
  status("waiting-for-codex", { port });

  // Codex Desktop gives every BrowserWindow its own webContents, its own React
  // root and its own TanStack Query cache. The global-hotkey "small window"
  // (Ctrl+Alt+C) and detached windows therefore each need an independent CDP
  // session with the network patch injected. A single-target supervisor leaves
  // those windows on the unmodified, quota-blocked payload.
  const workers = new Map();
  let lastPublishAt = 0;

  const publish = (force = false) => {
    const now = Date.now();
    // Several windows report every 2s; avoid hammering the disk with status
    // rewrites (a full disk previously killed this supervisor via ENOSPC).
    if (!force && now - lastPublishAt < 750) return;
    lastPublishAt = now;
    const records = [...workers.values()];
    const ready = records.filter((record) => record.state === "ready");
    const byRank = [...ready].sort((a, b) => (b.target.rank ?? 0) - (a.target.rank ?? 0));
    const primary = byRank[0] ?? records[0] ?? null;
    status(ready.length > 0 ? "ready" : (records.length > 0 ? "injecting" : "waiting-for-codex"), {
      port,
      // Keep the original single-target fields so the launcher and any existing
      // verification script can keep reading the primary window's numbers.
      targetId: primary?.target.id ?? null,
      targetUrl: primary?.target.url ?? null,
      mode: patchSource ? "network-rewrite" : "breakpoint",
      legacyGate,
      netPatch: primary?.details?.netPatch ?? null,
      netStats: primary?.details?.netStats ?? null,
      gateStats: primary?.details?.gateStats ?? null,
      breakpoints: primary?.details?.breakpoints ?? [],
      lastError: lastRetryError,
      targetCount: records.length,
      readyCount: ready.length,
      targets: records.map((record) => ({
        targetId: record.target.id,
        targetUrl: record.target.url,
        rank: record.target.rank,
        state: record.state,
        netPatch: record.details?.netPatch ?? null,
        netStats: record.details?.netStats ?? null,
        gateStats: record.details?.gateStats ?? null,
        error: record.error ?? null,
      })),
    });
  };

  while (true) {
    let targets;
    try {
      targets = await discoverTargets(port);
    } catch (error) {
      targets = null;
      lastRetryError = error?.message || String(error);
    }

    if (!targets || targets.length === 0) {
      if (!missingSince) missingSince = Date.now();
      if (!everReady && Date.now() >= deadline) {
        throw new Error(`Codex CDP startup timed out: ${lastRetryError || "Codex renderer target not found"}`);
      }
      if (everReady && Date.now() - missingSince > vanishGraceMs) return;
      publish();
      await sleep(500);
      continue;
    }
    missingSince = null;

    const liveIds = new Set(targets.map((target) => target.id));
    // A finished worker (page reload, lost execution context, injection error)
    // is dropped so the next poll attaches a fresh session to that target.
    for (const [id, record] of workers) {
      if (!liveIds.has(id) || record.done) {
        record.stop = true;
        workers.delete(id);
      }
    }

    for (const target of targets) {
      if (workers.has(target.id)) continue;
      const record = {
        target,
        state: "injecting",
        details: {},
        error: null,
        stop: false,
        done: false,
      };
      record.task = superviseTarget(target, {
        patchSource,
        gateSource,
        gateApi,
        legacyGate,
        legacyTimeoutMs,
        port,
        onReady: () => { everReady = true; },
        onStatus: (state, details) => {
          const becameReady = state === "ready" && record.state !== "ready";
          record.state = state;
          record.details = details;
          publish(becameReady);
        },
        shouldStop: () => record.stop,
      })
        .catch((error) => {
          record.error = error?.stack || error?.message || String(error);
          record.state = "retrying";
          lastRetryError = record.error;
          process.stderr.write(`[retry ${target.id}] ${record.error}\n`);
        })
        .finally(() => { record.done = true; });
      workers.set(target.id, record);
      process.stderr.write(`[attach] ${target.id} rank=${target.rank} ${target.url}\n`);
    }

    if (!everReady && Date.now() >= deadline) {
      throw new Error(`Codex CDP injection timed out: ${lastRetryError || "no target became ready"}`);
    }
    publish();
    await sleep(pollIntervalMs);
  }
}

main().catch((error) => {
  status("failed", { error: error?.stack || String(error) });
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
