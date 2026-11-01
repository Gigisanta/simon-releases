"use strict";

const crypto = require("node:crypto");

const REPO = "Gigisanta/simon-releases";
const WORKFLOW = `${REPO}/.github/workflows/windows-native-qa.yml@refs/heads/main`;
const BASELINE = Object.freeze({
  version: "0.1.9", releaseId: 401934333, assetId: 605890659,
  sha256: "2a3307a5a49e3ee06ef59c7c750c132df56e1e3ccf00d8ca91b2a29fe316807d",
});
const CANDIDATE_VERSION = "0.1.12";
// Public updater identity already shipped in 0.1.9. This is NOT Authenticode.
const UPDATER_PUBLIC_KEY = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDU1RjZFRkREQzUwM0YyQTcKUldTbjhnUEYzZS8yVmEraklGRnZUSDc3MGgrc2twRXl4ZjJvVUtIbzlUUGYycFdXSVNsaUhqWHEK";
const PROMPT = "Ejercicio de ficción sin datos personales: escribí una oración breve sobre una cometa violeta de papel. Incluí las palabras cometa y violeta.";
const FIXTURE_ID = "simon-qa-native-v1";
const DEADLINE_MS = 30_000;

class QaError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function requireThat(condition, code) {
  if (!condition) throw new QaError(code);
}
function numericId(value) {
  requireThat(/^[1-9][0-9]{0,14}$/.test(String(value)), "invalid_identity");
  const result = Number(value);
  requireThat(Number.isSafeInteger(result), "invalid_identity");
  return result;
}
function sha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
function runUrl(env = process.env) {
  numericId(env.GITHUB_RUN_ID);
  numericId(env.GITHUB_RUN_ATTEMPT);
  return `https://github.com/${REPO}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT}`;
}
function checkRun(env, repository, head) {
  requireThat(env.GITHUB_REPOSITORY === REPO && env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
    env.GITHUB_REF === "refs/heads/main" && env.GITHUB_WORKFLOW_REF === WORKFLOW &&
    env.GITHUB_RUN_ATTEMPT === "1" && /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") &&
    env.GITHUB_WORKFLOW_SHA === env.GITHUB_SHA, "untrusted_workflow_ref");
  requireThat(repository.full_name === REPO && repository.private === false &&
    repository.default_branch === "main" && repository.archived === false &&
    repository.fork === false && head.sha === env.GITHUB_SHA, "default_branch_changed");
  requireThat(["baseline-login", "upgrade-login", "full-generation"].includes(env.SIMON_QA_MODE), "invalid_mode");
  runUrl(env);
}
function oneAsset(release, name) {
  const matches = release.assets?.filter((asset) => asset.name === name) ?? [];
  requireThat(matches.length === 1, "ambiguous_release_asset");
  const asset = matches[0];
  numericId(asset.id);
  requireThat(asset.state === "uploaded" && Number.isSafeInteger(asset.size) && asset.size > 0 &&
    asset.size <= 100_000_000 && /^sha256:[a-f0-9]{64}$/.test(asset.digest ?? ""), "invalid_release_asset");
  return asset;
}
function checkRelease(release, identity, draft) {
  requireThat(release.id === identity.releaseId && release.tag_name === `v${identity.version}` &&
    release.draft === draft && (draft ? release.published_at === null : typeof release.published_at === "string"),
  "release_identity_mismatch");
  const installer = oneAsset(release, "Simon-setup.exe");
  requireThat(installer.id === identity.assetId && installer.digest === `sha256:${identity.sha256}`,
    "installer_identity_mismatch");
  return { installer, signature: oneAsset(release, "Simon-setup.exe.sig"), manifest: oneAsset(release, "latest.json") };
}
function decode64(value) {
  requireThat(typeof value === "string" && value.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value), "invalid_signature_encoding");
  const bytes = Buffer.from(value, "base64");
  requireThat(bytes.toString("base64") === value, "invalid_signature_encoding");
  return bytes;
}
function verifyUpdater(bytes, signatureText, version) {
  const publicLines = Buffer.from(UPDATER_PUBLIC_KEY, "base64").toString("utf8").trim().split(/\r?\n/);
  const key = decode64(publicLines[1]);
  const lines = decode64(signatureText.trim()).toString("utf8").trim().split(/\r?\n/);
  requireThat(key.length === 42 && key.subarray(0, 2).toString() === "Ed" && lines.length === 4 &&
    lines[0].startsWith("untrusted comment: ") && lines[2].startsWith("trusted comment: "), "invalid_signature_format");
  const signature = decode64(lines[1]);
  const globalSignature = decode64(lines[3]);
  requireThat(signature.length === 74 && globalSignature.length === 64 &&
    signature.subarray(2, 10).equals(key.subarray(2, 10)), "updater_signer_mismatch");
  const algorithm = signature.subarray(0, 2).toString();
  requireThat(algorithm === "ED" || algorithm === "Ed", "invalid_signature_algorithm");
  const publicKey = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key.subarray(10)]),
    format: "der", type: "spki",
  });
  const signedBytes = algorithm === "ED" ? crypto.createHash("blake2b512").update(bytes).digest() : bytes;
  requireThat(crypto.verify(null, signedBytes, publicKey, signature.subarray(10)), "updater_signature_invalid");
  const trustedComment = lines[2].slice("trusted comment: ".length);
  requireThat(crypto.verify(null, Buffer.concat([signature.subarray(10), Buffer.from(trustedComment)]), publicKey, globalSignature),
    "updater_comment_invalid");
  requireThat(trustedComment.split("\t").includes(`file:Simón_${version}_x64-setup.exe`), "signed_version_identity_mismatch");
  return "55F6EFDDC503F2A7";
}
function outsideQuietWindow(now = Date.now()) {
  const hour = Number(new Intl.DateTimeFormat("en", {
    timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", hourCycle: "h23",
  }).format(now));
  // The whole deadline, not just the click, must remain outside 01:00–08:00 ART.
  const endHour = Number(new Intl.DateTimeFormat("en", {
    timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", hourCycle: "h23",
  }).format(now + DEADLINE_MS));
  requireThat((hour < 1 || hour >= 8) && (endHour < 1 || endHour >= 8), "quiet_window");
}
function checkAdmission(statuses, env, candidateSha, now = Date.now()) {
  const context = `qa-windows/admission/${env.GITHUB_RUN_ID}/${env.GITHUB_RUN_ATTEMPT}`;
  const matching = statuses.filter((status) => status.context === context);
  requireThat(matching.length === 1, "admission_missing_or_replayed");
  const status = matching[0];
  const created = Date.parse(status.created_at);
  const description = /^([a-f0-9]{64}):([0-9]{10})$/.exec(status.description ?? "");
  requireThat(status.state === "success" && status.creator?.login === "Gigisanta" &&
    status.target_url === runUrl(env) && description && description[1] === candidateSha &&
    Number.isSafeInteger(status.id) && Number.isFinite(created) && now >= created && now - created <= 10_000,
  "admission_invalid_or_stale");
  const expires = Number(description[2]) * 1000;
  requireThat(expires >= now + DEADLINE_MS && expires <= created + 45_000, "admission_expired");
  outsideQuietWindow(now);
  return { id: status.id, context, createdAt: status.created_at, expiresEpoch: Number(description[2]) };
}
function checkFixture(data, expectedEmail) {
  requireThat(data?.user?.id === FIXTURE_ID && data.user.role === "self" &&
    (expectedEmail === undefined || (typeof expectedEmail === "string" && expectedEmail.length > 0 && data.user.email === expectedEmail)),
  "qa_fixture_session_mismatch");
}

module.exports = {
  REPO, WORKFLOW, BASELINE, CANDIDATE_VERSION, PROMPT, FIXTURE_ID, DEADLINE_MS,
  QaError, requireThat, numericId, sha256, runUrl, checkRun, checkRelease, verifyUpdater,
  outsideQuietWindow, checkAdmission, checkFixture,
};
