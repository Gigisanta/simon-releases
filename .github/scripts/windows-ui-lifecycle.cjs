"use strict";

const { QaError, requireThat } = require("./windows-contract.cjs");

function remaining(deadline) {
  const ms = deadline - Date.now();
  requireThat(Number.isFinite(ms) && ms > 0, "ui_readiness_deadline");
  return ms;
}
async function beforeDeadline(promise, deadline) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new QaError("ui_readiness_deadline")), remaining(deadline));
    })]);
  } finally { clearTimeout(timer); }
}
function profileStateFromSession(session) {
  const stamp = session?.user?.profileCompletedAt;
  if (stamp === null) return "incomplete";
  if (typeof stamp === "string" && /^\d{4}-\d{2}-\d{2}T/.test(stamp) && Number.isFinite(Date.parse(stamp))) return "complete";
  return "unknown";
}
function assertGenerationPrerequisites(state) {
  requireThat(state?.profileState === "complete",
    state?.profileState === "incomplete" ? "profile_incomplete" : "profile_state_unknown");
  requireThat(state.aiConsentGranted === true, "consent_required");
}
async function waitForGenerationComposer(page, state, deadline) {
  assertGenerationPrerequisites(state);
  const composer = page.getByRole("textbox", { name: "Escribí tu mensaje", exact: true });
  try {
    // The response can precede React's commit. Wait for the intersection instead
    // of treating a momentarily absent/disabled composer as denied consent.
    await composer.and(page.locator(":enabled")).waitFor({ state: "visible", timeout: remaining(deadline) });
    requireThat(await composer.count() === 1, "composer_ambiguous");
    remaining(deadline);
    return composer;
  } catch (error) {
    if (error instanceof QaError) throw error;
    throw new QaError("composer_not_ready");
  }
}
function historyRows(body) {
  requireThat(body && Object.hasOwn(body, "resumable"), "history_response_invalid");
  if (body.resumable === null) return [];
  const page = body.resumable;
  requireThat(page && typeof page.id === "string" && Array.isArray(page.messages) &&
    typeof page.orphanTail === "boolean" && (page.nextCursor === null || typeof page.nextCursor === "string"),
  "history_response_invalid");
  const rows = [];
  for (const message of page.messages) {
    requireThat(typeof message?.role === "string" && typeof message.content === "string", "history_response_invalid");
    if (message.role === "user" || message.role === "assistant") rows.push({ role: message.role, text: message.content });
  }
  // A restored pending turn is an uncertain old request, not this run's new
  // synthetic generation. Never click its retry or reuse its client message id.
  requireThat(page.orphanTail === false && rows.at(-1)?.role !== "user", "history_pending_turn");
  return rows;
}
function restoredHistoryMatchesDOM(rows) {
  const logs = document.querySelectorAll('[role="log"][aria-label="Conversación con Simón"]');
  if (logs.length !== 1) return false;
  const log = logs[0];
  const notices = Array.from(log.querySelectorAll('[role="status"], [role="alert"]'));
  if (notices.some((notice) => notice.textContent.includes("Buscando tu última conversación") ||
    notice.textContent.includes("No pudimos traer tu última conversación") ||
    notice.textContent.includes("Tu mensaje sigue pendiente"))) return false;
  const visible = Array.from(log.querySelectorAll("[data-role]"));
  if (visible.length !== rows.length) return false;
  if (rows.length === 0) return log.textContent.includes("Hola, soy Simón");
  return visible.every((element, index) => element.getAttribute("data-role") === rows[index].role &&
    Array.from(element.querySelectorAll("span.whitespace-pre-wrap")).map((span) => span.textContent).join("\n") === rows[index].text);
}
async function waitForHistoryRestored(page, responsePromise, deadline) {
  const response = await beforeDeadline(responsePromise, deadline);
  requireThat(response.status() === 200, "history_resume_http_failed");
  let body;
  try { body = await beforeDeadline(response.json(), deadline); } catch (error) {
    if (error instanceof QaError) throw error;
    throw new QaError("history_response_invalid");
  }
  const rows = historyRows(body);
  try {
    await page.waitForFunction(restoredHistoryMatchesDOM, rows, { timeout: remaining(deadline) });
  } catch (error) {
    if (error instanceof QaError) throw error;
    throw new QaError("history_restore_not_ready");
  }
  remaining(deadline);
  // Only counts leave this function. Never persist history ids, titles or text.
  return { responseStatus: 200, restoredUI: true, messageCount: rows.length,
    assistantCount: rows.filter((row) => row.role === "assistant").length, pendingTurn: false };
}
async function snapshotAndClickOnce(page, send, history, deadline) {
  requireThat(history?.restoredUI === true && history.responseStatus === 200 && history.pendingTurn === false,
    "history_not_settled");
  const assistants = await page.locator('[role="log"] [data-role="assistant"]').count();
  requireThat(assistants === history.assistantCount, "history_changed_after_readiness");
  // No API request, wait-for-admission, reload or other awaited work belongs
  // between this DOM snapshot and the ONE already-admitted native UI click.
  await send.click({ timeout: remaining(deadline) });
  return assistants;
}

module.exports = {
  profileStateFromSession, assertGenerationPrerequisites, waitForGenerationComposer,
  waitForHistoryRestored, snapshotAndClickOnce,
};
