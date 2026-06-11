/* =====================================================================
 * MarQueue-wk-one  ·  js/app.js  ·  THE FRONT END
 * =====================================================================
 * Talks ONLY to the DB data layer (js/data.js). It never reaches into
 * storage directly, so swapping DB for a real Postgres/Supabase backend
 * later means changing js/data.js, not this file.
 * ===================================================================== */

(() => {
  "use strict";

  /* ---------------- tiny DOM helpers ---------------- */
  const $ = (id) => document.getElementById(id);
  const show = (el) => el && el.classList.remove("hidden");
  const hide = (el) => el && el.classList.add("hidden");
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtTime = (sec) => {
    sec = Math.max(0, Math.round(sec));
    const m = Math.floor(sec / 60), s = sec % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };
  const fmtDate = (iso) => {
    try { return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); }
    catch { return iso; }
  };

  function toast(msg) {
    const host = $("toastHost");
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = msg;
    host.appendChild(t);
    setTimeout(() => { t.style.opacity = "0"; setTimeout(() => t.remove(), 250); }, 2400);
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        document.execCommand("copy"); ta.remove();
      }
      return true;
    } catch { return false; }
  }

  /* ---------------- app state ---------------- */
  const state = {
    user: null,                 // logged-in user (public shape, no hash)
    status: "idle",             // current recording-session status
    mediaRecorder: null,
    displayStream: null,
    micStream: null,
    audioMixCtx: null,
    chunks: [],
    recordedBlob: null,         // PRD: blob kept in memory for retry
    recordedMeta: null,         // { duration_seconds, resolution, codec }
    activeRecordingId: null,    // db row id once upload starts
    timerInterval: null,
    elapsed: 0,
    scriptLocked: false,
  };

  // Runtime maps so recorded videos can actually play in Library + Share.
  // (Seeded recordings have no blob and show a placeholder — by design.)
  const blobUrlByRecordingId = {};
  const blobUrlByToken = {};

  const MAX_SECONDS = 900;       // 15 min cap (PRD)
  const WARN_SECONDS = 840;      // 14 min notice (PRD)

  /* ================================================================
   *  ROUTER
   * ================================================================ */
  function parseShareToken() {
    const h = location.hash || "";
    const m = h.match(/^#\/share\/(.+)$/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function route() {
    const token = parseShareToken();
    if (token) { renderShareView(token); return; }

    // not a share link → normal app/auth
    hide($("view-share"));
    if (state.user) {
      hide($("view-auth"));
      show($("appbar"));
      show($("view-app"));
      $("whoami").innerHTML = `Signed in as <b>${esc(state.user.email)}</b>`;
    } else {
      hide($("appbar"));
      hide($("view-app"));
      show($("view-auth"));
    }
  }

  /* ================================================================
   *  AUTH
   * ================================================================ */
  function setFieldError(id, msg) {
    const el = $(id);
    if (el) el.textContent = msg || "";
  }
  function clearAuthErrors() {
    ["loginEmailErr", "loginPasswordErr", "signupEmailErr", "signupPasswordErr"].forEach(i => setFieldError(i, ""));
    hide($("loginBanner")); hide($("signupBanner")); hide($("resetBanner"));
  }

  function initAuthUI() {
    // tab switching
    const toLogin = () => {
      $("tabLogin").classList.add("active"); $("tabSignup").classList.remove("active");
      show($("loginForm")); hide($("signupForm")); clearAuthErrors();
    };
    const toSignup = () => {
      $("tabSignup").classList.add("active"); $("tabLogin").classList.remove("active");
      show($("signupForm")); hide($("loginForm")); clearAuthErrors();
    };
    $("tabLogin").addEventListener("click", toLogin);
    $("tabSignup").addEventListener("click", toSignup);

    // demo credential chips
    const chips = $("demoChips");
    DB.DEMO_ACCOUNTS.forEach(acc => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "demochip";
      b.innerHTML = `<span class="em">${esc(acc.email)}</span><span class="pw">${esc(acc.password)}</span><span class="use">use →</span>`;
      b.addEventListener("click", () => {
        toLogin();
        $("loginEmail").value = acc.email;
        $("loginPassword").value = acc.password;
        clearAuthErrors();
        $("loginPassword").focus();
      });
      chips.appendChild(b);
    });

    // login submit
    $("loginForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      clearAuthErrors();
      const email = $("loginEmail").value;
      const password = $("loginPassword").value;
      const eErr = DB.validateEmail(email); if (eErr) return setFieldError("loginEmailErr", eErr);
      const pErr = DB.validatePassword(password); if (pErr) return setFieldError("loginPasswordErr", pErr);

      const res = await DB.logIn({ email, password });
      if (res.error) {
        const b = $("loginBanner"); b.textContent = res.error; show(b);
        return;
      }
      onLoggedIn(res.user);
    });

    // forgot password (P1, simulated)
    $("forgotBtn").addEventListener("click", () => {
      clearAuthErrors();
      const res = DB.requestPasswordReset($("loginEmail").value || "");
      if (res.error) return setFieldError("loginEmailErr", res.error);
      const b = $("resetBanner"); b.textContent = res.message; show(b);
    });

    // signup submit
    $("signupForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      clearAuthErrors();
      const email = $("signupEmail").value;
      const password = $("signupPassword").value;
      const eErr = DB.validateEmail(email); if (eErr) return setFieldError("signupEmailErr", eErr);
      const pErr = DB.validatePassword(password); if (pErr) return setFieldError("signupPasswordErr", pErr);

      const res = await DB.signUp({ email, password });
      if (res.error) {
        const b = $("signupBanner"); b.textContent = res.error; show(b);
        return;
      }
      toast("Account created — you’re in!");
      onLoggedIn(res.user);
    });

    // logout
    $("logoutBtn").addEventListener("click", () => {
      cleanupRecordingResources();
      state.user = null;
      // reset record view
      resetRecorderUI();
      switchTab("record");
      route();
      toast("Logged out");
    });
  }

  function onLoggedIn(user) {
    state.user = user;
    // clear auth inputs
    ["loginEmail", "loginPassword", "signupEmail", "signupPassword"].forEach(i => { if ($(i)) $(i).value = ""; });
    clearAuthErrors();
    switchTab("record");
    route();
    renderTelemetry();
  }

  /* ================================================================
   *  NAV / SUB-VIEW SWITCHING
   * ================================================================ */
  function switchTab(name) {
    document.querySelectorAll(".navtab").forEach(t =>
      t.classList.toggle("active", t.dataset.view === name));
    if (name === "library") { hide($("view-record")); show($("view-library")); renderLibrary(); }
    else { hide($("view-library")); show($("view-record")); }
  }

  function initNav() {
    document.querySelectorAll(".navtab").forEach(t =>
      t.addEventListener("click", () => switchTab(t.dataset.view)));
  }

  /* ================================================================
   *  SCRIPT FIELD
   * ================================================================ */
  function initScript() {
    const ta = $("scriptInput");
    const count = $("scriptCount");
    const update = () => {
      const len = ta.value.length;
      count.textContent = `${len} / ${DB.LIMITS.scriptMax}`;
      const err = DB.validateScript(ta.value);
      setFieldError("scriptErr", err || "");
      count.style.color = len > DB.LIMITS.scriptMax ? "var(--err)" : "";
    };
    ta.addEventListener("input", update);
    update();
  }
  function lockScript(locked) {
    state.scriptLocked = locked;
    $("scriptInput").disabled = locked;
    const chip = $("scriptLockChip");
    chip.className = "chip " + (locked ? "complete" : "idle");
    chip.innerHTML = `<span class="led"></span>${locked ? "locked" : "unlocked"}`;
  }

  /* ================================================================
   *  RECORDING STATE MACHINE (PRD Section 4)
   * ================================================================ */
  const STATES = ["idle", "recording", "processing", "uploading", "complete"];
  function renderStateTrack() {
    const track = $("stateTrack");
    const idx = STATES.indexOf(state.status);
    track.innerHTML = STATES.map((s, i) => {
      const on = (state.status === "failed") ? (i <= STATES.indexOf("uploading") && s !== "complete")
                                             : (i <= idx);
      const node = `<span class="node ${on ? "on" : ""}">${s}</span>`;
      return i < STATES.length - 1 ? node + `<span class="arrow">→</span>` : node;
    }).join("") + (state.status === "failed" ? `<span class="arrow">→</span><span class="node on" style="background:var(--err);border-color:var(--err);">failed</span>` : "");
  }
  function setStatus(s) {
    state.status = s;
    const chip = $("statusChip");
    chip.className = "chip " + s;
    $("statusText").textContent = s;
    renderStateTrack();
  }

  /* ================================================================
   *  RECORDER
   * ================================================================ */
  function pickMimeType() {
    const candidates = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8,opus",
      "video/webm;codecs=vp8",
      "video/webm",
    ];
    for (const c of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
    }
    return "video/webm";
  }

  function buildRecordingStream(displayStream, micStream) {
    const videoTrack = displayStream.getVideoTracks()[0];
    const audioTracks = [
      ...displayStream.getAudioTracks(),
      ...(micStream ? micStream.getAudioTracks() : []),
    ];
    if (audioTracks.length <= 1) {
      return new MediaStream([videoTrack, ...audioTracks]);
    }
    // Mix multiple audio sources (system + mic) into one track via Web Audio.
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const dest = ctx.createMediaStreamDestination();
      audioTracks.forEach(t => {
        const src = ctx.createMediaStreamSource(new MediaStream([t]));
        src.connect(dest);
      });
      state.audioMixCtx = ctx;
      return new MediaStream([videoTrack, dest.stream.getAudioTracks()[0]]);
    } catch {
      return new MediaStream([videoTrack, ...audioTracks]);
    }
  }

  function startTimer() {
    state.elapsed = 0;
    $("timer").textContent = "00:00";
    $("timer").classList.remove("warn");
    state.timerInterval = setInterval(() => {
      state.elapsed += 1;
      $("timer").textContent = fmtTime(state.elapsed);

      if (state.elapsed === WARN_SECONDS) {
        const b = $("limitBanner");
        b.textContent = "Heads up — 1 minute left. Recording will auto-stop at 15:00.";
        show(b);
        $("timer").classList.add("warn");
      }
      if (state.elapsed >= MAX_SECONDS) {
        const b = $("limitBanner");
        b.textContent = "15-minute limit reached — recording stopped automatically.";
        show(b);
        stopRecording();
      }
    }, 1000);
  }
  function stopTimer() {
    if (state.timerInterval) { clearInterval(state.timerInterval); state.timerInterval = null; }
  }

  async function startRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      const b = $("permBanner");
      b.textContent = "Screen recording isn’t available in this browser. Use Chrome on desktop.";
      show(b);
      return;
    }
    hide($("permBanner")); hide($("limitBanner"));

    // 1) ask for the screen (PRD: select screen/window/tab)
    let displayStream;
    try {
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30, height: { ideal: 1080 }, width: { ideal: 1920 } },
        audio: true, // system audio when supported
      });
    } catch (err) {
      // PRD: screen permission denied → message, recording does not begin
      const b = $("permBanner");
      b.textContent = "Screen permission was denied or cancelled. Recording did not start.";
      show(b);
      return;
    }

    // 2) optional microphone (PRD: continue without mic if denied)
    let micStream = null;
    if ($("micToggle").checked) {
      try {
        micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        toast("Microphone blocked — recording without it.");
        micStream = null;
      }
    }

    state.displayStream = displayStream;
    state.micStream = micStream;

    // If user clicks the browser's native "Stop sharing", end the recording.
    displayStream.getVideoTracks()[0].addEventListener("ended", () => {
      if (state.status === "recording") stopRecording();
    });

    const recordStream = buildRecordingStream(displayStream, micStream);
    const mimeType = pickMimeType();

    let recorder;
    try {
      recorder = new MediaRecorder(recordStream, { mimeType });
    } catch (err) {
      const b = $("permBanner");
      b.textContent = "Could not start the recorder on this device. Try Chrome on desktop.";
      show(b);
      cleanupStreams();
      return;
    }

    state.mediaRecorder = recorder;
    state.chunks = [];
    state.recordedBlob = null;

    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) state.chunks.push(e.data); };
    recorder.onstop = () => onRecordingStopped(mimeType, displayStream);

    recorder.start(1000); // gather chunks every second

    // wire live preview (muted + no controls to avoid audio feedback)
    const v = $("preview");
    v.pause && v.pause();
    v.src = "";
    v.controls = false;
    v.muted = true;
    v.srcObject = displayStream;
    hide($("previewEmpty"));

    // UI → recording
    setStatus("recording");
    lockScript(true);                 // PRD: script locks when recording starts
    $("micToggle").disabled = true;
    hide($("startBtn")); show($("stopBtn"));
    $("recBadge").classList.add("on");
    hide($("uploadCard"));
    startTimer();

    DB.logEvent(state.user.id, "recording_started");
    renderTelemetry();
  }

  function stopRecording() {
    if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") {
      state.mediaRecorder.stop();   // triggers onstop → onRecordingStopped
    }
    stopTimer();
    $("recBadge").classList.remove("on");
    show($("startBtn")); hide($("stopBtn"));
  }

  function onRecordingStopped(mimeType, displayStream) {
    // ----- processing state: assemble blob (PRD) -----
    setStatus("processing");

    const videoTrack = displayStream.getVideoTracks()[0];
    const settings = videoTrack ? videoTrack.getSettings() : {};
    const resolution = (settings.width && settings.height) ? `${settings.width}x${settings.height}` : "unknown";

    cleanupStreams(); // release camera/screen now that capture is done

    // empty / corrupt capture → failed (PRD: recording → failed)
    if (!state.chunks.length) {
      setStatus("failed");
      const b = $("permBanner");
      b.textContent = "Nothing was captured (empty recording). Please try again.";
      show(b);
      lockScript(false);
      $("micToggle").disabled = false;
      return;
    }

    let blob;
    try {
      blob = new Blob(state.chunks, { type: mimeType });
      if (!blob.size) throw new Error("zero-size blob");
    } catch {
      // blob assembly fails → failed (PRD: processing → failed)
      setStatus("failed");
      const b = $("permBanner");
      b.textContent = "Could not assemble the recording. Please try again.";
      show(b);
      lockScript(false);
      $("micToggle").disabled = false;
      return;
    }

    state.recordedBlob = blob;
    state.recordedMeta = {
      duration_seconds: state.elapsed,
      resolution,
      codec: mimeType,
    };

    DB.logEvent(state.user.id, "recording_completed");
    renderTelemetry();

    // preview the recorded file
    const url = URL.createObjectURL(blob);
    const v = $("preview");
    v.srcObject = null;
    v.src = url;
    v.muted = false;
    v.controls = true;

    // ----- persist row + begin upload (PRD: row persisted when upload starts) -----
    const ins = DB.insertRecording(state.user.id, {
      title: defaultTitle(),
      script_text: $("scriptInput").value,
      status: "uploading",
      duration_seconds: state.recordedMeta.duration_seconds,
      resolution: state.recordedMeta.resolution,
      codec: state.recordedMeta.codec,
      local_blob_available: true,
    });
    if (ins.error) { toast(ins.error); return; }

    state.activeRecordingId = ins.recording.id;
    blobUrlByRecordingId[state.activeRecordingId] = url;

    runUpload(); // single-shot with retries
  }

  function defaultTitle() {
    const now = new Date();
    return `Screen recording — ${now.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
  }

  /* ================================================================
   *  UPLOAD  (single-shot + up to 3 retries, exponential backoff)
   *  The painkiller: a failed upload never loses the recording.
   * ================================================================ */
  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

  function animateProgress(toPct, ms) {
    return new Promise((resolve) => {
      const bar = $("uploadBar");
      const start = parseFloat(bar.style.width) || 0;
      const steps = 20;
      let i = 0;
      const tick = setInterval(() => {
        i++;
        bar.style.width = (start + (toPct - start) * (i / steps)) + "%";
        if (i >= steps) { clearInterval(tick); resolve(); }
      }, ms / steps);
    });
  }

  // Simulated transfer. Real backend would POST the blob to storage here.
  async function attemptUpload(shouldFail) {
    if (shouldFail) {
      await animateProgress(65, 700);
      throw new Error("network error");
    }
    await animateProgress(100, 900);
    return true;
  }

  async function runUpload() {
    setStatus("uploading");
    show($("uploadCard"));
    hide($("retryBtn")); hide($("copyLinkBtn")); hide($("openLibBtn"));
    const msg = $("uploadMsg");
    msg.className = "upload-msg";
    $("uploadBar").style.width = "0%";

    const maxAttempts = 4;          // 1 initial + 3 retries (PRD)
    const backoff = [0, 500, 1000, 2000]; // exponential backoff before attempts 2,3,4

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (backoff[attempt - 1] > 0) {
        msg.textContent = `Attempt ${attempt - 1} failed. Retrying in ${backoff[attempt - 1] / 1000}s…`;
        await wait(backoff[attempt - 1]);
      }
      msg.className = "upload-msg";
      msg.textContent = `Uploading… (attempt ${attempt} of ${maxAttempts})`;
      $("uploadBar").style.width = "0%";

      const shouldFail = $("failToggle").checked; // demo control
      try {
        await attemptUpload(shouldFail);
        return uploadSucceeded(attempt);
      } catch {
        DB.logEvent(state.user.id, "upload_failed", attempt);
        renderTelemetry();
        // keep looping until attempts exhausted
      }
    }
    uploadFailedAllRetries(maxAttempts);
  }

  function uploadSucceeded(attempt) {
    // mint share token, mark complete (PRD)
    const res = DB.generateShareToken(state.user.id, state.activeRecordingId);
    if (res.error) { toast(res.error); return; }

    blobUrlByToken[res.token] = blobUrlByRecordingId[state.activeRecordingId];

    setStatus("complete");
    const msg = $("uploadMsg");
    msg.className = "upload-msg ok";
    msg.textContent = `Upload complete on attempt ${attempt}. Your shareable link is ready.`;

    const link = shareLink(res.token);
    const copyBtn = $("copyLinkBtn");
    show(copyBtn);
    copyBtn.onclick = async () => {
      const ok = await copyText(link);
      toast(ok ? "Share link copied!" : link);
    };
    const openLib = $("openLibBtn");
    show(openLib);
    openLib.onclick = () => switchTab("library");
    hide($("retryBtn"));

    DB.logEvent(state.user.id, "upload_succeeded", attempt);
    DB.logEvent(state.user.id, "share_link_generated");
    renderTelemetry();

    // unlock for next take
    lockScript(false);
    $("micToggle").disabled = false;
    toast("Recording saved & link ready");
  }

  function uploadFailedAllRetries(maxAttempts) {
    setStatus("failed");
    // PRD: mark session failed, preserve blob, allow manual retry
    DB.updateRecording(state.user.id, state.activeRecordingId, { status: "failed", local_blob_available: true });

    const msg = $("uploadMsg");
    msg.className = "upload-msg err";
    msg.textContent = `Upload failed after ${maxAttempts} attempts. Your recording is safe in memory — you can retry without re-recording.`;

    const retry = $("retryBtn");
    show(retry);
    retry.textContent = $("failToggle").checked
      ? "Retry upload (turn off “Simulate failure” first to succeed)"
      : "Retry upload (blob preserved)";
    retry.onclick = () => {
      // manual retry — respects the current toggle so the demo can succeed
      runUpload();
    };

    DB.logEvent(state.user.id, "upload_failed_final", maxAttempts);
    renderTelemetry();
  }

  function shareLink(token) {
    const base = location.href.split("#")[0];
    return `${base}#/share/${encodeURIComponent(token)}`;
  }

  function initRecorderButtons() {
    $("startBtn").addEventListener("click", startRecording);
    $("stopBtn").addEventListener("click", stopRecording);

    // keep retry label honest as the toggle changes
    $("failToggle").addEventListener("change", () => {
      const retry = $("retryBtn");
      if (!retry.classList.contains("hidden")) {
        retry.textContent = $("failToggle").checked
          ? "Retry upload (turn off “Simulate failure” first to succeed)"
          : "Retry upload (blob preserved)";
      }
    });
  }

  function resetRecorderUI() {
    setStatus("idle");
    lockScript(false);
    $("scriptInput").value = "";
    $("scriptCount").textContent = `0 / ${DB.LIMITS.scriptMax}`;
    $("micToggle").disabled = false;
    $("failToggle").checked = false;
    show($("startBtn")); hide($("stopBtn"));
    hide($("uploadCard")); hide($("limitBanner")); hide($("permBanner"));
    $("recBadge").classList.remove("on");
    const v = $("preview");
    v.src = ""; v.srcObject = null; v.controls = false; v.muted = true;
    show($("previewEmpty"));
    $("uploadBar").style.width = "0%";
  }

  /* ================================================================
   *  RESOURCE CLEANUP
   * ================================================================ */
  function cleanupStreams() {
    [state.displayStream, state.micStream].forEach(s => {
      if (s) s.getTracks().forEach(t => t.stop());
    });
    state.displayStream = null;
    state.micStream = null;
    if (state.audioMixCtx) { try { state.audioMixCtx.close(); } catch {} state.audioMixCtx = null; }
  }
  function cleanupRecordingResources() {
    stopTimer();
    if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") {
      try { state.mediaRecorder.stop(); } catch {}
    }
    cleanupStreams();
  }

  /* ================================================================
   *  LIBRARY  (shows ONLY your own rows)
   * ================================================================ */
  function renderLibrary() {
    const grid = $("libGrid");
    const recs = DB.getRecordingsByUser(state.user.id);

    if (!recs.length) {
      grid.innerHTML = `<div class="empty-lib"><div class="big">No recordings yet</div><div>Head to <b>Record</b> to make your first one.</div></div>`;
      return;
    }

    grid.innerHTML = "";
    recs.forEach(r => grid.appendChild(buildRecCard(r)));
  }

  function buildRecCard(r) {
    const card = document.createElement("div");
    card.className = "rec-card";

    const blobUrl = blobUrlByRecordingId[r.id];
    const statusChip = `<span class="chip ${r.status}"><span class="led"></span>${r.status}</span>`;

    const thumb = blobUrl
      ? `<div class="rec-thumb"><video src="${blobUrl}" controls playsinline></video><span class="dur">${fmtTime(r.duration_seconds)}</span></div>`
      : `<div class="rec-thumb"><span class="placeholder">Sample recording<br/>(no playback — created before this session)</span><span class="dur">${fmtTime(r.duration_seconds)}</span></div>`;

    const scriptBlock = r.script_text
      ? `<div class="rec-script">${esc(r.script_text)}</div>`
      : `<div class="rec-meta">No script attached.</div>`;

    card.innerHTML = `
      ${thumb}
      <div class="rec-body">
        <div class="row"><div class="rec-title" data-title>${esc(r.title)}</div></div>
        <div class="rec-meta">${fmtDate(r.created_at)} · ${esc(r.resolution || "—")} · ${statusChip}</div>
        ${scriptBlock}
        <div class="rec-actions">
          <button class="btn btn-ghost btn-sm" data-act="rename">Rename</button>
          ${r.share_token ? `<button class="btn btn-ghost btn-sm" data-act="copy">Copy link</button>
                             <button class="btn btn-ink btn-sm" data-act="open">Open link</button>` : ``}
        </div>
      </div>`;

    // rename (P1, ownership enforced in data layer)
    card.querySelector('[data-act="rename"]').addEventListener("click", () => {
      const current = r.title;
      const next = window.prompt("Rename recording:", current);
      if (next == null) return;
      const res = DB.renameRecording(state.user.id, r.id, next);
      if (res.error) { toast(res.error); return; }
      card.querySelector("[data-title]").textContent = res.recording.title;
      toast("Renamed");
    });

    if (r.share_token) {
      card.querySelector('[data-act="copy"]').addEventListener("click", async () => {
        const ok = await copyText(shareLink(r.share_token));
        toast(ok ? "Share link copied!" : shareLink(r.share_token));
      });
      card.querySelector('[data-act="open"]').addEventListener("click", () => {
        location.hash = `#/share/${encodeURIComponent(r.share_token)}`;
      });
    }
    return card;
  }

  /* ================================================================
   *  SHARE VIEW  (no login, read-only)
   * ================================================================ */
  function renderShareView(token) {
    hide($("view-auth")); hide($("appbar")); hide($("view-app"));
    show($("view-share"));

    const host = $("shareContent");
    const res = DB.getRecordingByShareToken(token);

    if (res.error) {
      host.innerHTML = `<div class="banner err">${esc(res.error)}</div>`;
      return;
    }
    const r = res.recording;
    const blobUrl = blobUrlByToken[token];

    const player = blobUrl
      ? `<div class="share-player"><video src="${blobUrl}" controls playsinline autoplay></video></div>`
      : `<div class="card center muted">This shared recording was created in a previous session.<br/>Live demo video is kept in memory only, so playback isn’t available here — but the link, title, and script resolve correctly.</div>`;

    host.innerHTML = `
      ${player}
      <div class="share-meta">
        <h2 style="font-family:var(--display); font-size:1.5rem;">${esc(r.title)}</h2>
        <div class="rec-meta" style="margin-top:6px;">${fmtTime(r.duration_seconds)} · ${fmtDate(r.created_at)} · shared read-only · no account needed</div>
      </div>
      ${r.script_text ? `<div class="share-script"><div class="section-label">Script / notes</div><div style="white-space:pre-wrap;">${esc(r.script_text)}</div></div>` : ``}
    `;
  }

  /* ================================================================
   *  TELEMETRY PANEL (PRD Section 7)
   * ================================================================ */
  function renderTelemetry() {
    const out = $("telemetryOut");
    if (!out) return;
    const events = DB.getEvents();
    if (!events.length) { out.textContent = "No events yet."; return; }
    out.textContent = events.map(e =>
      `${e.created_at}  ${e.event_name}${e.attempt != null ? `  (attempt ${e.attempt})` : ""}`
    ).join("\n");
  }

  /* ================================================================
   *  PAGE-LEAVE PROTECTION DURING RECORDING (PRD: beforeunload)
   * ================================================================ */
  window.addEventListener("beforeunload", (e) => {
    if (state.status === "recording" || state.status === "processing") {
      e.preventDefault();
      e.returnValue = ""; // browser shows its own warning
    }
  });

  /* ================================================================
   *  BOOT
   * ================================================================ */
  async function boot() {
    await DB.init();

    initAuthUI();
    initNav();
    initScript();
    initRecorderButtons();
    setStatus("idle");
    renderStateTrack();

    // mobile notice if screen capture is unavailable
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      show($("mobileNote"));
      $("startBtn").disabled = true;
    }

    $("shareHome").addEventListener("click", (e) => {
      e.preventDefault();
      location.hash = "";
    });

    window.addEventListener("hashchange", route);
    route();
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
