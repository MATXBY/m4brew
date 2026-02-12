(function(){
  // =========================
  // HELP OVERLAY CONTENT
  // =========================
  const HELP = {
    "select-source": {
      title: "FOLDERS: LOCATION & STRUCTURE",
      body: [
        "Choose your *mapped folder* from the dropdown.",
        "",
        "Multiple root audiobook folders can be mapped into the container.",
        "",
        "The template provides 3 fields (Audiobooks 1–3).",
        "",
        "Set your host paths there… then pick one here.",
        "",
        "NOTE: Audiobook folder structure matters - See below"
      ],
      boxes: [
        {
          title: "FOLDER STRUCTURE",
          lines: [
            "Audiobooks/",
            "└── Author Name/",
            "    └── Book Title/",
            "        └── audio files"
          ]
        }
      ]
    },

    "select-audio": {
      title: "AUDIO CHANNELS",
      body: ["Choose audio channel behaviour:"],
      boxes: [
        { title: "", lines: ["MATCH — keep what the source uses", "MONO — force mono", "STEREO — force stereo"] }
      ]
    },

    "select-bitrate": {
      title: "BITRATE",
      body: ["Choose your preferred audio bitrate."],
      boxes: [
        { title: "", lines: ["MATCH SOURCE — detects the highest source bitrate and matches it", "FIXED — choose a specific bitrate (32–320 kbps)"] }
      ]
    },

    "step-convert": {
      title: "CONVERTING YOUR FILES",
      body: [],
      boxes: [
        { title: "TEST", tone: "test", lines: ["Preview how many books will be converted.", "No files are changed."] },
        { title: "RUN",  tone: "convert", lines: ["Begins the actual conversion process.", "Batch converts eligible folders into single, chapterised M4B files."] },
        { title: "CHAPTERS", lines: ["Chapters are defined by each source file.", "Each file becomes a chapter in the final M4B."] },
        { title: "SUPPORTED FILE TYPES", lines: ["MP3 → M4B", "M4A → M4B (single or multiple files)", "M4B parts → merged M4B (when part order is clear)"] }
      ]
    },

    "step-rename": {
      title: "RENAMING YOUR FILES",
      body: [],
      boxes: [
        { title: "TEST", tone: "test", lines: ["Shows which files would be renamed."] },
        { title: "RUN",  tone: "rename", lines: ["Performs the actual renaming.", "Naming is based on folder structure."] },
        {
          title: "RENAMING RULES",
          lines: [
            "Audiobooks/",
            "└── Author Name/",
            "    └── Book Title/",
            "        └── audio files",
            "",
            "Becomes: 'Book Title - Author Name.m4b'"
          ]
        }
      ]
    },

    "step-delete": {
      title: "DELETING BACKUPS",
      body: [],
      boxes: [
        { title: "TEST", tone: "test", lines: ["Shows how many backup folders would be deleted."] },
        { title: "RUN",  tone: "delete", lines: ["RUN permanently deletes those backup folders."] },
        { title: "SAFETY FIRST", lines: ["M4Brew only moves originals after a successful conversion.", "Delete only removes already-backed-up folders."] }
      ]
    }
  };

  const overlay = document.getElementById("helpOverlay");
  const closeBtn = document.getElementById("helpCloseBtn");
  const bodyEl = document.getElementById("helpBody");
  const titleEl = document.getElementById("helpTitle");

  function openHelp(key){
    const d = HELP[key];
    if(!d || !overlay || !bodyEl || !titleEl || !closeBtn) return;

    titleEl.textContent = d.title || "Help";
    bodyEl.innerHTML = (d.body || []).map(t => `<p>${String(t)}</p>`).join("");

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
    overlay.setAttribute("aria-hidden","false");
    closeBtn.focus();
  }

  function closeHelp(){
    if(!overlay) return;
    overlay.classList.remove("open");
    overlay.setAttribute("aria-hidden","true");
  }

  document.querySelectorAll("[data-help]").forEach(el => {
    if (!el.classList.contains("step-label")) return;
    el.addEventListener("click", () => openHelp(el.getAttribute("data-help")));
    el.addEventListener("keydown", (e) => {
      if(e.key === "Enter" || e.key === " "){
        e.preventDefault();
        openHelp(el.getAttribute("data-help"));
      }
    });
  });

  if (closeBtn) closeBtn.addEventListener("click", closeHelp);
  if (overlay) overlay.addEventListener("click", (e) => { if(e.target === overlay) closeHelp(); });
  document.addEventListener("keydown", (e) => { if(e.key === "Escape") closeHelp(); });

  // =========================
  // TASK PAGE LOGIC
  // =========================
  const statusPill = document.getElementById("statusPill");
  const liveBtn = document.getElementById("liveBtn");
  const liveWrap = document.getElementById("liveWrap");
  const livePanel = document.getElementById("livePanel");
  const cancelForm = document.getElementById("cancelForm");
  const statusTop = document.getElementById("statusTop");

  const lvTask = document.getElementById("lvTask");
  const lvBook = document.getElementById("lvBook");
  const lvProgress = document.getElementById("lvProgress");
  const lvRuntime = document.getElementById("lvRuntime");
  const lvAudio = document.getElementById("lvAudio");
  const lvStage = document.getElementById("lvStage");
  const lvWarn = document.getElementById("lvWarn");
  const lvErr = document.getElementById("lvErr");

  let liveOn = (localStorage.getItem("m4brew_live") === "1");
  let _nextPollMs = 1000;

  // DONE pill persistence (so it survives the redirect back to Tasks)
  const DONE_KEY = "m4brew_last_done_pill";
  const DONE_SEEN_KEY = "m4brew_seen_done_terminal";
  const HOLD_SEEN_KEY = "m4brew_seen_hold_terminal";
  const TEST_SEEN_KEY = "m4brew_seen_test_terminal";

  function setDonePill(cls, l1, term){
    try{ localStorage.setItem(DONE_KEY, JSON.stringify({cls:(cls||null), l1:(l1||""), term:(term||""), ts:Date.now()})); }catch(_){ }
  }
  function getDonePill(){
    try{ const raw = localStorage.getItem(DONE_KEY); return raw ? JSON.parse(raw) : null; }catch(_){ return null; }
  }
  function clearDonePill(){
    try{ localStorage.removeItem(DONE_KEY); }catch(_){ }
  }
  function dismissDone(){
    try{
      const raw = localStorage.getItem(DONE_KEY);
      if(raw){
        const d = JSON.parse(raw);
        if(d && d.term) localStorage.setItem(DONE_SEEN_KEY, String(d.term));
      }
      localStorage.removeItem(DONE_KEY);
    }catch(_){}
  }

  // If we navigated away and came back, dismiss DONE so it doesn’t repaint forever
  window.addEventListener("pagehide", () => {
    try{ sessionStorage.setItem("m4brew_tasks_left","1"); }catch(_){ }
  });
  window.addEventListener("pageshow", () => {
    try{
      if(sessionStorage.getItem("m4brew_tasks_left") === "1"){
        dismissDone();
        sessionStorage.removeItem("m4brew_tasks_left");
      }
    }catch(_){}
  });

  // Any user submit action = they’ve “seen” the DONE state
  document.addEventListener("submit", dismissDone, true);

  // -------------------------
  // Preflight (cached)
  // -------------------------
  let _pf_cache = null;
  let _pf_cache_ts = 0;

  async function fetchPreflight(force=false){
    const now = Date.now();
    if(!force && _pf_cache && (now - _pf_cache_ts) < 4000) return _pf_cache;
    try{
      const r = await fetch("/api/preflight?ts=" + now, {cache:"no-store"});
      const j = await r.json();
      _pf_cache = j;
      _pf_cache_ts = now;
      return j;
    }catch(_){
      return {ok:false, error_code:"preflight_exception", message:"Preflight request failed"};
    }
  }

  function preflightToPill(pf){
    const code = pf && pf.error_code ? String(pf.error_code) : "unknown";
    if(code === "folder_missing") return {cls:"status-warn", l1:"Mapped folder does not exist", l2:""};
    if(code === "not_mounted")   return {cls:"status-warn", l1:"Add folder path to M4Brew template", l2:""};
    if(code === "write_denied")  return {cls:"status-error", l1:"Write denied", l2:"Fix PUID/PGID or permissions"};
    if(code === "no_root")       return {cls:"status-warn", l1:"No mapped folder set", l2:"Set Mapped folder above"};
    if(code === "preflight_exception") return {cls:"status-error", l1:"Preflight error", l2:String((pf && pf.message) ? pf.message : "")};
    return {cls:"status-error", l1:"Cannot start", l2:String((pf && (pf.message||pf.error_code)) ? (pf.message||pf.error_code) : "Unknown error")};
  }

  // -------------------------
  // Helpers
  // -------------------------
  function pad2(n){ n = Number(n||0); return (n < 10 ? "0" : "") + n; }
  function fmtRuntime(seconds){
    const s = Math.max(0, Number(seconds || 0));
    const hh = Math.floor(s / 3600);
    const mm = Math.floor((s % 3600) / 60);
    const ss = Math.floor(s % 60);
    return pad2(hh) + ":" + pad2(mm) + ":" + pad2(ss);
  }
  function runtimeFromStarted(startedIso){
    if(!startedIso) return null;
    const t0 = Date.parse(String(startedIso));
    if(!Number.isFinite(t0)) return null;
    return Math.floor((Date.now() - t0) / 1000);
  }
  function modeLabel(mode){
    const m = String(mode || "").toLowerCase();
    return (m === "convert") ? "Convert"
         : (m === "correct") ? "Rename"
         : (m === "cleanup") ? "Delete"
         : "Run";
  }
  function modeVerb(mode){
    const m = String(mode || "").toLowerCase();
    return (m === "convert") ? "Convert"
         : (m === "correct") ? "Rename"
         : (m === "cleanup") ? "Delete"
         : "Run";
  }
  function modePast(mode){
    const m = String(mode || "").toLowerCase();
    return (m === "convert") ? "converted"
         : (m === "correct") ? "renamed"
         : (m === "cleanup") ? "deleted"
         : "done";
  }
  function isDryRun(job){
    const s = (job && job.summary) ? job.summary : {};
    return (job && (job.dry_run === true || job.dry_run === "true")) ||
           (s && (s.dry_run === true || s.dry_run === "true"));
  }
  function bookFromPath(p){
    const s = String(p || "");
    if(!s) return "—";
    const parts = s.split("/").filter(Boolean);
    if(parts.length < 2) return s;
    const book = parts[parts.length - 1];
    const author = parts[parts.length - 2];
    return author + " / " + book;
  }
  function currentBook(job){
    if(job && job.current_path && String(job.current_path).trim()) return bookFromPath(job.current_path);
    if(job && job.current_book && String(job.current_book).trim()) return String(job.current_book);
    return "";
  }
  function getWarnings(summary){
    const s = summary || {};
    const list = Array.isArray(s.warnings) ? s.warnings : [];
    const count = Number(s.warnings_count ?? list.length ?? 0);
    return { count, list };
  }
  function hasOrderUnclearWarning(summary){
    const w = getWarnings(summary);
    if(!w || !w.list || !w.list.length) return false;
    return w.list.some(x => x && String(x.code || "") === "order_unclear");
  }

  // -------------------------
  // Pill rendering
  // -------------------------
  let _pillHold = null; /* {cls,l1,until} */
  function holdPill(cls, l1, ms){
    _pillHold = { cls: (cls||null), l1: (l1||""), until: Date.now() + (ms||2500) };
  }
  function holdActive(){
    return _pillHold && Date.now() < _pillHold.until;
  }
  function clearHold(){
    _pillHold = null;
  }

  function setPill(stateClass, line1, line2){
    if(!statusPill) return;
    const allStates = ["status-running","status-done","status-warn","status-error","status-test","status-idle","status-run1","status-run2","status-run3"];
    const needsChange = stateClass && !statusPill.classList.contains(stateClass);
    if(needsChange){
      allStates.forEach(c => statusPill.classList.remove(c));
      statusPill.classList.add(stateClass);
    }
    if(line2){ statusPill.classList.add("is-two-line"); } else { statusPill.classList.remove("is-two-line"); }
    const curL1 = statusPill.querySelector(".pill-line1");
    const curL2 = statusPill.querySelector(".pill-line2");
    if(!curL1 || !curL2){
      statusPill.innerHTML = '<span class="pill-line1"></span><span class="pill-line2"></span>';
    }
    const el1 = statusPill.querySelector(".pill-line1");
    const el2 = statusPill.querySelector(".pill-line2");
    if(el1.textContent !== (line1 || "")) el1.textContent = line1 || "";
    if(line2){
      if(el2.textContent !== line2) el2.textContent = line2;
      el2.style.display = "block";
    }else{
      if(el2.textContent !== "") el2.textContent = "";
      el2.style.display = "none";
    }
  }

  function setPillDirect(stateClass, line1, line2){
    setPill(stateClass, line1, line2);
  }

  function setPulseForMode(mode, dry){
    if(!statusPill) return;
    const m = String(mode || "").toLowerCase();

    if(dry){
      try{ statusPill.style.setProperty("--pulse-color", "rgba(99,102,241,.22)"); }catch(_){ }
      try{ statusPill.style.setProperty("--running-bg",  "rgba(99,102,241,.18)"); }catch(_){ }
      try{ statusPill.style.setProperty("--running-border", "rgba(99,102,241,.38)"); }catch(_){ }
      return;
    }

    const pulse = (m === "convert") ? "rgb(var(--task-convert-rgb) / .22)"
                : (m === "correct") ? "rgb(var(--task-rename-rgb) / .22)"
                : (m === "cleanup") ? "rgb(var(--task-delete-rgb) / .22)"
                : "rgb(var(--task-convert-rgb) / .22)";

    const bg = (m === "convert") ? "rgb(var(--task-convert-rgb) / .18)"
             : (m === "correct") ? "rgb(var(--task-rename-rgb) / .18)"
             : (m === "cleanup") ? "rgb(var(--task-delete-rgb) / .18)"
             : "rgb(var(--task-convert-rgb) / .18)";

    const br = "transparent";
    try{ statusPill.style.setProperty("--pulse-color", pulse); }catch(_){ }
    try{ statusPill.style.setProperty("--running-bg", bg); }catch(_){ }
    try{ statusPill.style.setProperty("--running-border", br); }catch(_){ }
  }

  function clearPulse(){
    if(!statusPill) return;
    try{ statusPill.style.removeProperty("--pulse-border"); }catch(_){ }
  }

  // -------------------------
  // Live panel
  // -------------------------
  function setLiveUI(){
    if (liveBtn) {
      liveBtn.textContent = "Live output: " + (liveOn ? "ON" : "OFF");
      liveBtn.classList.toggle("primary", liveOn);
      liveBtn.classList.toggle("is-off", !liveOn);
    }
    if (liveWrap) liveWrap.style.display = liveOn ? "block" : "none";
  }

  if (liveBtn) liveBtn.addEventListener("click", () => {
    liveOn = !liveOn;
    localStorage.setItem("m4brew_live", liveOn ? "1" : "0");
    setLiveUI();
  });

  function updateLivePanel(job){
    if(!lvTask || !lvBook || !lvProgress || !lvRuntime || !lvAudio || !lvStage || !lvWarn || !lvErr) return;

    if(!job || !job.status || job.status === "none"){
      lvTask.textContent = "—";
      lvBook.textContent = "—";
      lvProgress.textContent = "—";
      lvRuntime.textContent = "—";
      lvAudio.textContent = "—";
      lvStage.textContent = "—";
      lvWarn.textContent = "—";
      lvErr.textContent = "—";
      return;
    }

    const mode = String(job.mode || "").toLowerCase();
    const task = modeLabel(mode);
    const dry = isDryRun(job);
    const taskLine = task + " (" + (dry ? "Test" : "Run") + ")";

    const book = (job.current_path && String(job.current_path).trim())
      ? bookFromPath(job.current_path)
      : ((job.current_book && String(job.current_book).trim()) ? String(job.current_book) : "—");

    const total = Number(job.total || 0);
    const current = Number(job.current || 0);
    const progress = (total > 0) ? (current + " / " + total) : "—";

    let seconds = null;
    if (job.runtime_s != null) seconds = Number(job.runtime_s);
    else if (job.started) seconds = runtimeFromStarted(job.started);
    const rt = (seconds != null) ? fmtRuntime(seconds) : "—";

    const st = (job.status === "running")
      ? (mode === "convert" ? "Converting"
        : mode === "correct" ? "Renaming"
        : mode === "cleanup" ? "Deleting"
        : "Running")
      : (job.status === "finished" ? "Finished" : String(job.status));

    const settings = job.settings || {};
    const am = settings.audio_mode ? String(settings.audio_mode) : "—";
    const br = (settings.bitrate != null) ? String(settings.bitrate) + " kbps" : "—";
    const audio = (am !== "—" || br !== "—") ? (am + ", " + br) : "—";

    const sum = job.summary || {};
    const w = getWarnings(sum);
    const warnings = String(Number(sum.warnings_count ?? (Array.isArray(sum.warnings) ? sum.warnings.length : 0) ?? 0));
    const errors = String(Number(sum.failed || 0));

    lvTask.textContent = taskLine;
    lvBook.textContent = book;
    lvProgress.textContent = progress;
    lvRuntime.textContent = rt;
    lvAudio.textContent = audio;
    lvStage.textContent = st;
    lvWarn.textContent = warnings;
    lvErr.textContent = errors;
  }

  // --- Live panel view toggle (Human vs Full log) ---
  function setupLiveViews(){
    const viewBtn = document.getElementById("viewToggleBtn");
    if(!livePanel || !viewBtn) return;

    let logPre = document.getElementById("fullLog");
    if(!logPre){
      logPre = document.createElement("pre");
      logPre.id = "fullLog";
      logPre.className = "full-log";
      logPre.style.display = "none";
      const firstRow = livePanel.querySelector(".live-row");
      if(firstRow) livePanel.insertBefore(logPre, firstRow);
      else livePanel.appendChild(logPre);
    }

    let mode = localStorage.getItem("m4brew_live_view") || "human";

    async function refreshLog(){
      try{
        const r = await fetch("/job/output?ts=" + Date.now(), {cache:"no-store"});
        const t = await r.text();
        logPre.textContent = t;
        logPre.scrollTop = logPre.scrollHeight;
      }catch(_){ }
    }

    function apply(){
      const rows = livePanel.querySelectorAll(".live-row");
      rows.forEach(el => { el.style.display = (mode === "human") ? "" : "none"; });
      logPre.style.display = (mode === "log") ? "block" : "none";
      viewBtn.textContent = (mode === "human") ? "Advanced View" : "Simple View";
    }

    viewBtn.addEventListener("click", () => {
      mode = (mode === "human") ? "log" : "human";
      localStorage.setItem("m4brew_live_view", mode);
      apply();
      if(mode === "log") refreshLog();
    });

    apply();
    window.__m4brew_live_view = () => mode;
    window.__m4brew_refresh_log = refreshLog;
  }

  // -------------------------
  // Mount dropdown + autosave
  // -------------------------
  const form = document.getElementById("settingsForm");
  const rootInput = document.getElementById("root_folder");
  const initialRoot = rootInput ? (rootInput.value || "") : "";
  let rootDirty = false;
  let _autosaveTimer = null;

  async function initMountDropdown(){
    try{
      if(!rootInput) return;

      const r = await fetch("/api/mounts?ts=" + Date.now(), {cache:"no-store"});
      const j = await r.json();
      const mounts = (j && j.mounts) ? j.mounts : [];

      const filtered = mounts.filter(m =>
        m && m.container && m.host &&
        String(m.container).startsWith("/") &&
        !["/config","/var/run/docker.sock"].includes(String(m.container))
      );

      if(!filtered.length) return;

      const sel = document.createElement("select");
      sel.className = "field";
      sel.id = "root_mount_pick";
      sel.setAttribute("aria-label","Pick from mapped folders");

      const ph = document.createElement("option");
      ph.value = "";
      ph.textContent = "Pick from mapped folders…";
      sel.appendChild(ph);

      for(const m of filtered){
        const opt = document.createElement("option");
        opt.value = String(m.container);
        opt.textContent = `${m.container}  (${m.host})`;
        sel.appendChild(opt);
      }

      const cur = String((rootInput.value || "")).trim();
      if(cur){
        const hit = filtered.find(m => cur === String(m.container) || cur === String(m.host));
        if(hit) sel.value = String(hit.container);
      }

      rootInput.insertAdjacentElement("afterend", sel);

      sel.addEventListener("change", async () => {
        if(!sel.value) return;

        rootInput.value = sel.value;

        rootInput.dispatchEvent(new Event("input", {bubbles:true}));
        rootInput.dispatchEvent(new Event("change", {bubbles:true}));

        _pf_cache = null; _pf_cache_ts = 0;
        try{
          const pf = await fetchPreflight(true);
          const pill = (pf && pf.ok) ? {cls:"status-idle", l1:"Ready", l2:""} : preflightToPill(pf);
          setPillDirect(pill.cls, pill.l1, pill.l2);
        }catch(_){}
      });

    }catch(_){}
  }

  function autosave(){
    if(!form) return;
    if(_autosaveTimer) clearTimeout(_autosaveTimer);
    _autosaveTimer = setTimeout(async () => {
      try{
        const fd = new FormData(form);
        if(!rootDirty) fd.delete("root_folder");

        await fetch("/settings", {
          method: "POST",
          body: fd,
          headers: {
            "X-M4Brew-Autosave": "1",
            "X-M4Brew-Root-Dirty": rootDirty ? "1" : "0"
          }
        });
      }catch(_){}
    }, 250);
  }

  if(rootInput){
    initMountDropdown();
    rootInput.addEventListener("input", () => {
      rootDirty = (rootInput.value || "") !== initialRoot;
    });
  }
  if(form){
    form.addEventListener("submit", (e) => { e.preventDefault(); });
    form.addEventListener("input", autosave);
    form.addEventListener("change", autosave);
  }

  // -------------------------
  // Status pill click toggles Live output
  // -------------------------
  setLiveUI();

  if(statusPill){
    statusPill.style.cursor = "pointer";
    statusPill.setAttribute("role","button");
    statusPill.setAttribute("tabindex","0");
    statusPill.setAttribute("title","Click to toggle live output");

    const toggleLive = () => {
      liveOn = !liveOn;
      localStorage.setItem("m4brew_live", liveOn ? "1" : "0");
      setLiveUI();
    };

    statusPill.addEventListener("click", toggleLive);
    statusPill.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleLive(); }
    });
  }

  // -------------------------
  // Guard Step forms: block Test/Run when preflight fails
  // -------------------------
  document.addEventListener("submit", async (e) => {
    const f = e.target;
    if(!f || f.tagName !== "FORM") return;

    const action = (f.getAttribute("action") || "").trim();
    if(action !== "/") return;

    // Allow after we pass preflight once
    if(f.__m4brew_allowed === true) return;

    // Only Step forms have a mode field
    if(!f.querySelector('input[name="mode"]')) return;

    e.preventDefault();

    const pf = await fetchPreflight(true);
    if(pf && pf.ok === true){
      f.__m4brew_allowed = true;
      f.submit();
      return;
    }

    const info = preflightToPill(pf || {});
    setPillDirect(info.cls, info.l1, info.l2);
  }, true);

  // =========================
  // MAIN POLL LOOP
  // =========================
  let _dismissRunTerminal = false;
  let _navReload = false;
  try{
    const n = performance.getEntriesByType && performance.getEntriesByType("navigation");
    _navReload = !!(n && n[0] && n[0].type === "reload");
  }catch(_){ _navReload = false; }

  document.addEventListener("input", (e) => {
    try{ if(e && e.target && e.target.closest && e.target.closest("#settingsForm")) _dismissRunTerminal = true; }catch(_){ }
  }, true);
  document.addEventListener("change", (e) => {
    try{ if(e && e.target && e.target.closest && e.target.closest("#settingsForm")) _dismissRunTerminal = true; }catch(_){ }
  }, true);

  document.addEventListener("submit", () => {
    _dismissRunTerminal = true;
    clearHold();
    clearDonePill();
  }, true);

  async function tick(){
    try{
      const r = await fetch("/api/job", {cache:"no-store"});
      const job = await r.json();

      const jobRunning = (job && (job.status === "running" || job.status === "canceling"));

      // When NOT running, show preflight setup warnings
      if(!jobRunning){
        const pf = await fetchPreflight(false);
        if(pf && pf.ok === false){
          const info = preflightToPill(pf);
          setPill(info.cls, info.l1, info.l2);
          clearPulse();

          if(cancelForm) cancelForm.style.display = "none";
          if(statusTop) statusTop.classList.remove("has-cancel");
          if(liveOn) updateLivePanel(job);
          return;
        }
      }

      // Cancel button visibility: only show during real convert run (matches your existing rule)
      const showCancel = (job && job.status === "running" && String(job.mode||"").toLowerCase() === "convert" && !isDryRun(job));
      if(cancelForm) cancelForm.style.display = showCancel ? "flex" : "none";
      if(statusTop) statusTop.classList.toggle("has-cancel", showCancel);

      if(!job || !job.status || job.status === "none"){
        if(holdActive()){
          setPill((_pillHold.cls||"status-idle"), _pillHold.l1, "");
        }else{
          const d = getDonePill();
          if(d && d.l1 && d.term && (localStorage.getItem(DONE_SEEN_KEY) !== d.term)){
            setPill((d.cls||"status-idle"), d.l1, "");
            try{ localStorage.setItem(DONE_SEEN_KEY, d.term); }catch(_){ }
          }else{
            setPill("status-idle", "Ready to Brew", "");
          }
        }
        clearPulse();
        if(liveOn) updateLivePanel(job);
        return;
      }

      const mode = String(job.mode || "").toLowerCase();
      const dry = isDryRun(job);
      const sum = job.summary || {};
      const failed = Number(sum.failed ?? 0);
      const w = getWarnings(sum);
      const hasOrder = hasOrderUnclearWarning(sum);

      if(job.status === "running" || job.status === "canceling"){
        clearHold();
        clearDonePill();

        setPulseForMode(mode, dry);

        const total = Number(job.total || 0);
        const current = Number(job.current || 0);

        if(dry){
          const l1 = (total > 0) ? ("Test · Checking " + current + "/" + total) : "Test · Checking…";
          setPill("status-running", l1, "");
        }else{
          let seconds = null;
          if (job.runtime_s != null) seconds = Number(job.runtime_s);
          else if (job.started) seconds = runtimeFromStarted(job.started);
          const rt = (seconds != null) ? fmtRuntime(seconds) : "00:00:00";
          let l1 = rt + " · " + (mode === "convert" ? "Converting" : mode === "correct" ? "Renaming" : mode === "cleanup" ? "Deleting" : "Running");
          if(total > 0) l1 += " " + current + "/" + total;
          setPill("status-running", l1, "");
        }

        if(liveOn) updateLivePanel(job);
        return;
      }

      // Finished/canceled/failed
      clearPulse();

      const started = String(job.started || "");
      const _termKey = started + "|" + mode + "|" + String(job.status || "") + "|" + String(job.exit_code || "");
      const _seenKey = "m4brew_seen_terminal";
      const _alreadySeen = (localStorage.getItem(_seenKey) === _termKey);
      const _seenTest = (localStorage.getItem(TEST_SEEN_KEY) === _termKey);

      // If RUN finished, and user refreshed/navigated, return to idle instead of repainting DONE forever
      if(job.status === "finished" && !dry && _dismissRunTerminal){
        setPill("status-idle", "Ready to Brew", "");
        if(liveOn) updateLivePanel(job);
        return;
      }

      // If TEST already seen and no hold active, go idle (but allow “done pill” persistence once)
      if(dry && _seenTest && !holdActive()){
        const d = getDonePill();
        if(d) setPill(d.cls, d.l1, "");
        else setPill("status-idle", "Ready to Brew", "");
        if(liveOn) updateLivePanel(job);
        return;
      }

      if(job.status === "canceled"){
        if(!_alreadySeen) localStorage.setItem(_seenKey, _termKey);
        if(_alreadySeen && !holdActive()){
          setPill("status-idle", "Ready to Brew", "");
          if(liveOn) updateLivePanel({status:"none"});
          return;
        }
        setPill("status-warn", "Cancelled", "");
        holdPill("status-warn","Cancelled",2500);
        if(liveOn) updateLivePanel(job);
        return;
      }

      // Counts: created/renamed/deleted (same as your server summary)
      const count = (mode === "convert") ? Number(sum.created ?? 0)
                   : (mode === "correct") ? Number(sum.renamed ?? 0)
                   : (mode === "cleanup") ? Number(sum.deleted ?? 0)
                   : 0;

      // Terminal “seen” gating (prevents repaint loops)
      if(dry){
        if(localStorage.getItem(TEST_SEEN_KEY) !== _termKey){
          localStorage.setItem(TEST_SEEN_KEY, _termKey);
        }
      }else{
        // If DONE was dismissed, do NOT repaint
        if(count > 0 && (localStorage.getItem(DONE_SEEN_KEY) === _termKey)){
          setPill("status-idle", "Ready to Brew", "");
          if(liveOn) updateLivePanel(job);
          return;
        }

        // If RUN "Nothing to ..." already held once, don’t repaint on revisit
        if(count === 0 && (localStorage.getItem(HOLD_SEEN_KEY) === _termKey) && !holdActive()){
          setPill("status-idle", "Ready to Brew", "");
          if(liveOn) updateLivePanel(job);
          return;
        }
      }

      const verb = modeVerb(mode);    // Convert/Rename/Delete
      const past = modePast(mode);    // converted/renamed/deleted

      // =========
      // NEW: Warning-first UX for unclear order
      // =========
      if((failed > 0 || w.count > 0) && hasOrder){
        // User wanted:
        // Line1: "X to convert • Y failed • Check Logs"
        // Line2: "Part order unclear. Check History"
        if(dry){
          setPill("status-warn", `Test · ${count} to ${verb.toLowerCase()} • ${failed} failed • Check Logs`, "");
          if(!holdActive()) holdPill("status-warn", `${count} to ${verb} / ${failed} failed • Check Logs`, 2500);
        }else{
          // RUN version (same format, but you could switch to "Done: X converted / Y failed" later if you prefer)
          setPill("status-warn", `Done: ${count} ${past} • ${failed} failed • Check Logs`, "");
          setDonePill("status-warn", `Done: ${count} ${past} / ${failed} failed • Check Logs`, _termKey);
        }

        if(liveOn) updateLivePanel(job);
        return;
      }

      // Generic failure/warn cases
      if(failed > 0 && count > 0){
        if(dry){
          setPill("status-warn", `${count} to ${verb} / ${failed} failed • Check Logs`, "Check History");
          if(!holdActive()) holdPill("status-warn", `${count} to ${verb} / ${failed} failed • Check Logs`, 2500);
        }else{
          setPill("status-warn", `Done: ${count} ${past} / ${failed} failed • Check Logs`, "Check History");
          setDonePill("status-warn", `Done: ${count} ${past} / ${failed} failed • Check Logs`, _termKey);
        }
      }else if(failed > 0 && count === 0){
        setPill("status-error", `${failed} failed • Check Logs`, "See History for details");
      }else if(count > 0){
        if(dry){
          setPill("status-test", `Test · ${count} to ${verb}`, "");
          if(!holdActive()) holdPill("status-test", `Test · ${count} to ${verb}`, 2500);
        }else{
          const cls = (mode === "convert") ? "status-run1" : (mode === "correct") ? "status-run2" : (mode === "cleanup") ? "status-run3" : "status-done";
          setPill(cls, `Done: ${count} ${past}`, "");
          setDonePill(cls, `Done: ${count} ${past}`, _termKey);
        }
      }else{
        const l1 = dry ? `Test · Nothing to ${verb}` : `Nothing to ${verb}`;
        const cls = dry ? "status-test" : (mode === "convert" ? "status-run1" : (mode === "correct" ? "status-run2" : (mode === "cleanup" ? "status-run3" : "status-warn")));
        setPill(cls, l1, "");
        if(!dry){
          if(localStorage.getItem(HOLD_SEEN_KEY) !== _termKey){
            localStorage.setItem(HOLD_SEEN_KEY, _termKey);
            holdPill(cls, l1, 2500);
          }
        }else{
          if(!holdActive()) holdPill(cls, l1, 2500);
        }
      }

      if(liveOn){
        try{
          if(window.__m4brew_live_view && window.__m4brew_live_view() === "log" && window.__m4brew_refresh_log){
            window.__m4brew_refresh_log();
          }
        }catch(_){}
        updateLivePanel(job);
      }
    }catch(_){}
  }

  setupLiveViews();

  function _pollLoop(){
    tick().finally(() => { setTimeout(_pollLoop, _nextPollMs); });
  }
  _pollLoop();
})();


/* --- M4Brew: Tasks scroll behaviour (v2) ---
   Goals:
   - Pressing Test/Run (form submit + redirect back to Tasks) should KEEP scroll position.
   - Navigating away to another page, then returning to Tasks, should RESET to top.
*/
(function(){
  const KEY_KEEP  = "m4brew_tasks_keep_scroll";
  const KEY_Y     = "m4brew_tasks_scroll_y";
  const KEY_FORCE = "m4brew_tasks_force_top";

  function navType(){
    try{
      const n = performance.getEntriesByType("navigation");
      return (n && n[0] && n[0].type) ? n[0].type : null;
    }catch(_){ return null; }
  }

  try { if ("scrollRestoration" in history) history.scrollRestoration = "manual"; } catch(_){}

  document.addEventListener("submit", () => {
    try{
      sessionStorage.setItem(KEY_KEEP, "1");
      sessionStorage.setItem(KEY_Y, String(window.scrollY || 0));
    }catch(_){}
  }, true);

  window.addEventListener("pagehide", () => {
    try{
      if (sessionStorage.getItem(KEY_KEEP) === "1") return;
      sessionStorage.setItem(KEY_FORCE, "1");
    }catch(_){}
  });

  window.addEventListener("pageshow", (e) => {
    let keep = false;
    let y = 0;

    try{
      keep = (sessionStorage.getItem(KEY_KEEP) === "1");
      y = Number(sessionStorage.getItem(KEY_Y) || 0);
    }catch(_){}

    if (keep){
      setTimeout(() => window.scrollTo(0, y), 0);
      try{
        sessionStorage.removeItem(KEY_KEEP);
        sessionStorage.removeItem(KEY_Y);
        sessionStorage.removeItem(KEY_FORCE);
      }catch(_){}
      return;
    }

    let forceTop = false;
    if (e && e.persisted) forceTop = true;
    if (navType() === "back_forward") forceTop = true;

    try{
      if (sessionStorage.getItem(KEY_FORCE) === "1") forceTop = true;
      sessionStorage.removeItem(KEY_FORCE);
    }catch(_){}

    if (forceTop){
      setTimeout(() => window.scrollTo(0, 0), 0);
    }
  });
})();
