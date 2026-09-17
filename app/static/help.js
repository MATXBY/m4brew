// help.js — shared help modal used on every page that has a helpOverlay
function initHelpModal(helpData) {
  const overlay = document.getElementById("helpOverlay");
  const closeBtn = document.getElementById("helpCloseBtn");
  const bodyEl   = document.getElementById("helpBody");
  const titleEl  = document.getElementById("helpTitle");

  function openHelp(key) {
    const d = helpData[key];
    if (!d || !overlay || !bodyEl || !titleEl) return;
    titleEl.textContent = d.title || "Help";
    bodyEl.innerHTML = (d.body || []).map(t => "<p>" + String(t) + "</p>").join("");
    if (d.boxes && Array.isArray(d.boxes)) {
      d.boxes.forEach(b => {
        const wrap = document.createElement("div");
        wrap.className = "help-box" + (b.tone ? (" help-box--" + b.tone) : "");
        const h = document.createElement("div");
        h.className = "help-box-title";
        h.textContent = b.title || "";
        wrap.appendChild(h);
        (b.lines || []).forEach(l => {
          const p = document.createElement("p");
          p.textContent = l;
          wrap.appendChild(p);
        });
        bodyEl.appendChild(wrap);
      });
    }
    overlay.classList.add("open");
    overlay.setAttribute("aria-hidden", "false");
    if (closeBtn) closeBtn.focus();
  }

  function closeHelp() {
    if (!overlay) return;
    overlay.classList.remove("open");
    overlay.setAttribute("aria-hidden", "true");
  }

  // Each [data-help] trigger is the small ⓘ icon inside its pill/section,
  // not the whole pill - stop the click here so it never bubbles up to a
  // parent's own click handler (e.g. the status bar pill's expand/collapse).
  document.querySelectorAll("[data-help]").forEach(el => {
    el.addEventListener("click", e => { e.stopPropagation(); openHelp(el.getAttribute("data-help")); });
    el.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); openHelp(el.getAttribute("data-help")); }
    });
  });

  if (closeBtn) closeBtn.addEventListener("click", closeHelp);
  if (overlay)  overlay.addEventListener("click", e => { if (e.target === overlay) closeHelp(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeHelp(); });
}
