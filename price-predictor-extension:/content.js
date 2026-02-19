// ===== Price parsing (number + currency) =====
function parsePrice(text) {
  if (!text) return null;

  const t = text.replace(/\u00A0/g, " ").trim(); // nbsp -> space

  // currency detection (basic)
  let currency = null;
  if (/kr|sek/i.test(t)) currency = "SEK";
  else if (/€|eur/i.test(t)) currency = "EUR";
  else if (/\$|usd/i.test(t)) currency = "USD";
  else if (/£|gbp/i.test(t)) currency = "GBP";

  // Find number-like chunk (supports 1 299, 1.299, 1,299, 1299, 49,90, 49.90)
  const m = t.match(/(\d{1,3}([ .,\u00A0]\d{3})*|\d+)([.,]\d{2})?/);
  if (!m) return null;

  let numStr = m[0];
  numStr = numStr.replace(/\s/g, "");

  const hasDot = numStr.includes(".");
  const hasComma = numStr.includes(",");

  if (hasDot && hasComma) {
    const lastDot = numStr.lastIndexOf(".");
    const lastComma = numStr.lastIndexOf(",");
    const decPos = Math.max(lastDot, lastComma);

    const intPart = numStr.slice(0, decPos).replace(/[.,]/g, "");
    const decPart = numStr.slice(decPos + 1);
    numStr = intPart + "." + decPart;
  } else if (hasComma && !hasDot) {
    if (/,(\d{2})$/.test(numStr)) numStr = numStr.replace(",", ".");
    else numStr = numStr.replace(/,/g, "");
  } else if (hasDot && !hasComma) {
    if (/\.(\d{2})$/.test(numStr)) {
      // ok
    } else {
      numStr = numStr.replace(/\./g, "");
    }
  }

  const value = Number(numStr);
  if (!Number.isFinite(value)) return null;

  return { value, currency, raw: m[0] };
}

// ===== Find likely price element on page =====
function findLikelyPriceElement() {
  const candidates = [
    ...document.querySelectorAll('[class*="price" i], [id*="price" i], [data-testid*="price" i]')
  ].slice(0, 50);

  for (const el of candidates) {
    const txt = el.innerText;
    const parsed = parsePrice(txt);
    if (parsed) return { el, parsed };
  }

  const all = [...document.querySelectorAll("span, div, p")].slice(0, 200);
  for (const el of all) {
    const txt = el.innerText;
    if (!txt || txt.length > 60) continue;
    const parsed = parsePrice(txt);
    if (parsed) return { el, parsed };
  }

  return null;
}

// ===== Storage helpers =====
function makeItemKey() {
  return location.origin + location.pathname;
}

async function savePricePoint({ title, url, parsed }) {
  if (!parsed || typeof parsed.value !== "number") {
    throw new Error("savePricePoint: parsed price is missing or invalid");
  }

  const key = makeItemKey();
  const now = new Date().toISOString();

  const data = await chrome.storage.local.get([key]);
  const existing = data[key] || { title, url, points: [] };

  existing.title = title;
  existing.url = url;

  existing.points.push({
    value: parsed.value,
    currency: parsed.currency || "UNKNOWN",
    timestamp: now
  });

  await chrome.storage.local.set({ [key]: existing });
  return existing;
}

function summarize(item) {
  const points = item?.points || [];
  if (points.length === 0) {
    return { count: 0, current: null, lowest: null, highest: null, currency: "UNKNOWN" };
  }

  // Assume currency is consistent per item (good enough for MVP)
  const currency = points[points.length - 1].currency || "UNKNOWN";
  const values = points.map(p => p.value).filter(v => Number.isFinite(v));

  const current = points[points.length - 1].value;
  const lowest = Math.min(...values);
  const highest = Math.max(...values);

  return {
    count: points.length,
    currency,
    current,
    lowest,
    highest
  };
}

// ===== Click-to-select mode =====
let selectMode = false;

function enableSelectMode() {
  if (selectMode) return;
  selectMode = true;

  const handler = async (e) => {
    e.preventDefault();
    e.stopPropagation();

    const el = e.target;
    const parsed = parsePrice(el.innerText);

    if (!parsed) {
      alert("That doesn’t look like a price. Try clicking the price text.");
      return;
    }

    await savePricePoint({ title: document.title, url: location.href, parsed });
    alert("Saved ✅");
    cleanup();
  };

  function cleanup() {
    document.removeEventListener("click", handler, true);
    selectMode = false;
  }

  document.addEventListener("click", handler, true);
}

// ===== Messages from popup =====
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "TRACK_PRICE_AUTO") {
        const found = findLikelyPriceElement();
        if (!found) return sendResponse({ ok: false, error: "Could not detect price automatically." });

        const item = await savePricePoint({
          title: document.title,
          url: location.href,
          parsed: found.parsed
        });

        return sendResponse({ ok: true, summary: summarize(item) });
      }

      if (msg.type === "SELECT_PRICE_MODE") {
        enableSelectMode();
        return sendResponse({ ok: true });
      }
    } catch (err) {
      return sendResponse({ ok: false, error: err?.message || "Unknown error" });
    }
  })();

  return true;
});
