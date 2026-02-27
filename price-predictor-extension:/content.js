(() => {
  // =====================================================
  // content.js (WIDGET + POPUP HANDLERS)
  // - Widget: floating button + draggable panel
  // - Popup support: PING, TRACK_PRICE_AUTO, SELECT_PRICE_MODE, OPEN_WIDGET
  // - Storage: PRICE_HISTORY_BY_PRODUCT, LAST_PRODUCT_SNAPSHOT
  //
  // FIXES INCLUDED (so it "works for real"):
  // 1) Better price extraction:
  //    - Prefer meta/JSON-LD Product offers
  //    - Prefer price candidates inside main/product areas
  //    - Filter out Klarna/monthly, shipping, delivery etc.
  //    - Only pick "lowest" when sale context is present
  // 2) Select-mode still ignores struck-through prices
  // 3) Data is saved per product (already in your code)
  // 4) (Optional but helpful) keeps a tiny debug string in-memory for current page extraction
  // =====================================================

  // Prevent running twice on same page
  if (window.__PRICE_CO2_WIDGET__) return;
  window.__PRICE_CO2_WIDGET__ = true;

  // =========================
  // Helpers (storage + format)
  // =========================
  async function getLocal(key) {
    const obj = await chrome.storage.local.get(key);
    return obj[key];
  }
  async function setLocal(key, value) {
    await chrome.storage.local.set({ [key]: value });
  }

  function formatPrice(value, currency = "SEK") {
    if (typeof value !== "number" || !Number.isFinite(value)) return "—";
    try {
      return new Intl.NumberFormat("sv-SE", { style: "currency", currency }).format(value);
    } catch {
      return `${value} ${currency}`;
    }
  }

  function fmtKg(num) {
    if (typeof num !== "number" || !Number.isFinite(num)) return "—";
    return `${num.toFixed(2)} kg`;
  }

  // =========================
  // Product identity (per product)
  // =========================
  function canonicalUrl(rawUrl = location.href) {
    const u = new URL(rawUrl);

    // Remove common tracking params so the same product doesn't become "new"
    [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_content",
      "utm_term",
      "gclid",
      "fbclid",
      "msclkid",
      "yclid",
      "ttclid"
    ].forEach((p) => u.searchParams.delete(p));

    // NOTE:
    // Do NOT wipe all query params, because some sites use ?variant=... for product variants.
    // We only remove tracking params.
    const qs = u.searchParams.toString();
    return u.origin + u.pathname + (qs ? `?${qs}` : "");
  }

  function getProductId(url = location.href) {
    const host = location.hostname.replace(/^www\./, "");
    const canon = canonicalUrl(url);
    return `${host}|${canon}`;
  }

  // =========================
  // PRICE extraction (robust)
  // =========================
  function normalizeCurrency(symbol) {
    const s = String(symbol || "").toLowerCase();
    if (s.includes("kr") || s.includes("sek")) return "SEK";
    if (s.includes("€")) return "EUR";
    if (s.includes("$")) return "USD";
    return "SEK";
  }

  // We keep a simple "last extraction source" for debugging (not saved)
  let __LAST_PRICE_SOURCE__ = "";

  function setLastPriceSource(s) {
    __LAST_PRICE_SOURCE__ = String(s || "").slice(0, 140);
  }

  // Context filters for "not product price"
  const BAD_CONTEXT_RE =
    /(\/\s*mån|kr\s*\/\s*mån|per\s*month|\/\s*month|\bmån\b|\bmonth\b|klarna|delbetal|installment|finansier|frakt|shipping|delivery|leverans|porto|avgift|fee)/i;

  const SALE_CONTEXT_RE =
    /(-\s?\d{1,3}\s?%|\brea\b|\bsale\b|\bord\.?\b|\bwas\b|\bbefore\b|kampanj|nedsatt|sänkt|nu\s*pris)/i;

  function extractPriceFromText(text) {
    if (!text) return null;

    const str = String(text);

    // Find all prices
    const matches = [...str.matchAll(/(\d{1,6}(?:[.,]\d{2})?)\s?(kr|sek|€|\$)/ig)];
    if (!matches.length) return null;

    function contextAround(index, span = 36) {
      const start = Math.max(0, index - span);
      const end = Math.min(str.length, index + span);
      return str.slice(start, end).toLowerCase();
    }

    const parsed = matches
      .map((m) => {
        const value = parseFloat(String(m[1]).replace(",", "."));
        if (!Number.isFinite(value)) return null;

        const currency = normalizeCurrency(m[2]);
        const idx = typeof m.index === "number" ? m.index : str.indexOf(m[0]);
        const ctx = contextAround(idx);

        return { value, currency, idx, ctx };
      })
      .filter(Boolean);

    const filtered = parsed.filter((p) => !BAD_CONTEXT_RE.test(p.ctx));
    const candidates = filtered.length ? filtered : parsed;
    if (!candidates.length) return null;

    const saleContext = SALE_CONTEXT_RE.test(str);

    // If sale context: choose lowest
    if (saleContext && candidates.length >= 2) {
      const min = candidates.reduce((a, b) => (b.value < a.value ? b : a));
      return { value: min.value, currency: min.currency };
    }

    // Otherwise choose earliest plausible candidate
    const first = candidates.slice().sort((a, b) => a.idx - b.idx)[0];
    return { value: first.value, currency: first.currency };
  }

  function isVisible(el) {
    if (!(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function textFromNode(el) {
    if (!el) return "";
    return (el.innerText || el.textContent || "").trim();
  }

  function tryExtractFromMetaAndLdJson() {
    // 1) Meta tags / itemprop price
    const metaSelectors = [
      'meta[property="product:price:amount"]',
      'meta[property="og:price:amount"]',
      'meta[itemprop="price"]',
      '[itemprop="price"]'
    ];

    for (const sel of metaSelectors) {
      const node = document.querySelector(sel);
      if (!node) continue;

      // meta content="299.00"
      if (node.tagName === "META") {
        const content = node.getAttribute("content") || "";
        const p = extractPriceFromText(content);
        if (p) {
          setLastPriceSource(`meta:${sel}`);
          return p;
        }
      }

      // element text or value/content attributes
      const t = textFromNode(node);
      const p1 = extractPriceFromText(t);
      if (p1) {
        setLastPriceSource(`itemprop:${sel}`);
        return p1;
      }
      const content = node.getAttribute("content") || node.getAttribute("value") || "";
      const p2 = extractPriceFromText(content);
      if (p2) {
        setLastPriceSource(`attr:${sel}`);
        return p2;
      }
    }

    // 2) JSON-LD Product offers
    const scripts = [...document.querySelectorAll('script[type="application/ld+json"]')];
    for (const s of scripts) {
      try {
        const json = JSON.parse(s.textContent || "null");
        const nodes = Array.isArray(json) ? json : [json];

        for (const n of nodes) {
          // direct Product
          const offers = n?.offers;
          const offerArr = Array.isArray(offers) ? offers : offers ? [offers] : [];

          for (const off of offerArr) {
            const price = off?.price ?? off?.priceSpecification?.price;
            const currency = off?.priceCurrency;
            if (price != null) {
              const p = extractPriceFromText(`${price} ${currency || "SEK"}`);
              if (p) {
                setLastPriceSource("jsonld:offers.price");
                return p;
              }
            }
          }

          // Graph form
          const graph = n?.["@graph"];
          if (Array.isArray(graph)) {
            for (const g of graph) {
              const offers2 = g?.offers;
              const offerArr2 = Array.isArray(offers2) ? offers2 : offers2 ? [offers2] : [];
              for (const off of offerArr2) {
                const price = off?.price ?? off?.priceSpecification?.price;
                const currency = off?.priceCurrency;
                if (price != null) {
                  const p = extractPriceFromText(`${price} ${currency || "SEK"}`);
                  if (p) {
                    setLastPriceSource("jsonld:@graph.offers.price");
                    return p;
                  }
                }
              }
            }
          }
        }
      } catch {
        // ignore broken JSON-LD
      }
    }

    return null;
  }

  function collectPriceCandidates(root = document) {
    const selectors = [
      // common testing hooks
      '[data-testid*="price"]',
      '[data-test*="price"]',
      '[data-qa*="price"]',

      // common semantics
      '[itemprop="price"]',
      '[aria-label*="price"]',
      '[aria-label*="pris"]',

      // generic classes/ids
      '[class*="price"]',
      '[class*="Price"]',
      '[id*="price"]',
      '[id*="Price"]',

      // fallbacks
      "span",
      "div"
    ];

    const nodes = [];
    for (const sel of selectors) nodes.push(...root.querySelectorAll(sel));

    const uniq = Array.from(new Set(nodes));

    const candidates = [];
    for (const el of uniq) {
      if (!isVisible(el)) continue;

      const t = textFromNode(el);
      if (!t) continue;

      // avoid huge blocks
      if (t.length > 180) continue;

      // only consider strings that look price-ish
      if (!/(kr|sek|€|\$)/i.test(t)) continue;

      const p = extractPriceFromText(t);
      if (!p) continue;

      const lower = t.toLowerCase();
      let score = 0;

      // bonuses
      if (/pris|price|rea|sale|ord\.|nu/i.test(lower)) score += 3;
      if (SALE_CONTEXT_RE.test(lower)) score += 2;
      if (/(kr|sek|€|\$)/i.test(t)) score += 1;

      // penalties
      if (BAD_CONTEXT_RE.test(lower)) score -= 8;

      // Prefer stuff in "main/product" areas
      if (el.closest("main, [role='main'], [data-testid*='product'], [class*='product'], [id*='product']")) score += 2;

      // Avoid header/footer/nav
      if (el.closest("header, footer, nav")) score -= 2;

      // Avoid tiny UI labels
      if (t.length < 3) score -= 2;

      candidates.push({ value: p.value, currency: p.currency, score, text: t });
    }

    return candidates;
  }

  function pickBestCandidate(cands) {
    if (!cands.length) return null;

    // Highest score wins; tie-breaker: prefer larger value (avoids choosing e.g. shipping 99kr)
    cands.sort((a, b) => (b.score - a.score) || (b.value - a.value));

    // extra safety: if best is suspiciously low compared to runner-up and best text looks non-product, pick runner-up
    const best = cands[0];
    const second = cands[1];
    if (second && best.value > 0 && second.value > 0) {
      const ratio = second.value / best.value;
      if (ratio >= 2.2 && BAD_CONTEXT_RE.test(best.text.toLowerCase())) {
        return { value: second.value, currency: second.currency };
      }
    }

    return { value: best.value, currency: best.currency };
  }

  function extractPriceFromPage() {
    // 1) Structured sources (most reliable)
    const meta = tryExtractFromMetaAndLdJson();
    if (meta) return meta;

    // 2) Search in likely product container
    const root =
      document.querySelector("main") ||
      document.querySelector('[role="main"]') ||
      document.querySelector('[data-testid*="product"]') ||
      document;

    const scoped = collectPriceCandidates(root);
    const bestScoped = pickBestCandidate(scoped);
    if (bestScoped) {
      setLastPriceSource("dom:scoped");
      return bestScoped;
    }

    // 3) global dom search
    const global = collectPriceCandidates(document);
    const bestGlobal = pickBestCandidate(global);
    if (bestGlobal) {
      setLastPriceSource("dom:global");
      return bestGlobal;
    }

    // 4) very last resort: body text
    const text = document.body?.innerText || "";
    const last = extractPriceFromText(text);
    if (last) setLastPriceSource("body:text");
    return last;
  }

  // NEW: for select-mode, ignore struck-through prices (<del>, <s>, <strike>) when reading element text.
  function getTextWithoutStruckPrices(element) {
    try {
      const clone = element.cloneNode(true);
      if (clone.querySelectorAll) {
        clone.querySelectorAll("del, s, strike").forEach((n) => n.remove());
      }
      return (clone.innerText || clone.textContent || "").trim();
    } catch {
      return (element?.innerText || element?.textContent || "").trim();
    }
  }

  // =========================
  // Storage (per product)
  // =========================
  const PRICE_HISTORY_KEY = "PRICE_HISTORY_BY_PRODUCT";

  async function savePricePoint(price, url = location.href) {
    const productId = getProductId(url);

    const all = (await getLocal(PRICE_HISTORY_KEY)) || {};
    const history = Array.isArray(all[productId]) ? all[productId] : [];

    // avoid spam duplicates within 60s for same value
    const last = history[history.length - 1];
    if (last && last.value === price.value && (Date.now() - last.timestamp) < 60_000) {
      await setLocal(PRICE_HISTORY_KEY, { ...all, [productId]: history });
      return;
    }

    history.push({
      value: price.value,
      currency: price.currency,
      timestamp: Date.now(),
      url: canonicalUrl(url),
      productId
    });

    all[productId] = history.slice(-200);
    await setLocal(PRICE_HISTORY_KEY, all);
  }

  async function buildSummary(currency) {
    const productId = getProductId(location.href);
    const all = (await getLocal(PRICE_HISTORY_KEY)) || {};
    const historyRaw = Array.isArray(all[productId]) ? all[productId] : [];

    const history = historyRaw.filter((p) => p && p.currency === currency);
    if (!history.length) return null;

    const values = history.map((p) => p.value).filter((n) => typeof n === "number" && Number.isFinite(n));
    if (!values.length) return null;

    return {
      current: values[values.length - 1],
      lowest: Math.min(...values),
      highest: Math.max(...values),
      currency,
      productId,
      points: values.length,
      canonical: canonicalUrl(location.href)
    };
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

  // =========================
  // CO2 snapshot (lightweight)
  // =========================
  function getPageTextLower() {
    return (document.body?.innerText || "").toLowerCase();
  }
  function detectMaterial(text) {
    if (text.includes("100% cotton") || text.includes("100% bomull") || text.includes("bomull")) return "cotton";
    if (text.includes("polyester")) return "polyester";
    if (text.includes("ull") || text.includes("wool")) return "wool";
    if (text.includes("linne") || text.includes("linen")) return "linen";
    if (text.includes("viskos") || text.includes("viscose")) return "viscose";
    return null;
  }
  function detectCategory(title) {
    const t = (title || "").toLowerCase();
    if (t.includes("dress") || t.includes("klänning")) return "dress";
    if (t.includes("t-shirt") || t.includes("tee") || t.includes("tshirt")) return "tshirt";
    if (t.includes("jeans")) return "jeans";
    if (t.includes("hoodie")) return "hoodie";
    return "unknown";
  }

  const DEFAULT_WEIGHT_KG = {
    tshirt: 0.18,
    jeans: 0.7,
    hoodie: 0.6,
    dress: 0.35,
    unknown: 0.3
  };

  async function saveCurrentProductSnapshot() {
    const title = document.title || "";
    const text = getPageTextLower();
    const category = detectCategory(title);
    const material = detectMaterial(text);

    const payload = {
      title,
      url: location.href,
      canonicalUrl: canonicalUrl(location.href),
      productId: getProductId(location.href),
      category,
      material: material || "cotton",
      materialDetected: Boolean(material),
      weightKg: DEFAULT_WEIGHT_KG[category] ?? DEFAULT_WEIGHT_KG.unknown,
      confidence: material ? "Medium" : "Low",
      updatedAt: new Date().toISOString()
    };

    await setLocal("LAST_PRODUCT_SNAPSHOT", payload);
    return payload;
  }

  // =========================
  // UI: floating button + panel
  // =========================
  const styles = `
    .pc2-fab {
      position: fixed;
      right: 18px;
      bottom: 18px;
      width: 52px;
      height: 52px;
      border-radius: 999px;
      background: #a2bcf0ff;
      box-shadow: 0 12px 30px rgba(0,0,0,.25);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 2147483647;
      cursor: pointer;
      user-select: none;
      font: 700 14px/1 system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
    }
    .pc2-fab:hover { filter: brightness(0.98); }

    .pc2-panel {
      position: fixed;
      right: 18px;
      bottom: 82px;
      width: 340px;
      max-width: calc(100vw - 24px);
      border-radius: 16px;
      background: #0b0f14;
      color: #e8edf3;
      box-shadow: 0 18px 50px rgba(0,0,0,.45);
      z-index: 2147483647;
      overflow: hidden;
      display: none;
      font: 14px/1.4 system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
    }

    .pc2-header {
      padding: 12px 12px;
      background: linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,0));
      display: flex;
      align-items: center;
      justify-content: space-between;
      cursor: move;
      user-select: none;
    }
    .pc2-title { font-weight: 800; letter-spacing: .2px; }
    .pc2-close {
      width: 32px;
      height: 32px;
      border-radius: 10px;
      border: 1px solid rgba(255,255,255,.12);
      background: rgba(255,255,255,.04);
      color: #e8edf3;
      cursor: pointer;
    }

    .pc2-body { padding: 12px; }
    .pc2-section {
      border: 1px solid rgba(255,255,255,.10);
      border-radius: 14px;
      padding: 10px;
      margin-bottom: 10px;
      background: rgba(255,255,255,.03);
    }
    .pc2-section h3 { margin: 0 0 8px 0; font-size: 13px; opacity: .9; }

    .pc2-row { display:flex; justify-content:space-between; gap:10px; margin: 4px 0; }
    .pc2-key { opacity: .75; }
    .pc2-val { font-weight: 700; text-align: right; }

    .pc2-actions { display:flex; gap:8px; flex-wrap: wrap; margin-top: 10px; }
    .pc2-btn {
      padding: 9px 10px;
      border-radius: 12px;
      border: 1px solid hsla(225, 83%, 81%, 0.12);
      background: rgba(255,255,255,.06);
      color: #e8edf3;
      cursor: pointer;
      font-weight: 700;
    }
    .pc2-btn.primary {
      border-color: rgba(139, 168, 242, 0.35);
      background: rgba(139, 168, 242, .18);
    }
    .pc2-btn:disabled { opacity: .5; cursor: not-allowed; }

    .pc2-status { margin-top: 8px; opacity: .8; font-size: 12px; }
    .pc2-footnote { margin-top: 8px; opacity: .6; font-size: 11px; }

    /* selection overlay */
    .pc2-selecting {
      outline: 2px dashed rgba(162,188,240,.9) !important;
      outline-offset: 2px !important;
      cursor: crosshair !important;
    }
    .pc2-hint {
      position: fixed;
      left: 18px;
      bottom: 18px;
      z-index: 2147483647;
      background: rgba(11, 15, 20, .92);
      color: #e8edf3;
      border: 1px solid rgba(255,255,255,.12);
      border-radius: 12px;
      padding: 10px 12px;
      font: 12px/1.3 system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
      box-shadow: 0 12px 30px rgba(0,0,0,.25);
    }
  `;

  const styleEl = document.createElement("style");
  styleEl.textContent = styles;
  document.documentElement.appendChild(styleEl);

  const fab = document.createElement("div");
  fab.className = "pc2-fab";
  fab.title = "Price Predictor + CO₂";
  fab.textContent = "Price";
  document.documentElement.appendChild(fab);

  const panel = document.createElement("div");
  panel.className = "pc2-panel";
  panel.innerHTML = `
    <div class="pc2-header" id="pc2-drag">
      <div class="pc2-title">Price + CO₂</div>
      <button class="pc2-close" id="pc2-close">✕</button>
    </div>
    <div class="pc2-body">
      <div class="pc2-section" id="pc2-priceSection">
        <h3>Price</h3>
        <div class="pc2-row"><div class="pc2-key">Current</div><div class="pc2-val" id="pc2-current">—</div></div>
        <div class="pc2-row"><div class="pc2-key">Lowest</div><div class="pc2-val" id="pc2-lowest">—</div></div>
        <div class="pc2-row"><div class="pc2-key">Highest</div><div class="pc2-val" id="pc2-highest">—</div></div>
        <div class="pc2-row"><div class="pc2-key">Signal</div><div class="pc2-val" id="pc2-signal">—</div></div>
        <div class="pc2-row"><div class="pc2-key">Vs lowest</div><div class="pc2-val" id="pc2-vslowest">—</div></div>
        <div class="pc2-actions">
          <button class="pc2-btn primary" id="pc2-track">Track price</button>
          <button class="pc2-btn" id="pc2-refresh">Refresh</button>
        </div>
        <div class="pc2-status" id="pc2-priceStatus"></div>
      </div>

      <div class="pc2-section" id="pc2-co2Section">
        <h3>CO₂ impact (Climatiq)</h3>
        <div class="pc2-row"><div class="pc2-key">Category</div><div class="pc2-val" id="pc2-cat">—</div></div>
        <div class="pc2-row"><div class="pc2-key">Material</div><div class="pc2-val" id="pc2-mat">—</div></div>
        <div class="pc2-row"><div class="pc2-key">Weight</div><div class="pc2-val" id="pc2-w">—</div></div>
        <div class="pc2-row"><div class="pc2-key">CO₂e</div><div class="pc2-val" id="pc2-co2">—</div></div>
        <div class="pc2-actions">
          <button class="pc2-btn primary" id="pc2-estimate">Estimate CO₂</button>
        </div>
        <div class="pc2-status" id="pc2-co2Status"></div>
        <div class="pc2-footnote">Estimate baserad på material + antagen vikt. Källa: Climatiq emission factors.</div>
      </div>
    </div>
  `;
  document.documentElement.appendChild(panel);

  // Elements
  const el = {
    close: panel.querySelector("#pc2-close"),
    drag: panel.querySelector("#pc2-drag"),
    track: panel.querySelector("#pc2-track"),
    refresh: panel.querySelector("#pc2-refresh"),
    estimate: panel.querySelector("#pc2-estimate"),

    current: panel.querySelector("#pc2-current"),
    lowest: panel.querySelector("#pc2-lowest"),
    highest: panel.querySelector("#pc2-highest"),
    signal: panel.querySelector("#pc2-signal"),
    vslowest: panel.querySelector("#pc2-vslowest"),
    priceStatus: panel.querySelector("#pc2-priceStatus"),

    cat: panel.querySelector("#pc2-cat"),
    mat: panel.querySelector("#pc2-mat"),
    w: panel.querySelector("#pc2-w"),
    co2: panel.querySelector("#pc2-co2"),
    co2Status: panel.querySelector("#pc2-co2Status"),
  };

  function openPanel() {
    panel.style.display = "block";
    renderAll();
  }
  function closePanel() {
    panel.style.display = "none";
  }

  fab.addEventListener("click", () => {
    const isOpen = panel.style.display === "block";
    if (isOpen) closePanel();
    else openPanel();
  });

  el.close.addEventListener("click", closePanel);

  // Drag logic (panel)
  let dragging = false;
  let startX = 0,
    startY = 0;
  let startLeft = 0,
    startTop = 0;

  function px(n) {
    return `${Math.round(n)}px`;
  }

  el.drag.addEventListener("mousedown", (e) => {
    dragging = true;
    const rect = panel.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    startLeft = rect.left;
    startTop = rect.top;

    panel.style.right = "auto";
    panel.style.bottom = "auto";
    panel.style.left = px(rect.left);
    panel.style.top = px(rect.top);
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    const newLeft = Math.min(window.innerWidth - 60, Math.max(8, startLeft + dx));
    const newTop = Math.min(window.innerHeight - 60, Math.max(8, startTop + dy));

    panel.style.left = px(newLeft);
    panel.style.top = px(newTop);
  });

  window.addEventListener("mouseup", () => {
    dragging = false;
  });

  // =========================
  // Render functions
  // =========================
  async function renderPrice() {
    const price = extractPriceFromPage();
    if (!price) {
      el.priceStatus.textContent = "No price found on this page.";
      return;
    }

    const summary = await buildSummary(price.currency);
    if (!summary) {
      el.current.textContent = "—";
      el.lowest.textContent = "—";
      el.highest.textContent = "—";
      el.signal.textContent = "—";
      el.vslowest.textContent = "—";
      el.priceStatus.textContent = "No price history yet. Click Track price.";
      return;
    }

    const signal = computeSignal(summary.current, summary.lowest);
    const change = pctChange(summary.current, summary.lowest);

    el.current.textContent = formatPrice(summary.current, summary.currency);
    el.lowest.textContent = formatPrice(summary.lowest, summary.currency);
    el.highest.textContent = formatPrice(summary.highest, summary.currency);
    el.signal.textContent = signal;
    el.vslowest.textContent = change === null ? "—" : `${change}%`;

    el.priceStatus.textContent = `Tracked points (this product): ${summary.points}`;
  }

  async function renderSnapshot() {
    let snap = await getLocal("LAST_PRODUCT_SNAPSHOT");
    if (!snap || snap.url !== location.href) {
      snap = await saveCurrentProductSnapshot();
    }

    el.cat.textContent = snap.category;
    el.mat.textContent = snap.material + (snap.materialDetected ? "" : " (fallback)");
    el.w.textContent = `${snap.weightKg} kg`;
  }

  async function renderAll() {
    await renderSnapshot();
    await renderPrice();
  }

  // =========================
  // Widget actions
  // =========================
  el.refresh.addEventListener("click", async () => {
    el.priceStatus.textContent = "Refreshing…";
    await saveCurrentProductSnapshot();
    await renderAll();
    el.priceStatus.textContent = "";
  });

  el.track.addEventListener("click", async () => {
    el.priceStatus.textContent = "Saving price…";

    const price = extractPriceFromPage();
    if (!price) {
      el.priceStatus.textContent = "Could not find price on page.";
      return;
    }

    await savePricePoint(price);
    await renderPrice();

    el.priceStatus.textContent = "Saved price point ✅";
    setTimeout(() => (el.priceStatus.textContent = ""), 1500);
  });

  el.estimate.addEventListener("click", async () => {
    el.co2Status.textContent = "Calculating…";
    el.co2.textContent = "—";

    const snap = await getLocal("LAST_PRODUCT_SNAPSHOT");
    if (!snap) {
      el.co2Status.textContent = "No product snapshot yet. Refresh page.";
      return;
    }

    chrome.runtime.sendMessage(
      { type: "CO2_ESTIMATE_REQUEST", payload: { material: snap.material, weightKg: snap.weightKg } },
      (resp) => {
        if (!resp?.ok) {
          el.co2Status.textContent = `Error: ${resp?.error || "Unknown error"}`;
          return;
        }
        el.co2Status.textContent = "Done ✅";
        el.co2.textContent = fmtKg(resp.result.co2e);
      }
    );
  });

  // Init snapshot + keep updated on SPA navigations
  saveCurrentProductSnapshot();
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      saveCurrentProductSnapshot();
      if (panel.style.display === "block") renderAll();
    }
  }, 1200);

  // =========================
  // POPUP: select price mode
  // =========================
  let selecting = false;
  let hintEl = null;

  function showHint(text) {
    if (!hintEl) {
      hintEl = document.createElement("div");
      hintEl.className = "pc2-hint";
      document.documentElement.appendChild(hintEl);
    }
    hintEl.textContent = text;
  }
  function hideHint() {
    if (hintEl) hintEl.remove();
    hintEl = null;
  }

  function onMouseOver(e) {
    if (!selecting) return;
    const t = e.target;
    if (!(t instanceof Element)) return;
    t.classList.add("pc2-selecting");
  }
  function onMouseOut(e) {
    const t = e.target;
    if (!(t instanceof Element)) return;
    t.classList.remove("pc2-selecting");
  }

  async function onClickPick(e) {
    if (!selecting) return;
    e.preventDefault();
    e.stopPropagation();

    const t = e.target;
    if (!(t instanceof Element)) return;

    // Try element text first (without struck-through prices), fallback to body
    const text = getTextWithoutStruckPrices(t);
    let price = extractPriceFromText(text);
    if (!price) price = extractPriceFromPage();

    selecting = false;
    document.removeEventListener("mouseover", onMouseOver, true);
    document.removeEventListener("mouseout", onMouseOut, true);
    document.removeEventListener("click", onClickPick, true);
    hideHint();

    if (!price) return;

    await savePricePoint(price);
    if (panel.style.display === "block") await renderPrice();
  }

  // =========================
  // POPUP MESSAGE HANDLERS
  // =========================
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "PING") {
      sendResponse({ ok: true, ready: true });
      return true;
    }

    if (msg?.type === "OPEN_WIDGET") {
      openPanel();
      sendResponse({ ok: true });
      return true;
    }

    if (msg?.type === "TRACK_PRICE_AUTO") {
      (async () => {
        const price = extractPriceFromPage();
        if (!price) {
          sendResponse({ ok: false, error: "Could not find price on page." });
          return;
        }
        await savePricePoint(price);
        const summary = await buildSummary(price.currency);
        sendResponse({ ok: true, summary });
      })();
      return true;
    }

    if (msg?.type === "SELECT_PRICE_MODE") {
      selecting = true;

      showHint("Click the price on the page 👆 (ESC to cancel)");

      document.addEventListener("mouseover", onMouseOver, true);
      document.addEventListener("mouseout", onMouseOut, true);
      document.addEventListener("click", onClickPick, true);

      const onKey = (ev) => {
        if (ev.key === "Escape") {
          selecting = false;
          document.removeEventListener("mouseover", onMouseOver, true);
          document.removeEventListener("mouseout", onMouseOut, true);
          document.removeEventListener("click", onClickPick, true);
          window.removeEventListener("keydown", onKey, true);
          hideHint();
        }
      };
      window.addEventListener("keydown", onKey, true);

      sendResponse({ ok: true });
      return true;
    }

    return false;
  });
})();