/**
 * background.js
 * Climatiq integration (hardcoded key for course project)
 *
 * Fix: /estimate needs parameters depending on unit type.
 * For Weight factors use: { weight, weight_unit }  (NOT amount/unit)
 * Docs: Climatiq Parameters (Weight) + Estimate endpoint.
 */

const CLIMATIQ_KEY = "V63K2AG9FD0Z7C4XK1HH13ZYX0";

async function climatiqSearch(query) {
  const url = new URL("https://api.climatiq.io/data/v1/search");
  url.searchParams.set("query", query);
  url.searchParams.set("data_version", "^3");

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${CLIMATIQ_KEY}` }
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.error?.message || `Search HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

async function climatiqEstimateWeight(emissionFactorId, weightKg) {
  const res = await fetch("https://api.climatiq.io/data/v1/estimate", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CLIMATIQ_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      emission_factor: { id: emissionFactorId },
      parameters: {
        weight: weightKg,
        weight_unit: "kg"
      }
    })
  });

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.error?.message || `Estimate HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

function pickBestWeightFactor(searchResults) {
  const results = searchResults?.results || [];

  // 1) Ta första emissionsfaktor som accepterar unit_type "Weight"
  // (så vår weight/weight_unit request matchar)
  const weightFactor = results.find(r => String(r.unit_type).toLowerCase() === "weight");
  if (weightFactor) return weightFactor;

  // 2) fallback: bara första om inget matchar (kan fortfarande faila)
  return results[0] || null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type !== "CO2_ESTIMATE_REQUEST") return;

      const { material, weightKg } = msg.payload;

      // Bättre queries än bara "textile cotton"
      const queries = [
        `textile ${material} weight`,
        `${material} fabric weight`,
        `${material} textile`
      ];

      let factor = null;
      let lastSearch = null;

      for (const q of queries) {
        lastSearch = await climatiqSearch(q);
        factor = pickBestWeightFactor(lastSearch);
        if (factor?.id && String(factor.unit_type).toLowerCase() === "weight") break;
      }

      if (!factor?.id) throw new Error("No emission factor found.");

      // Räkna CO2e med WEIGHT-parametrar
      const estimate = await climatiqEstimateWeight(factor.id, weightKg);

      sendResponse({
        ok: true,
        result: {
          co2e: estimate.co2e,
          co2e_unit: estimate.co2e_unit,
          factor_name: factor.name,
          unit_type: factor.unit_type
        }
      });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();

  return true;
});
// =====================
// ALARM (10s) + NOTIFICATION
// =====================
const NOTIF_ALARM_NAME = "price_co2_followup_alarm";

function showNotification(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: title || "Price Predictor",
    message: message || "Ping",
    priority: 2
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "SCHEDULE_NOTIFICATION") return;

  const delaySeconds = Number(msg.delaySeconds ?? 10);

  chrome.storage.local.set({
    NOTIF_PAYLOAD: {
      title: msg.title || "Price Predictor",
      message: msg.message || "10 sek har gått — kolla pris & CO₂ igen 👀"
    }
  });

  // ✅ 10 sek med "when" (ms)
  chrome.alarms.create(NOTIF_ALARM_NAME, { when: Date.now() + delaySeconds * 1000 });

  sendResponse({ ok: true, scheduledFor: Date.now() + delaySeconds * 1000 });
  return true;
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== NOTIF_ALARM_NAME) return;

  const { NOTIF_PAYLOAD } = await chrome.storage.local.get("NOTIF_PAYLOAD");
  showNotification(NOTIF_PAYLOAD?.title, NOTIF_PAYLOAD?.message);
});
