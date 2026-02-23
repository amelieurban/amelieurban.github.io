// Initiera dataLayer om den inte redan finns
window.dataLayer = window.dataLayer || [];

// Helper-funktion för att pusha till dataLayer
function pushToDataLayer(event, data) {
  const payload = {
    event: event,
    ...data,
    timestamp: new Date().toISOString()
  };
  window.dataLayer.push(payload);

  // Logga till konsolen för debug
  console.log("📊 dataLayer push:", payload);
}

// När sidan laddas
document.addEventListener("DOMContentLoaded", function() {
  // Registrera sidvisning
  pushToDataLayer("page_view", {
    page_title: document.title,
    page_location: window.location.href,
    page_path: window.location.pathname
  });

  // Meny-klick (alla länkar i nav eller knappar med .menu-btn)
  document.querySelectorAll("nav a, .menu-btn").forEach(link => {
    link.addEventListener("click", function() {
      pushToDataLayer("menu_click", {
        link_text: this.textContent.trim(),
        link_url: this.href || null
      });
    });
  });

  // "Read more"-klick (alla knappar/länkar med texten Read more)
  document.querySelectorAll("a, button").forEach(el => {
    if (el.textContent.trim().toLowerCase() === "view case") {
      el.addEventListener("click", function() {
        pushToDataLayer("view_case_click", {
          link_text: this.textContent.trim(),
          link_url: this.href || null
        });
      });
    }
  });
});

// Exempel: logga hela historiken till konsolen
window.showDataLayerHistory = function() {
  console.table(window.dataLayer);
};
