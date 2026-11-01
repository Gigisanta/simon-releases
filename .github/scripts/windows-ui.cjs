"use strict";

const { spawn, spawnSync } = require("node:child_process");
const net = require("node:net");
const { randomUUID } = require("node:crypto");
const { chromium } = require("playwright-core");
const admittedAction = require("./admitted-action.cjs");
const {
  REPO, PROMPT, DEADLINE_MS, QaError, requireThat, checkFixture,
  checkAdmission, checkRelease, outsideQuietWindow,
} = require("./windows-contract.cjs");
const { root, readJson, writeJson, record, githubJson, health, assertTrustedRun, stopNative, cli } = require("./windows-native-qa.cjs");
const {
  profileStateFromSession, assertGenerationPrerequisites, waitForGenerationComposer,
  waitForHistoryRestored, snapshotAndClickOnce,
} = require("./windows-ui-lifecycle.cjs");

const ORIGIN = "https://tauri.localhost";
const API = "https://simon.maat.work";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const remaining = (deadline) => {
  const ms = deadline - Date.now();
  requireThat(ms > 0, "ui_deadline");
  return ms;
};
function isApi(response, pathname) {
  const url = new URL(response.url());
  return url.origin === API && url.pathname === pathname && !url.search;
}
function isResume(response) {
  const url = new URL(response.url());
  return url.origin === API && url.pathname === "/api/chat/resume" && url.search === "?allowOrphan=1" &&
    response.request().method() === "GET";
}
function isNative(page) {
  try { return new URL(page.url()).origin === ORIGIN; } catch { return false; }
}
async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function nativeEnvironment(port, selection) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/TOKEN|SECRET|PASSWORD|EMAIL|PRIVATE_KEY|^SIMON_QA_|^DEBUG$|^PWDEBUG$/.test(name)) delete env[name];
  }
  env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-address=127.0.0.1 --remote-debugging-port=${port}`;
  env.WEBVIEW2_USER_DATA_FOLDER = selection.webviewDirectory;
  env.WEBVIEW2_WAIT_FOR_SCRIPT_DEBUGGER = "1";
  return env;
}
async function guardianState(state) {
  const guardian = await readJson(`telemetry-${state.label}.json`);
  requireThat(guardian.schema === "simon-cdp-guardian/v1" && guardian.bootId === state.guardBootId &&
    guardian.nativePid === state.pid && guardian.guardianPid === state.guardPid &&
    guardian.phase === "running" && Number.isSafeInteger(guardian.heartbeatAt) &&
    Date.now() - guardian.heartbeatAt >= 0 && Date.now() - guardian.heartbeatAt <= 5000 &&
    guardian.proof?.preexistingParsedScripts === 0 && guardian.proof.hookAcknowledgedBeforeResume === true,
  "telemetry_guard_not_live");
  return guardian;
}
async function telemetryEvidence(page, state) {
  const guardian = await guardianState(state);
  const hook = await page.evaluate(() => window[Symbol.for("simon.qa.telemetry.guard.v1")]?.());
  requireThat(hook?.schema === "simon-telemetry-guard/v1" && hook.bootId === state.guardBootId &&
    hook.fetchGuarded === true && hook.bridgeArmed === true && hook.bridgeGuarded === true &&
    Number.isSafeInteger(hook.fetchBlocked) && Number.isSafeInteger(hook.invokeBlocked), "telemetry_guard_not_ready");
  return { ...guardian.proof, guardedScripts: guardian.guardedScripts,
    windowFetchGuarded: true, tauriHttpInvokeGuarded: true,
    fetchBlocked: hook.fetchBlocked, invokeBlocked: hook.invokeBlocked, zeroFootprint: "not-claimed" };
}
async function attach(state, deadline) {
  requireThat(Number.isSafeInteger(state.pid) && state.pid > 0 && Number.isInteger(state.port) && state.port > 0,
    "native_process_identity_invalid");
  const selection = await readJson("selection.json");
  requireThat(state.executable === selection.executable, "native_process_identity_invalid");
  const windowCheck = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command",
    "$p = Get-Process -Id $env:SIMON_QA_PROCESS_ID -ErrorAction Stop; " +
    "if ($p.Path -cne $env:SIMON_QA_PROCESS_PATH) { exit 2 }; " +
    "if ($p.MainWindowHandle -eq 0) { exit 3 }"], {
    env: { ...process.env, SIMON_QA_PROCESS_ID: String(state.pid), SIMON_QA_PROCESS_PATH: state.executable },
    stdio: "ignore", windowsHide: true, timeout: Math.min(5000, remaining(deadline)),
  });
  requireThat(windowCheck.status === 0, "native_window_unavailable");
  // Playwright may not be the first CDP client: the raw guardian must already
  // have proven its bootstrap pause and acknowledged both scoped hooks.
  await guardianState(state);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${state.port}`, { timeout: remaining(deadline) });
  let pages;
  do {
    pages = browser.contexts().flatMap((context) => context.pages()).filter(isNative);
    requireThat(pages.length <= 1, "ambiguous_native_webview");
    if (pages.length === 1) break;
    await pause(Math.min(100, remaining(deadline)));
  } while (remaining(deadline));
  requireThat(pages.length === 1 && browser.contexts().length === 1, "native_webview_missing");
  const page = pages[0];
  page.setDefaultTimeout(5000);
  page.setDefaultNavigationTimeout(5000);
  return { browser, page, context: page.context(), nativeState: state };
}
async function launch(label, deadline) {
  const selection = await readJson("selection.json");
  const port = await unusedPort();
  const child = spawn(selection.executable, [], {
    env: nativeEnvironment(port, selection), stdio: "ignore", detached: true, windowsHide: false,
  });
  let launchFailed = false;
  child.once("error", () => { launchFailed = true; });
  requireThat(Number.isSafeInteger(child.pid), "native_launch_failed");
  child.unref();
  const state = { pid: child.pid, port, executable: selection.executable, label, guardBootId: randomUUID() };
  await writeJson("native.json", state);
  // Wait only for the native app's local CDP endpoint; never start a browser.
  while (true) {
    requireThat(!launchFailed && child.exitCode === null, "native_exited_during_startup");
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(Math.min(500, remaining(deadline))), redirect: "error",
      });
      if (response.ok) { await response.body?.cancel(); break; }
    } catch (error) {
      if (error instanceof QaError) throw error;
    }
    await pause(Math.min(100, remaining(deadline)));
  }
  const guardianEnv = nativeEnvironment(port, selection);
  guardianEnv.SIMON_QA_ROOT = process.env.SIMON_QA_ROOT;
  const guardian = spawn(process.execPath, [require.resolve("./windows-cdp-guard.cjs"), label, state.guardBootId, String(deadline)], {
    env: guardianEnv, stdio: "ignore", detached: true, windowsHide: true,
  });
  let guardianFailed = false;
  guardian.once("error", () => { guardianFailed = true; });
  requireThat(Number.isSafeInteger(guardian.pid), "telemetry_guard_launch_failed");
  guardian.unref();
  state.guardPid = guardian.pid;
  await writeJson("native.json", state);
  while (true) {
    requireThat(!guardianFailed && guardian.exitCode === null, "telemetry_guard_exited");
    let status;
    try { status = await readJson(`telemetry-${label}.json`); } catch { /* Not ready yet. */ }
    if (status?.bootId === state.guardBootId) {
      requireThat(status.phase === "bootstrapping" || status.phase === "running", "telemetry_guard_blocked");
      if (status.phase === "running") break;
    }
    await pause(Math.min(50, remaining(deadline)));
  }
  return await attach(state, deadline);
}
async function chatBlocker(context) {
  let attempts = 0;
  await context.route(/^https:\/\/simon\.maat\.work\/api\/chat(?:\?.*)?$/, async (route) => {
    if (route.request().method() === "POST") {
      attempts += 1;
      await route.abort("blockedbyclient");
    } else {
      await route.continue();
    }
  });
  return () => requireThat(attempts === 0, "unrequested_chat_attempt");
}
async function login(label) {
  requireThat(label === "baseline" || label === "candidate", "invalid_label");
  const email = process.env.SIMON_QA_EMAIL;
  const password = process.env.SIMON_QA_PASSWORD;
  requireThat(typeof email === "string" && email.length > 0 && typeof password === "string" && password.length > 0,
    "qa_credentials_missing");
  const started = Date.now();
  await record("telemetry", {
    scope: "section-view-post-window-fetch-and-tauri-http-invoke",
    startupBarrier: "required-raw-cdp-before-product-script",
    accountExclusion: "owner-account-contract-required",
    zeroFootprint: "not-claimed",
    strictAcceptance: "requires-observed-windows-runtime-proof",
  });
  const { page, context, nativeState } = await launch(label, started + DEADLINE_MS);
  const noChat = await chatBlocker(context);
  await page.locator('input[name="identity"], a[href^="/ingresar"], #chat-titulo').first()
    .waitFor({ state: "visible", timeout: remaining(started + DEADLINE_MS) });
  // Reject an unsupported bridge before entering credentials or navigating.
  await telemetryEvidence(page, nativeState);
  remaining(started + DEADLINE_MS);
  const startupMs = Date.now() - started;
  const loginStarted = Date.now();
  const deadline = loginStarted + DEADLINE_MS;
  let restoredSession = false;
  if (await page.locator("#chat-titulo").count()) {
    // A real upgrade keeps app data/Stronghold and the SAME WebView folder.
    // Then sign out via the app to exercise an actual password login too.
    restoredSession = true;
    const logout = page.getByRole("button", { name: "Cerrar sesión", exact: true });
    requireThat(await logout.count() === 1, "ambiguous_logout_control");
    await logout.click({ timeout: remaining(deadline) });
  }
  if (await page.getByRole("link", { name: "Ya tengo cuenta", exact: true }).count()) {
    await page.getByRole("link", { name: "Ya tengo cuenta", exact: true }).click({ timeout: remaining(deadline) });
  }
  const identity = page.getByRole("textbox", { name: "Email", exact: true });
  const secret = page.getByLabel("Contraseña", { exact: true });
  await identity.waitFor({ state: "visible", timeout: remaining(deadline) });
  requireThat(await identity.count() === 1 && await secret.count() === 1, "ambiguous_login_control");
  await identity.fill(email, { timeout: remaining(deadline) });
  await secret.fill(password, { timeout: remaining(deadline) });
  const signIn = page.waitForResponse((response) => isApi(response, "/api/auth/sign-in/email") &&
    response.request().method() === "POST", { timeout: remaining(deadline) });
  const session = page.waitForResponse((response) => isApi(response, "/api/auth/get-session") &&
    response.request().method() === "GET", { timeout: remaining(deadline) });
  const consent = page.waitForResponse((response) => isApi(response, "/api/user/ai-consent") &&
    response.request().method() === "GET", { timeout: remaining(deadline) });
  // Mark observations handled immediately; a UI failure must never cause an
  // unhandled Playwright error containing locator/form/credential details.
  for (const observation of [signIn, session, consent]) observation.catch(() => {});
  await page.getByRole("button", { name: "Entrar", exact: true }).click({ timeout: remaining(deadline) });
  const [signInResponse, sessionResponse] = await Promise.all([signIn, session]);
  requireThat(signInResponse.status() === 200 && sessionResponse.status() === 200, "ui_login_rejected");
  const sessionBody = await sessionResponse.json();
  checkFixture(sessionBody, email);
  await page.getByRole("heading", { name: "Chat con Simón", exact: true })
    .waitFor({ state: "visible", timeout: remaining(deadline) });
  const consentResponse = await consent;
  requireThat(consentResponse.status() === 200, "consent_state_unknown");
  const consentBody = await consentResponse.json();
  requireThat(typeof consentBody?.consent?.granted === "boolean", "consent_state_unknown");
  noChat();
  const telemetry = await telemetryEvidence(page, nativeState);
  remaining(deadline);
  const selection = await readJson("selection.json");
  await record(label === "baseline" ? "loginBaseline" : "loginCandidate", {
    state: "completed", version: selection[label].version, startupMs, loginMs: Date.now() - loginStarted,
    nativeWindow: "verified", nativeWebView: "installed-webview2-cdp", login: "native-ui-password",
    fixture: "immutable-test-self", restoredSession, aiConsentGranted: consentBody.consent.granted,
    profileState: profileStateFromSession(sessionBody),
    chatRequests: 0, updaterOffer: "not-asserted", updaterInstall: "not-exercised",
    telemetry,
  });
  if (label === "baseline" || selection.mode !== "full-generation") await stopNative();
  // Candidate/full-generation intentionally keeps the installed app alive for
  // the next exact GitHub step. CLI process exit detaches CDP, not the WebView.
}
async function existingPage() {
  const state = await readJson("native.json");
  requireThat(state.label === "candidate", "candidate_not_running");
  return await attach(state, Date.now() + DEADLINE_MS);
}
async function consent() {
  const { page, context, nativeState } = await existingPage();
  const noChat = await chatBlocker(context);
  const evidence = await readJson("evidence.json");
  requireThat(evidence.loginCandidate?.state === "completed", "candidate_login_missing");
  // An empty self profile is NOT authorization to assert identity/18+/DNI.
  // Fail before the ready/admission step, even if IA was separately granted.
  assertGenerationPrerequisites(evidence.loginCandidate);
  const deadline = Date.now() + DEADLINE_MS;
  const freshSession = page.waitForResponse((response) => isApi(response, "/api/auth/get-session") &&
    response.request().method() === "GET", { timeout: remaining(deadline) });
  const freshConsent = page.waitForResponse((response) => isApi(response, "/api/user/ai-consent") &&
    response.request().method() === "GET", { timeout: remaining(deadline) });
  const freshHistory = page.waitForResponse(isResume, { timeout: remaining(deadline) });
  for (const observation of [freshSession, freshConsent, freshHistory]) observation.catch(() => {});
  // These are requests made by the actual installed UI. The harness does not
  // call auth/profile/consent/history endpoints or click any grant/retry.
  await page.reload({ timeout: remaining(deadline) });
  const [sessionResponse, consentResponse] = await Promise.all([freshSession, freshConsent]);
  requireThat(sessionResponse.status() === 200, "qa_fixture_session_mismatch");
  const sessionBody = await sessionResponse.json();
  checkFixture(sessionBody);
  requireThat(consentResponse.status() === 200, "consent_state_unknown");
  const consentBody = await consentResponse.json();
  const prerequisites = { profileState: profileStateFromSession(sessionBody),
    aiConsentGranted: consentBody?.consent?.granted };
  await waitForGenerationComposer(page, prerequisites, deadline);
  const history = await waitForHistoryRestored(page, freshHistory, deadline);
  await telemetryEvidence(page, nativeState);
  remaining(deadline);
  noChat();
  await writeJson("ui-ready.json", {
    schema: "simon-generation-ui-ready/v1", nativePid: nativeState.pid, guardBootId: nativeState.guardBootId,
    ...prerequisites, history,
  });
  await record("consent", { state: "already-granted-by-owner", grantedByWorkflow: false,
    profileState: prerequisites.profileState, profileCompletedByWorkflow: false, history });
}
async function statuses() {
  const all = [];
  for (let number = 1; number <= 10; number += 1) {
    const page = await githubJson(`/repos/${REPO}/commits/${process.env.GITHUB_SHA}/statuses?per_page=100&page=${number}`);
    requireThat(Array.isArray(page), "admission_history_invalid");
    all.push(...page);
    if (page.length < 100) return all;
  }
  throw new QaError("admission_history_unbounded");
}
async function waitForAdmission(candidateSha) {
  const context = `qa-windows/admission/${process.env.GITHUB_RUN_ID}/${process.env.GITHUB_RUN_ATTEMPT}`;
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    outsideQuietWindow();
    const all = await statuses();
    if (all.some((status) => status.context === context)) return checkAdmission(all, process.env, candidateSha);
    await pause(1000);
  }
  throw new QaError("admission_wait_deadline");
}
async function generate() {
  requireThat(process.env.SIMON_QA_MODE === "full-generation" && process.env.GITHUB_RUN_ATTEMPT === "1", "generation_not_authorized");
  const { page, context, nativeState } = await existingPage();
  const ready = await readJson("ui-ready.json");
  requireThat(ready.schema === "simon-generation-ui-ready/v1" && ready.nativePid === nativeState.pid &&
    ready.guardBootId === nativeState.guardBootId, "ui_preflight_stale");
  const composer = await waitForGenerationComposer(page, ready, Date.now() + DEADLINE_MS);
  const selection = await readJson("selection.json");
  await telemetryEvidence(page, nativeState);
  requireThat(selection.candidate?.version === "0.1.12", "candidate_identity_missing");
  let armed = false;
  let attempts = 0;
  let dispatched = 0;
  let requestIds;
  let routeFailure = null;
  let deadline = 0;
  let finalStatuses;
  await context.route(/^https:\/\/simon\.maat\.work\/api\/chat(?:\?.*)?$/, async (route) => {
    const request = route.request();
    if (request.method() !== "POST") { await route.continue(); return; }
    attempts += 1;
    try {
      requireThat(armed && attempts === 1 && Date.now() < deadline, "extra_or_unadmitted_chat_request");
      // Recheck the issued status at the actual network dispatch too, so UI
      // actionability waiting cannot spend the ten-second freshness allowance.
      checkAdmission(finalStatuses, process.env, selection.candidate.sha256);
      const body = request.postDataJSON();
      requireThat(new URL(request.url()).search === "" && Object.keys(body).sort().join(",") === "clientMessageId,conversationId,text" &&
        body.text === PROMPT && /^[a-zA-Z0-9_-]{8,64}$/.test(body.conversationId) &&
        /^[a-zA-Z0-9_-]{8,64}$/.test(body.clientMessageId), "non_synthetic_chat_request");
      requestIds = { conversationId: body.conversationId, clientMessageId: body.clientMessageId };
      dispatched += 1;
      await route.continue();
    } catch (error) {
      routeFailure = error instanceof QaError ? error.code : "chat_interception_failed";
      await route.abort("blockedbyclient");
    }
  });
  await composer.fill(PROMPT);
  const send = page.getByRole("button", { name: "Enviar mensaje", exact: true });
  await send.and(page.locator(":enabled")).waitFor({ state: "visible", timeout: DEADLINE_MS });
  requireThat(await send.count() === 1, "send_control_unavailable");
  const admission = await waitForAdmission(selection.candidate.sha256);
  let elapsedMs;
  let requestId;
  let generationTelemetry;
  try {
    await admittedAction(async () => {
      await assertTrustedRun();
      const liveRelease = await githubJson(`/repos/${REPO}/releases/${selection.candidate.releaseId}`);
      checkRelease(liveRelease, selection.candidate, true);
      await health();
      await telemetryEvidence(page, nativeState);
      await waitForGenerationComposer(page, ready, Date.now() + DEADLINE_MS);
      finalStatuses = await statuses();
      const fresh = checkAdmission(finalStatuses, process.env, selection.candidate.sha256);
      requireThat(fresh.id === admission.id && attempts === 0, "admission_identity_changed");
      // This precheck is fresh and awaited. It does not reserve the gateway.
      return { exit_code: 0 };
    }, async () => {
      outsideQuietWindow();
      const started = Date.now();
      deadline = started + DEADLINE_MS;
      armed = true;
      const responsePromise = page.waitForResponse((response) => isApi(response, "/api/chat") &&
        response.request().method() === "POST", { timeout: DEADLINE_MS });
      responsePromise.catch(() => {});
      let timer;
      const timedOut = new Promise((_, reject) => {
        timer = setTimeout(() => {
          armed = false;
          // Disconnect the actual native client at the deadline; the owner still
          // owns its guard and must verify backend settlement before release.
          void stopNative().catch(() => {});
          reject(new QaError("generation_deadline_result_uncertain"));
        }, DEADLINE_MS);
      });
      try {
        await Promise.race([(async () => {
          const assistantsBefore = await snapshotAndClickOnce(page, send, ready.history, deadline);
          const response = await responsePromise;
          requireThat(response.status() === 200 && !routeFailure && dispatched === 1 && attempts === 1,
            "ui_generation_http_failed");
          const reply = await response.json();
          requireThat(requestIds && reply.conversationId === requestIds.conversationId &&
            reply.clientMessageId === requestIds.clientMessageId && typeof reply.text === "string" &&
            reply.text.trim().length > 0 && reply.text.length <= 8000 && /\bcometa\b/i.test(reply.text) && /\bvioleta\b/i.test(reply.text),
          "generation_reply_not_synthetic_match");
          await page.waitForFunction(({ text, count }) => {
            const assistants = document.querySelectorAll('[role="log"] [data-role="assistant"]');
            if (assistants.length !== count + 1) return false;
            const rendered = Array.from(assistants[assistants.length - 1].querySelectorAll("span.whitespace-pre-wrap"))
              .map((element) => element.textContent).join("\n");
            return rendered === text;
          }, { text: reply.text, count: assistantsBefore }, { timeout: remaining(deadline) });
          generationTelemetry = await telemetryEvidence(page, nativeState);
          requireThat(!routeFailure && attempts === 1 && dispatched === 1, "extra_chat_request");
          remaining(deadline);
          elapsedMs = Date.now() - started;
          // An opaque server request id allows the local owner to correlate
          // existing inference evidence. No bearer, conversation id or body.
          const observedId = response.headers()["x-request-id"];
          requestId = /^[a-zA-Z0-9_-]{1,64}$/.test(observedId ?? "") ? observedId : null;
        })(), timedOut]);
      } finally {
        armed = false;
        clearTimeout(timer);
      }
    });
    await record("generation", {
      state: "ui-turn-completed", requestCount: dispatched, attemptCount: attempts,
      deadlineMs: DEADLINE_MS, durationMs: elapsedMs, prompt: "fixed-synthetic-cometa-violeta",
      renderedReplyMatchesNativeResponse: true, responseHttpStatus: 200,
      admissionStatusId: admission.id, admissionContext: admission.context,
      admissionCreatedAt: admission.createdAt, admissionExpiresEpoch: admission.expiresEpoch,
      serverRequestId: requestId, providerEvidence: "owner-correlation-required",
      telemetry: generationTelemetry,
    });
  } catch (error) {
    await record("generation", {
      state: dispatched ? "result-uncertain-or-failed-no-retry" : "not-dispatched",
      requestCount: dispatched, attemptCount: attempts, deadlineMs: DEADLINE_MS,
    });
    throw error;
  } finally {
    armed = false;
    await stopNative();
  }
}
const action = process.argv[2];
const operations = { login: () => login(process.argv[3]), consent, generate };
// No debug traces, raw exceptions or error.toString(): they can include filled
// fields, auth bodies or chat text. Exit also detaches the CDP websocket.
void cli(["login", "consent", "generate"].includes(action) ? action : "invalid_action", async () => {
  root();
  requireThat(Boolean(operations[action]), "invalid_action");
  await operations[action]();
}).finally(() => process.exit(process.exitCode ?? 0));
