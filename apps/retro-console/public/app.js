import { createI18n } from "./i18n.js";

const $ = (selector) => document.querySelector(selector);
const i18n = createI18n();
const t = (key, values) => i18n.t(key, values);

const state = {
  walletConnected: false,
  aiConfigured: false,
  aiProvider: "deterministic",
  language: i18n.language,
};

const decisionTones = {
  ALLOW: "allow",
  DENY: "deny",
  REWRITE: "rewrite",
  REQUIRE_APPROVAL: "approval",
};

function decisionMeta(decision, fallbackTitle = t("result.default")) {
  const tone = decisionTones[decision] ?? "neutral";
  return {
    tone,
    label: i18n.lookup(`decision.${decision}.label`) ?? fallbackTitle,
    description: i18n.lookup(`decision.${decision}.description`) ?? t("result.description"),
  };
}

function policyExplanation(result, fallback) {
  return i18n.lookup(`reason.${result.reasonCode}`) ?? result.explanation ?? fallback;
}

function localizedProtections(reasonCode) {
  const specific = i18n.lookup(`protection.${reasonCode}`);
  return [t("protection.llm"), t("protection.secrets"), specific ?? t("protection.default")];
}

function errorText(code) {
  const key = `error.${code}`;
  return i18n.lookup(key) ?? code;
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "accept-language": state.language,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers ?? {}),
    },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(errorText(result.error || "REQUEST_FAILED"));
  return result;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function resultRow(label, value, className = "") {
  const row = element("div", "result-row");
  row.append(element("b", "", label), element("span", className, value));
  return row;
}

function decisionBanner(result, fallbackTitle = t("result.default")) {
  const meta = decisionMeta(result.decision, fallbackTitle);
  const banner = element("div", `decision-banner ${meta.tone}`);
  banner.append(
    element("small", "", t("result.policy")),
    element("strong", "", meta.label),
    element("span", "", policyExplanation(result, meta.description)),
  );
  return banner;
}

function walletBanner(result, fallbackTitle) {
  if (typeof result.affordable !== "boolean") return decisionBanner(result, fallbackTitle);
  const affordable = result.affordable;
  const banner = element("div", `decision-banner ${affordable ? "allow" : "deny"}`);
  banner.append(
    element("small", "", t("result.affordability")),
    element("strong", "", t(affordable ? "result.sufficient" : "result.insufficient")),
    element("span", "", t(affordable ? "result.sufficientBody" : "result.insufficientBody")),
  );
  return banner;
}

function criticalJson(value) {
  const details = element("details", "raw-json");
  details.open = true;
  details.append(element("summary", "", t("result.json")));
  details.append(element("pre", "", JSON.stringify(value, null, 2)));
  return details;
}

function agentJson(result) {
  return {
    decision: result.policy.decision,
    risk: result.policy.risk,
    reasonCode: result.policy.reasonCode,
    capability: result.agent.capability,
    aiSource: result.agent.source,
    executionPerformed: result.execution.performed,
  };
}

function rememberPaymentId(paymentId) {
  try { window.localStorage.setItem("shadeguard:last-payment-id", paymentId); } catch {}
}

function updateQuickStatus() {
  const paymentId = $("#payment-id").value.trim();
  const disabled = !state.walletConnected || !paymentId;
  $("#quick-status").disabled = disabled;
  $("#status-submit").disabled = disabled;
  $("#known-payment-note").textContent = paymentId
    ? t("track.known", { id: `${paymentId.slice(0, 10)}…${paymentId.slice(-8)}` })
    : t("track.empty");
}

function walletJson(result) {
  const affordability = typeof result.affordable === "boolean";
  return {
    ...(affordability
      ? {
        policyDecision: result.decision,
        fundsResult: result.affordable ? "AFFORDABLE" : "INSUFFICIENT_FUNDS",
      }
      : { decision: result.decision }),
    risk: result.risk,
    reasonCode: result.reasonCode,
    ...(affordability ? { affordable: result.affordable } : {}),
    ...(result.receiveAddress ? { receiveAddress: result.receiveAddress } : {}),
    ...(result.payment ? { transaction: { status: result.payment.status, txid: result.payment.paymentId } } : {}),
    ...(result.paymentStatus ? {
      paymentStatus: {
        status: result.paymentStatus.status,
        ...(result.paymentStatus.confirmations === undefined ? {} : { confirmations: result.paymentStatus.confirmations }),
      },
    } : {}),
    ...(result.safeAlternative ? { safeAlternative: result.safeAlternative } : {}),
    ...(result.approval ? { approval: { id: result.approval.id, status: result.approval.status } } : {}),
    ...(Array.isArray(result.approvals) ? {
      approvals: result.approvals.map(({ id, capability, status }) => ({ id, capability, status })),
    } : {}),
  };
}

function renderAgent(result) {
  const target = $("#agent-result");
  target.replaceChildren(decisionBanner(result.policy));
  const grid = element("div", "result-grid");
  grid.append(
    resultRow(t("row.ai"), `${result.agent.source.toUpperCase()} · ${result.agent.capability}`),
    resultRow(t("row.risk"), result.policy.risk),
    resultRow(t("row.reason"), result.policy.reasonCode),
    resultRow(t("row.explanation"), result.agent.explanation),
  );
  if (result.agent.providerNotice) grid.append(resultRow(t("row.aiStatus"), t("provider.fallback")));
  for (const item of localizedProtections(result.policy.reasonCode)) grid.append(resultRow(t("row.protection"), item, "protected"));
  grid.append(resultRow(t("row.execution"), t("execution.preview"), "protected"));
  target.append(grid, criticalJson(agentJson(result)));
}

function renderWallet(result, actionKey) {
  const actionLabel = t(actionKey);
  const target = $("#wallet-result");
  target.replaceChildren(walletBanner(result, actionLabel));
  const grid = element("div", "result-grid");
  grid.append(resultRow(t("row.operation"), actionLabel));
  if (result.risk) grid.append(resultRow(t("row.risk"), result.risk));
  if (result.reasonCode) grid.append(resultRow(t("row.reason"), result.reasonCode));
  if (typeof result.affordable === "boolean") {
    grid.append(resultRow(t("row.affordable"), t(result.affordable ? "value.yes" : "value.no"), result.affordable ? "protected" : "rejected"));
  }
  if (result.receiveAddress) grid.append(resultRow(t("row.receive"), result.receiveAddress));
  if (result.payment?.paymentId) {
    grid.append(resultRow(t("row.txStatus"), result.payment.status));
    grid.append(resultRow("TXID", result.payment.paymentId));
    $("#payment-id").value = result.payment.paymentId;
    rememberPaymentId(result.payment.paymentId);
    updateQuickStatus();
  }
  if (result.paymentStatus) {
    grid.append(resultRow(t("row.chainStatus"), result.paymentStatus.status));
    if (result.paymentStatus.confirmations !== undefined) grid.append(resultRow(t("row.confirmations"), result.paymentStatus.confirmations));
  }
  if (result.safeAlternative) {
    const removed = t(result.safeAlternative.memoRemoved ? "value.yes" : "value.no").toLowerCase();
    grid.append(resultRow(t("row.alternative"), `${result.safeAlternative.capability} · ${t("value.memoRemoved", { value: removed })}`));
  }
  if (result.approval) grid.append(resultRow(t("row.approval"), `${result.approval.status} · ${result.approval.id}`));
  target.append(grid, criticalJson(walletJson(result)));
}

function renderPiiProtection(result) {
  const target = $("#wallet-result");
  const safeAlternative = result.policy.safeAlternative
    ? { capability: result.policy.safeAlternative.capability, memoRemoved: result.policy.safeAlternative.memoRemoved }
    : undefined;
  const summary = {
    decision: result.policy.decision,
    risk: result.policy.risk,
    reasonCode: result.policy.reasonCode,
    ...(safeAlternative ? { safeAlternative } : {}),
  };
  target.replaceChildren(decisionBanner(result.policy));
  const grid = element("div", "result-grid");
  grid.append(
    resultRow(t("row.operation"), t("pii.operation")),
    resultRow(t("row.risk"), result.policy.risk),
    resultRow(t("row.reason"), result.policy.reasonCode),
    resultRow(t("row.protection"), t("pii.protection"), "protected"),
    resultRow(t("row.execution"), t("execution.pii"), "protected"),
  );
  target.append(grid, criticalJson(summary));
}

function renderFailure(target, message) {
  target.replaceChildren();
  const result = { decision: "DENY", explanation: message, error: message };
  target.append(decisionBanner(result), criticalJson({ decision: result.decision, error: result.error }));
}

async function loadStatus() {
  const status = await request("/api/status");
  state.walletConnected = status.wallet.connected;
  state.aiConfigured = status.ai.configured;
  state.aiProvider = status.ai.provider;
  $("#wallet-status").textContent = t(status.wallet.connected ? "status.connected" : "status.offline");
  $("#wallet-dot").className = status.wallet.connected ? "on" : "warn";
  $("#ai-status").textContent = status.ai.configured ? status.ai.provider.toUpperCase() : t("status.local");
  $("#ai-dot").className = status.ai.configured ? "on" : "warn";
  const note = $("#wallet-note");
  if (status.wallet.connected) {
    note.className = "wallet-note ok";
    note.textContent = t("wallet.connectedNote", { provider: status.wallet.provider, version: status.wallet.version });
  } else {
    note.className = "wallet-note";
    note.textContent = t("wallet.offlineNote");
  }
  for (const button of document.querySelectorAll("#panel-wallet button")) button.disabled = !status.wallet.connected;
  $("#approvals-button").disabled = false;
  updateQuickStatus();
}

function approvalDescription(approval) {
  const amount = approval.amountZatoshi === undefined ? "" : ` · ${(approval.amountZatoshi / 100_000_000).toFixed(8)} TAZ`;
  return `${approval.capability}${amount} · ${approval.reasonCode} · ${approval.status}`;
}

async function loadApprovals(renderEmpty = false) {
  const result = await request("/api/approvals");
  const target = $("#approval-list");
  target.replaceChildren();
  const pending = result.approvals.filter((approval) => approval.status === "PENDING");
  if (!pending.length) {
    if (renderEmpty) target.append(element("p", "empty-state", t("approval.empty")));
    return result;
  }
  for (const approval of pending) {
    const card = element("div", "approval-card");
    card.append(element("p", "", approvalDescription(approval)));
    const button = element("button", "", t("approval.button"));
    button.type = "button";
    button.addEventListener("click", async () => {
      if (!window.confirm(t("approval.confirm"))) return;
      button.disabled = true;
      try {
        const resumed = await request(`/api/approvals/${approval.id}/approve`, { method: "POST", body: "{}" });
        renderWallet(resumed, "action.approved");
        await Promise.all([loadApprovals(true), loadAudit()]);
      } catch (error) {
        renderFailure($("#wallet-result"), error.message);
      } finally {
        button.disabled = false;
      }
    });
    card.append(button);
    target.append(card);
  }
  return result;
}

async function loadAudit() {
  const { events } = await request("/api/audit");
  const target = $("#audit-list");
  target.replaceChildren();
  if (!events.length) {
    target.append(element("p", "empty-state", t("audit.empty")));
    return;
  }
  for (const event of events) {
    const row = element("div", "audit-event");
    const locale = state.language === "tr" ? "tr-TR" : "en-US";
    const time = element("time", "", new Date(event.timestamp).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    const capability = element("b", "", event.capability);
    const meta = decisionMeta(event.decision, event.decision);
    const decision = element("span", `audit-decision ${meta.tone}`, meta.label);
    row.append(time, capability, decision);
    target.append(row);
  }
}

i18n.applyDocument();

$("#language-toggle").addEventListener("click", () => {
  i18n.switchLanguage();
  window.location.reload();
});

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item === tab));
    document.querySelectorAll(".panel").forEach((panel) => panel.classList.toggle("active", panel.id === `panel-${tab.dataset.tab}`));
    if (tab.dataset.tab === "audit") void loadAudit();
    if (tab.dataset.tab === "wallet") void loadApprovals(false);
  });
});

document.querySelectorAll("[data-run-prompt]").forEach((button) => {
  button.addEventListener("click", () => {
    $("#instruction").value = button.dataset.runPrompt;
    $("#agent-form").requestSubmit();
  });
});

$("#agent-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  $("#agent-result").replaceChildren(element("p", "empty-state", t(state.aiConfigured ? "loading.nvidia" : "loading.local")));
  try {
    renderAgent(await request("/api/agent/analyze", { method: "POST", body: JSON.stringify({ instruction: $("#instruction").value }) }));
    await loadAudit();
  } catch (error) {
    renderFailure($("#agent-result"), t("error.analysis", { message: error.message }));
  } finally {
    button.disabled = false;
  }
});

$("#afford-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    renderWallet(await request("/api/wallet/can-afford", {
      method: "POST",
      body: JSON.stringify({ amountZec: $("#afford-amount").value, purpose: "Retro console minimum-information check" }),
    }), "action.afford");
    await loadAudit();
  } catch (error) { renderFailure($("#wallet-result"), error.message); }
});

$("#quick-afford").addEventListener("click", () => {
  $("#afford-amount").value = "0.01";
  $("#afford-form").requestSubmit();
});

$("#quick-pii").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const recipient = $("#recipient").value.trim()
      || "ztestsapling1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
    const result = await request("/api/agent/analyze", {
      method: "POST",
      body: JSON.stringify({ instruction: t("prompt.pii", { recipient }) }),
    });
    renderPiiProtection(result);
    await loadAudit();
  } catch (error) {
    renderFailure($("#wallet-result"), error.message);
  } finally {
    button.disabled = !state.walletConnected;
  }
});

$("#send-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!window.confirm(t("confirm.send"))) return;
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const result = await request("/api/wallet/send", {
      method: "POST",
      body: JSON.stringify({
        recipient: $("#recipient").value,
        amountZec: $("#send-amount").value,
        purpose: $("#purpose").value,
        memo: $("#memo").value || undefined,
        acceptSafeRewrite: $("#accept-rewrite").checked,
      }),
    });
    renderWallet(result, "action.send");
    await Promise.all([loadApprovals(false), loadAudit()]);
  } catch (error) { renderFailure($("#wallet-result"), error.message); }
  finally { button.disabled = false; }
});

$("#status-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    renderWallet(await request("/api/wallet/status", {
      method: "POST",
      body: JSON.stringify({ paymentId: $("#payment-id").value }),
    }), "action.status");
    await loadAudit();
  } catch (error) { renderFailure($("#wallet-result"), error.message); }
});

$("#quick-status").addEventListener("click", () => $("#status-form").requestSubmit());

$("#receive-button").addEventListener("click", async () => {
  try {
    renderWallet(await request("/api/wallet/receive", {
      method: "POST",
      body: JSON.stringify({ purpose: "Testnet demo wallet funding" }),
    }), "action.receive");
    await loadAudit();
  } catch (error) { renderFailure($("#wallet-result"), error.message); }
});

$("#approvals-button").addEventListener("click", async () => {
  try {
    const result = await loadApprovals(true);
    renderWallet(result, "action.approvals");
  } catch (error) { renderFailure($("#wallet-result"), error.message); }
});

$("#audit-refresh").addEventListener("click", () => void loadAudit());

try {
  $("#payment-id").value = window.localStorage.getItem("shadeguard:last-payment-id") || "";
} catch {}

void Promise.all([loadStatus(), loadAudit(), loadApprovals(false)]).catch(() => {
  $("#wallet-note").textContent = t("wallet.backendUnavailable");
});
