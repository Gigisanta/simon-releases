"use strict";

const { QaError, requireThat, DEADLINE_MS } = require("./windows-contract.cjs");
const { readJson, writeJson, stopNative } = require("./windows-native-qa.cjs");
const { telemetrySource } = require("./windows-telemetry-guard.cjs");
const BOOTSTRAP_URL = "simon-qa://before-first-script";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function checkTarget(targets, port) {
  requireThat(Array.isArray(targets) && targets.length === 1 && targets[0].type === "page", "raw_cdp_target_ambiguous");
  const target = targets[0];
  const page = new URL(target.url || "about:blank");
  requireThat(page.href === "about:blank" || page.origin === "https://tauri.localhost", "raw_cdp_target_untrusted");
  const socket = new URL(target.webSocketDebuggerUrl);
  requireThat(socket.protocol === "ws:" && socket.hostname === "127.0.0.1" && Number(socket.port) === port &&
    !socket.username && !socket.password && !socket.search && !socket.hash &&
    socket.pathname === `/devtools/page/${target.id}` && /^[a-zA-Z0-9_-]{1,100}$/.test(target.id), "raw_cdp_socket_untrusted");
  return socket.href;
}

class RawCdp {
  constructor(socket, deadline) {
    this.socket = socket;
    this.deadline = deadline;
    this.pending = new Map();
    this.pauses = [];
    this.nextId = 1;
    this.otherScriptsBeforeGuard = 0;
    this.collectScripts = true;
    this.bootstrapScripts = new Set();
    this.allowHarnessScripts = false;
    this.failure = null;
    socket.addEventListener("message", (event) => {
      try {
        requireThat(typeof event.data === "string" && event.data.length <= 2_000_000, "raw_cdp_message_invalid");
        const message = JSON.parse(event.data);
        if (message.id) {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) pending.reject(new QaError("raw_cdp_command_rejected"));
          else pending.resolve(message.result);
        } else if (message.method === "Debugger.scriptParsed") {
          if (this.allowHarnessScripts && message.params.url === BOOTSTRAP_URL) this.bootstrapScripts.add(message.params.scriptId);
          else if (this.collectScripts && !(this.allowHarnessScripts && message.params.url === "simon-qa://telemetry-guard")) {
            this.otherScriptsBeforeGuard += 1;
          }
        } else if (message.method === "Debugger.paused") {
          requireThat(this.pauses.length < 256, "raw_cdp_pause_overflow");
          this.pauses.push(message.params);
        }
      } catch {
        this.fail("raw_cdp_message_invalid");
      }
    });
    socket.addEventListener("error", () => this.fail("raw_cdp_socket_failed"));
    socket.addEventListener("close", () => this.fail("raw_cdp_disconnected"));
  }
  fail(code) {
    this.failure ??= new QaError(code);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.failure);
    }
    this.pending.clear();
  }
  async opened() {
    while (this.socket.readyState !== WebSocket.OPEN) {
      if (this.failure) throw this.failure;
      requireThat(Date.now() < this.deadline, "raw_cdp_connect_deadline");
      await sleep(10);
    }
    return this;
  }
  send(method, params = {}) {
    if (this.failure) return Promise.reject(this.failure);
    const timeout = Math.min(5000, this.deadline - Date.now());
    if (timeout <= 0 || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new QaError("raw_cdp_command_deadline"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new QaError("raw_cdp_command_deadline"));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new QaError("raw_cdp_send_failed"));
      }
    });
  }
  async nextPause() {
    while (!this.pauses.length) {
      if (this.failure) throw this.failure;
      requireThat(Date.now() < this.deadline, "raw_cdp_pause_ack_missing");
      await sleep(10);
    }
    return this.pauses.shift(); // Events are buffered BEFORE enable/evaluate.
  }
  close() { this.socket.close(); }
}

function checkHook(result, bootId) {
  requireThat(!result?.exceptionDetails, "telemetry_hook_rejected");
  const hook = result?.result?.value;
  requireThat(hook?.schema === "simon-telemetry-guard/v1" && hook.bootId === bootId && hook.fetchGuarded === true &&
    hook.bridgeArmed === true && typeof hook.bridgeGuarded === "boolean", "telemetry_hook_ack_missing");
  return hook;
}
async function guardPausedScript(cdp, pause, bootId) {
  requireThat(Array.isArray(pause?.callFrames) && pause.callFrames.length > 0 &&
    typeof pause.callFrames[0].callFrameId === "string", "raw_cdp_pause_ack_missing");
  return checkHook(await cdp.send("Debugger.evaluateOnCallFrame", {
    callFrameId: pause.callFrames[0].callFrameId, expression: telemetrySource(bootId),
    silent: true, returnByValue: true,
  }), bootId);
}
async function proveAndArm(cdp, bootId) {
  // Page.waitForDebugger is a WebView page-wait loop, not necessarily a V8
  // Debugger.paused event. Do NOT equate Target.waitingForDebugger to it, and do
  // not force a late pause then call it proof that no product script ran.
  await cdp.send("Debugger.enable");
  await cdp.send("Page.enable");
  await cdp.send("Page.getFrameTree"); // Same ordered socket: drains scriptParsed catch-up.
  requireThat(cdp.otherScriptsBeforeGuard === 0, "product_script_preceded_guard");
  cdp.allowHarnessScripts = true;
  const evaluation = cdp.send("Runtime.evaluate", {
    expression: `debugger;\n//# sourceURL=${BOOTSTRAP_URL}`, silent: false,
  });
  evaluation.catch(() => {});
  const pause = await cdp.nextPause();
  requireThat(pause.reason === "other" && pause.callFrames?.length === 1 &&
    cdp.bootstrapScripts.has(pause.callFrames[0].location?.scriptId), "raw_cdp_bootstrap_pause_unproven");
  requireThat(cdp.otherScriptsBeforeGuard === 0, "product_script_preceded_guard");
  await guardPausedScript(cdp, pause, bootId);
  requireThat(cdp.otherScriptsBeforeGuard === 0, "product_script_preceded_guard");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: telemetrySource(bootId) });
  const breakpoint = await cdp.send("Debugger.setInstrumentationBreakpoint", { instrumentation: "beforeScriptExecution" });
  requireThat(typeof breakpoint?.breakpointId === "string", "raw_cdp_instrumentation_missing");
  cdp.collectScripts = false;
  // These are the FIRST resume commands. Fetch/bridge hooks and future-document
  // instrumentation are acknowledged while the explicit bootstrap is paused.
  await cdp.send("Runtime.runIfWaitingForDebugger");
  await cdp.send("Debugger.resume");
  return { evaluation, proof: {
    webviewWaitRequested: true, preexistingParsedScripts: 0,
    pauseAcknowledged: "explicit-bootstrap-debugger-before-product-script",
    hookAcknowledgedBeforeResume: true, futureDocuments: "persistent-beforeScriptExecution",
  } };
}
async function resumeGuardedScript(cdp, paused, bootId) {
  requireThat(paused.reason === "instrumentation", "raw_cdp_unexpected_pause");
  await guardPausedScript(cdp, paused, bootId);
  await cdp.send("Debugger.resume");
}
async function stopBeforeDetach(stop, detach) {
  await stop(); // If termination fails, deliberately keep the raw session open.
  detach();
}

async function guardian(label, bootId, startupDeadline) {
  requireThat(["baseline", "candidate"].includes(label) && /^[a-zA-Z0-9-]{36}$/.test(bootId) &&
    process.env.WEBVIEW2_WAIT_FOR_SCRIPT_DEBUGGER === "1" &&
    Number.isSafeInteger(startupDeadline) && startupDeadline > Date.now() && startupDeadline <= Date.now() + DEADLINE_MS,
  "raw_cdp_launch_contract_invalid");
  let native;
  while (Date.now() < startupDeadline) {
    native = await readJson("native.json");
    requireThat(native.label === label && native.guardBootId === bootId, "raw_cdp_native_identity_changed");
    if (native.guardPid === process.pid) break;
    await sleep(10);
  }
  requireThat(native.guardPid === process.pid, "raw_cdp_guardian_identity_invalid");
  const state = { schema: "simon-cdp-guardian/v1", label, bootId, nativePid: native.pid, guardianPid: process.pid,
    phase: "bootstrapping", webviewWaitRequested: true, zeroFootprint: "not-claimed" };
  let cdp;
  let timer;
  let writes = Promise.resolve();
  const save = () => {
    const snapshot = { ...state, heartbeatAt: Date.now() };
    writes = writes.then(() => writeJson(`telemetry-${label}.json`, snapshot));
    return writes;
  };
  try {
    await save();
    const response = await fetch(`http://127.0.0.1:${native.port}/json/list`, {
      redirect: "error", signal: AbortSignal.timeout(Math.min(3000, startupDeadline - Date.now())),
    });
    requireThat(response.ok, "raw_cdp_discovery_failed");
    const url = checkTarget(await response.json(), native.port);
    cdp = await new RawCdp(new WebSocket(url), startupDeadline).opened();
    const armed = await proveAndArm(cdp, bootId);
    state.proof = armed.proof;
    state.guardedScripts = 1;
    const monitor = (async () => {
      while (true) {
        const paused = await cdp.nextPause();
        await resumeGuardedScript(cdp, paused, bootId);
        state.guardedScripts += 1;
      }
    })();
    monitor.catch(() => {});
    // Consume buffered before-script pauses BEFORE waiting for the bootstrap
    // reply: nested WebView page-wait loops can delay that evaluation response.
    await Promise.race([armed.evaluation, monitor]);
    cdp.deadline = Date.now() + 25 * 60_000;
    state.phase = "running";
    await save();
    timer = setInterval(() => { void save().catch(() => cdp.fail("raw_cdp_heartbeat_failed")); }, 1000);
    await monitor;
  } catch (error) {
    clearInterval(timer);
    state.phase = "blocked";
    state.failure = error instanceof QaError ? error.code : "raw_cdp_unexpected_failure";
    try { await save(); } catch { /* No raw protocol or application output. */ }
    try {
      await stopBeforeDetach(() => stopNative(native), () => cdp?.close());
    } catch {
      state.phase = "termination-failed-session-kept-open";
      try { await save(); } catch { /* Preserve suspension, not unsafe output. */ }
      setInterval(() => {}, 1000); // Runner cleanup can still terminate its own app.
    }
    process.exitCode = 1;
  }
}
if (require.main === module) {
  void guardian(process.argv[2], process.argv[3], Number(process.argv[4])).catch(() => {
    // Launch-contract errors happen before any debugger attach/resume.
    process.exitCode = 1;
  });
}
module.exports = { checkTarget, RawCdp, checkHook, guardPausedScript, proveAndArm, resumeGuardedScript, stopBeforeDetach };
