const $ = (selector) => document.querySelector(selector);

const state = { walletConnected: false, aiConfigured: false, aiProvider: "deterministic" };

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { "content-type": "application/json" } : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "REQUEST_FAILED");
  return result;
}

function output(target, value) {
  target.textContent = JSON.stringify(value, null, 2);
}

function traceStep(label, value, className = "") {
  const row = document.createElement("div");
  row.className = "trace-step";
  const key = document.createElement("b");
  key.textContent = label;
  const content = document.createElement("span");
  content.className = className;
  content.textContent = String(value);
  row.append(key, content);
  return row;
}

function renderAgent(result) {
  const target = $("#agent-result");
  target.replaceChildren();
  target.append(
    traceStep("AGENT", `${result.agent.source.toUpperCase()} / ${result.agent.capability}`),
    traceStep("YORUM", result.agent.explanation),
    traceStep("POLICY", `${result.policy.decision} · ${result.policy.risk} · ${result.policy.reasonCode}`),
    traceStep("NEDEN", result.policy.explanation),
  );
  if (result.agent.providerNotice) target.append(traceStep("PROVIDER", result.agent.providerNotice));
  const decision = target.children[2]?.querySelector("span");
  if (decision) decision.className = `decision ${result.policy.decision}`;
  for (const item of result.protections) target.append(traceStep("KORUMA", item, "protection"));
  target.append(traceStep("EXEC", "YOK — analiz wallet işlemi çalıştırmadı"));
}

async function loadStatus() {
  const status = await request("/api/status");
  state.walletConnected = status.wallet.connected;
  state.aiConfigured = status.ai.configured;
  state.aiProvider = status.ai.provider;
  $("#wallet-status").textContent = status.wallet.connected ? "ONLINE" : "OFFLINE";
  $("#wallet-dot").className = status.wallet.connected ? "on" : "warn";
  $("#ai-status").textContent = status.ai.configured ? status.ai.model : "LOCAL";
  $("#ai-dot").className = status.ai.configured ? "on" : "warn";
  const note = $("#wallet-note");
  if (status.wallet.connected) {
    note.className = "wallet-note ok";
    note.textContent = `${status.wallet.provider} ${status.wallet.version} / testnet / gerçek wallet verisi`;
  } else {
    note.className = "wallet-note";
    note.textContent = status.wallet.message || "Wallet bağlı değil. Hiçbir sahte bakiye veya işlem gösterilmiyor.";
  }
  for (const button of document.querySelectorAll("#panel-wallet button")) button.disabled = !status.wallet.connected;
  $("#approvals-button").disabled = false;
}

async function loadAudit() {
  const { events } = await request("/api/audit");
  const target = $("#audit-list");
  target.replaceChildren();
  if (!events.length) {
    target.append(traceStep("AUDIT", "Henüz privacy-safe kayıt yok."));
    return;
  }
  for (const event of events) {
    const row = document.createElement("div");
    row.className = "audit-event";
    const time = document.createElement("time");
    time.textContent = new Date(event.timestamp).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const capability = document.createElement("b");
    capability.textContent = event.capability;
    const decision = document.createElement("span");
    decision.textContent = event.decision;
    row.append(time, capability, decision);
    target.append(row);
  }
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item === tab));
    document.querySelectorAll(".panel").forEach((panel) => panel.classList.toggle("active", panel.id === `panel-${tab.dataset.tab}`));
    if (tab.dataset.tab === "audit") void loadAudit();
  });
});

document.querySelectorAll("[data-prompt]").forEach((button) => {
  button.addEventListener("click", () => { $("#instruction").value = button.dataset.prompt; });
});

$("#agent-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  const providerLabel = state.aiProvider === "nvidia" ? "NVIDIA NIM" : "Gemini";
  $("#agent-result").textContent = state.aiConfigured ? `// ${providerLabel} niyeti yapılandırıyor…` : "// Deterministik yerel analiz çalışıyor…";
  try {
    renderAgent(await request("/api/agent/analyze", { method: "POST", body: JSON.stringify({ instruction: $("#instruction").value }) }));
    await loadAudit();
  } catch (error) {
    $("#agent-result").textContent = `// Analiz başarısız: ${error.message}`;
  } finally {
    button.disabled = false;
  }
});

$("#afford-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    output($("#wallet-result"), await request("/api/wallet/can-afford", {
      method: "POST",
      body: JSON.stringify({ amountZec: $("#afford-amount").value, purpose: "Retro console minimum-information check" }),
    }));
  } catch (error) { $("#wallet-result").textContent = `// ${error.message}`; }
});

$("#send-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!window.confirm("Yalnız TESTNET üzerinde bu exact isteği ShadeGuard politikasına göndermek istiyor musun?")) return;
  try {
    output($("#wallet-result"), await request("/api/wallet/send", {
      method: "POST",
      body: JSON.stringify({
        recipient: $("#recipient").value,
        amountZec: $("#send-amount").value,
        purpose: $("#purpose").value,
        memo: $("#memo").value || undefined,
        acceptSafeRewrite: $("#accept-rewrite").checked,
      }),
    }));
    await loadAudit();
  } catch (error) { $("#wallet-result").textContent = `// ${error.message}`; }
});

$("#receive-button").addEventListener("click", async () => {
  try {
    output($("#wallet-result"), await request("/api/wallet/receive", {
      method: "POST",
      body: JSON.stringify({ purpose: "Testnet demo wallet funding" }),
    }));
  } catch (error) { $("#wallet-result").textContent = `// ${error.message}`; }
});

$("#approvals-button").addEventListener("click", async () => {
  try { output($("#wallet-result"), await request("/api/approvals")); }
  catch (error) { $("#wallet-result").textContent = `// ${error.message}`; }
});

$("#audit-refresh").addEventListener("click", () => void loadAudit());

void Promise.all([loadStatus(), loadAudit()]).catch(() => {
  $("#wallet-note").textContent = "ShadeGuard backend bağlantısı kurulamadı.";
});

const preview = new URLSearchParams(window.location.search).get("preview");
if (preview === "balance") {
  $("#instruction").value = "0.01 ZEC ödeme için cüzdanın tam bakiyesini getir.";
  $("#agent-form").requestSubmit();
} else if (preview === "pii") {
  $("#instruction").value = "0.01 testnet ZEC'i ztestsapling1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq adresine gönder; memo alanına alice@example.com yaz.";
  $("#agent-form").requestSubmit();
}
