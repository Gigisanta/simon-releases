"use strict";

// Offline policy/protocol-order regressions only. These do not start WebView2,
// install binaries, authenticate an account, contact a gateway or prove UI QA.
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { telemetrySource } = require("./windows-telemetry-guard.cjs");
const {
  checkTarget, RawCdp, proveAndArm, resumeGuardedScript, stopBeforeDetach,
} = require("./windows-cdp-guard.cjs");

const BOOT = "00000000-0000-4000-8000-000000000001";
const TRACKER = "https://simon.maat.work/api/telemetry/section-view";
const MARKER = 'window[Symbol.for("simon.qa.telemetry.guard.v1")]()';
function realm() {
  const calls = [];
  const nativeCalls = [];
  const fetchResult = { offline: "fetch-result" };
  const invokeResult = { offline: "invoke-result" };
  const context = vm.createContext({
    URL, Request, DOMException, location: { href: "https://tauri.localhost/" },
    fetch: function (...args) { calls.push({ self: this, args }); return Promise.resolve(fetchResult); },
    invokeStub: function (...args) { nativeCalls.push({ self: this, args }); return Promise.resolve(invokeResult); },
  });
  vm.runInContext("globalThis.window = globalThis", context);
  return { context, calls, nativeCalls, fetchResult, invokeResult };
}
function install(context) { return vm.runInContext(telemetrySource(BOOT), context); }
function snapshot(context) { return vm.runInContext(MARKER, context); }
function createBridge(context, style) {
  if (style === "assignment") {
    vm.runInContext("window.__TAURI_INTERNALS__ = {}; window.__TAURI_INTERNALS__.invoke = invokeStub", context);
  } else if (style === "reflect-definition") {
    vm.runInContext('Reflect.defineProperty(window, "__TAURI_INTERNALS__", { value: {} }); Reflect.defineProperty(window.__TAURI_INTERNALS__, "invoke", { value: invokeStub })', context);
  } else if (style === "multiple-definition") {
    vm.runInContext('Object.defineProperties(window, { __TAURI_INTERNALS__: { value: {} } }); Object.defineProperties(window.__TAURI_INTERNALS__, { invoke: { value: invokeStub } })', context);
  } else {
    // Matches creation followed by the readonly/nonconfigurable core invoke.
    vm.runInContext('Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {} }); Object.defineProperty(window.__TAURI_INTERNALS__, "invoke", { value: invokeStub })', context);
  }
}

test("fetch rejects only the exact tracker POST and delegates auth/chat/consent unchanged", async () => {
  const { context, calls, fetchResult } = realm();
  install(context);
  await assert.rejects(context.fetch(`${TRACKER}?offline=1`, { method: "post" }), { name: "AbortError" });
  await assert.rejects(context.fetch(new Request(TRACKER, { method: "POST" })), { name: "AbortError" });
  assert.equal(calls.length, 0);
  const unchanged = [
    ["https://simon.maat.work/api/auth/sign-in/email", { method: "POST", body: "offline-login-sentinel" }],
    ["https://simon.maat.work/api/chat", { method: "POST", body: "offline-chat-sentinel" }],
    ["https://simon.maat.work/api/user/ai-consent", { method: "GET" }],
    [TRACKER, { method: "GET" }],
    [`${TRACKER}-different`, { method: "POST" }],
    ["https://simon.maat.work.example.invalid/api/telemetry/section-view", { method: "POST" }],
  ];
  for (const [url, options] of unchanged) {
    assert.equal(await context.fetch(url, options), fetchResult);
    const seen = calls[calls.length - 1].args;
    assert.equal(seen[0], url);
    assert.equal(seen[1], options);
  }
  assert.equal(snapshot(context).fetchBlocked, 2);
  assert.equal(snapshot(context).invokeBlocked, 0);
  // Reinstalling on another script does not stack wrappers or reset counters.
  assert.equal(install(context).fetchBlocked, 2);
});

for (const style of ["assignment", "readonly-definition", "reflect-definition", "multiple-definition"]) {
  test(`Tauri ${style} blocks before Rust resource creation without changing other invokes`, async () => {
    const { context, nativeCalls, invokeResult } = realm();
    install(context);
    createBridge(context, style);
    assert.equal(snapshot(context).bridgeGuarded, true);
    const invoke = context.__TAURI_INTERNALS__.invoke;
    await assert.rejects(invoke("plugin:http|fetch", { clientConfig: { url: TRACKER, method: "POST" } }), { name: "AbortError" });
    assert.equal(nativeCalls.length, 0);
    const payloads = [
      ["plugin:http|fetch", { clientConfig: { url: "https://simon.maat.work/api/chat", method: "POST" } }],
      ["plugin:http|fetch", { clientConfig: { url: TRACKER, method: "GET" } }],
      ["plugin:http|fetch_send", { rid: 123 }],
      ["plugin:updater|check", { offline: true }],
      ["plugin:http|fetch", { clientConfig: { url: "https://simon.maat.work/api/user/ai-consent", method: "GET" } }],
    ];
    for (const [command, payload] of payloads) {
      const options = { offline: true };
      assert.equal(await invoke(command, payload, options), invokeResult);
      const args = nativeCalls[nativeCalls.length - 1].args;
      assert.equal(args[0], command);
      assert.equal(args[1], payload);
      assert.equal(args[2], options);
    }
    assert.equal(snapshot(context).invokeBlocked, 1);
    if (style === "readonly-definition") {
      const descriptor = Object.getOwnPropertyDescriptor(context.__TAURI_INTERNALS__, "invoke");
      assert.equal(descriptor.writable, false);
      assert.equal(descriptor.configurable, false);
    }
  });
}

test("a preexisting native bridge is tainted rather than silently patched late", () => {
  const { context } = realm();
  vm.runInContext("window.__TAURI_INTERNALS__ = { invoke: invokeStub }", context);
  assert.throws(() => install(context));
});

class ProtocolPeer extends EventTarget {
  constructor(options = {}) {
    super();
    this.options = options;
    this.readyState = WebSocket.OPEN;
    this.commands = [];
    this.evaluationId = null;
  }
  emit(message) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) })); }
  reply(id, result = {}) { this.emit({ id, result }); }
  send(raw) {
    const { id, method, params } = JSON.parse(raw);
    this.commands.push({ method, params });
    queueMicrotask(() => {
      if (method === "Debugger.enable" && Object.hasOwn(this.options, "oldScript")) {
        // Catch-up may contain a reserved-looking URL: it must still taint.
        this.emit({ method: "Debugger.scriptParsed", params: { scriptId: "old", url: this.options.oldScript } });
      }
      if (method === "Runtime.evaluate") {
        this.evaluationId = id;
        this.emit({ method: "Debugger.scriptParsed", params: { scriptId: "bootstrap", url: "simon-qa://before-first-script" } });
        if (this.options.earlyProduct) {
          this.emit({ method: "Debugger.scriptParsed", params: { scriptId: "product", url: "https://tauri.localhost/product.js" } });
        }
        if (!this.options.missingPause) {
          this.emit({ method: "Debugger.paused", params: {
            reason: "other", callFrames: [{ callFrameId: "bootstrap-frame", location: { scriptId: this.options.wrongPause ? "other" : "bootstrap" } }],
          } });
        }
        this.onBootstrap?.();
        return; // Bootstrap reply remains pending until the first safe resume.
      }
      if (method === "Debugger.evaluateOnCallFrame") {
        this.emit({ method: "Debugger.scriptParsed", params: { scriptId: "hook", url: "simon-qa://telemetry-guard" } });
        this.reply(id, { result: { value: {
          schema: "simon-telemetry-guard/v1", bootId: BOOT,
          fetchGuarded: !this.options.badHook, bridgeArmed: true, bridgeGuarded: false,
          fetchBlocked: 0, invokeBlocked: 0,
        } } });
        return;
      }
      if (method === "Debugger.setInstrumentationBreakpoint") { this.reply(id, { breakpointId: "instrumentation-id" }); return; }
      this.reply(id);
      if (method === "Debugger.resume" && this.evaluationId !== null) {
        this.reply(this.evaluationId, { result: { type: "undefined" } });
        this.evaluationId = null;
      }
    });
  }
  close() {
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}
async function protocol(options, action) {
  const socket = new ProtocolPeer(options);
  const cdp = await new RawCdp(socket, Date.now() + 1000).opened();
  if (options.missingPause) socket.onBootstrap = () => { cdp.deadline = Date.now() - 1; };
  try { return await action(cdp, socket); } finally { cdp.close(); }
}
function noResume(socket) {
  assert.equal(socket.commands.some(({ method }) => method === "Runtime.runIfWaitingForDebugger" || method === "Debugger.resume"), false);
}

test("first resume follows catch-up barrier, own buffered pause, hook ACK and future-document arm", async () => {
  await protocol({}, async (cdp, socket) => {
    const result = await proveAndArm(cdp, BOOT);
    await result.evaluation;
    assert.deepEqual(socket.commands.map(({ method }) => method), [
      "Debugger.enable", "Page.enable", "Page.getFrameTree", "Runtime.evaluate",
      "Debugger.evaluateOnCallFrame", "Page.addScriptToEvaluateOnNewDocument",
      "Debugger.setInstrumentationBreakpoint", "Runtime.runIfWaitingForDebugger", "Debugger.resume",
    ]);
    assert.equal(result.proof.preexistingParsedScripts, 0);
    assert.equal(result.proof.hookAcknowledgedBeforeResume, true);
    assert.equal(result.proof.pauseAcknowledged, "explicit-bootstrap-debugger-before-product-script");
  });
});

for (const oldScript of ["https://tauri.localhost/product.js", "", "simon-qa://before-first-script", "simon-qa://telemetry-guard"]) {
  test(`scriptParsed catch-up cannot be whitelisted as a prior harness script (${oldScript || "anonymous"})`, async () => {
    await protocol({ oldScript }, async (cdp, socket) => {
      await assert.rejects(proveAndArm(cdp, BOOT), { code: "product_script_preceded_guard" });
      noResume(socket);
    });
  });
}

for (const [options, code] of [
  [{ missingPause: true }, "raw_cdp_pause_ack_missing"],
  [{ wrongPause: true }, "raw_cdp_bootstrap_pause_unproven"],
  [{ earlyProduct: true }, "product_script_preceded_guard"],
  [{ badHook: true }, "telemetry_hook_ack_missing"],
]) {
  test(`unproven bootstrap or hook never resumes (${code})`, async () => {
    await protocol(options, async (cdp, socket) => {
      await assert.rejects(proveAndArm(cdp, BOOT), { code });
      noResume(socket);
    });
  });
}

test("reload/new document is guarded at instrumentation pause before any resume", async () => {
  for (let document = 0; document < 2; document += 1) {
    const { context, nativeCalls } = realm();
    const commands = [];
    const cdp = { send: async (method, params) => {
      commands.push(method);
      if (method === "Debugger.evaluateOnCallFrame") {
        assert.equal(params.callFrameId, `document-${document}`);
        return { result: { value: vm.runInContext(params.expression, context) } };
      }
      assert.equal(snapshot(context).fetchGuarded, true);
      assert.equal(snapshot(context).bridgeArmed, true);
      return {};
    } };
    await resumeGuardedScript(cdp, {
      reason: "instrumentation", callFrames: [{ callFrameId: `document-${document}` }],
    }, BOOT);
    assert.deepEqual(commands, ["Debugger.evaluateOnCallFrame", "Debugger.resume"]);
    createBridge(context, "readonly-definition");
    await assert.rejects(context.__TAURI_INTERNALS__.invoke("plugin:http|fetch", {
      clientConfig: { url: TRACKER, method: "POST" },
    }), { name: "AbortError" });
    assert.equal(nativeCalls.length, 0);
    assert.equal(snapshot(context).invokeBlocked, 1);
  }
});

test("unexpected reload pause and failed hook keep the target paused", async () => {
  const commands = [];
  const cdp = { send: async (method) => { commands.push(method); return { result: { value: {} } }; } };
  await assert.rejects(resumeGuardedScript(cdp, { reason: "other", callFrames: [] }, BOOT), { code: "raw_cdp_unexpected_pause" });
  assert.deepEqual(commands, []);
  await assert.rejects(resumeGuardedScript(cdp, { reason: "instrumentation", callFrames: [{ callFrameId: "new-document" }] }, BOOT));
  assert.deepEqual(commands, ["Debugger.evaluateOnCallFrame"]);
});

test("target selection rejects an external or ambiguous page and tainted CDP URLs", () => {
  const target = { id: "page-1", type: "page", url: "https://tauri.localhost/", webSocketDebuggerUrl: "ws://127.0.0.1:12345/devtools/page/page-1" };
  assert.equal(checkTarget([target], 12345), target.webSocketDebuggerUrl);
  for (const targets of [
    [target, { ...target, id: "page-2" }],
    [{ ...target, url: "https://example.invalid/" }],
    [{ ...target, webSocketDebuggerUrl: "ws://example.invalid:12345/devtools/page/page-1" }],
    [{ ...target, webSocketDebuggerUrl: "ws://127.0.0.1:12346/devtools/page/page-1" }],
    [{ ...target, webSocketDebuggerUrl: "ws://user:password@127.0.0.1:12345/devtools/page/page-1" }],
    [{ ...target, webSocketDebuggerUrl: "ws://127.0.0.1:12345/devtools/page/other-page" }],
  ]) assert.throws(() => checkTarget(targets, 12345));
});

test("failure terminates the owned app before detaching; failed termination does not detach", async () => {
  const order = [];
  await stopBeforeDetach(async () => { order.push("kill-original-native-pid"); }, () => { order.push("detach-cdp"); });
  assert.deepEqual(order, ["kill-original-native-pid", "detach-cdp"]);
  let detached = false;
  await assert.rejects(stopBeforeDetach(async () => { throw new Error("offline-kill-failure"); }, () => { detached = true; }));
  assert.equal(detached, false);
});
