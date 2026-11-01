"use strict";

// Offline policy regressions, NOT Windows/UI/gateway acceptance evidence.
const test = require("node:test");
const assert = require("node:assert/strict");
const admittedAction = require("./admitted-action.cjs");
const {
  REPO, WORKFLOW, FIXTURE_ID, checkRun, checkAdmission, outsideQuietWindow, checkFixture,
} = require("./windows-contract.cjs");

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
