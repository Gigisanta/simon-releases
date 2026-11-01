"use strict";

// Offline policy regressions, NOT Windows/UI/gateway acceptance evidence.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const admittedAction = require("./admitted-action.cjs");
const {
  REPO, WORKFLOW, FIXTURE_ID, QaError, checkRun, checkAdmission, outsideQuietWindow, checkFixture,
} = require("./windows-contract.cjs");
const {
  profileStateFromSession, assertGenerationPrerequisites, waitForGenerationComposer,
  waitForHistoryRestored, snapshotAndClickOnce,
} = require("./windows-ui-lifecycle.cjs");

const SHA = "a".repeat(40);
const ASSET_SHA = "b".repeat(64);
const env = {
  GITHUB_REPOSITORY: REPO, GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: "refs/heads/main",
  GITHUB_WORKFLOW_REF: WORKFLOW, GITHUB_WORKFLOW_SHA: SHA, GITHUB_SHA: SHA,
  GITHUB_RUN_ID: "12345", GITHUB_RUN_ATTEMPT: "1", SIMON_QA_MODE: "full-generation",
};
const repo = { full_name: REPO, private: false, fork: false, default_branch: "main", archived: false };
const now = Date.parse("2026-10-31T15:00:05Z"); // 12:00:05 ART, allowed
const status = {
  id: 77, context: "qa-windows/admission/12345/1", state: "success",
  creator: { login: "Gigisanta" }, created_at: "2026-10-31T15:00:00Z",
  description: `${ASSET_SHA}:${Math.floor(Date.parse("2026-10-31T15:00:00Z") / 1000) + 40}`,
  target_url: `https://github.com/${REPO}/actions/runs/12345/attempts/1`,
};

test("only the exact default-branch manual workflow commit may obtain credentials", () => {
  assert.doesNotThrow(() => checkRun(env, repo, { sha: SHA }));
  for (const change of [
    { GITHUB_REF: "refs/heads/unreviewed" }, { GITHUB_EVENT_NAME: "pull_request_target" },
    { GITHUB_RUN_ATTEMPT: "2" }, { GITHUB_WORKFLOW_REF: WORKFLOW.replace("main", "topic") },
    { GITHUB_WORKFLOW_SHA: "c".repeat(40) }, { GITHUB_REPOSITORY: "someone/simon-releases" },
  ]) assert.throws(() => checkRun({ ...env, ...change }, repo, { sha: SHA }));
  assert.throws(() => checkRun(env, { ...repo, private: true }, { sha: SHA }));
  assert.throws(() => checkRun(env, repo, { sha: "c".repeat(40) }));
});

test("admission is creator/run/attempt/asset/deadline bound and cannot be replayed", () => {
  assert.equal(checkAdmission([status], env, ASSET_SHA, now).id, 77);
  for (const change of [
    { creator: { login: "another-maintainer" } }, { state: "failure" },
    { context: "qa-windows/admission/12346/1" }, { context: "qa-windows/admission/12345/2" },
    { description: `${"c".repeat(64)}:${Math.floor(now / 1000) + 35}` },
    { target_url: `https://github.com/${REPO}/actions/runs/12346/attempts/1` },
    { created_at: "2026-10-31T14:59:54Z" }, { created_at: "2026-10-31T15:00:06Z" },
    { description: `${ASSET_SHA}:${Math.floor(now / 1000) + 29}` },
    { description: `${ASSET_SHA}:${Math.floor(now / 1000) + 46}` },
  ]) assert.throws(() => checkAdmission([{ ...status, ...change }], env, ASSET_SHA, now));
  assert.throws(() => checkAdmission([], env, ASSET_SHA, now));
  assert.throws(() => checkAdmission([status, { ...status, id: 78 }], env, ASSET_SHA, now));
});

test("the entire 30 second generation stays outside 01–08 ART", () => {
  for (const at of ["2026-10-31T03:59:45Z", "2026-10-31T04:00:00Z", "2026-10-31T10:59:59Z"]) {
    assert.throws(() => outsideQuietWindow(Date.parse(at)));
  }
  for (const at of ["2026-10-31T03:59:00Z", "2026-10-31T11:00:00Z"]) {
    assert.doesNotThrow(() => outsideQuietWindow(Date.parse(at)));
  }
});

test("a normal authenticated account is not the immutable least-privilege QA fixture", () => {
  const account = { user: { id: FIXTURE_ID, role: "self", email: "fixture@example.invalid" } };
  assert.doesNotThrow(() => checkFixture(account, "fixture@example.invalid"));
  for (const change of [{ id: "personal-account" }, { role: "admin" }, { email: "other@example.invalid" }]) {
    assert.throws(() => checkFixture({ user: { ...account.user, ...change } }, "fixture@example.invalid"));
  }
  assert.throws(() => checkFixture(null));
});

test("the persistent operation never dispatches after failed, pending or unknown precheck", async () => {
  let sends = 0;
  for (const result of [null, {}, { exit_code: 75 }, { exit_code: 0, session_id: "running" }, { exit_code: 0, isError: true }]) {
    await assert.rejects(admittedAction(async () => result, async () => { sends += 1; }));
  }
  await assert.rejects(admittedAction(async () => { throw new Error("precheck_failed"); }, async () => { sends += 1; }));
  assert.equal(sends, 0);
  await assert.rejects(admittedAction(async () => ({ exit_code: 0 }), async () => { sends += 1; throw new Error("uncertain"); }));
  assert.equal(sends, 1); // no retry, even when the action's result is uncertain
});

const healthyBackend = {
  ok: true, db: "ok", liveness: { status: "ok" }, capabilities: { chatResume: "read-only-v1" },
};
const unhealthyBackends = [
  ["missing capability despite a new version", { body: { ...healthyBackend, capabilities: undefined, version: "99.0.0" } },
    "chat_resume_capability_required"],
  ["unknown capability", { body: { ...healthyBackend, capabilities: { chatResume: "read-only-v2" } } },
    "chat_resume_capability_required"],
  ["malformed capability", { body: { ...healthyBackend, capabilities: { chatResume: ["read-only-v1"] } } },
    "chat_resume_capability_required"],
  ["malformed JSON", { malformed: true }, "public_health_failed"],
  ["HTTP failure with an otherwise valid body", { status: 503, body: healthyBackend }, "public_health_failed"],
  ["transport failure", { error: new Error("offline-transport") }, "public_health_failed"],
  ["unhealthy database", { body: { ...healthyBackend, db: "failed" } }, "public_health_failed"],
  ["unknown liveness", { body: { ...healthyBackend, liveness: null } }, "public_health_failed"],
  ["non-boolean ok", { body: { ...healthyBackend, ok: "true" } }, "public_health_failed"],
];

function loadOfflineScript(name, globals, imports = {}, asCli = false) {
  const filename = path.join(__dirname, name);
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  const sandboxRequire = (id) => Object.hasOwn(imports, id) ? imports[id] : localRequire(id);
  sandboxRequire.main = asCli ? module : null;
  sandboxRequire.resolve = localRequire.resolve;
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    module, exports: module.exports, require: sandboxRequire, ...globals,
  }, { filename, timeout: 1000 });
  return module.exports;
}

function backendHarness(replies, { restoredSession = false, loginLink = false } = {}) {
  // Real runner/UI entrypoints, with only OS, filesystem, HTTP and CDP peers
  // replaced. No exported test-only launch helper or real network/process.
  const calls = [];
  const requests = [];
  const directory = path.join("/offline-runner", "simon-windows-qa");
  const boot = "00000000-0000-4000-8000-000000000001";
  const selection = {
    baseline: { version: "0.1.9" }, candidate: { version: "0.1.12", sha256: ASSET_SHA },
    mode: "full-generation", executable: path.join(directory, "installed", "simon.exe"),
    webviewDirectory: path.join(directory, "webview"),
  };
  const native = { pid: 321, guardPid: 654, port: 43210, executable: selection.executable,
    label: "candidate", guardBootId: boot };
  const files = new Map();
  const setJson = (name, value) => files.set(path.join(directory, name), JSON.stringify(value));
  setJson("selection.json", selection);
  setJson("native.json", native);
  setJson("evidence.json", { schema: "simon-windows-qa/v1",
    loginCandidate: { state: "completed", profileState: "complete", aiConsentGranted: true } });
  setJson("ui-ready.json", { schema: "simon-generation-ui-ready/v1", nativePid: native.pid,
    guardBootId: boot, profileState: "complete", aiConsentGranted: true,
    history: { responseStatus: 200, restoredUI: true, assistantCount: 0, messageCount: 0, pendingTurn: false } });
  for (const label of ["baseline", "candidate"]) {
    setJson(`telemetry-${label}.json`, {
      schema: "simon-cdp-guardian/v1", bootId: boot, nativePid: native.pid, guardianPid: native.guardPid,
      phase: "running", heartbeatAt: Date.now(),
      proof: { preexistingParsedScripts: 0, hookAcknowledgedBeforeResume: true },
    });
  }
  let finished;
  let finishOnExitCode = false;
  let exitCode;
  const process = {
    platform: "win32", execPath: "offline-node",
    env: { ...env, RUNNER_ENVIRONMENT: "github-hosted", RUNNER_TEMP: "/offline-runner",
      SIMON_QA_ROOT: directory, SIMON_QA_EMAIL: "fixture@example.invalid", SIMON_QA_PASSWORD: "offline-only",
      GH_TOKEN: "offline-github-sentinel" },
    stderr: { write() {} },
    exit(code) { finished.resolve(code); },
  };
  Object.defineProperty(process, "exitCode", {
    get: () => exitCode,
    set(value) { exitCode = value; if (finishOnExitCode) finished.resolve(value); },
  });
  const filesystem = {
    async mkdir() {},
    async readFile(file) {
      assert.ok(files.has(file), `unexpected offline read: ${path.basename(file)}`);
      return files.get(file);
    },
    async writeFile(file, value) { files.set(file, value); },
    async rename(from, to) { files.set(to, files.get(from)); files.delete(from); },
    async rm(file) { files.delete(file); },
  };
  let responseIndex = 0;
  const fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    if (url === "https://simon.maat.work/api/health") {
      calls.push("health");
      assert.ok(responseIndex < replies.length, "unplanned health request");
      const reply = replies[responseIndex++];
      if (reply.error) throw reply.error;
      return { status: reply.status ?? 200, json: async () => {
        if (reply.malformed) throw new SyntaxError("offline-invalid-json");
        return reply.body;
      } };
    }
    if (url === `https://api.github.com/repos/${REPO}`) return { ok: true, json: async () => repo };
    if (url === `https://api.github.com/repos/${REPO}/commits/main`) return { ok: true, json: async () => ({ sha: SHA }) };
    if (String(url).startsWith("http://127.0.0.1:43210/")) return { ok: true };
    calls.push("unexpected-backend-or-admission");
    throw new QaError("offline_unexpected_request");
  };
  const child = (pid) => ({ pid, exitCode: null, once() {}, unref() {} });
  const children = {
    spawn(executable) {
      const guardian = executable === process.execPath;
      calls.push(guardian ? "guardian-launch" : "native-launch");
      return child(guardian ? native.guardPid : native.pid);
    },
    spawnSync() { calls.push("native-window-check"); return { status: 0 }; },
  };
  const globals = { process, fetch, URL, AbortSignal, Buffer, setTimeout, clearTimeout };
  const runner = loadOfflineScript("windows-native-qa.cjs", globals,
    { "node:fs/promises": filesystem, "node:child_process": children });
  const field = (name) => ({
    count: async () => 1, waitFor: async () => {},
    fill: async () => { calls.push(`fill-${name}`); },
    and() { return this; },
    click: async () => {
      calls.push(`click-${name}`);
      throw new QaError(`offline_${name}_boundary`);
    },
  });
  const page = {
    url: () => "https://tauri.localhost/",
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {},
    locator(selector) {
      if (selector === "#chat-titulo") return { count: async () => restoredSession ? 1 : 0 };
      return { first: () => ({ waitFor: async () => {} }) };
    },
    getByRole(role, { name }) {
      if (role === "link") return { ...field("login-navigation"), count: async () => loginLink ? 1 : 0 };
      return field(name === "Cerrar sesión" ? "logout" : name === "Entrar" ? "sign-in" : "composer");
    },
    getByLabel: () => field("secret"),
    waitForResponse: () => Promise.resolve({ status: () => 200 }),
    evaluate: async () => ({ schema: "simon-telemetry-guard/v1", bootId: boot,
      fetchGuarded: true, bridgeArmed: true, bridgeGuarded: true, fetchBlocked: 0, invokeBlocked: 0 }),
    reload: async () => { calls.push("reload"); throw new QaError("offline_reload_boundary"); },
  };
  const context = {
    pages: () => [page],
    route: async (pattern) => {
      assert.equal(pattern.test("https://simon.maat.work/api/chat/resume?allowOrphan=1"), false,
        "resume must remain an unintercepted native UI request");
    },
  };
  page.context = () => context;
  const imports = {
    "node:child_process": children,
    "node:crypto": { randomUUID: () => boot },
    "node:net": { createServer: () => ({
      once() {}, listen(_port, _address, ready) { ready(); },
      address: () => ({ port: native.port }), close(done) { done(); },
    }) },
    "playwright-core": { chromium: { connectOverCDP: async () => {
      calls.push("attach-ui");
      return { contexts: () => [context] };
    } } },
    "./windows-native-qa.cjs": runner,
  };
  async function run(name, action, label) {
    finished = deferred();
    finishOnExitCode = name === "windows-native-qa.cjs";
    exitCode = undefined;
    process.argv = ["offline-node", name, action, label];
    loadOfflineScript(name, globals, name === "windows-ui.cjs" ? imports :
      { "node:fs/promises": filesystem, "node:child_process": children }, true);
    return await finished.promise;
  }
  return {
    calls, requests, runner, process,
    evidence: () => JSON.parse(files.get(path.join(directory, "evidence.json"))),
    runNative: (action, label) => run("windows-native-qa.cjs", action, label),
    runUI: (action, label) => run("windows-ui.cjs", action, label),
  };
}

test("public no-wake health requires the exact code capability and retains only minimal evidence", async () => {
  for (const [name, reply, code] of unhealthyBackends) {
    const harness = backendHarness([reply]);
    await assert.rejects(harness.runner.health("offline-boundary"), { code }, name);
    assert.equal(harness.evidence().backend, undefined, name);
    assert.equal(harness.requests.length, 1, name);
  }
  const harness = backendHarness([{ body: { ...healthyBackend, privateField: "must-not-persist" } }]);
  await harness.runner.health("baseline-launch");
  assert.deepEqual(harness.evidence().backend, {
    endpoint: "https://simon.maat.work/api/health", httpStatus: 200,
    chatResume: "read-only-v1", checkedBefore: "baseline-launch",
  });
  assert.equal(harness.requests.length, 1);
  const { url, options } = harness.requests[0];
  assert.equal(url, "https://simon.maat.work/api/health");
  assert.equal(options.method ?? "GET", "GET");
  assert.equal(options.redirect, "error");
  assert.equal(options.signal.aborted, false);
  assert.deepEqual(Object.keys(options.headers), ["cache-control"]);
  assert.equal(options.headers["cache-control"], "no-cache");
  assert.equal(options.body, undefined);
  assert.equal(JSON.stringify(harness.evidence()).includes("must-not-persist"), false);
});

test("prepare fails closed before selecting/downloading any executable on an unsafe backend", async () => {
  for (const [name, reply, code] of unhealthyBackends) {
    const harness = backendHarness([reply]);
    harness.process.env.SIMON_QA_MODE = "baseline-login";
    assert.equal(await harness.runNative("prepare"), 1, name);
    assert.equal(harness.evidence().failure.code, code, name);
    assert.equal(harness.evidence().assets, undefined, name);
    assert.deepEqual(harness.calls, ["health"], name);
  }
});

test("both NSIS entrypoints use the shared fail-closed health CLI before installer execution", async () => {
  for (const label of ["baseline", "candidate"]) {
    const harness = backendHarness([unhealthyBackends[0][1]]);
    assert.equal(await harness.runNative("health", label), 1);
    assert.equal(harness.evidence().failure.code, "chat_resume_capability_required");
    assert.deepEqual(harness.calls, ["health"]);
  }
  // The Linux offline lane cannot execute PowerShell/NSIS. This independently
  // guards the cross-language handoff; native parsing/execution remains separate.
  const installer = fs.readFileSync(path.join(__dirname, "windows-install.ps1"), "utf8");
  const beforeLaunch = installer.split(/^\s*\$process\s*=\s*Start-Process\b/m)[0];
  assert.notEqual(beforeLaunch.length, installer.length, "real NSIS launch must exist");
  assert.match(beforeLaunch, /&\s+node\s+\(Join-Path\s+\$PSScriptRoot\s+'windows-native-qa\.cjs'\)\s+health\s+\$Version\s*\r?\n\s*if\s*\(\$LASTEXITCODE\s+-ne\s+0\)\s*\{\s*throw\s+'backend_resume_boundary_failed'\s*\}/);
});

test("unsafe health prevents baseline/candidate bootstrap and every UI/admission entrypoint", async () => {
  for (const [action, label] of [["login", "baseline"], ["login", "candidate"], ["consent"], ["generate"]]) {
    for (const [name, reply, code] of unhealthyBackends) {
      const harness = backendHarness([reply]);
      assert.equal(await harness.runUI(action, label), 1, `${action}/${label}: ${name}`);
      assert.equal(harness.evidence().failure.code, code, `${action}/${label}: ${name}`);
      assert.deepEqual(harness.calls, ["health"], `${action}/${label}: ${name}`);
    }
  }
});

test("login rechecks after bootstrap and before sign-out, navigation or password submission", async () => {
  for (const options of [{}, { restoredSession: true }, { loginLink: true }]) {
    const harness = backendHarness([{ body: healthyBackend }, unhealthyBackends[1][1]], options);
    assert.equal(await harness.runUI("login", "candidate"), 1);
    assert.equal(harness.evidence().failure.code, "chat_resume_capability_required");
    assert.equal(harness.calls.filter((call) => call === "native-launch").length, 1);
    assert.equal(harness.calls.filter((call) => call === "health").length, 2);
    assert.equal(harness.calls.some((call) => call.startsWith("click-")), false);
    assert.equal(harness.calls.includes("unexpected-backend-or-admission"), false);
    assert.equal(harness.calls[0], "health");
    assert.equal(harness.calls.at(-1), "health");
  }
  for (const label of ["baseline", "candidate"]) {
    const harness = backendHarness([{ body: healthyBackend }, { body: healthyBackend }]);
    assert.equal(await harness.runUI("login", label), 1); // Offline sentinel at the permitted UI boundary.
    assert.equal(harness.evidence().failure.code, "offline_sign-in_boundary");
    assert.equal(harness.calls[0], "health");
    assert.deepEqual(harness.calls.slice(-2), ["health", "click-sign-in"]);
    assert.equal(harness.calls.filter((call) => call === "native-launch").length, 1);
  }
});

test("restoration rechecks fresh health before reload and never reaches admission on downgrade", async () => {
  for (const [name, reply, code] of unhealthyBackends) {
    const harness = backendHarness([{ body: healthyBackend }, reply]);
    assert.equal(await harness.runUI("consent"), 1, name);
    assert.equal(harness.evidence().failure.code, code, name);
    assert.deepEqual(harness.calls, ["health", "native-window-check", "attach-ui", "health"], name);
    assert.equal(harness.evidence().consent, undefined, name);
  }
  const harness = backendHarness([{ body: healthyBackend }, { body: healthyBackend }]);
  assert.equal(await harness.runUI("consent"), 1); // No actual reload; stop at the offline boundary.
  assert.equal(harness.evidence().failure.code, "offline_reload_boundary");
  assert.deepEqual(harness.calls.slice(-2), ["health", "reload"]);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const readyProfile = { profileState: "complete", aiConsentGranted: true };
const settledHistory = { responseStatus: 200, restoredUI: true, assistantCount: 1, messageCount: 2, pendingTurn: false };
const resumedBody = { resumable: {
  id: "offline-conversation", nextCursor: null, orphanTail: false,
  messages: [
    { id: "offline-user", role: "user", content: "Pregunta ficticia anterior." },
    { id: "offline-assistant", role: "assistant", content: "Respuesta ficticia anterior." },
  ],
} };

test("blank or unknown profile stops before UI/admission even when IA was already granted", async () => {
  assert.equal(profileStateFromSession({ user: { profileCompletedAt: null } }), "incomplete");
  assert.equal(profileStateFromSession({ user: { profileCompletedAt: "2026-10-31T12:00:00.000Z" } }), "complete");
  for (const stamp of [undefined, false, "", "invalid"]) {
    assert.equal(profileStateFromSession({ user: { profileCompletedAt: stamp } }), "unknown");
  }
  let uiReads = 0;
  const page = { getByRole() { uiReads += 1; throw new Error("must-not-read-ui"); } };
  for (const state of [
    { profileState: "incomplete", aiConsentGranted: true },
    { profileState: "incomplete", aiConsentGranted: false },
    { profileState: "unknown", aiConsentGranted: true },
  ]) {
    await assert.rejects(waitForGenerationComposer(page, state, Date.now() + 1000), {
      code: state.profileState === "incomplete" ? "profile_incomplete" : "profile_state_unknown",
    });
  }
  assert.equal(uiReads, 0);
  assert.throws(() => assertGenerationPrerequisites({ ...readyProfile, aiConsentGranted: false }), { code: "consent_required" });
});

test("grant response waits for the bounded visible AND enabled SDK barrier before accepting composer", async () => {
  const rendered = deferred();
  let countReads = 0;
  let completed = false;
  let enabledSelector;
  const composer = {
    and(filter) {
      assert.equal(filter, enabledSelector);
      return { waitFor: async ({ state, timeout }) => {
        assert.equal(state, "visible");
        assert.ok(timeout > 0 && timeout <= 1000);
        await rendered.promise;
      } };
    },
    count: async () => { countReads += 1; return 1; },
    isVisible: () => { throw new Error("instant-visibility-is-not-readiness"); },
    isEnabled: () => { throw new Error("instant-enabled-is-not-readiness"); },
  };
  const page = {
    getByRole: () => composer,
    locator(selector) { assert.equal(selector, ":enabled"); enabledSelector = {}; return enabledSelector; },
  };
  const waiting = waitForGenerationComposer(page, readyProfile, Date.now() + 1000);
  waiting.then(() => { completed = true; }, () => {});
  assert.equal(completed, false);
  assert.equal(countReads, 0); // Server grant observed; React has not committed.
  rendered.resolve();
  assert.equal(await waiting, composer);
  assert.equal(countReads, 1);
});

test("composer SDK deadline remains a readiness failure rather than fabricated denial or a retry", async () => {
  let waits = 0;
  const page = {
    locator: () => ({}),
    getByRole: () => ({
      and: () => ({ waitFor: async () => { waits += 1; throw new Error("offline-sdk-timeout"); } }),
      count: () => { throw new Error("must-not-snapshot-after-timeout"); },
    }),
  };
  await assert.rejects(waitForGenerationComposer(page, readyProfile, Date.now() + 1000), { code: "composer_not_ready" });
  assert.equal(waits, 1);
});

test("delayed resume response AND delayed restored UI finish before the adjacent one-click snapshot", async () => {
  const responseArrived = deferred();
  const renderStarted = deferred();
  const rendered = deferred();
  const order = [];
  let assistants = 0;
  let clicks = 0;
  const page = {
    waitForFunction: async (_predicate, rows, { timeout }) => {
      assert.equal(rows.length, 2);
      assert.ok(timeout > 0 && timeout <= 1000);
      order.push("wait-restored-ui");
      renderStarted.resolve();
      await rendered.promise;
    },
    locator: () => ({ count: async () => { order.push("snapshot"); return assistants; } }),
  };
  const send = { click: async () => { clicks += 1; order.push("click"); } };
  const deadline = Date.now() + 1000;
  const turn = (async () => {
    const history = await waitForHistoryRestored(page, responseArrived.promise, deadline);
    assert.deepEqual(history, settledHistory);
    return snapshotAndClickOnce(page, send, history, deadline);
  })();
  assert.deepEqual(order, []); // Slow GET cannot consume the only generation.
  responseArrived.resolve({ status: () => 200, json: async () => resumedBody });
  await renderStarted.promise;
  assert.deepEqual(order, ["wait-restored-ui"]);
  assert.equal(clicks, 0); // Headers/body alone are not a React restoration ACK.
  assistants = 1;
  rendered.resolve();
  assert.equal(await turn, 1);
  assert.deepEqual(order, ["wait-restored-ui", "snapshot", "click"]);
  assert.equal(clicks, 1);
});

test("failed/unknown history and restored pending requests cannot reach a new synthetic click", async () => {
  const lastUser = { ...resumedBody.resumable, messages: resumedBody.resumable.messages.slice(0, 1) };
  for (const [status, body, code] of [
    [403, resumedBody, "history_resume_http_failed"],
    [200, {}, "history_response_invalid"],
    [200, { resumable: { ...resumedBody.resumable, orphanTail: true } }, "history_pending_turn"],
    [200, { resumable: lastUser }, "history_pending_turn"],
  ]) {
    let clicks = 0;
    const page = { waitForFunction: () => { throw new Error("must-not-accept-history"); } };
    await assert.rejects((async () => {
      const history = await waitForHistoryRestored(page, Promise.resolve({ status: () => status, json: async () => body }), Date.now() + 1000);
      await snapshotAndClickOnce(page, { click: async () => { clicks += 1; } }, history, Date.now() + 1000);
    })(), { code });
    assert.equal(clicks, 0);
  }
});

test("history changes after readiness fail before click instead of consuming a turn and timing out", async () => {
  let clicks = 0;
  const page = { locator: () => ({ count: async () => 2 }) };
  await assert.rejects(snapshotAndClickOnce(page, { click: async () => { clicks += 1; } }, settledHistory, Date.now() + 1000), {
    code: "history_changed_after_readiness",
  });
  assert.equal(clicks, 0);
});

test("a partially delivered native click is attempted once with no automatic second click", async () => {
  const order = [];
  let clicks = 0;
  const page = { locator: () => ({ count: async () => { order.push("snapshot"); return 1; } }) };
  const send = { click: async () => {
    order.push("click");
    clicks += 1;
    throw new Error("offline-partial-delivery");
  } };
  await assert.rejects(snapshotAndClickOnce(page, send, settledHistory, Date.now() + 1000), /offline-partial-delivery/);
  assert.deepEqual(order, ["snapshot", "click"]);
  assert.equal(clicks, 1);
});
