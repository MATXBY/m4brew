(function(){
  // ---------- HELP COPY ----------
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
        {
          title: "",
          lines: [
            "MATCH — keep what the source uses",
            "MONO — force mono",
            "STEREO — force stereo"
          ]
        }
      ]
    },

    "select-bitrate": {
      title: "BITRATE",
      body: ["Choose your preferred audio bitrate."],
      boxes: [
        {
          title: "",
          lines: [
            "Bitrate range: 32kbps – 320kbps.",
            "Match source coming soon"
          ]
        }
      ]
    },

    "step-convert": {
      title: "CONVERTING YOUR FILES",
      body: [],
      boxes: [
        { title: "TEST", tone: "test", lines: ["Preview how many books will be converted.", "No files are changed."] },
        { title: "RUN",  tone: "convert", lines: ["Begins the actual conversion process.", "Batch converts eligible folders into single, chapterised M4B files."] },
        { title: "CHAPTERS", lines: ["Chapters are defined by each source file.", "Each file becomes a chapter in the final M4B."] },
        { title: "SUPPORTED FILE TYPES", lines: ["MP3 → M4B", "M4A → M4B (single or multiple files)"] }
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
    if(!d) return;
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

  closeBtn.addEventListener("click", closeHelp);
  overlay.addEventListener("click", (e) => { if(e.target === overlay) closeHelp(); });
  document.addEventListener("keydown", (e) => { if(e.key === "Escape") closeHelp(); });

  // ---------- TASK PAGE LOGIC ----------
  const statusPill = document.getElementById("statusPill");
  let lastJobStatus = null;
  let _dismissRunTerminal = false; /* user has "seen" last RUN terminal */
  let _navReload = false; /* page load was a reload */
  try{
    const n = performance.getEntriesByType && performance.getEntriesByType("navigation");
    _navReload = !!(n && n[0] && n[0].type === "reload");
  }catch(_){ _navReload = false; }

  /* Any settings tweak counts as "seen" */
  document.addEventListener("input", (e) => {
    try{ if(e && e.target && e.target.closest && e.target.closest("#settingsForm")) _dismissRunTerminal = true; }catch(_){ }
  }, true);
  document.addEventListener("change", (e) => {
    try{ if(e && e.target && e.target.closest && e.target.closest("#settingsForm")) _dismissRunTerminal = true; }catch(_){ }
  }, true);

  /* Any Test/Run submit counts as "seen" */
  document.addEventListener("submit", () => {
    _dismissRunTerminal = true;
    try{ clearDonePill && clearDonePill(); }catch(_){ }
  }, true);

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

  function navType(){
    try{
      const n = performance.getEntriesByType("navigation");
      return (n && n[0] && n[0].type) ? n[0].type : null;
    }catch(_){ return null; }
  }

  // Hard refresh = user has seen the last DONE -> dismiss it.
  if(navType() === "reload"){ dismissDone(); }
  try{
    if(sessionStorage.getItem("m4brew_tasks_left") === "1"){
      dismissDone();
      sessionStorage.removeItem("m4brew_tasks_left");
    }
  }catch(_){ }


  // Any user submit action (Test/Run/settings) = user has seen DONE -> dismiss it.
  document.addEventListener("submit", dismissDone, true);

  // Leaving the Tasks page (including BFCache) = user has seen DONE -> mark for dismiss on return
  window.addEventListener("pagehide", () => {
    try{ sessionStorage.setItem("m4brew_tasks_left","1"); }catch(_){ }
  });

  // Returning to Tasks via back/forward (BFCache restore) = dismiss DONE before polling repaints it
  window.addEventListener("pageshow", () => {
    try{
      if(sessionStorage.getItem("m4brew_tasks_left") === "1"){
        dismissDone();
        sessionStorage.removeItem("m4brew_tasks_left");
      }
    }catch(_){ }
  });


const liveBtn = document.getElementById("liveBtn");
  const liveWrap = document.getElementById("liveWrap");
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

  // ---------- PREFLIGHT (block start when root invalid) ----------
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
    const root = pf && pf.root_folder ? String(pf.root_folder) : "";
    const base = root ? ("Source: " + root) : "";
    if(code === "folder_missing") return {cls:"status-warn", l1:"Mapped folder does not exist", l2:""};
    if(code === "not_mounted")   return {cls:"status-warn", l1:"Add folder path to M4Brew template", l2:""};
    if(code === "write_denied")  return {cls:"status-error", l1:"Write denied", l2:"Fix PUID/PGID or permissions"};
    if(code === "no_root")       return {cls:"status-warn", l1:"No mapped folder set", l2:"Set Mapped folder above"};
    if(code === "preflight_exception") return {cls:"status-error", l1:"Preflight error", l2: String((pf && pf.message) ? pf.message : "")};
    return {cls:"status-error", l1:"Cannot start", l2: String((pf && (pf.message||pf.error_code)) ? (pf.message||pf.error_code) : "Unknown error")};
  }

  function setPillDirect(stateClass, line1, line2){
    if(!statusPill) return;
    statusPill.classList.remove("status-running","status-done","status-warn","status-error","status-test","status-idle","status-run1","status-run2","status-run3");
    if(stateClass) statusPill.classList.add(stateClass);
    statusPill.classList.add("is-two-line");
            if(stateClass === "status-running" && !dry){
              if(mode === "convert") statusPill.classList.add("status-run1");
              else if(mode === "correct") statusPill.classList.add("status-run2");
              else if(mode === "cleanup") statusPill.classList.add("status-run3");
            }
    statusPill.innerHTML = "<span class=\"pill-line1\"></span><span class=\"pill-line2\"></span>";
    statusPill.querySelector(".pill-line1").textContent = line1 || "";
    const el2 = statusPill.querySelector(".pill-line2");
    if(line2){ el2.textContent = line2; el2.style.display = "block"; }
    else { el2.textContent = ""; el2.style.display = "none"; }
    try{ statusPill.style.removeProperty("--pulse-border"); }catch(_){ }
  }


  // Autosave settings
  const form = document.getElementById("settingsForm");
  let t = null;
  const rootInput = document.getElementById("root_folder");
  const initialRoot = rootInput ? (rootInput.value || "") : "";
  let rootDirty = false;

  // ---------- MOUNT DROPDOWN (pick from /api/mounts) ----------
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

      // If current root matches either container path or host path, preselect
      const cur = String((rootInput.value || "")).trim();
      if(cur){
        const hit = filtered.find(m => cur === String(m.container) || cur === String(m.host));
        if(hit) sel.value = String(hit.container);
      }

      // Insert dropdown right after the text input
      rootInput.insertAdjacentElement("afterend", sel);

      sel.addEventListener("change", async () => {
        if(!sel.value) return;

        rootInput.value = sel.value;

        // Trigger existing rootDirty + autosave machinery
        rootInput.dispatchEvent(new Event("input", {bubbles:true}));
        rootInput.dispatchEvent(new Event("change", {bubbles:true}));

        // Force-refresh preflight cache and update pill immediately (best-effort)
        _pf_cache = null; _pf_cache_ts = 0;
        try{
          const pf = await fetchPreflight(true);
          const pill = (pf && pf.ok) ? {cls:"status-idle", l1:"Ready", l2:""} : preflightToPill(pf);
          setPillDirect(pill.cls, pill.l1, pill.l2);
        }catch(_){}
      });

    }catch(_){}
  }

  function autosave() {
    if (!form) return;
    if (t) clearTimeout(t);
    t = setTimeout(async () => {
      try {
        const fd = new FormData(form);
        // Only send root_folder when user actually changed it
        if (!rootDirty) fd.delete("root_folder");

        await fetch("/settings", {
          method: "POST",
        body: fd,
          headers: {
            "X-M4Brew-Autosave": "1",
            "X-M4Brew-Root-Dirty": rootDirty ? "1" : "0"
          }
        });
      } catch (e) {}
    }, 250);
  }

  if (rootInput) {
      initMountDropdown();

    rootInput.addEventListener("input", () => {
      rootDirty = (rootInput.value || "") !== initialRoot;
    });
  }
  if (form){
      // Prevent full page reloads when pressing Enter (autosave handles it)
      form.addEventListener("submit", (e) => { e.preventDefault(); });
      form.addEventListener("input", autosave);
      form.addEventListener("change", autosave);
    }

  let liveOn = (localStorage.getItem("m4brew_live") === "1");
  let _nextPollMs = 5000;

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
  function isDryRun(job){
    const s = (job && job.summary) ? job.summary : {};
    return (job && (job.dry_run === true || job.dry_run === "true")) ||
           (s && (s.dry_run === true || s.dry_run === "true"));
  }
  function setLiveUI(){
    if (liveBtn) {
    liveBtn.textContent = "Live output: " + (liveOn ? "ON" : "OFF");
    liveBtn.classList.toggle("primary", liveOn);
    liveBtn.classList.toggle("is-off", !liveOn);
    }
    liveWrap.style.display = liveOn ? "block" : "none";
  }
  if (liveBtn) liveBtn.addEventListener("click", () => {
    liveOn = !liveOn;
    localStorage.setItem("m4brew_live", liveOn ? "1" : "0");
    setLiveUI();
  });

  function statusTextForFinished(job){
    const s = (job && job.summary) ? job.summary : {};
    const mode = String(job && job.mode ? job.mode : "").toLowerCase();

    const noun = (mode === "convert") ? "convert"
               : (mode === "correct") ? "rename"
               : (mode === "cleanup") ? "delete"
               : "run";

    const past = (mode === "convert") ? "converted"
               : (mode === "correct") ? "renamed"
               : (mode === "cleanup") ? "deleted"
               : "done";

    const count = (mode === "convert") ? Number(s.created ?? 0)
                 : (mode === "correct") ? Number(s.renamed ?? 0)
                 : (mode === "cleanup") ? Number(s.deleted ?? 0)
                 : 0;

    const dry = isDryRun(job);

    if(count > 0){
      if(dry) return "Test · " + count + " to " + noun;
      return '<span style="color:#6ee7b7;font-weight:800;">✓&nbsp;</span>Done: ' + count + " " + past;
    }
    return "Nothing to " + noun;
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

  function updateLivePanel(job){
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
    const warnings = "0";
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


    // --- M4Brew: Live panel view toggle (Human vs Full log) ---
    function setupLiveViews(){
      const viewBtn = document.getElementById("viewToggleBtn");
      if(!livePanel || !viewBtn) return;

      let logPre = document.getElementById("fullLog");
      if(!logPre){
        logPre = document.createElement("pre");
        logPre.id = "fullLog";
        logPre.className = "full-log";
        logPre.style.display = "none";
        const actions = livePanel.querySelector(".live-actions");
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

  async function tick(){

    // If we left Tasks and came back (BFCache), dismiss persisted DONE before painting.
    try{
      if(sessionStorage.getItem("m4brew_tasks_left") === "1"){
        dismissDone();
        sessionStorage.removeItem("m4brew_tasks_left");
      }
    }catch(_){ }

    try{
      const r = await fetch("/api/job", {cache:"no-store"});
      const job = await r.json();

      // --- M4Brew: Preflight (setup) warning when NOT running ---
      let pre = null;
      try{
        const pr = await fetch("/api/preflight", {cache:"no-store"});
        pre = await pr.json();
      }catch(_){ pre = null; }

      const jobRunning = (job && (job.status === "running" || job.status === "canceling"));
      if(!jobRunning && pre && pre.ok === false){
        const code = String(pre.error_code || "");
        let msg  = String(pre.message || "Needs attention");
        let l1 = "Setup needs attention";
        if(code === "not_mounted"){ l1 = "Add folder path to M4Brew template"; msg = ""; }
        else if(code === "folder_missing"){ l1 = "Mapped folder does not exist"; msg = ""; }
        else if(code === "write_denied")   l1 = "Setup: No write access";
        else if(code === "no_root")        l1 = "Setup: Choose a source folder";

        setPill("status-warn", l1, msg);
        clearPulse();
        if(cancelForm) cancelForm.style.display = "none";
        if(statusTop) statusTop.classList.remove("has-cancel");
        if(liveOn) updateLivePanel(job);
        return;
      }

      const showCancel = (job && job.status === "running" && job.mode === "convert");
      if(cancelForm) cancelForm.style.display = showCancel ? "flex" : "none";

      if(statusTop) statusTop.classList.toggle("has-cancel", showCancel);

        // ----- Status pill (2-line, stateful) -----

          function setPulseForMode(mode, dry){
            const m = String(mode || "").toLowerCase();

            // Dry-run stays purple
            if(dry){
              try{ statusPill.style.setProperty("--pulse-color", "rgba(99,102,241,.22)"); }catch(_){ }
              try{ statusPill.style.setProperty("--running-bg",  "rgba(99,102,241,.18)"); }catch(_){ }
              try{ statusPill.style.setProperty("--running-border", "rgba(99,102,241,.38)"); }catch(_){ }
              return;
            }

            // LIVE run mapping: run1=convert(blue), run2=rename(pink), run3=delete(indigo)
            const pulse = (m === "convert") ? "rgb(var(--task-convert-rgb) / .22)"
                        : (m === "correct") ? "rgb(var(--task-rename-rgb) / .22)"
                        : (m === "cleanup") ? "rgb(var(--task-delete-rgb) / .22)"
                        : "rgb(var(--task-convert-rgb) / .22)";

            const bg = (m === "convert") ? "rgb(var(--task-convert-rgb) / .18)"
                     : (m === "correct") ? "rgb(var(--task-rename-rgb) / .18)"
                     : (m === "cleanup") ? "rgb(var(--task-delete-rgb) / .18)"
                     : "rgb(var(--task-convert-rgb) / .18)";

            // Remove outline on RUN (pulsing) pills
            const br = "transparent";

            try{ statusPill.style.setProperty("--pulse-color", pulse); }catch(_){ }
            try{ statusPill.style.setProperty("--running-bg", bg); }catch(_){ }
            try{ statusPill.style.setProperty("--running-border", br); }catch(_){ }
          }
          function setTestOutlineForMode(mode){
  const m = String(mode || "").toLowerCase();
  const v = (m === "convert") ? "var(--task-convert)"
          : (m === "correct") ? "var(--task-rename)"
          : (m === "cleanup") ? "var(--task-delete)"
          : "var(--line)";
  try{ statusPill.style.setProperty("--test-outline", v); }catch(_){ }
}



          function clearTestOutline(){
            try{ statusPill.style.removeProperty("--test-outline"); }catch(_){ }
          }

          function clearPulse
(){
            try{ statusPill.style.removeProperty("--pulse-border"); }catch(_){ }
          }

        const mode = String(job && job.mode ? job.mode : "").toLowerCase();
        const dry = isDryRun(job);

        function setPill(stateClass, line1, line2){
          statusPill.classList.remove("status-running","status-done","status-warn","status-error","status-test","status-idle","status-run1","status-run2","status-run3");
          if(stateClass) statusPill.classList.add(stateClass);
          statusPill.classList.add("is-two-line");
          statusPill.innerHTML = "<span class=\"pill-line1\"></span><span class=\"pill-line2\"></span>";
          statusPill.querySelector(".pill-line1").textContent = line1 || "";
          const el2 = statusPill.querySelector(".pill-line2");
          if(line2){
            el2.textContent = line2;
            el2.style.display = "block";
          }else{
            el2.textContent = "";
            el2.style.display = "none";
          }
        
          try{
            if(stateClass === "status-test") setTestOutlineForMode(mode);
            else clearTestOutline();
          }catch(_){ }
        }

        function currentBook(job){
          if(job && job.current_path && String(job.current_path).trim()) return bookFromPath(job.current_path);
          if(job && job.current_book && String(job.current_book).trim()) return String(job.current_book);
          return "";
        }

        if(!job || !job.status || job.status === "none"){
          const pf = await fetchPreflight();
          if(pf && pf.ok === false){
            const info = preflightToPill(pf);
            setPill(info.cls, info.l1, info.l2);
          }else{
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
          }
          lastJobStatus = null;
        }else if(job.status === "running"){ _dismissRunTerminal = false; clearHold(); clearDonePill(); clearHold();
            setPulseForMode(mode, dry);
          const total = Number(job.total || 0);
          const current = Number(job.current || 0);
          const book = currentBook(job);
          if(dry){
            const l1 = (total > 0) ? ("Test · Checking " + current + "/" + total) : "Test · Checking…";
            setPill("status-running", l1, "");
          }else{
            let seconds = null;
            if (job.runtime_s != null) seconds = Number(job.runtime_s);
            else if (job.started) seconds = runtimeFromStarted(job.started);
            const rt = (seconds != null) ? fmtRuntime(seconds) : "00:00:00";
            const task = modeLabel(mode);
            let l1 = rt + " · " + (mode === "convert" ? "Converting" : mode === "correct" ? "Renaming" : mode === "cleanup" ? "Deleting" : task);
            if(total > 0) l1 += " " + current + "/" + total;
            setPill("status-running", l1, "");
          }
        }else if(job.status === "finished" || job.status === "canceled"){
          const _seenKey = "m4brew_seen_terminal";
          const _termKey = String(job.started || "") + "|" + String(mode || "") + "|" + String(job.status || "") + "|" + String(job.exit_code || "");
          const _alreadySeen = (localStorage.getItem(_seenKey) === _termKey);
          const _seenTest = (localStorage.getItem(TEST_SEEN_KEY) === _termKey);

          if(job.status === "finished" && !dry && (_navReload || _dismissRunTerminal)){
            const pf2 = await fetchPreflight();
            if(pf2 && pf2.ok === false){
              const info2 = preflightToPill(pf2);
              setPill(info2.cls, info2.l1, info2.l2);
            }else{
              setPill("status-idle", "Ready to Brew", "");
            }
            clearPulse();
            return;
          }

          if(dry && _seenTest && !holdActive()){
            const d = getDonePill();
            if(d) setPill(d.cls, d.l1, "");
            else setPill("status-idle", "Ready to Brew", "");
            clearPulse();
            return;
          }

          if(job.status === "canceled" && _alreadySeen && !holdActive()){
            const pf2 = await fetchPreflight();
            if(pf2 && pf2.ok === false){
              const info2 = preflightToPill(pf2);
              setPill(info2.cls, info2.l1, info2.l2);
            }else{
              setPill("status-idle", "Ready to Brew", "");
            }
            lastJobStatus = null;
            clearPulse();
            return;
          }
          if(job.status === "canceled" && !_alreadySeen){
            localStorage.setItem(_seenKey, _termKey);
          }

          const seenKey = "m4brew_seen_finished_job";
          const jid = String(job.id || "");
          const alreadySeen = (job.status === "canceled") && (jid && (localStorage.getItem(seenKey) === jid));

          if(alreadySeen){
            const pf2 = await fetchPreflight();
            if(pf2 && pf2.ok === false){
              const info = preflightToPill(pf2);
              setPill(info.cls, info.l1, info.l2);
            }else{
              if(holdActive()){ setPill((_pillHold.cls||"status-idle"), _pillHold.l1, ""); } else { setPill("status-idle", "Ready to Brew", ""); }
            }
            clearPulse();
            if(cancelForm) cancelForm.style.display = "none";
            if(statusTop) statusTop.classList.remove("has-cancel");
            if(liveOn) updateLivePanel({status:"none"});
            return;
          }
          
const s = (job && job.summary) ? job.summary : {};
          const failed = Number(s.failed ?? 0);
          const count = (mode === "convert") ? Number(s.created ?? 0)
                       : (mode === "correct") ? Number(s.renamed ?? 0)
                       : (mode === "cleanup") ? Number(s.deleted ?? 0)
                       : 0;

          // If DONE was dismissed (refresh/submit), do NOT repaint it forever.
          if(!dry && count > 0 && (localStorage.getItem(DONE_SEEN_KEY) === _termKey)){
            setPill("status-idle", "Ready to Brew", "");
            clearPulse();
            return;
          }

          // If a RUN "Nothing to ..." was already held once, do NOT repaint it on revisit.
          if(!dry && count === 0 && (localStorage.getItem(HOLD_SEEN_KEY) === _termKey) && !holdActive()){
            setPill("status-idle", "Ready to Brew", "");
            clearPulse();
            return;
          }

const noun = (mode === "convert") ? "convert"
                     : (mode === "correct") ? "rename"
                     : (mode === "cleanup") ? "delete"
                     : "run";
          const past = (mode === "convert") ? "converted"
                     : (mode === "correct") ? "renamed"
                     : (mode === "cleanup") ? "deleted"
                     : "done";

          const cancelled = (job && job.cancel_requested === true) || (Number(job.exit_code || 0) === 130);
          if(cancelled){
            setPill("status-warn", "Cancelled", ""); if(!_alreadySeen) holdPill("status-warn","Cancelled",2500);
          }else if(failed > 0 && count > 0){
            if(dry){
              setPill("status-warn", "Test · " + count + " to " + noun + " · " + failed + " failed", "");
            if(localStorage.getItem(TEST_SEEN_KEY) !== _termKey){
              localStorage.setItem(TEST_SEEN_KEY, _termKey);
              holdPill("status-warn", "Test · " + count + " to " + noun + " · " + failed + " failed", 2500);
            }
            }else{
              setPill("status-warn", "Done: " + count + " " + past + " · " + failed + " failed", "");
            }
          }else if(failed > 0 && count === 0){
            setPill("status-error", "Error: " + failed + " failed", "See History for details");
          }else if(count > 0){
            if(dry){
              setPill("status-test", "Test · " + count + " to " + noun, "");
            if(localStorage.getItem(TEST_SEEN_KEY) !== _termKey){
              localStorage.setItem(TEST_SEEN_KEY, _termKey);
              holdPill("status-test", "Test · " + count + " to " + noun, 2500);
            }
            }else{
              setPill((mode === "convert") ? "status-run1" : (mode === "correct") ? "status-run2" : (mode === "cleanup") ? "status-run3" : "status-done", "Done: " + count + " " + past, "");
                        setDonePill((mode === "convert") ? "status-run1" : (mode === "correct") ? "status-run2" : (mode === "cleanup") ? "status-run3" : "status-done", "Done: " + count + " " + past, _termKey);
}
          }else{
            const l1 = dry ? ("Test · Nothing to " + noun) : ("Nothing to " + noun);
            const cls = dry ? "status-test" : (mode === "convert" ? "status-run1" : (mode === "correct" ? "status-run2" : (mode === "cleanup" ? "status-run3" : "status-warn")));
            setPill(cls, l1, "");
            if(dry){
              if(localStorage.getItem(TEST_SEEN_KEY) !== _termKey){
                localStorage.setItem(TEST_SEEN_KEY, _termKey);
                holdPill(cls, l1, 2500);
              }
            }else{
              if(localStorage.getItem(HOLD_SEEN_KEY) !== _termKey){
                localStorage.setItem(HOLD_SEEN_KEY, _termKey);
                holdPill(cls, l1, 2500);
              }
            }

          }
          try{ if(jid) localStorage.setItem(seenKey, jid); }catch(_){ }
        }else{
          setPill("status-warn", String(job.status || ""), "");
        }

        lastJobStatus = (job && job.status) ? job.status : null;

      if(liveOn){
          try{
            if(window.__m4brew_live_view && window.__m4brew_live_view() === "log" && window.__m4brew_refresh_log){
              window.__m4brew_refresh_log();
            }
          }catch(_){ }

        updateLivePanel(job);
      }
    }catch(e){}
  }

  setLiveUI();

    // Status pill toggles Live output (replaces Live button)
    if (statusPill) {
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


    // Block Test/Run submits if preflight fails (no folder creation, no job started)
  document.addEventListener("submit", () => { try{ clearDonePill(); /* user action */ }catch(_){ } }, true);

    document.addEventListener("submit", async (e) => {
      const f = e.target;
      if(!f || f.tagName !== "FORM") return;
      const action = (f.getAttribute("action") || "").trim();
      if(action !== "/") return;
      if(!f.querySelector("input[name=\"mode\"]")) return;

      e.preventDefault();

      const pf = await fetchPreflight(true);
      if(pf && pf.ok === true){
        f.submit();
        return;
      }
      const info = preflightToPill(pf || {});
      setPillDirect(info.cls, info.l1, info.l2);
    }, true);

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

    // Any form submit on this page = in-page action (Test/Run/settings), so preserve scroll
  document.addEventListener("submit", () => { try{ clearDonePill(); /* user action */ }catch(_){ } }, true);

    document.addEventListener("submit", () => {
      try{
        sessionStorage.setItem(KEY_KEEP, "1");
        sessionStorage.setItem(KEY_Y, String(window.scrollY || 0));
      }catch(_){}
    }, true);

    // Mark "left the page" only if it wasn't a form submit
    window.addEventListener("pagehide", () => {
    try{ sessionStorage.setItem("m4brew_tasks_left","1"); }catch(_){ }

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
        // restore exact prior scroll after Test/Run redirect
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

/* --- M4Brew: If preflight blocks Test/Run, explain it in the status pill --- */
(function(){
  const pill = document.getElementById("statusPill");
  if(!pill) return;

  function setPillError(line1, line2){
    pill.classList.remove("status-running","status-done","status-warn","status-error","status-test","status-idle","status-run1","status-run2","status-run3");
    pill.classList.add("status-error","is-two-line");
    pill.innerHTML = '<span class="pill-line1"></span><span class="pill-line2"></span>';
    pill.querySelector(".pill-line1").textContent = line1 || "";
    const el2 = pill.querySelector(".pill-line2");
    if(line2){
      el2.textContent = line2;
      el2.style.display = "block";
    }else{
      el2.textContent = "";
      el2.style.display = "none";
    }
  }

  // Intercept Step buttons (convert/correct/cleanup) and only allow submit if preflight is OK.
  // If blocked: show a human message instead of “nothing happens”.
  document.addEventListener("submit", () => { try{ clearDonePill(); /* user action */ }catch(_){ } }, true);

  document.addEventListener("submit", async (e) => {
    const form = e.target;
    if(!form || form.tagName !== "FORM") return;

    // Only guard the Step forms (POST to "/")
    const action = (form.getAttribute("action") || "").trim();
    if(action !== "/") return;

    // Avoid infinite loop when we re-submit programmatically
    if(form.__m4brew_allowed === true) return;

    e.preventDefault();

    let pf = null;
    try{
      const r = await fetch("/api/preflight?ts=" + Date.now(), {cache:"no-store"});
      pf = await r.json();
    }catch(_){
      setPillError("Can’t start job", "Preflight check failed (network/error).");
      return;
    }

    if(pf && pf.ok === true){
      form.__m4brew_allowed = true;
      form.submit();
      return;
    }

    const msg = (pf && pf.message) ? String(pf.message) : "Check the source folder path.";
      const code = (pf && pf.error_code) ? String(pf.error_code) : "";
      if(code === "folder_missing"){
        setPillError("Mapped folder does not exist", "");
        // After 1s, downgrade from red (action-block) to orange (setup warning)
        setTimeout(() => {
        const pill = document.getElementById("statusPill");
        if(!pill) return;
        const l1 = pill.querySelector(".pill-line1");
        if(pill.classList.contains("status-error") && l1 && (l1.textContent === "Mapped folder does not exist" || l1.textContent === "Add folder path to M4Brew template")){
          pill.classList.remove("status-error");
          pill.classList.add("status-warn");
        }
      }, 3000);
    }else if(code === "not_mounted"){
        setPillError("Add folder path to M4Brew template", "");
        // After 1s, downgrade from red (action-block) to orange (setup warning)
        setTimeout(() => {
          const pill = document.getElementById("statusPill");
          if(!pill) return;
          const l1 = pill.querySelector(".pill-line1");
          if(pill.classList.contains("status-error") && l1 && l1.textContent === "Add folder path to M4Brew template"){
            pill.classList.remove("status-error");
            pill.classList.add("status-warn");
          }
        }, 1000);
      }else{
        setPillError("Fix source folder", msg);
      }
}, true);
})();

/* --- M4Brew: If preflight blocks Test/Run, explain it in the status pill --- */
(function(){
  const pill = document.getElementById("statusPill");
  if(!pill) return;

  function setPillError(line1, line2){
    pill.classList.remove("status-running","status-done","status-warn","status-error","status-test","status-idle","status-run1","status-run2","status-run3");
    pill.classList.add("status-error","is-two-line");
    pill.innerHTML = '<span class="pill-line1"></span><span class="pill-line2"></span>';
    pill.querySelector(".pill-line1").textContent = line1 || "";
    const el2 = pill.querySelector(".pill-line2");
    if(line2){
      el2.textContent = line2;
      el2.style.display = "block";
    }else{
      el2.textContent = "";
      el2.style.display = "none";
    }
  }

  // Guard ONLY the Step forms (POST to "/") and only in the browser.
  document.addEventListener("submit", () => { try{ clearDonePill(); /* user action */ }catch(_){ } }, true);

  document.addEventListener("submit", async (e) => {
    const form = e.target;
    if(!form || form.tagName !== "FORM") return;

    const action = (form.getAttribute("action") || "").trim();
    if(action !== "/") return;

    // allow the real submit after we pass preflight
    if(form.__m4brew_allowed === true) return;

    e.preventDefault();

    let pf = null;
    try{
      const r = await fetch("/api/preflight?ts=" + Date.now(), {cache:"no-store"});
      pf = await r.json();
    }catch(_){
      setPillError("Can’t start job", "Preflight check failed.");
      return;
    }

    if(pf && pf.ok === true){
      form.__m4brew_allowed = true;
      form.submit();
      return;
    }

    const msg = (pf && pf.message) ? String(pf.message) : "Check the source folder path.";
      const code = (pf && pf.error_code) ? String(pf.error_code) : "";
      if(code === "folder_missing"){
        setPillError("Mapped folder does not exist", "");
        // After 1s, downgrade from red (action-block) to orange (setup warning)
        setTimeout(() => {
        const pill = document.getElementById("statusPill");
        if(!pill) return;
        const l1 = pill.querySelector(".pill-line1");
        if(pill.classList.contains("status-error") && l1 && (l1.textContent === "Mapped folder does not exist" || l1.textContent === "Add folder path to M4Brew template")){
          pill.classList.remove("status-error");
          pill.classList.add("status-warn");
        }
      }, 3000);
    }else if(code === "not_mounted"){
        setPillError("Add folder path to M4Brew template", "");
        // After 1s, downgrade from red (action-block) to orange (setup warning)
        setTimeout(() => {
          const pill = document.getElementById("statusPill");
          if(!pill) return;
          const l1 = pill.querySelector(".pill-line1");
          if(pill.classList.contains("status-error") && l1 && l1.textContent === "Add folder path to M4Brew template"){
            pill.classList.remove("status-error");
            pill.classList.add("status-warn");
          }
        }, 1000);
      }else{
        setPillError("Fix source folder", msg);
      }
}, true);
})();

/* --- M4Brew: idle preflight paint (orange) --- */
(function(){
  const pill = document.getElementById("statusPill");
  if(!pill) return;

  // Only paint when the page loads (idle). Red on button press still works elsewhere.
  fetch("/api/preflight?ts=" + Date.now(), {cache:"no-store"})
    .then(r => r.json())
    .then(pf => {
      if(!pf || pf.ok !== false) return;

      const code = String(pf.error_code || "");
      if(code !== "folder_missing") return;

      // Make it orange + one-line (no second line)
      pill.classList.remove("status-running","status-done","status-warn","status-error","status-test","status-idle","status-run1","status-run2","status-run3");
      pill.classList.add("status-warn","is-two-line");
      pill.innerHTML = '<span class="pill-line1"></span><span class="pill-line2"></span>';
      pill.querySelector(".pill-line1").textContent = "Mapped folder does not exist";
      const el2 = pill.querySelector(".pill-line2");
      el2.textContent = "";
      el2.style.display = "none";
    })
    .catch(() => {});
})();

/* --- M4Brew: autosave hook -> preflight paint (orange) --- */
(function(){
  const pill = document.getElementById("statusPill");
  if(!pill) return;

  function isRedSourceMissing(){
    return true;
  }

  function paintOrangeIfMissing(){
    // Don't override the red "blocked" state (your rule: red sticks until refresh)
    if(isRedSourceMissing()) return;

    // Also don't mess with UI mid-job
    fetch("/api/job", {cache:"no-store"})
      .then(r => r.json())
      .then(job => {
        const running = job && (job.status === "running" || job.status === "canceling");
        if(running) return;

        return fetch("/api/preflight?ts=" + Date.now(), {cache:"no-store"})
          .then(r => r.json())
          .then(pf => {
            if(!pf || pf.ok !== false) return;
            if(String(pf.error_code || "") !== "folder_missing") return;

            pill.classList.remove("status-running","status-done","status-warn","status-error","status-test","status-idle","status-run1","status-run2","status-run3");
            pill.classList.add("status-warn","is-two-line");
            pill.innerHTML = '<span class="pill-line1"></span><span class="pill-line2"></span>';
            pill.querySelector(".pill-line1").textContent = "Mapped folder does not exist";
            const el2 = pill.querySelector(".pill-line2");
            el2.textContent = "";
            el2.style.display = "none";
          });
      })
      .catch(() => {});
  }

  // Hook fetch(): when autosave posts settings, repaint orange after it completes.
  const origFetch = window.fetch;
  window.fetch = function(){
    const p = origFetch.apply(this, arguments);
    try{
      const url = String(arguments[0] || "");
      const opts = arguments[1] || {};
      const method = String(opts.method || "GET").toUpperCase();

      // "settings" endpoints (covers most variants)
      const looksLikeSettingsSave =
        method === "POST" &&
        (url.includes("/settings") || url.includes("/api/settings") || url.includes("/save"));

      if(looksLikeSettingsSave){
        p.then(() => setTimeout(paintOrangeIfMissing, 0)).catch(() => {});
      }
    }catch(_){}
    return p;
  };
})();
