"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { guardState, checkRun, readyJob, issueOnce } = require("./windows-admit-owner.cjs");
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
    readGuard: async () => { calls.push("precheck"); return guardState({ status: "ok" }, stats(), ENV, NOW); },
    post: async (body) => { calls.push("post"); return { ...body, id: 55, creator: { login: "Gigisanta" } }; },
    ...overrides,
  };
  return { calls, input };
}

test("owned quiet guard is required, not merely a resource_guard prefix", () => {
  assert.equal(guardState({ status: "ok" }, stats(), ENV, NOW).exit_code, 0);
  for (const mutate of [
    (s) => { s.gpu_turns.hold_who = "resource_guard_99999_deadbeef"; },
    (s) => { s.gpu_turns.lease_protected = false; },
    (s) => { s.gpu_turns.hold_s = 30; },
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
    { exit_code: 0, ownedLease: true, quiet: false }, undefined]) {
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
