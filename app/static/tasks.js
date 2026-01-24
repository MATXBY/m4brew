(function(){
  // ---------- HELP COPY ----------
  const HELP = {
    "select-source": {
      title: "FOLDERS: LOCATION & STRUCTURE",
      body: [
        "Enter your Audiobooks root folder here.",
        "IMPORTANT: That folder's structure must match this:"
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

  // Autosave settings
  const form = document.getElementById("settingsForm");
  let t = null;
  const rootInput = document.getElementById("root_folder");
  const initialRoot = rootInput ? (rootInput.value || "") : "";
  let rootDirty = false;

  function autosave() {
    if (!form) return;
    if (t) clearTimeout(t);
    t = setTimeout(async () => {
      try {
        const fd = new FormData(form);
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
    liveBtn.textContent = "Live output: " + (liveOn ? "ON" : "OFF");
    liveBtn.classList.toggle("primary", liveOn);
    liveBtn.classList.toggle("is-off", !liveOn);
    liveWrap.style.display = liveOn ? "block" : "none";
  }
  liveBtn.addEventListener("click", () => {
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
      if(dry) return "Test: " + count + " to " + noun;
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
    if(!job || !job.status){
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

  async function tick(){
    try{
      const r = await fetch("/api/job", {cache:"no-store"});
      const job = await r.json();

      const showCancel = (job && job.status === "running" && job.mode === "convert");
      cancelForm.style.display = showCancel ? "flex" : "none";

      if(statusTop) statusTop.classList.toggle("has-cancel", showCancel);

        // ----- Status pill (2-line, stateful) -----
        const mode = String(job && job.mode ? job.mode : "").toLowerCase();
        const dry = isDryRun(job);

        function setPill(stateClass, line1, line2){
          statusPill.classList.remove("status-running","status-done","status-warn","status-error");
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
        }

        function currentBook(job){
          if(job && job.current_path && String(job.current_path).trim()) return bookFromPath(job.current_path);
          if(job && job.current_book && String(job.current_book).trim()) return String(job.current_book);
          return "";
        }

        if(!job || !job.status){
          setPill(null, "Ready", "");
          lastJobStatus = null;
        }else if(job.status === "running"){
          const total = Number(job.total || 0);
          const current = Number(job.current || 0);
          const book = currentBook(job);
          if(dry){
            const l1 = (total > 0) ? ("Test: Checking " + current + "/" + total) : "Test: Checking…";
            setPill("status-running", l1, book);
          }else{
            let seconds = null;
            if (job.runtime_s != null) seconds = Number(job.runtime_s);
            else if (job.started) seconds = runtimeFromStarted(job.started);
            const rt = (seconds != null) ? fmtRuntime(seconds) : "00:00:00";
            const task = modeLabel(mode);
            let l1 = rt + " Run: " + task;
            if(total > 0) l1 += " " + current + "/" + total;
            setPill("status-running", l1, book);
          }
        }else if(job.status === "finished"){
          const s = (job && job.summary) ? job.summary : {};
          const failed = Number(s.failed ?? 0);
          const count = (mode === "convert") ? Number(s.created ?? 0)
                       : (mode === "correct") ? Number(s.renamed ?? 0)
                       : (mode === "cleanup") ? Number(s.deleted ?? 0)
                       : 0;
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
            setPill("status-warn", "Cancelled", "");
          }else if(failed > 0 && count > 0){
            if(dry){
              setPill("status-warn", "Test: " + count + " to " + noun + " · " + failed + " failed", "");
            }else{
              setPill("status-warn", "Done: " + count + " " + past + " · " + failed + " failed", "");
            }
          }else if(failed > 0 && count === 0){
            setPill("status-error", "Error: " + failed + " failed", "See History for details");
          }else if(count > 0){
            if(dry){
              setPill("status-done", "Test: " + count + " to " + noun, "");
            }else{
              setPill("status-done", "Done: " + count + " " + past, "");
            }
          }else{
            const l1 = dry ? ("Test: Nothing to " + noun) : ("Nothing to " + noun);
            setPill("status-warn", l1, "");
          }
        }else{
          setPill("status-warn", String(job.status || ""), "");
        }

        lastJobStatus = (job && job.status) ? job.status : null;

      if(liveOn){
        updateLivePanel(job);
      }
    }catch(e){}
  }

  setLiveUI();
  tick();
  setInterval(tick, 1200);
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
    document.addEventListener("submit", () => {
      try{
        sessionStorage.setItem(KEY_KEEP, "1");
        sessionStorage.setItem(KEY_Y, String(window.scrollY || 0));
      }catch(_){}
    }, true);

    // Mark "left the page" only if it wasn't a form submit
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
