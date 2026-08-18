const $ = (selector) => document.querySelector(selector);

const state = { walletConnected: false, aiConfigured: false, aiProvider: "deterministic" };

const decisionLabels = {
  ALLOW: { label: "KABUL", tone: "allow", description: "İstek politika sınırları içinde." },
  DENY: { label: "RED", tone: "deny", description: "İstek güvenli şekilde durduruldu." },
  REWRITE: { label: "GÜVENLİ ALTERNATİF", tone: "rewrite", description: "İstek daha az bilgi veya yetki kullanacak şekilde değiştirildi." },
  REQUIRE_APPROVAL: { label: "KULLANICI ONAYI", tone: "approval", description: "Açık kullanıcı onayı olmadan işlem yapılmayacak." },
};

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { "content-type": "application/json" } : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "REQUEST_FAILED");
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

function decisionBanner(result, fallbackTitle = "SONUÇ") {
  const meta = decisionLabels[result.decision] || {
    label: fallbackTitle,
    tone: "neutral",
    description: "İşlem sonucu aşağıda gösteriliyor.",
  };
  const banner = element("div", `decision-banner ${meta.tone}`);
  banner.append(
    element("small", "", "DETERMİNİSTİK POLİTİKA KARARI"),
    element("strong", "", meta.label),
    element("span", "", result.explanation || meta.description),
  );
  return banner;
}

function walletBanner(result, fallbackTitle) {
  if (typeof result.affordable !== "boolean") return decisionBanner(result, fallbackTitle);
  const affordable = result.affordable;
  const banner = element("div", `decision-banner ${affordable ? "allow" : "deny"}`);
  banner.append(
    element("small", "", "ÖDEME YETERLİLİK SONUCU"),
    element("strong", "", affordable ? "YETERLİ BAKİYE" : "YETERSİZ BAKİYE"),
    element("span", "", affordable
      ? "Cüzdan istenen tutarı karşılayabiliyor; tam bakiye açıklanmadı."
      : "Cüzdan istenen tutarı karşılayamıyor; tam bakiye açıklanmadı."),
  );
  return banner;
}

function criticalJson(value) {
  const details = element("details", "raw-json");
  details.open = true;
  details.append(element("summary", "", "KRİTİK JSON · GÖSTER / GİZLE"));
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
    ? `Bilinen açık referans: ${paymentId.slice(0, 10)}…${paymentId.slice(-8)} · shielded alanlar görünmez.`
    : "Bu tarayıcıda henüz bilinen bir gönderim yok.";
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
    resultRow("AI YORUMU", `${result.agent.source.toUpperCase()} · ${result.agent.capability}`),
    resultRow("RİSK", result.policy.risk),
    resultRow("NEDEN", result.policy.reasonCode),
    resultRow("AÇIKLAMA", result.agent.explanation),
  );
  if (result.agent.providerNotice) grid.append(resultRow("AI DURUMU", result.agent.providerNotice));
  for (const item of result.protections) grid.append(resultRow("KORUMA", item, "protected"));
  grid.append(resultRow("ÇALIŞTIRMA", "Yapılmadı — analiz cüzdana dokunmaz", "protected"));
  target.append(grid, criticalJson(agentJson(result)));
}

function renderWallet(result, actionLabel) {
  const target = $("#wallet-result");
  target.replaceChildren(walletBanner(result, actionLabel));
  const grid = element("div", "result-grid");
  grid.append(resultRow("İŞLEM", actionLabel));
  if (result.risk) grid.append(resultRow("RİSK", result.risk));
  if (result.reasonCode) grid.append(resultRow("NEDEN", result.reasonCode));
  if (typeof result.affordable === "boolean") {
    grid.append(resultRow("YETERLİ Mİ", result.affordable ? "EVET" : "HAYIR", result.affordable ? "protected" : "rejected"));
  }
  if (result.receiveAddress) grid.append(resultRow("ALMA ADRESİ", result.receiveAddress));
  if (result.payment?.paymentId) {
    grid.append(resultRow("TX DURUMU", result.payment.status));
    grid.append(resultRow("TXID", result.payment.paymentId));
    $("#payment-id").value = result.payment.paymentId;
    rememberPaymentId(result.payment.paymentId);
    updateQuickStatus();
  }
  if (result.paymentStatus) {
    grid.append(resultRow("ZİNCİR DURUMU", result.paymentStatus.status));
    if (result.paymentStatus.confirmations !== undefined) grid.append(resultRow("ONAY", result.paymentStatus.confirmations));
  }
  if (result.safeAlternative) grid.append(resultRow("ALTERNATİF", `${result.safeAlternative.capability} · memo kaldırıldı: ${result.safeAlternative.memoRemoved ? "evet" : "hayır"}`));
  if (result.approval) grid.append(resultRow("ONAY", `${result.approval.status} · ${result.approval.id}`));
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
    resultRow("İŞLEM", "PII memo güvenlik kontrolü"),
    resultRow("RİSK", result.policy.risk),
    resultRow("NEDEN", result.policy.reasonCode),
    resultRow("KORUMA", "E-posta LLM'e ve zincire gönderilmedi", "protected"),
    resultRow("ÇALIŞTIRMA", "Yapılmadı — yalnız güvenli alternatif üretildi", "protected"),
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
  $("#wallet-status").textContent = status.wallet.connected ? "BAĞLI" : "KAPALI";
  $("#wallet-dot").className = status.wallet.connected ? "on" : "warn";
  $("#ai-status").textContent = status.ai.configured ? status.ai.provider.toUpperCase() : "YEREL";
  $("#ai-dot").className = status.ai.configured ? "on" : "warn";
  const note = $("#wallet-note");
  if (status.wallet.connected) {
    note.className = "wallet-note ok";
    note.textContent = `${status.wallet.provider} ${status.wallet.version} bağlı · gerçek testnet verisi · sahte bakiye yok`;
  } else {
    note.className = "wallet-note";
    note.textContent = status.wallet.message || "Cüzdan bağlı değil. Hiçbir sahte bakiye veya işlem gösterilmiyor.";
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
    if (renderEmpty) target.append(element("p", "empty-state", "Bekleyen kullanıcı onayı yok."));
    return result;
  }
  for (const approval of pending) {
    const card = element("div", "approval-card");
    card.append(element("p", "", approvalDescription(approval)));
    const button = element("button", "", "BU EXACT İSTEĞİ ONAYLA VE DEVAM ET");
    button.type = "button";
    button.addEventListener("click", async () => {
      if (!window.confirm("Bu exact testnet isteğini tek kullanımlık onayla çalıştırmak istiyor musun?")) return;
      button.disabled = true;
      try {
        const resumed = await request(`/api/approvals/${approval.id}/approve`, { method: "POST", body: "{}" });
        renderWallet(resumed, "Onaylanan testnet işlemi");
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
    target.append(element("p", "empty-state", "Henüz privacy-safe kayıt yok."));
    return;
  }
  for (const event of events) {
    const row = element("div", "audit-event");
    const time = element("time", "", new Date(event.timestamp).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    const capability = element("b", "", event.capability);
    const tone = decisionLabels[event.decision]?.tone || "neutral";
    const label = decisionLabels[event.decision]?.label || event.decision;
    const decision = element("span", `audit-decision ${tone}`, label);
    row.append(time, capability, decision);
    target.append(row);
  }
}

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
  $("#agent-result").replaceChildren(element("p", "empty-state", state.aiConfigured ? "NVIDIA NIM isteği yorumluyor…" : "Deterministik yerel analiz çalışıyor…"));
  try {
    renderAgent(await request("/api/agent/analyze", { method: "POST", body: JSON.stringify({ instruction: $("#instruction").value }) }));
    await loadAudit();
  } catch (error) {
    renderFailure($("#agent-result"), `Analiz başarısız: ${error.message}`);
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
    }), "Minimum bilgi sorgusu");
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
      body: JSON.stringify({
        instruction: `0.01 testnet ZEC'i ${recipient} adresine gönder; memo alanına alice@example.com yaz.`,
      }),
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
  if (!window.confirm("Bu exact isteği ShadeGuard politikasına göndermek istiyor musun? Politika ALLOW verirse gerçek TESTNET transferi yayınlanır.")) return;
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
    renderWallet(result, "Shielded testnet gönderimi");
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
    }), "Tek işlem durumu");
    await loadAudit();
  } catch (error) { renderFailure($("#wallet-result"), error.message); }
});

$("#quick-status").addEventListener("click", () => $("#status-form").requestSubmit());

$("#receive-button").addEventListener("click", async () => {
  try {
    renderWallet(await request("/api/wallet/receive", {
      method: "POST",
      body: JSON.stringify({ purpose: "Testnet demo wallet funding" }),
    }), "Testnet alma adresi");
    await loadAudit();
  } catch (error) { renderFailure($("#wallet-result"), error.message); }
});

$("#approvals-button").addEventListener("click", async () => {
  try {
    const result = await loadApprovals(true);
    renderWallet(result, "Kullanıcı onayları");
  } catch (error) { renderFailure($("#wallet-result"), error.message); }
});

$("#audit-refresh").addEventListener("click", () => void loadAudit());

try {
  $("#payment-id").value = window.localStorage.getItem("shadeguard:last-payment-id") || "";
} catch {}

void Promise.all([loadStatus(), loadAudit(), loadApprovals(false)]).catch(() => {
  $("#wallet-note").textContent = "ShadeGuard backend bağlantısı kurulamadı.";
});
