/* =====================================================================
 * MarQueue-wk-one  ·  js/data.js  ·  THE DATA LAYER ("backend in the browser")
 * =====================================================================
 * This file stands in for the PostgreSQL backend (see ../../backend/schema.sql).
 * It keeps the SAME table names, column names, and rules, so the UI in
 * js/app.js is written against the real shape you will deploy later.
 *
 * What it demonstrates:
 *   - Users + recordings tables (same columns as Postgres)
 *   - Passwords are HASHED, never stored as plaintext (SubtleCrypto SHA-256
 *     + per-user salt). Production would use Supabase Auth / bcrypt.
 *   - Row Level Security: getRecordingsByUser only ever returns YOUR rows.
 *   - Input validation so bad input cannot break the app.
 *   - Minimal internal telemetry (PRD Section 7).
 *
 * The seed is inlined below so the app runs by double-clicking index.html
 * (no server, no fetch, no CORS problems). The same data lives in
 * ../../backend/seed.json as the documented contract.
 * ===================================================================== */

const DB = (() => {
  "use strict";

  // ---- In-memory tables (reset on page reload = PRD "ephemeral session") ----
  const tables = {
    app_users: [],
    recordings: [],
    telemetry_events: [],
  };

  // ---- The seed (mirror of data/seed.json) ----
  const SEED = {
    app_users: [
      { id: "11111111-1111-1111-1111-111111111111", email: "rob@marqueue.app", demo_password: "demo123", created_at: "2026-06-01T09:00:00Z" },
      { id: "22222222-2222-2222-2222-222222222222", email: "vince@marqueue.app",  demo_password: "demo123", created_at: "2026-06-02T09:00:00Z" },
    ],
    recordings: [
      { id: "aaaaaaaa-0000-0000-0000-000000000001", user_id: "11111111-1111-1111-1111-111111111111", title: "Onboarding flow walkthrough", script_text: "Show the signup screen, then the empty dashboard, then record one demo.", status: "complete", duration_seconds: 92,  resolution: "1920x1080", codec: "video/webm;codecs=vp9", share_token: "sample-token-rob-onboarding", storage_path: "private/rob/onboarding.webm", local_blob_available: false, created_at: "2026-06-05T14:20:00Z" },
      { id: "aaaaaaaa-0000-0000-0000-000000000002", user_id: "11111111-1111-1111-1111-111111111111", title: "Bug repro: upload retry",     script_text: "Trigger an upload failure and show the blob is kept for retry.",       status: "complete", duration_seconds: 47,  resolution: "1920x1080", codec: "video/webm;codecs=vp9", share_token: "sample-token-rob-bug",        storage_path: "private/rob/bug-repro.webm", local_blob_available: false, created_at: "2026-06-06T10:05:00Z" },
      { id: "bbbbbbbb-0000-0000-0000-000000000001", user_id: "22222222-2222-2222-2222-222222222222", title: "Sprint update - week 23",      script_text: "Quick async status: shipped, blocked, next.",                          status: "complete", duration_seconds: 130, resolution: "1920x1080", codec: "video/webm;codecs=vp9", share_token: "sample-token-vince-sprint",       storage_path: "private/vince/sprint-23.webm",  local_blob_available: false, created_at: "2026-06-07T16:40:00Z" },
    ],
  };

  // ----------------------- helpers -----------------------

  // Unguessable id / token (PRD share-link security: unguessable token).
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
      (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)
    );
  }
  function randomToken() {
    const bytes = crypto.getRandomValues(new Uint8Array(18));
    return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  }

  // Hash a password with SHA-256 + salt. Returns "salt:hash".
  // (Demonstrates "never store plaintext". Production = Supabase Auth/bcrypt.)
  async function hashPassword(password, salt) {
    salt = salt || randomToken();
    const data = new TextEncoder().encode(salt + ":" + password);
    const digest = await crypto.subtle.digest("SHA-256", data);
    const hex = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
    return salt + ":" + hex;
  }
  async function verifyPassword(password, stored) {
    const salt = stored.split(":")[0];
    const recomputed = await hashPassword(password, salt);
    return recomputed === stored;
  }

  // ----------------------- validation -----------------------
  // Centralised so every form uses the same rules (PRD: validate all input).
  const LIMITS = { passwordMin: 6, titleMax: 120, scriptMax: 20000 };

  function validateEmail(email) {
    if (typeof email !== "string") return "Email is required.";
    email = email.trim();
    if (!email) return "Email is required.";
    if (email.length > 254) return "Email is too long.";
    // Simple, safe email shape check.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "Enter a valid email address.";
    return null; // null = valid
  }
  function validatePassword(pw) {
    if (typeof pw !== "string" || pw.length === 0) return "Password is required.";
    if (pw.length < LIMITS.passwordMin) return `Password must be at least ${LIMITS.passwordMin} characters.`;
    if (pw.length > 200) return "Password is too long.";
    return null;
  }
  function validateTitle(t) {
    if (typeof t !== "string") return "Title must be text.";
    if (t.trim().length === 0) return "Title cannot be empty.";
    if (t.length > LIMITS.titleMax) return `Title must be ${LIMITS.titleMax} characters or fewer.`;
    return null;
  }
  function validateScript(s) {
    if (s == null) return null; // script is optional
    if (typeof s !== "string") return "Script must be text.";
    if (s.length > LIMITS.scriptMax) return `Script must be ${LIMITS.scriptMax} characters or fewer.`;
    return null;
  }

  // ----------------------- init -----------------------
  async function init() {
    tables.app_users = [];
    tables.recordings = [];
    tables.telemetry_events = [];

    // Hash the demo passwords at startup; never keep the plaintext around.
    for (const u of SEED.app_users) {
      tables.app_users.push({
        id: u.id,
        email: u.email,
        password_hash: await hashPassword(u.demo_password),
        created_at: u.created_at,
      });
    }
    // Deep-copy seed recordings so edits don't mutate the seed constant.
    tables.recordings = SEED.recordings.map(r => ({ ...r }));
  }

  // ----------------------- auth -----------------------
  async function signUp({ email, password }) {
    const eErr = validateEmail(email);
    if (eErr) return { error: eErr };
    const pErr = validatePassword(password);
    if (pErr) return { error: pErr };

    email = email.trim().toLowerCase();
    if (tables.app_users.some(u => u.email.toLowerCase() === email)) {
      return { error: "An account with that email already exists." };
    }
    const user = {
      id: uuid(),
      email,
      password_hash: await hashPassword(password),
      created_at: new Date().toISOString(),
    };
    tables.app_users.push(user);
    return { user: publicUser(user) };
  }

  async function logIn({ email, password }) {
    const eErr = validateEmail(email);
    if (eErr) return { error: eErr };
    if (!password) return { error: "Password is required." };

    email = email.trim().toLowerCase();
    const user = tables.app_users.find(u => u.email.toLowerCase() === email);
    // Same generic message whether email or password is wrong (no user enumeration).
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return { error: "Email or password is incorrect." };
    }
    return { user: publicUser(user) };
  }

  // P1: password reset is simulated (production = Supabase Auth email).
  function requestPasswordReset(email) {
    const eErr = validateEmail(email);
    if (eErr) return { error: eErr };
    return { ok: true, message: "If that email exists, a reset link has been sent. (Simulated in the demo.)" };
  }

  // Strip the hash before anything leaves the data layer.
  function publicUser(u) {
    return { id: u.id, email: u.email, created_at: u.created_at };
  }

  // ----------------------- recordings (with ownership / RLS) -----------------------

  // INSERT. Returns the created row.
  function insertRecording(userId, fields) {
    const tErr = validateTitle(fields.title || "Untitled recording");
    if (tErr) return { error: tErr };
    const sErr = validateScript(fields.script_text);
    if (sErr) return { error: sErr };

    const row = {
      id: uuid(),
      user_id: userId,
      title: (fields.title || "Untitled recording").trim(),
      script_text: fields.script_text || "",
      status: fields.status || "uploading",
      duration_seconds: Math.max(0, Math.min(900, Math.round(fields.duration_seconds || 0))),
      resolution: fields.resolution || null,
      codec: fields.codec || null,
      share_token: null,
      storage_path: null,
      local_blob_available: !!fields.local_blob_available,
      created_at: new Date().toISOString(),
    };
    tables.recordings.unshift(row); // newest first
    return { recording: { ...row } };
  }

  // UPDATE, but only if the caller owns the row (RLS).
  function updateRecording(userId, id, patch) {
    const row = tables.recordings.find(r => r.id === id);
    if (!row) return { error: "Recording not found." };
    if (row.user_id !== userId) return { error: "Not authorised." }; // ownership check
    const allowed = ["title", "script_text", "status", "share_token", "storage_path", "local_blob_available", "duration_seconds", "resolution", "codec"];
    for (const key of allowed) {
      if (key in patch) row[key] = patch[key];
    }
    return { recording: { ...row } };
  }

  // SELECT ... WHERE user_id = me  (this IS the Row Level Security guarantee).
  function getRecordingsByUser(userId) {
    return tables.recordings
      .filter(r => r.user_id === userId)
      .map(r => ({ ...r }))
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }

  // Rename with ownership enforced (P1).
  function renameRecording(userId, id, newTitle) {
    const tErr = validateTitle(newTitle);
    if (tErr) return { error: tErr };
    return updateRecording(userId, id, { title: newTitle.trim() });
  }

  // Generate + attach an unguessable share token (PRD share-link security).
  function generateShareToken(userId, id) {
    const token = randomToken();
    const res = updateRecording(userId, id, {
      share_token: token,
      storage_path: `private/${userId}/${id}.webm`,
      status: "complete",
    });
    if (res.error) return res;
    return { token, recording: res.recording };
  }

  // Public share lookup: NO login, read-only. Returns only what a viewer needs.
  // In production this maps to "exchange token for a short-lived signed URL".
  function getRecordingByShareToken(token) {
    if (!token) return { error: "Missing share token." };
    const row = tables.recordings.find(r => r.share_token === token && r.status === "complete");
    if (!row) return { error: "Recording not found or link expired." };
    return {
      recording: {
        id: row.id,
        title: row.title,
        script_text: row.script_text,
        duration_seconds: row.duration_seconds,
        created_at: row.created_at,
        // Note: the blob URL is attached at runtime by app.js for real playback.
      },
    };
  }

  // ----------------------- telemetry (PRD Section 7) -----------------------
  function logEvent(userId, eventName, attempt) {
    const ev = { id: tables.telemetry_events.length + 1, user_id: userId || null, event_name: eventName, attempt: attempt ?? null, created_at: new Date().toISOString() };
    tables.telemetry_events.push(ev);
    return ev;
  }
  function getEvents() {
    return tables.telemetry_events.map(e => ({ ...e }));
  }

  // ----------------------- public API -----------------------
  return {
    init,
    LIMITS,
    // validation (exposed so the UI can validate live as the user types)
    validateEmail, validatePassword, validateTitle, validateScript,
    // auth
    signUp, logIn, requestPasswordReset,
    // recordings
    insertRecording, updateRecording, getRecordingsByUser, renameRecording,
    generateShareToken, getRecordingByShareToken,
    // telemetry
    logEvent, getEvents,
    // demo credential hints for the login screen
    DEMO_ACCOUNTS: [
      { email: "rob@marqueue.app", password: "demo123" },
      { email: "vince@marqueue.app", password: "demo123" },
    ],
  };
})();
