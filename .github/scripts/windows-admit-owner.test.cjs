"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { guardState, authenticateLease, coordinationState, checkRun, readyJob, issueOnce } = require("./windows-admit-owner.cjs");
const NOW = Date.parse("2026-11-01T00:00:00Z");
const OWNER = "resource_guard_12345_1234abcd";
const ENV = { MAAT_HOLD_OWNER: OWNER, MAAT_HOLD_TOKEN: "fixture-token-not-a-secret-0000" };
function stats() {
  return {
    gpu_turns: { lease_protected: true, hold_who: OWNER, hold_reject: true, hold_s: 100,
      active: null, count: 0, waiting: 0, hold_sensitive_preparing: 0, bg_in_turn: 0,
      admission_recovery_required: false, admission_journal_entries: 0,
      maintenance: { active: false, pending_drain: false, corrupt_state: false,
        quarantine: { active: false, corrupt_state: false },
        cpu: { active: 0, waiting: 0, uncertain: 0, recovery_required: false, corrupt_state: false } } },
    admission: { pending: 0 }, background: { interactive_active: 0, interactive_waiting: 0, bg_active: 0 },
    tiers: { simon: { active_conns: 0, pending: { pending: 0 } } },
  };
}
function coordination() {
  return { bench: null, ci: { updated: NOW / 1000, state: "off", lock_owner: null,
    runners: { "actions.runner.fixture": "running" } },
  processes: "/sbin/launchd\n/Users/fixture/runner/bin/Runner.Listener run\n" };
}
const run = { id: 1234, repository: { full_name: "Gigisanta/simon-releases" }, event: "workflow_dispatch",
  head_branch: "main", run_attempt: 1, path: ".github/workflows/windows-native-qa.yml",
  head_sha: "a".repeat(40), actor: { login: "Gigisanta" }, status: "in_progress" };
const jobs = { jobs: [{ name: "windows-native", status: "in_progress", steps: [
  { name: "Esperar admisión de generación", status: "in_progress", conclusion: null },
] }] };
function fixture(overrides = {}) {
  const calls = [];
  const input = {
    run, candidate: { sha256: "b".repeat(64) }, clock: () => NOW,
    readRun: async () => run, readHead: async () => ({ sha: run.head_sha }),
    readJobs: async () => jobs, readStatuses: async () => [],
    readGuard: async () => {
      calls.push("precheck");
      return { ...guardState({ status: "ok" }, stats(), ENV, NOW),
        ...coordinationState(coordination(), NOW), ownedLease: true };
    },
    post: async (body) => { calls.push("post"); return { ...body, id: 55, creator: { login: "Gigisanta" } }; },
    ...overrides,
  };
  return { calls, input };
}

test("owned quiet guard is required, not merely a resource_guard prefix", () => {
  assert.equal(guardState({ status: "ok" }, stats(), ENV, NOW).exit_code, 0);
  assert.equal(guardState({ status: "ok" }, stats(), ENV, NOW).ownedLease, undefined,
    "public owner metadata is not authenticated ownership");
  for (const mutate of [
    (s) => { s.gpu_turns.hold_who = "resource_guard_99999_deadbeef"; },
    (s) => { s.gpu_turns.lease_protected = false; },
    (s) => { s.gpu_turns.hold_s = 30; },
    (s) => { s.gpu_turns.hold_s = "100"; },
    (s) => { s.gpu_turns.hold_s = Infinity; },
    (s) => { s.gpu_turns.active = "simon"; },
    (s) => { s.gpu_turns.waiting = 1; },
    (s) => { s.gpu_turns.maintenance.quarantine.active = true; },
    (s) => { s.gpu_turns.maintenance.cpu.uncertain = 1; },
    (s) => { s.admission.pending = 1; },
    (s) => { s.tiers.simon.pending.pending = 1; },
  ]) {
    const altered = stats(); mutate(altered);
    assert.throws(() => guardState({ status: "ok" }, altered, ENV, NOW));
  }
  assert.throws(() => guardState({ status: "ok" }, stats(), {}, NOW));
  assert.throws(() => guardState({ status: "degraded" }, stats(), ENV, NOW));
  assert.throws(() => guardState({ status: "ok" }, stats(), ENV, Date.parse("2026-11-01T04:00:00Z")));
  assert.equal(guardState({ status: "ok" }, stats(), ENV, Date.parse("2026-11-01T04:00:00Z"),
    { forGeneration: false }).quiet, true, "settlement remains observable after the public pause starts");
});

test("lease credentials are authenticated before JSON rejection without any model or wake payload", async () => {
  const requests = [];
  const request = async (path, options) => {
    requests.push({ path, ...options });
    return options.headers["X-Maat-Hold-Token"] === ENV.MAAT_HOLD_TOKEN
      ? { status: 400, body: { error: "invalid_json" } }
      : { status: 403, body: { error: "invalid_gpu_hold_credentials" } };
  };
  assert.equal(await authenticateLease(ENV, request), true);
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0].headers["X-Maat-Hold-Token"], ENV.MAAT_HOLD_TOKEN);
  assert.equal(requests[1].headers["X-Maat-Hold-Token"], ENV.MAAT_HOLD_TOKEN);
  for (const request of requests) {
    assert.equal(request.path, "/v1/chat/completions");
    assert.equal(request.method, "POST");
    assert.equal(request.body, "null", "no model, prompt, queue request or inference");
    assert.equal(request.headers["X-Maat-Hold-Owner"], OWNER);
  }
});

test("a copied public owner with a false token and unknown authentication emit no admission", async () => {
  const failures = [
    async () => ({ status: 403, body: { error: "invalid_gpu_hold_credentials" } }),
    async () => ({ status: 400, body: { error: "invalid_json" } }),
    async () => ({ status: 403, body: { error: "invalid_json" } }),
    async () => { throw new Error("transport unknown"); },
  ];
  for (const request of failures) {
    let writes = 0;
    const { input } = fixture({
      readGuard: async () => {
        await authenticateLease({ ...ENV, MAAT_HOLD_TOKEN: "copied-owner-wrong-token-0000" }, request);
        return { exit_code: 0, quiet: true, ownedLease: true, coordinationQuiet: true };
      },
      post: async () => { writes += 1; },
    });
    await assert.rejects(issueOnce(input));
    assert.equal(writes, 0);
  }
});

test("canonical bench and CI coordination must be fresh, off, unowned and worker-free", () => {
  assert.equal(coordinationState(coordination(), NOW).coordinationQuiet, true);
  const expired = coordination();
  expired.bench = { "dueño": "previous-bench", expira_en: NOW / 1000 - 1 };
  assert.equal(coordinationState(expired, NOW).coordinationQuiet, true);
  for (const mutate of [
    (s) => { s.bench = {}; },
    (s) => { s.bench = { "dueño": "foreign-bench", expira_en: NOW / 1000 + 60 }; },
    (s) => { s.bench = { "dueño": OWNER, expira_en: NOW / 1000 + 60 }; },
    (s) => { s.bench = { "dueño": "unknown", expira_en: "bad-date" }; },
    (s) => { s.ci = null; },
    (s) => { s.ci.updated = NOW / 1000 - 60.001; },
    (s) => { s.ci.updated = NOW / 1000 + 1; },
    (s) => { s.ci.state = "paused"; },
    (s) => { s.ci.state = "draining"; },
    (s) => { s.ci.state = "resuming"; },
    (s) => { s.ci.lock_owner = "foreign-bench"; },
    (s) => { s.ci.runners = {}; },
    (s) => { s.ci.runners["actions.runner.fixture"] = "paused"; },
    (s) => { s.processes = ""; },
    (s) => { s.processes = null; },
    (s) => { s.processes += "/Users/fixture/runner/bin.2.331.0/Runner.Worker spawnclient 1 2\n"; },
  ]) {
    const altered = coordination(); mutate(altered);
    assert.throws(() => coordinationState(altered, NOW));
  }
});

test("only exact first-attempt main workflow, actor and ready step qualify", () => {
  checkRun(run, { sha: run.head_sha }, run.id);
  assert.equal(readyJob(jobs), true);
  for (const change of [{ event: "pull_request" }, { head_branch: "other" }, { run_attempt: 2 },
    { actor: { login: "other" } }, { path: "other.yml" }]) {
    assert.throws(() => checkRun({ ...run, ...change }, { sha: run.head_sha }, run.id));
  }
  assert.throws(() => checkRun(run, { sha: "c".repeat(40) }, run.id));
  assert.throws(() => readyJob({ jobs: [...jobs.jobs, ...jobs.jobs] }));
  assert.equal(readyJob({ jobs: [{ ...jobs.jobs[0], steps: [{ ...jobs.jobs[0].steps[0], status: "completed" }] }] }), false);
});

test("fresh successful guard precedes the sole creator-bound status write", async () => {
  const { calls, input } = fixture();
  const receipt = await issueOnce(input);
  assert.deepEqual(calls, ["precheck", "post"]);
  assert.equal(receipt.statusId, 55);
  assert.equal(receipt.context, "qa-windows/admission/1234/1");
  assert.equal(receipt.expiresEpoch, Math.floor(NOW / 1000) + 40);
});

test("blocked, unknown or thrown precheck emits no status", async () => {
  for (const result of [{ exit_code: 75 }, { exit_code: null }, { exit_code: 0 },
    { exit_code: 0, ownedLease: true, quiet: false, coordinationQuiet: true },
    { exit_code: 0, ownedLease: true, quiet: true },
    { exit_code: 0, ownedLease: true, quiet: true, coordinationQuiet: false }, undefined]) {
    const { calls, input } = fixture({ readGuard: async () => result });
    await assert.rejects(issueOnce(input));
    assert.deepEqual(calls, []);
  }
  const { calls, input } = fixture({ readGuard: async () => { throw new Error("unknown"); } });
  await assert.rejects(issueOnce(input));
  assert.deepEqual(calls, []);
});

test("a previous status or non-ready run cannot be retried under a fresh lease", async () => {
  for (const overrides of [
    { readStatuses: async () => [{ context: "qa-windows/admission/1234/1", state: "failure" }] },
    { readRun: async () => ({ ...run, status: "completed" }) },
    { readJobs: async () => ({ jobs: [{ ...jobs.jobs[0], steps: [] }] }) },
  ]) {
    const { calls, input } = fixture(overrides);
    await assert.rejects(issueOnce(input));
    assert.deepEqual(calls, []);
  }
});

test("an uncertain write is attempted once and never converted into approval", async () => {
  let writes = 0;
  const { input } = fixture({ post: async () => { writes += 1; throw new Error("write outcome unknown"); } });
  await assert.rejects(issueOnce(input));
  assert.equal(writes, 1);
  const malformed = fixture({ post: async (body) => ({ ...body, id: 55, creator: { login: "other" } }) });
  await assert.rejects(issueOnce(malformed.input));
});
