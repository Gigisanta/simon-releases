"use strict";

// Offline policy regressions, NOT Windows/UI/gateway acceptance evidence.
const test = require("node:test");
const assert = require("node:assert/strict");
const admittedAction = require("./admitted-action.cjs");
const {
  REPO, WORKFLOW, FIXTURE_ID, checkRun, checkAdmission, outsideQuietWindow, checkFixture,
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
