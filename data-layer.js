// =========================
// Initiera dataLayer
// =========================
window.dataLayer = window.dataLayer || [];

// =========================
// Helper: pusha till dataLayer
// =========================
function pushToDataLayer(event, data) {
  const payload = {
    event: event,
    ...data,
    timestamp: new Date().toISOString()
  };

  window.dataLayer.push(payload);

  // Debug
  console.log("📊 dataLayer push:", payload);
}

// =========================
// Helpers
// =========================
function safeText(str, max = 80) {
  if (!str) return "";
  return String(str).trim().replace(/\s+/g, " ").slice(0, max);
}

function cssPath(el) {
  try {
    if (!el || el.nodeType !== 1) return "";
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 7) {
      let part = cur.nodeName.toLowerCase();
      if (cur.id) {
        part += `#${cur.id}`;
        parts.unshift(part);
        break;
      }
      if (cur.classList && cur.classList.length) {
        part += "." + Array.from(cur.classList).slice(0, 2).join(".");
      }
      parts.unshift(part);
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  } catch {
    return "";
  }
}

function safeAbsUrl(href) {
  if (!href) return "";
  try {
    return new URL(href, window.location.href).href;
  } catch {
    return "";
  }
}

function isOutbound(url) {
  try {
    const u = new URL(url);
    return u.host !== window.location.host;
  } catch {
    return false;
  }
}

function getExtension(url) {
  try {
    const clean = String(url).split("?")[0].split("#")[0];
    const last = clean.split("/").pop() || "";
    return last.includes(".")
      ? last.split(".").pop().toLowerCase()
      : "";
  } catch {
    return "";
  }
}

const downloadExt = new Set([
  "pdf", "zip", "rar", "7z",
  "doc", "docx", "ppt", "pptx", "xls", "xlsx",
  "csv", "txt",
  "png", "jpg", "jpeg", "webp", "svg",
  "mp4", "mov", "mp3", "wav"
]);

// =========================
// Unik click-id
// =========================
const pageId =
  (window.crypto && crypto.randomUUID && crypto.randomUUID()) ||
  `p_${Math.random().toString(16).slice(2)}_${Date.now()}`;

let clickCounter = 0;

function makeClickId() {
  clickCounter += 1;
  return `${pageId}_${clickCounter}`;
}

// =========================
// När sidan laddas
// =========================
document.addEventListener("DOMContentLoaded", function () {

  // Page view
  pushToDataLayer("page_view", {
    page_title: document.title,
    page_location: window.location.href,
    page_path: window.location.pathname
  });

  // Meny-klick
  document.querySelectorAll("nav a, .menu-btn").forEach(link => {
    link.addEventListener("click", function () {
      pushToDataLayer("menu_click", {
        link_text: this.textContent.trim(),
        link_url: this.href || null
      });
    });
  });

  // View work klick

  // View work card click
  document.querySelectorAll(".work-card-link").forEach(link => {
    link.addEventListener("click", function () {
      const title = this.querySelector("h3")?.textContent?.trim() || "Work";
      pushToDataLayer("view_work_click", {
        link_text: title,
        link_url: this.href || null
      });
    });
  });

  document.querySelectorAll("a, button").forEach(el => {
    if (el.textContent.trim().toLowerCase() === "view work") {
      el.addEventListener("click", function () {
        pushToDataLayer("view_work_click", {
          link_text: this.textContent.trim(),
          link_url: this.href || null
        });
      });
    }
  });

});

// =========================
// GLOBAL CLICK TRACKING
// =========================
document.addEventListener("pointerdown", function (e) {

  const target = e.target;

  const el =
    target?.closest?.("a, button, [role='button'], input, textarea, select, [data-track]") ||
    target;

  if (!el) return;

  const clickId = makeClickId();
  const tag = (el.tagName || "").toLowerCase();

  const a = el.closest?.("a");
  const href = a?.getAttribute?.("href") || "";

  const linkUrl = safeAbsUrl(href);
  const ext = getExtension(href);
  const isDownload = ext && downloadExt.has(ext);
  const outbound = linkUrl ? isOutbound(linkUrl) : false;

  const trackName = el.getAttribute?.("data-track") || "";
  const trackValue = el.getAttribute?.("data-track-value") || "";

  const text =
    safeText(el.getAttribute?.("aria-label")) ||
    safeText(el.getAttribute?.("title")) ||
    safeText(el.textContent);

  pushToDataLayer("au_click", {
    click_id: clickId,

    page_title: document.title,
    page_location: window.location.href,
    page_path: window.location.pathname,

    element_tag: tag,
    element_id: el.id || "",
    element_classes: safeText(el.className, 120),
    element_text: text,
    element_selector: cssPath(el),

    link_href: href || "",
    link_url: linkUrl || "",
    is_outbound: outbound,
    is_download: isDownload || false,
    file_extension: ext || "",

    track_name: trackName,
    track_value: trackValue
  });

  if (isDownload && linkUrl) {
    pushToDataLayer("au_download", {
      click_id: clickId,
      file_url: linkUrl,
      file_extension: ext,
      page_path: window.location.pathname
    });
  }

  if (outbound && linkUrl) {
    pushToDataLayer("au_outbound", {
      click_id: clickId,
      outbound_url: linkUrl,
      page_path: window.location.pathname
    });
  }

}, { capture: true });

// =========================
// Debug helper
// =========================
window.showDataLayerHistory = function () {
  console.table(window.dataLayer);
};