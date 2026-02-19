const statusEl = document.getElementById("status");
const summaryEl = document.getElementById("summary");

document.getElementById("trackBtn").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  chrome.tabs.sendMessage(tab.id, { type: "TRACK_PRICE_AUTO" }, (res) => {
    if (chrome.runtime.lastError) {
      statusEl.textContent = "Open a normal webpage and refresh it, then try again.";
      return;
    }

    statusEl.textContent = res?.ok
      ? "Saved price point ✅"
      : (res?.error || "Could not track");

    if (res?.summary) renderSummary(res.summary);
  });
});

document.getElementById("selectPriceBtn").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  chrome.tabs.sendMessage(tab.id, { type: "SELECT_PRICE_MODE" }, (res) => {
    if (chrome.runtime.lastError) {
      statusEl.textContent = "Open a normal webpage and refresh it, then try again.";
      return;
    }

    statusEl.textContent = res?.ok
      ? "Click the price on the page 👆"
      : (res?.error || "Could not start selection");
  });
});

function formatPrice(value, currency) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";

  const cur = currency && currency !== "UNKNOWN" ? currency : null;

  try {
    if (cur) {
      return new Intl.NumberFormat("sv-SE", {
        style: "currency",
        currency: cur
      }).format(value);
    }
    return new Intl.NumberFormat("sv-SE", {
      maximumFractionDigits: 2
    }).format(value);
  } catch {
    return cur ? `${value} ${cur}` : `${value}`;
  }
}

function computeSignal(current, lowest) {
  if (
    typeof current !== "number" ||
    typeof lowest !== "number" ||
    !Number.isFinite(current) ||
    !Number.isFinite(lowest)
  ) {
    return "—";
  }

  if (current <= lowest * 1.03) return "Good time to buy";
  if (current >= lowest * 1.15) return "Consider waiting";
  return "Fair price";
}

function pctChange(current, lowest) {
  if (
    typeof current !== "number" ||
    typeof lowest !== "number" ||
    !Number.isFinite(current) ||
    !Number.isFinite(lowest) ||
    lowest === 0
  ) {
    return null;
  }

  const pct = ((current - lowest) / lowest) * 100;
  return Math.round(pct);
}

function renderSummary(s) {
  const currency = s.currency || "UNKNOWN";
  const signal = computeSignal(s.current, s.lowest);
  const change = pctChange(s.current, s.lowest);

  summaryEl.innerHTML = `
    <p><b>Current</b><span>${formatPrice(s.current, currency)}</span></p>
    <p><b>Lowest seen</b><span>${formatPrice(s.lowest, currency)}</span></p>
    <p><b>Highest seen</b><span>${formatPrice(s.highest, currency)}</span></p>
    <p><b>Points</b><span>${s.count ?? 0}</span></p>
    <p><b>Signal</b><span>${signal}</span></p>
    <p><b>Vs lowest</b><span>${change === null ? "—" : `${change}%`}</span></p>
  `;
}
