"use strict";

// Run locally INSIDE the canonical gpu-heavy resource_guard, never in Actions.
const { execFileSync } = require("node:child_process");
const { openSync, writeSync, ftruncateSync, fsyncSync, closeSync, lstatSync } = require("node:fs");
const { dirname, isAbsolute } = require("node:path");
const admittedAction = require("./admitted-action.cjs");
const { REPO, CANDIDATE_VERSION, numericId, requireThat, outsideQuietWindow, checkRelease } = require("./windows-contract.cjs");
const READY_STEP = "Esperar admisión de generación";
const WORKFLOW_PATH = ".github/workflows/windows-native-qa.yml";
function guardState(health, stats, env = process.env, now = Date.now(), { forGeneration = true } = {}) {
  if (forGeneration) outsideQuietWindow(now);
  const owner = env.MAAT_HOLD_OWNER;
  requireThat(/^resource_guard_[0-9]+_[a-f0-9]{8}$/.test(owner ?? "") &&
    typeof env.MAAT_HOLD_TOKEN === "string" && env.MAAT_HOLD_TOKEN.length >= 24, "guard_environment_missing");
  const gpu = stats?.gpu_turns;
  requireThat(health?.status === "ok" && !health.reason && gpu?.lease_protected === true &&
    gpu.hold_who === owner && gpu.hold_reject === true && gpu.hold_s > 35, "own_guard_lease_missing");
  requireThat(gpu.active === null && gpu.count === 0 && gpu.waiting === 0 &&
    gpu.hold_sensitive_preparing === 0 && gpu.bg_in_turn === 0 &&
    gpu.admission_recovery_required === false && gpu.admission_journal_entries === 0, "gateway_not_quiet");
  const maintenance = gpu.maintenance;
  requireThat(maintenance?.active === false && maintenance.pending_drain === false &&
    maintenance.corrupt_state === false && maintenance.quarantine?.active === false &&
    maintenance.quarantine.corrupt_state === false && maintenance.cpu?.active === 0 &&
    maintenance.cpu.waiting === 0 && maintenance.cpu.uncertain === 0 &&
    maintenance.cpu.recovery_required === false && maintenance.cpu.corrupt_state === false, "gateway_maintenance_unknown");
  requireThat(stats.admission?.pending === 0 && stats.background?.interactive_active === 0 &&
    stats.background.interactive_waiting === 0 && stats.background.bg_active === 0 &&
    stats.tiers && Object.keys(stats.tiers).length > 0 &&
    Object.values(stats.tiers).every((tier) => tier.active_conns === 0 && tier.pending?.pending === 0), "gateway_not_quiet");
  return { exit_code: 0, ownedLease: true, quiet: true };
}

function checkRun(run, head, runId) {
  requireThat(run?.id === runId && run.repository?.full_name === REPO &&
    run.event === "workflow_dispatch" && run.head_branch === "main" &&
    run.run_attempt === 1 && run.path === WORKFLOW_PATH &&
    /^[a-f0-9]{40}$/.test(run.head_sha ?? "") && head?.sha === run.head_sha &&
    run.actor?.login === "Gigisanta", "unexpected_windows_run");
}

function readyJob(jobs) {
  const matches = jobs?.jobs?.filter((job) => job.name === "windows-native") ?? [];
  requireThat(matches.length === 1, "windows_job_ambiguous");
  const job = matches[0];
  return job.status === "in_progress" && job.steps?.some((step) =>
    step.name === READY_STEP && step.status === "in_progress" && step.conclusion === null);
}

async function issueOnce({ run, candidate, readRun, readHead, readJobs, readStatuses, readGuard, post, clock = Date.now }) {
  const context = `qa-windows/admission/${run.id}/1`;
  const target = `https://github.com/${REPO}/actions/runs/${run.id}/attempts/1`;
  return admittedAction(async () => {
    const current = await readRun();
    checkRun(current, await readHead(), run.id);
    requireThat(current.status === "in_progress" && readyJob(await readJobs()), "windows_not_ready");
    requireThat(!(await readStatuses()).some((status) => status.context === context), "admission_already_attempted");
    const result = await readGuard();
    requireThat(result?.exit_code === 0 && result.ownedLease === true && result.quiet === true, "guard_precheck_failed");
    return result;
  }, async () => {
    outsideQuietWindow(clock());
    // Forty seconds leaves room for API transit but cannot grant a long window.
    const expires = Math.floor(clock() / 1000) + 40;
    const result = await post({ state: "success", context, description: `${candidate.sha256}:${expires}`, target_url: target });
    requireThat(result?.state === "success" && result.context === context &&
      result.creator?.login === "Gigisanta" && result.target_url === target &&
      result.description === `${candidate.sha256}:${expires}` && Number.isSafeInteger(result.id), "admission_write_uncertain");
    return { statusId: result.id, context, expiresEpoch: expires };
  });
}

function gh(path, method = "GET", body) {
  const args = ["api", "--hostname", "github.com", "--method", method, path];
  if (body !== undefined) args.push("--input", "-");
  const raw = execFileSync("gh", args, {
    input: body === undefined ? undefined : JSON.stringify(body), encoding: "utf8",
    timeout: 15_000, maxBuffer: 2 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GH_PROMPT_DISABLED: "1" },
  });
  return raw.trim() ? JSON.parse(raw) : null;
}

async function localJson(path) {
  const response = await fetch(`http://127.0.0.1:8080${path}`, { redirect: "error", signal: AbortSignal.timeout(5_000) });
  requireThat(response.status === 200, "gateway_http_unknown");
  const parts = [];
  let size = 0;
  for await (const part of response.body) {
    size += part.length;
    requireThat(size <= 262_144, "gateway_response_oversized");
    parts.push(part);
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}

function statuses(sha) {
  const result = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = gh(`repos/${REPO}/commits/${sha}/statuses?per_page=100&page=${page}`);
    requireThat(Array.isArray(batch), "status_history_unknown");
    result.push(...batch);
    if (batch.length < 100) return result;
  }
  throw new Error("status_history_oversized");
}

async function main(argv) {
  requireThat(argv.length === 10, "usage_run_release_asset_sha256_receipt_required");
  const options = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [argv[index * 2], argv[index * 2 + 1]]));
  requireThat(Object.keys(options).sort().join(",") === "--asset-id,--receipt,--release-id,--run-id,--sha256", "invalid_options");
  const runId = numericId(options["--run-id"]);
  const candidate = { version: CANDIDATE_VERSION, releaseId: numericId(options["--release-id"]),
    assetId: numericId(options["--asset-id"]), sha256: options["--sha256"] };
  requireThat(/^[a-f0-9]{64}$/.test(candidate.sha256), "invalid_installer_sha256");
  requireThat(isAbsolute(options["--receipt"]), "private_absolute_receipt_required");
  const parent = lstatSync(dirname(options["--receipt"]));
  requireThat(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === process.getuid() &&
    (parent.mode & 0o077) === 0, "private_receipt_parent_required");
  const fd = openSync(options["--receipt"], "wx", 0o600);
  const receipt = { schemaVersion: 1, runId, candidate, statusAttempted: false, statusConfirmed: false,
    runTerminal: false, backendSettled: false, ok: false };
  const save = () => {
    const bytes = Buffer.from(JSON.stringify(receipt, null, 2) + "\n");
    requireThat(writeSync(fd, bytes, 0, bytes.length, 0) === bytes.length, "receipt_write_incomplete");
    ftruncateSync(fd, bytes.length);
    fsyncSync(fd);
  };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let run;
  const readRun = () => gh(`repos/${REPO}/actions/runs/${runId}`);
  const readHead = () => gh(`repos/${REPO}/commits/main`);
  const readJobs = () => gh(`repos/${REPO}/actions/runs/${runId}/jobs?per_page=100`);
  const readGuard = async (forGeneration = true) =>
    guardState(await localJson("/health"), await localJson("/stats"), process.env, Date.now(), { forGeneration });
  try {
    requireThat(gh("user").login === "Gigisanta", "owner_identity_required");
    checkRelease(gh(`repos/${REPO}/releases/${candidate.releaseId}`), candidate, true);
    run = readRun();
    checkRun(run, readHead(), runId);
    receipt.workflowSha = run.head_sha;
    await readGuard();
    const readyDeadline = Date.now() + 10 * 60_000;
    while (!readyJob(readJobs())) {
      run = readRun();
      checkRun(run, readHead(), runId);
      requireThat(run.status !== "completed", "run_completed_before_admission");
      requireThat(Date.now() < readyDeadline, "ready_step_timeout");
      await wait(2_000);
    }
    checkRelease(gh(`repos/${REPO}/releases/${candidate.releaseId}`), candidate, true);
    receipt.admission = await issueOnce({ run, candidate, readRun, readHead, readJobs,
      readStatuses: () => statuses(run.head_sha), readGuard,
      post: async (body) => {
        receipt.statusAttempted = true;
        save(); // Persist uncertainty BEFORE the sole provider-side write.
        return gh(`repos/${REPO}/statuses/${run.head_sha}`, "POST", body);
      },
    });
    receipt.statusConfirmed = true;
    save();
  } catch (error) {
    receipt.error = error?.code && /^[a-z_]+$/.test(error.code) ? error.code : "owner_admission_failed";
    save();
  } finally {
    if (receipt.statusAttempted) {
      // An uncertain POST may have succeeded. Never retry it or release early.
      const terminalDeadline = Date.now() + 20 * 60_000;
      while (Date.now() < terminalDeadline) {
        try {
          run = readRun();
          checkRun(run, { sha: receipt.workflowSha }, runId);
          if (run.status === "completed") {
            receipt.runTerminal = true;
            receipt.conclusion = run.conclusion;
            break;
          }
        } catch { receipt.observationUnknown = true; }
        await wait(3_000);
      }
      if (!receipt.runTerminal) {
        // Cancel only this exact already-verified QA run; never any other job.
        try { gh(`repos/${REPO}/actions/runs/${runId}/cancel`, "POST"); } catch { receipt.cancelUncertain = true; }
      }
      // Keep the guard while the run or backend is uncertain. Its own bounded
      // command deadline remains the final containment boundary, not a success.
      while (!receipt.runTerminal || !receipt.backendSettled) {
        try {
          run = readRun();
          checkRun(run, { sha: receipt.workflowSha }, runId);
          if (run.status === "completed") {
            receipt.runTerminal = true;
            receipt.conclusion = run.conclusion;
            await readGuard(false);
            await wait(1_000);
            await readGuard(false);
            receipt.backendSettled = true;
          }
        } catch { receipt.observationUnknown = true; }
        save();
        if (!receipt.runTerminal || !receipt.backendSettled) await wait(3_000);
      }
    }
    receipt.ok = !receipt.error && receipt.statusConfirmed && receipt.runTerminal &&
      receipt.backendSettled && receipt.conclusion === "success";
    save();
    closeSync(fd);
  }
  console.log(JSON.stringify({ ok: receipt.ok, runId, statusConfirmed: receipt.statusConfirmed,
    runTerminal: receipt.runTerminal, backendSettled: receipt.backendSettled, error: receipt.error ?? null }));
  process.exitCode = receipt.ok ? 0 : 1;
}

module.exports = { guardState, checkRun, readyJob, issueOnce };
if (require.main === module) main(process.argv.slice(2)).catch(() => {
  console.error("owner_admission_failed"); process.exitCode = 1;
});
