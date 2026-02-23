/**
 * popup.js
 * - PRICE: Track / Select price (no injection; content.js is loaded via manifest)
 * - CO2: Estimate with Climatiq (via background.js)
 * - Level 2: Schedule a notification after 60 seconds using chrome.alarms (via background)
 * - NEW: Open the on-page widget after successful track (OPEN_WIDGET)
 */

const statusEl = document.getElementById("status");
const summaryEl = document.getElementById("summary");

const productBox = document.getElementById("productBox");
const estimateBtn = document.getElementById("estimateBtn");
const co2Status = document.getElementById("co2Status");
const co2Result = document.getElementById("co2Result");

// =====================================================
// ONLY PING (no executeScript injection)
// =====================================================

async function ensureContentReady(tabId) {
  const ping = await new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: "PING" }, (res) => {
      if (chrome.runtime.lastError) return resolve(null);
      resolve(res);
    });
  });

  return Boolean(ping?.ok);
}

async function sendToActiveTab(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id || !tab?.url) {
    return { ok: false, error: "No active tab found." };
  }

  // Chrome blocks extensions on internal pages
  if (tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) {
    return { ok: false, error: "This page is blocked by Chrome (internal page)." };
  }

  // Content script should already be present via manifest content_scripts
  const ready = await ensureContentReady(tab.id);
  if (!ready) {
    return { ok: false, error: "Content script not ready. Refresh the page and try again." };
  }

  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tab.id, message, (res) => {
      if (chrome.runtime.lastError) {
        return resolve({ ok: false, error: "No response from content script." });
      }
      resolve(res || { ok: false, error: "No response." });
    });
  });
}

// =====================================================
// PRICE BUTTONS
// =====================================================

document.getElementById("trackBtn").addEventListener("click", async () => {
  const res = await sendToActiveTab({ type: "TRACK_PRICE_AUTO" });

  statusEl.textContent = res?.ok
    ? "Saved price point ✅"
    : (res?.error || "Could not track");

  // ✅ If tracking succeeded:
  // 1) Open the on-page widget
  // 2) Schedule notification
  if (res?.ok) {
    // 1) Open widget (floating panel) on the page
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, { type: "OPEN_WIDGET" });
    }

    // 2) Schedule notification after 10 seconds (you can change delaySeconds)
    chrome.runtime.sendMessage({
      type: "SCHEDULE_NOTIFICATION",
      delaySeconds: 10,
      title: "Price Predictor",
      message: "10 sek har gått — kolla pris & CO₂ igen 👀"
    });
  }

  if (res?.summary) renderSummary(res.summary);
});

document.getElementById("selectPriceBtn").addEventListener("click", async () => {
  const res = await sendToActiveTab({ type: "SELECT_PRICE_MODE" });

  statusEl.textContent = res?.ok
    ? "Click the price on the page 👆"
    : (res?.error || "Could not start selection");
});

// ===== price summary helpers =====
function formatPrice(value, currency) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  try {
    return new Intl.NumberFormat("sv-SE", {
      style: "currency",
      currency: currency
    }).format(value);
  } catch {
    return `${value}`;
  }
}

function computeSignal(current, lowest) {
  if (!current || !lowest) return "—";
  if (current <= lowest * 1.03) return "Good time to buy";
  if (current >= lowest * 1.15) return "Consider waiting";
  return "Fair price";
}

function pctChange(current, lowest) {
  if (!current || !lowest || lowest === 0) return null;
  return Math.round(((current - lowest) / lowest) * 100);
}

function renderSummary(s) {
  if (!s) {
    summaryEl.innerHTML = "<p>No price history yet.</p>";
    return;
  }

  const signal = computeSignal(s.current, s.lowest);
  const change = pctChange(s.current, s.lowest);

  summaryEl.innerHTML = `
    <p><b>Current</b> ${formatPrice(s.current, s.currency)}</p>
    <p><b>Lowest seen</b> ${formatPrice(s.lowest, s.currency)}</p>
    <p><b>Highest seen</b> ${formatPrice(s.highest, s.currency)}</p>
    <p><b>Signal</b> ${signal}</p>
    <p><b>Vs lowest</b> ${change === null ? "—" : `${change}%`}</p>
  `;
}

// =====================================================
// CO2 SECTION
// =====================================================

function fmtKg(num) {
  if (typeof num !== "number") return "—";
  return `${num.toFixed(2)} kg`;
}

async function loadProductSnapshot() {
  const { LAST_PRODUCT_SNAPSHOT } = await chrome.storage.local.get("LAST_PRODUCT_SNAPSHOT");

  if (!LAST_PRODUCT_SNAPSHOT) {
    productBox.textContent = "No product data yet. Open a product page and refresh it.";
    estimateBtn.disabled = true;
    return null;
  }

  const p = LAST_PRODUCT_SNAPSHOT;
  estimateBtn.disabled = false;

  productBox.innerHTML = `
    <div><b>Category:</b> ${p.category}</div>
    <div><b>Material:</b> ${p.material} ${p.materialDetected ? "" : "(fallback)"}</div>
    <div><b>Weight:</b> ${p.weightKg} kg</div>
    <div><b>Confidence:</b> ${p.confidence}</div>
  `;

  return p;
}

estimateBtn.addEventListener("click", async () => {
  co2Status.textContent = "Calculating…";
  co2Result.innerHTML = "";

  const p = await loadProductSnapshot();
  if (!p) return;

  chrome.runtime.sendMessage(
    { type: "CO2_ESTIMATE_REQUEST", payload: { material: p.material, weightKg: p.weightKg } },
    (resp) => {
      if (!resp?.ok) {
        co2Status.textContent = `Error: ${resp?.error || "Unknown error"}`;
        return;
      }

      co2Status.textContent = "Done ✅";
      co2Result.innerHTML = `
        <p><b>Estimated CO₂e</b> ${fmtKg(resp.result.co2e)}</p>
        <p><b>Factor</b> ${resp.result.factor_name || "—"}</p>
      `;
    }
  );
});

// Load snapshot on open
loadProductSnapshot();