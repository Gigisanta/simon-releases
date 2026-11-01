"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  REPO, BASELINE, CANDIDATE_VERSION, QaError, requireThat, numericId, sha256,
  runUrl, checkRun, checkHealth, checkRelease, verifyUpdater,
} = require("./windows-contract.cjs");

function root() {
  requireThat(process.platform === "win32" && process.env.RUNNER_ENVIRONMENT === "github-hosted" &&
    typeof process.env.RUNNER_TEMP === "string", "hosted_windows_required");
  const expected = path.join(process.env.RUNNER_TEMP, "simon-windows-qa");
  requireThat(path.resolve(process.env.SIMON_QA_ROOT ?? "") === path.resolve(expected), "invalid_qa_directory");
  return expected;
}
async function readJson(name) { return JSON.parse(await fs.readFile(path.join(root(), name), "utf8")); }
async function writeJson(name, value) {
  await fs.mkdir(root(), { recursive: true });
  const target = path.join(root(), name);
  await fs.writeFile(`${target}.tmp`, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(`${target}.tmp`, target);
}
async function record(stage, value) {
  let evidence;
  try { evidence = await readJson("evidence.json"); } catch { evidence = { schema: "simon-windows-qa/v1" }; }
  evidence[stage] = value;
  await writeJson("evidence.json", evidence);
}
async function github(endpoint, accept = "application/vnd.github+json") {
  requireThat(Boolean(process.env.GH_TOKEN) && endpoint.startsWith(`/repos/${REPO}`), "github_auth_or_scope_missing");
  const response = await fetch(`https://api.github.com${endpoint}`, {
    headers: {
      authorization: `Bearer ${process.env.GH_TOKEN}`, accept,
      "x-github-api-version": "2022-11-28", "user-agent": "simon-windows-native-qa",
    },
    redirect: "manual", signal: AbortSignal.timeout(10_000),
  });
  return response;
}
async function githubJson(endpoint) {
  const response = await github(endpoint);
  requireThat(response.ok, "github_read_failed");
  return await response.json();
}
async function health(boundary) {
  let body;
  try {
    const response = await fetch("https://simon.maat.work/api/health", {
      redirect: "error", signal: AbortSignal.timeout(3_000), headers: { "cache-control": "no-cache" },
    });
    requireThat(response.status === 200, "public_health_failed");
    // Health only: no auth token, model warmup, chat endpoint or API-only login.
    body = await response.json();
  } catch (error) {
    if (error instanceof QaError) throw error;
    throw new QaError("public_health_failed");
  }
  checkHealth(body);
  // Only the fixed endpoint/contract and last guarded boundary leave this call.
  // Never persist the health body, credentials, session or restored history.
  await record("backend", {
    endpoint: "https://simon.maat.work/api/health", httpStatus: 200,
    chatResume: "read-only-v1", checkedBefore: boundary,
  });
}
async function assertTrustedRun() {
  const [repository, head] = await Promise.all([
    githubJson(`/repos/${REPO}`), githubJson(`/repos/${REPO}/commits/main`),
  ]);
  checkRun(process.env, repository, head);
}
async function downloadAsset(asset) {
  let response = await github(`/repos/${REPO}/releases/assets/${asset.id}`, "application/octet-stream");
  if (response.status === 302) {
    const target = new URL(response.headers.get("location"));
    requireThat(target.protocol === "https:" && target.hostname === "release-assets.githubusercontent.com" &&
      !target.username && !target.password, "asset_redirect_rejected");
    // Never forward GITHUB_TOKEN to a redirected object store.
    response = await fetch(target, { redirect: "error", signal: AbortSignal.timeout(60_000) });
  }
  requireThat(response.status === 200, "asset_download_failed");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    requireThat(size <= asset.size, "asset_size_mismatch");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks, size);
  requireThat(size === asset.size && `sha256:${sha256(bytes)}` === asset.digest, "asset_checksum_mismatch");
  return bytes;
}
async function downloadRelease(label, identity, draft) {
  const endpoint = `/repos/${REPO}/releases/${identity.releaseId}`;
  const release = await githubJson(endpoint);
  const assets = checkRelease(release, identity, draft);
  const [installer, signature, manifestBytes] = await Promise.all([
    downloadAsset(assets.installer), downloadAsset(assets.signature), downloadAsset(assets.manifest),
  ]);
  const signatureText = signature.toString("utf8").trim();
  const signerKeyId = verifyUpdater(installer, signatureText, identity.version);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const windows = manifest.platforms?.["windows-x86_64"];
  requireThat(manifest.version === identity.version && windows?.signature === signatureText &&
    windows?.url === `https://github.com/${REPO}/releases/download/v${identity.version}/Simon-setup.exe`,
  "updater_manifest_mismatch");
  // Draft assets can change. Re-read their identities before any execution.
  const again = checkRelease(await githubJson(endpoint), identity, draft);
  for (const name of ["installer", "signature", "manifest"]) {
    requireThat(again[name].id === assets[name].id && again[name].digest === assets[name].digest,
      "release_assets_changed");
  }
  await fs.writeFile(path.join(root(), `${label}-setup.exe`), installer);
  return {
    version: identity.version, releaseId: identity.releaseId, assetId: identity.assetId,
    sha256: identity.sha256, signatureAssetId: assets.signature.id, signerKeyId,
    updaterSignature: "verified", releaseState: draft ? "draft" : "published",
  };
}
async function prepare() {
  root();
  await fs.mkdir(root(), { recursive: false });
  await assertTrustedRun();
  const mode = process.env.SIMON_QA_MODE;
  const candidateInputs = [process.env.SIMON_QA_CANDIDATE_RELEASE_ID, process.env.SIMON_QA_CANDIDATE_ASSET_ID,
    process.env.SIMON_QA_CANDIDATE_SHA256];
  let candidate;
  if (mode === "baseline-login") {
    requireThat(candidateInputs.every((value) => !value), "baseline_has_candidate_inputs");
  } else {
    requireThat(/^[a-f0-9]{64}$/.test(candidateInputs[2] ?? ""), "invalid_candidate_checksum");
    candidate = {
      version: CANDIDATE_VERSION, releaseId: numericId(candidateInputs[0]),
      assetId: numericId(candidateInputs[1]), sha256: candidateInputs[2],
    };
  }
  await record("run", {
    url: runUrl(), workflowSha: process.env.GITHUB_SHA, mode,
    runner: "windows-2025", sourceCheckout: "public-binary-repository-only",
  });
  await record("generation", {
    state: mode === "full-generation" ? "not-dispatched" : "not-requested",
    requestCount: 0, attemptCount: 0, deadlineMs: 30_000,
  });
  await health("prepare");
  const baseline = await downloadRelease("baseline", BASELINE, false);
  const selectedCandidate = candidate ? await downloadRelease("candidate", candidate, true) : null;
  await writeJson("selection.json", {
    baseline, candidate: selectedCandidate, mode,
    installDirectory: path.join(root(), "installed"),
    executable: path.join(root(), "installed", "simon.exe"),
    webviewDirectory: path.join(root(), "webview"),
  });
  await record("assets", { baseline, candidate: selectedCandidate, upgradeMethod: "manual-nsis-not-updater" });
}
async function stopNative(expectedState) {
  let state = expectedState;
  if (!state) {
    try { state = await readJson("native.json"); } catch { return; }
  }
  const selection = await readJson("selection.json");
  requireThat(state.executable === selection.executable && Number.isSafeInteger(state.pid) && state.pid > 0,
    "native_process_identity_invalid");
  // Match executable path as well as PID; never terminate a reused PID or a
  // process outside this new hosted VM's private installation directory.
  const command = "$p = Get-Process -Id $env:SIMON_QA_PROCESS_ID -ErrorAction SilentlyContinue; " +
    "if ($p) { if ($p.Path -cne $env:SIMON_QA_PROCESS_PATH) { exit 2 }; " +
    "& taskkill.exe /PID $p.Id /T /F | Out-Null; if ($LASTEXITCODE -ne 0) { exit 3 } }";
  const result = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", command], {
    env: { ...process.env, SIMON_QA_PROCESS_ID: String(state.pid), SIMON_QA_PROCESS_PATH: selection.executable },
    stdio: "ignore", windowsHide: true, timeout: 15_000,
  });
  requireThat(result.status === 0, "native_cleanup_failed");
  // A detached guardian owns its original PID only. It must never remove a
  // later candidate's state file while handling the baseline socket closing.
  if (!expectedState) await fs.rm(path.join(root(), "native.json"), { force: true });
}
async function summarize() {
  let data;
  try { data = await readJson("evidence.json"); } catch {
    data = { schema: "simon-windows-qa/v1", result: "incomplete_before_evidence" };
  }
  // Only this structured evidence file is emitted. No stdout/stderr from the
  // application, Playwright error/locator messages, HAR, trace, DOM or image.
  const permitted = ["schema", "result", "run", "backend", "assets", "installBaseline", "installCandidate", "loginBaseline",
    "loginCandidate", "telemetry", "consent", "generation", "failure"];
  const publicEvidence = Object.fromEntries(permitted.filter((name) => data[name] !== undefined).map((name) => [name, data[name]]));
  publicEvidence.releaseAcceptance = "not-claimed";
  publicEvidence.updaterInstall = "not-exercised";
  const text = JSON.stringify(publicEvidence, null, 2);
  requireThat(text.length <= 24_000 && !text.includes("```") && !/[<>]/.test(text), "invalid_evidence");
  requireThat(typeof process.env.GITHUB_STEP_SUMMARY === "string", "summary_unavailable");
  await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,
    `## Installed Windows native QA\n\nThis is measured UI evidence, not a release approval.\n\n\`\`\`json\n${text}\n\`\`\`\n`);
}
async function cli(action, operation) {
  try {
    await operation();
  } catch (error) {
    const code = error instanceof QaError ? error.code : `${action}_unexpected_failure`;
    try { await record("failure", { stage: action, code }); } catch { /* No unsafe fallback logging. */ }
    process.stderr.write(`Windows QA blocked: ${code}\n`);
    process.exitCode = 1;
  }
}
if (require.main === module) {
  const action = process.argv[2];
  const operations = { prepare, cleanup: stopNative, summarize, health: async () => {
    const label = process.argv[3];
    requireThat(label === "baseline" || label === "candidate", "invalid_label");
    await health(`${label}-nsis`);
  } };
  void cli(["prepare", "cleanup", "summarize", "health"].includes(action) ? action : "invalid_action", async () => {
    requireThat(Boolean(operations[action]), "invalid_action");
    await operations[action]();
  });
}
module.exports = { root, readJson, writeJson, record, githubJson, health, assertTrustedRun, stopNative, cli };
