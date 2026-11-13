let META = null;
let USAGE_SOCKET = null;
let RECONNECT_TIMER = null;
let LOGGING_OUT = false;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The QR code now lives in a single modal appended to <body>, outside the
// #list subtree that render() tears down and rebuilds every ~5s. That means
// opening it once is enough — it survives every subsequent websocket refresh
// on its own, with nothing to track per-card.
let QR_MODAL = null;
let QR_MODAL_BODY = null;
let QR_MODAL_LABEL = null;

// If a websocket "usage" refresh lands while the admin has a limit-editor
// input focused or has text selected inside the list, applying it right away
// would blow away focus/selection (rebuilding the DOM always does that, even
// though typed values would be lost). So we hold the latest
// snapshot here and flush it once the admin is done interacting.
let PENDING_RENDER = null;

const UNIT_BYTES = { MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 };

function bytesToUnit(bytes) {
  if (bytes == null) return { value: "", unit: "GB" };
  if (bytes >= UNIT_BYTES.TB) return { value: round2(bytes / UNIT_BYTES.TB), unit: "TB" };
  if (bytes >= UNIT_BYTES.GB) return { value: round2(bytes / UNIT_BYTES.GB), unit: "GB" };
  return { value: round2(bytes / UNIT_BYTES.MB), unit: "MB" };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// "30 days" / "5 hours" for a remaining duration in milliseconds.
function formatRemaining(ms) {
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  if (ms >= day) {
    const d = Math.ceil(ms / day);
    return `${d} day${d === 1 ? "" : "s"}`;
  }
  const h = Math.max(1, Math.ceil(ms / hour));
  return `${h} hour${h === 1 ? "" : "s"}`;
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

async function api(url, options) {
  const res = await fetch(url, options);
  if (res.status === 401) {
    window.location.href = "/login";
    throw new Error("unauthorized");
  }
  return res;
}

async function loadMeta() {
  const res = await api("/api/meta");
  META = await res.json();
}

function buildLink(uuid, label) {
  const host = location.hostname;
  const remark = encodeURIComponent(label || "VLESS");
  return `vless://${uuid}@${host}:443?encryption=none&security=tls&sni=${host}&type=ws&host=${host}&path=${encodeURIComponent(
    META.wsPath
  )}#${remark}`;
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// One-shot REST fetch — used for the very first paint and as a manual
// "Refresh usage" fallback. Ongoing live updates come from the websocket.
async function loadClients() {
  const [clientsRes, usageRes] = await Promise.all([api("/api/clients"), api("/api/usage")]);
  const clients = await clientsRes.json();
  const usage = await usageRes.json();
  render(clients, usage);
}

function flashCopied(btn, labelEl) {
  const oldLabel = labelEl ? labelEl.textContent : null;
  const oldHtml = btn.innerHTML;
  if (labelEl) {
    labelEl.textContent = "Copied";
    btn.style.color = "var(--success)";
  } else {
    btn.innerHTML = "Copied";
  }
  btn.disabled = true;
  setTimeout(() => {
    if (labelEl) {
      labelEl.textContent = oldLabel;
      btn.style.color = "";
    } else {
      btn.innerHTML = oldHtml;
    }
    btn.disabled = false;
  }, 1200);
}

function copyToClipboard(text, btn, labelEl) {
  navigator.clipboard
    .writeText(text)
    .then(() => flashCopied(btn, labelEl))
    .catch(() => {
      window.prompt("Copy this:", text);
    });
}

const ICONS = {
  edit:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"></path></svg>',
  qrcode:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect><line x1="14" y1="14" x2="14" y2="21"></line><line x1="21" y1="14" x2="21" y2="14.01"></line><line x1="14" y1="17.5" x2="17.5" y2="17.5"></line><line x1="21" y1="21" x2="17.5" y2="21"></line><line x1="17.5" y1="17.5" x2="17.5" y2="21"></line></svg>',
  copy:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"></rect><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"></path></svg>',
  link:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>',
  trash:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="7" x2="20" y2="7"></line><path d="M6 7V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v3"></path><path d="M19 7l-1 13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1L5 7"></path></svg>',
};

function iconBtn({ icon, label, ariaLabel, extraClass }) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "icon-btn" + (extraClass ? " " + extraClass : "");
  btn.setAttribute("aria-label", ariaLabel || label);
  btn.title = ariaLabel || label;
  const iconWrap = document.createElement("span");
  iconWrap.innerHTML = icon;
  const labelEl = document.createElement("span");
  labelEl.textContent = label;
  btn.appendChild(iconWrap);
  btn.appendChild(labelEl);
  return { btn, labelEl };
}

// A client counts as "active" for the status dot when the server detected
// new traffic between the last two 5s snapshots (see getUsageSnapshot's
// trackActivity logic in server.js) — genuinely transient, not lifetime total.
function isActive(clientUsage) {
  return !!clientUsage.active;
}

function renderStatChips(clients, usage) {
  const chips = document.getElementById("statChips");
  if (!chips) return;
  const total = clients.length;
  const active = clients.filter((c) => !c.disabled && isActive(usage[c.id] || {})).length;
  const capped = clients.filter((c) => c.capped).length;
  const expired = clients.filter((c) => c.expired).length;
  const disabledCount = clients.filter((c) => c.disabled).length;
  const totalBytes = clients.reduce((sum, c) => sum + ((usage[c.id] || {}).total || 0), 0);

  chips.innerHTML = "";
  const items = [
    { label: "configs", value: String(total) },
    { label: "active now", value: String(active), live: active > 0 },
    { label: "total usage", value: formatBytes(totalBytes) },
  ];
  if (capped > 0) items.push({ label: "capped", value: String(capped) });
  if (expired > 0) items.push({ label: "expired", value: String(expired) });
  if (disabledCount > 0) items.push({ label: "disabled", value: String(disabledCount) });
  items.forEach((item) => {
    const chip = document.createElement("div");
    chip.className = "stat-chip" + (item.live ? " is-live" : "");
    chip.innerHTML = `<strong>${item.value}</strong><span>${item.label}</span>`;
    chips.appendChild(chip);
  });
}

// ---------- QR code modal (single instance, lives outside #list) ----------
function ensureQrModal() {
  if (QR_MODAL) return;

  const overlay = document.createElement("div");
  overlay.className = "qr-modal-overlay";

  const modal = document.createElement("div");
  modal.className = "qr-modal";

  const head = document.createElement("div");
  head.className = "qr-modal-head";
  const label = document.createElement("span");
  label.className = "label";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "qr-modal-close";
  closeBtn.innerHTML = "&times;";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.addEventListener("click", closeQrModal);
  head.appendChild(label);
  head.appendChild(closeBtn);

  const body = document.createElement("div");
  body.className = "qr-modal-body";

  modal.appendChild(head);
  modal.appendChild(body);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // click on the dim backdrop (not the modal itself) closes it
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeQrModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.classList.contains("is-open")) closeQrModal();
  });

  QR_MODAL = overlay;
  QR_MODAL_BODY = body;
  QR_MODAL_LABEL = label;
}

function openQrModal(link, label) {
  ensureQrModal();
  QR_MODAL_LABEL.textContent = label || "QR code";
  QR_MODAL_BODY.innerHTML = "";
  try {
    // eslint-disable-next-line no-undef
    new QRCode(QR_MODAL_BODY, { text: link, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.L });
  } catch (err) {
    console.error("QR generation failed:", err);
    QR_MODAL_BODY.textContent = "Couldn't generate QR code — use the copy button instead.";
  }
  QR_MODAL.classList.add("is-open");
}

function closeQrModal() {
  if (QR_MODAL) QR_MODAL.classList.remove("is-open");
}

// ---------- edit window (single instance, lives outside #list) ----------
// One window with every editable field and a single Save button. Only the fields
// that actually changed are sent, in one PATCH, so the server restarts Xray once.
let EDIT_MODAL = null;
let EDIT_STATE = null; // { client, els }

function field(labelText, control, hint) {
  const wrap = document.createElement("div");
  wrap.className = "edit-field";
  const lab = document.createElement("label");
  lab.className = "edit-label";
  lab.textContent = labelText;
  wrap.appendChild(lab);
  wrap.appendChild(control);
  if (hint) {
    const h = document.createElement("p");
    h.className = "edit-hint";
    h.textContent = hint;
    wrap.appendChild(h);
  }
  return wrap;
}

function ensureEditModal() {
  if (EDIT_MODAL) return;

  const overlay = document.createElement("div");
  overlay.className = "qr-modal-overlay";
  const modal = document.createElement("div");
  modal.className = "qr-modal edit-modal";

  const head = document.createElement("div");
  head.className = "qr-modal-head";
  const title = document.createElement("span");
  title.className = "label";
  title.textContent = "Edit config";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "qr-modal-close";
  closeBtn.innerHTML = "&times;";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.addEventListener("click", closeEditModal);
  head.appendChild(title);
  head.appendChild(closeBtn);

  const labelInput = document.createElement("input");
  labelInput.type = "text";
  labelInput.maxLength = 100;

  const uuidInput = document.createElement("input");
  uuidInput.type = "text";
  uuidInput.spellcheck = false;
  uuidInput.autocomplete = "off";
  uuidInput.className = "uuid-input";
  uuidInput.placeholder = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx";
  const randomBtn = document.createElement("button");
  randomBtn.type = "button";
  randomBtn.className = "secondary";
  randomBtn.textContent = "Random";
  randomBtn.addEventListener("click", () => {
    uuidInput.value = crypto.randomUUID();
  });
  const uuidRowEl = document.createElement("div");
  uuidRowEl.className = "edit-inline";
  uuidRowEl.appendChild(uuidInput);
  uuidRowEl.appendChild(randomBtn);

  const limitInput = document.createElement("input");
  limitInput.type = "number";
  limitInput.min = "0";
  limitInput.step = "any";
  limitInput.placeholder = "Unlimited";
  const limitUnit = document.createElement("select");
  ["MB", "GB", "TB"].forEach((u) => {
    const opt = document.createElement("option");
    opt.value = u;
    opt.textContent = u;
    limitUnit.appendChild(opt);
  });
  const limitRowEl = document.createElement("div");
  limitRowEl.className = "edit-inline";
  limitRowEl.appendChild(limitInput);
  limitRowEl.appendChild(limitUnit);

  const daysInput = document.createElement("input");
  daysInput.type = "number";
  daysInput.min = "1";
  daysInput.step = "1";
  const noExpiryBox = document.createElement("input");
  noExpiryBox.type = "checkbox";
  const noExpiryLab = document.createElement("label");
  noExpiryLab.className = "edit-check";
  noExpiryLab.appendChild(noExpiryBox);
  noExpiryLab.appendChild(document.createTextNode(" No expiry"));
  noExpiryBox.addEventListener("change", () => {
    daysInput.disabled = noExpiryBox.checked;
  });
  const expiryRowEl = document.createElement("div");
  expiryRowEl.className = "edit-inline";
  expiryRowEl.appendChild(daysInput);
  expiryRowEl.appendChild(noExpiryLab);

  const enabledBox = document.createElement("input");
  enabledBox.type = "checkbox";
  const enabledLab = document.createElement("label");
  enabledLab.className = "edit-check";
  enabledLab.appendChild(enabledBox);
  enabledLab.appendChild(document.createTextNode(" Enabled"));

  const errorEl = document.createElement("p");
  errorEl.className = "edit-error";
  errorEl.hidden = true;

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.textContent = "Save";
  saveBtn.addEventListener("click", saveEdit);
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "secondary";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", closeEditModal);
  const footer = document.createElement("div");
  footer.className = "edit-footer";
  footer.appendChild(cancelBtn);
  footer.appendChild(saveBtn);

  const expiryField = field("Expiry", expiryRowEl, "-");
  const expiryHint = expiryField.querySelector(".edit-hint");

  modal.appendChild(head);
  modal.appendChild(field("Label", labelInput));
  modal.appendChild(field("UUID", uuidRowEl, "Changing it breaks the old config link right away."));
  modal.appendChild(field("Data limit", limitRowEl, "Leave empty for unlimited."));
  modal.appendChild(expiryField);
  modal.appendChild(enabledLab);
  modal.appendChild(errorEl);
  modal.appendChild(footer);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeEditModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.classList.contains("is-open")) closeEditModal();
  });

  EDIT_MODAL = overlay;
  EDIT_STATE = {
    client: null,
    els: { labelInput, uuidInput, limitInput, limitUnit, daysInput, noExpiryBox, enabledBox, errorEl, saveBtn, expiryHint },
  };
}

function openEditModal(c) {
  ensureEditModal();
  const { els } = EDIT_STATE;
  EDIT_STATE.client = c;

  els.labelInput.value = c.label;
  els.uuidInput.value = c.uuid;
  const lim = bytesToUnit(c.dataLimitBytes);
  els.limitInput.value = lim.value;
  els.limitUnit.value = lim.unit;
  els.daysInput.value = "";
  els.noExpiryBox.checked = false;
  els.daysInput.disabled = false;
  els.daysInput.placeholder = c.expiresAt ? "Days from today (renew)" : "Days from today";
  els.expiryHint.textContent = c.expiresAt
    ? `Currently ends ${formatDate(c.expiresAt)}. Leave empty to keep it, or enter days to set a new end date.`
    : "Currently no expiry. Enter days to set one.";
  els.enabledBox.checked = !c.disabled;
  els.errorEl.hidden = true;
  els.saveBtn.disabled = false;

  EDIT_MODAL.classList.add("is-open");
  els.labelInput.focus();
}

function closeEditModal() {
  if (EDIT_MODAL) EDIT_MODAL.classList.remove("is-open");
}

function editError(msg) {
  const { errorEl } = EDIT_STATE.els;
  errorEl.textContent = msg;
  errorEl.hidden = false;
}

async function saveEdit() {
  const { client: c, els } = EDIT_STATE;
  const body = {};

  const label = els.labelInput.value.trim();
  if (!label) return editError("Label cannot be empty.");
  if (label !== c.label) body.label = label;

  const uuid = els.uuidInput.value.trim().toLowerCase();
  if (!UUID_RE.test(uuid)) return editError("Enter a valid UUID (8-4-4-4-12 hex characters).");
  if (uuid !== String(c.uuid).toLowerCase()) body.uuid = uuid;

  const rawLimit = els.limitInput.value.trim();
  let limitBytes = null;
  if (rawLimit) {
    limitBytes = Math.round(parseFloat(rawLimit) * UNIT_BYTES[els.limitUnit.value]);
    if (!Number.isFinite(limitBytes) || limitBytes <= 0) return editError("Enter a valid positive data limit, or leave it empty.");
  }
  if (limitBytes !== (c.dataLimitBytes ?? null)) body.dataLimitBytes = limitBytes;

  if (els.noExpiryBox.checked) {
    if (c.expiresAt) body.expiryDays = null;
  } else if (els.daysInput.value.trim()) {
    const days = parseFloat(els.daysInput.value);
    if (!Number.isFinite(days) || days <= 0) return editError("Enter a valid positive number of days.");
    body.expiryDays = days;
  }

  const disabled = !els.enabledBox.checked;
  if (disabled !== !!c.disabled) body.disabled = disabled;

  if (Object.keys(body).length === 0) {
    closeEditModal();
    return;
  }
  if (body.uuid && !confirm("Change this UUID? The old config link will stop working right away.")) return;

  els.saveBtn.disabled = true;
  els.errorEl.hidden = true;
  try {
    const res = await api("/api/clients/" + c.id, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      editError(data.error || "Could not save the changes.");
      return;
    }
    closeEditModal();
    await loadClients();
  } finally {
    els.saveBtn.disabled = false;
  }
}

// ---------- interaction guard: don't let background refreshes clobber
// an in-progress edit or a manual text selection inside the client list ----------
function isInteractingWithList() {
  const list = document.getElementById("list");
  if (!list) return false;

  const active = document.activeElement;
  if (active && list.contains(active) && (active.tagName === "INPUT" || active.tagName === "SELECT")) {
    return true;
  }

  const sel = window.getSelection();
  if (sel && sel.toString().length > 0 && sel.anchorNode && list.contains(sel.anchorNode)) {
    return true;
  }

  return false;
}

// Every render driven by the background usage websocket goes through here
// instead of calling render() directly. If the admin is mid-edit or has
// text selected, we hold onto the latest data and apply it once they're done,
// instead of yanking the DOM out from under them every ~5s.
function scheduleRender(clients, usage) {
  if (isInteractingWithList()) {
    PENDING_RENDER = { clients, usage };
    return;
  }
  render(clients, usage);
}

function flushPendingRenderIfIdle() {
  if (PENDING_RENDER && !isInteractingWithList()) {
    const { clients, usage } = PENDING_RENDER;
    PENDING_RENDER = null;
    render(clients, usage);
  }
}

function render(clients, usage) {
  renderStatChips(clients, usage);

  const list = document.getElementById("list");
  list.className = "client-list";
  list.innerHTML = "";

  if (!clients.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No configs yet — add one above to generate a link and QR code.";
    list.appendChild(empty);
    return;
  }

  clients.forEach((c) => {
    const link = buildLink(c.uuid, c.label);
    const clientUsage = usage[c.id] || { uplink: 0, downlink: 0, total: 0, active: false };
    const capped = !!c.capped;
    const expired = !!c.expired;
    const disabled = !!c.disabled;
    const blocked = capped || expired;

    const card = document.createElement("div");
    card.className = "client-card" + (disabled ? " disabled" : blocked ? " capped" : "");

    const head = document.createElement("div");
    head.className = "client-head";

    const dot = document.createElement("span");
    dot.className =
      "status-dot" +
      (disabled ? " disabled" : blocked ? " capped" : isActive(clientUsage) ? " active" : "");

    const labelWrap = document.createElement("div");
    const label = document.createElement("p");
    label.className = "client-label";
    label.textContent = c.label;
    const uuidShort = document.createElement("p");
    uuidShort.className = "client-uuid";
    uuidShort.textContent = c.uuid.split("-")[0];
    labelWrap.appendChild(label);
    labelWrap.appendChild(uuidShort);

    head.appendChild(dot);
    head.appendChild(labelWrap);

    // ---- enable / disable switch ----
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "switch" + (disabled ? "" : " is-on");
    toggle.setAttribute("role", "switch");
    toggle.setAttribute("aria-checked", String(!disabled));
    toggle.setAttribute("aria-label", disabled ? "Enable this config" : "Disable this config");
    toggle.title = disabled ? "Disabled - click to enable" : "Enabled - click to disable";
    const knob = document.createElement("span");
    knob.className = "switch-knob";
    toggle.appendChild(knob);
    toggle.addEventListener("click", () => toggleDisabled(c.id, !disabled, toggle));
    // ---- edit button, next to the switch ----
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "head-edit";
    editBtn.setAttribute("aria-label", "Edit this config");
    editBtn.title = "Edit";
    editBtn.innerHTML = ICONS.edit;
    editBtn.addEventListener("click", () => openEditModal(c));
    head.appendChild(editBtn);
    head.appendChild(toggle);

    const stats = document.createElement("div");
    stats.className = "client-stats";

    const down = document.createElement("div");
    down.innerHTML = `<span class="stat-label">Download</span><span class="stat-value">${formatBytes(
      clientUsage.downlink
    )}</span>`;
    const up = document.createElement("div");
    up.innerHTML = `<span class="stat-label">Upload</span><span class="stat-value">${formatBytes(
      clientUsage.uplink
    )}</span>`;
    const total = document.createElement("div");
    total.innerHTML = `<span class="stat-label">Total</span><span class="stat-value">${formatBytes(
      clientUsage.total
    )}</span>`;

    stats.appendChild(down);
    stats.appendChild(up);
    stats.appendChild(total);

    // ---- usage-vs-cap progress bar (only meaningful when a limit is set) ----
    let usageBarTrack = null;
    if (c.dataLimitBytes != null) {
      const ratio = Math.min(1, clientUsage.total / c.dataLimitBytes);
      usageBarTrack = document.createElement("div");
      usageBarTrack.className = "usage-bar-track";
      const fill = document.createElement("div");
      fill.className =
        "usage-bar-fill" + (capped ? " is-capped" : ratio >= 0.85 ? " is-warn" : "");
      fill.style.width = `${Math.max(2, ratio * 100)}%`;
      usageBarTrack.appendChild(fill);
    }

    // ---- data limit row (read-only; everything is edited in the Edit window) ----
    const limitRow = document.createElement("div");
    limitRow.className = "client-limit-row";
    const limitLabel = document.createElement("span");
    if (c.dataLimitBytes == null) {
      limitLabel.textContent = "Unlimited";
    } else if (capped) {
      limitLabel.textContent = "Limit reached";
      const badge = document.createElement("span");
      badge.className = "capped-badge";
      badge.textContent = ` · ${formatBytes(c.dataLimitBytes)}`;
      limitLabel.appendChild(badge);
    } else {
      const remaining = Math.max(0, c.dataLimitBytes - clientUsage.total);
      limitLabel.textContent = `${formatBytes(remaining)} remaining of ${formatBytes(c.dataLimitBytes)}`;
    }
    limitRow.appendChild(limitLabel);

    // ---- expiry row ----
    const expiryRow = document.createElement("div");
    expiryRow.className = "client-limit-row";
    const expiryLabel = document.createElement("span");
    if (!c.expiresAt) {
      expiryLabel.textContent = "No expiry";
    } else if (expired) {
      expiryLabel.textContent = "Expired";
      const badge = document.createElement("span");
      badge.className = "capped-badge";
      badge.textContent = ` · ${formatDate(c.expiresAt)}`;
      expiryLabel.appendChild(badge);
    } else {
      const remainingMs = Date.parse(c.expiresAt) - Date.now();
      expiryLabel.textContent = `Expires in ${formatRemaining(remainingMs)} · ${formatDate(c.expiresAt)}`;
    }
    expiryRow.appendChild(expiryLabel);

    // ---- UUID row ----
    const uuidRow = document.createElement("div");
    uuidRow.className = "client-limit-row";
    const uuidLabel = document.createElement("span");
    uuidLabel.className = "uuid-full";
    uuidLabel.textContent = c.uuid;
    uuidRow.appendChild(uuidLabel);

    // ---- actions: icon + visible label, so first-time users know what each does ----
    const actions = document.createElement("div");
    actions.className = "client-actions";

    const { btn: qrBtn } = iconBtn({ icon: ICONS.qrcode, label: "QR", ariaLabel: "Show QR code" });
    const { btn: copyBtn, labelEl: copyLabelEl } = iconBtn({
      icon: ICONS.copy,
      label: "Copy",
      ariaLabel: "Copy config link",
    });
    copyBtn.addEventListener("click", () => copyToClipboard(link, copyBtn, copyLabelEl));

    const { btn: subBtn, labelEl: subLabelEl } = iconBtn({
      icon: ICONS.link,
      label: "Subscribe",
      ariaLabel: "Copy subscription link",
    });
    subBtn.addEventListener("click", () => copyToClipboard(`${META.subBase}/${c.id}`, subBtn, subLabelEl));

    const { btn: deleteBtn } = iconBtn({
      icon: ICONS.trash,
      label: "Delete",
      ariaLabel: "Delete this config",
      extraClass: "icon-btn-danger",
    });
    deleteBtn.addEventListener("click", () => deleteClient(c.id));

    actions.appendChild(qrBtn);
    actions.appendChild(copyBtn);
    actions.appendChild(subBtn);
    actions.appendChild(deleteBtn);

    const resetRow = document.createElement("div");
    resetRow.className = "actions";
    resetRow.style.marginTop = "8px";
    const resetBtn = document.createElement("button");
    resetBtn.className = "secondary";
    resetBtn.type = "button";
    resetBtn.style.width = "100%";
    resetBtn.textContent = "Reset usage";
    resetBtn.addEventListener("click", () => resetUsage(c.id, resetBtn));
    resetRow.appendChild(resetBtn);

    qrBtn.addEventListener("click", () => openQrModal(link, c.label));

    card.appendChild(head);
    card.appendChild(stats);
    if (usageBarTrack) card.appendChild(usageBarTrack);
    card.appendChild(limitRow);
    card.appendChild(expiryRow);
    card.appendChild(uuidRow);
    card.appendChild(actions);
    card.appendChild(resetRow);
    list.appendChild(card);
  });
}

// Switches a config off (disabled=true) or back on (disabled=false). The server
// rebuilds the Xray config without the client, which cuts its live connections.
async function toggleDisabled(clientId, disabled, btn) {
  btn.disabled = true;
  try {
    const res = await api("/api/clients/" + clientId, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disabled }),
    });
    if (!res.ok) {
      alert("Could not change the config state.");
      return;
    }
    await loadClients();
  } finally {
    btn.disabled = false;
  }
}

async function resetUsage(clientId, btn) {
  if (!confirm("Reset usage for this config? If it was capped, it will reconnect immediately.")) return;
  btn.disabled = true;
  try {
    await api("/api/clients/" + clientId + "/reset-usage", { method: "POST" });
    await loadClients();
  } finally {
    btn.disabled = false;
  }
}

async function createClient() {
  const input = document.getElementById("newLabel");
  const label = input.value.trim();
  const limitValueInput = document.getElementById("newLimitValue");
  const limitUnitSelect = document.getElementById("newLimitUnit");
  const rawLimit = limitValueInput.value.trim();
  const dataLimitBytes = rawLimit
    ? Math.round(parseFloat(rawLimit) * UNIT_BYTES[limitUnitSelect.value])
    : null;
  if (rawLimit && (!Number.isFinite(dataLimitBytes) || dataLimitBytes <= 0)) {
    alert("Enter a valid positive limit, or leave it empty for unlimited.");
    return;
  }
  const uuidInputEl = document.getElementById("newUuid");
  const rawUuid = uuidInputEl.value.trim();
  if (rawUuid && !UUID_RE.test(rawUuid)) {
    alert("Enter a valid UUID (8-4-4-4-12 hex characters), or leave it empty.");
    return;
  }
  const daysInput = document.getElementById("newDays");
  const rawDays = daysInput.value.trim();
  const expiryDays = rawDays ? parseFloat(rawDays) : null;
  if (rawDays && (!Number.isFinite(expiryDays) || expiryDays <= 0)) {
    alert("Enter a valid positive number of days, or leave it empty for no expiry.");
    return;
  }
  const btn = document.getElementById("createBtn");
  btn.disabled = true;
  try {
    const createRes = await api("/api/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label, dataLimitBytes, expiryDays, uuid: rawUuid || null }),
    });
    if (!createRes.ok) {
      const data = await createRes.json().catch(() => ({}));
      alert(data.error || "Could not create the config.");
      return;
    }
    input.value = "";
    uuidInputEl.value = "";
    limitValueInput.value = "";
    daysInput.value = "";
    // the server pushes an updated snapshot over the websocket right away;
    // this REST call is just a fast fallback in case the socket is down.
    await loadClients();
  } finally {
    btn.disabled = false;
  }
}

async function deleteClient(id) {
  if (!confirm("Delete this config? Anyone using it will be disconnected.")) return;
  await api("/api/clients/" + id, { method: "DELETE" });
  await loadClients();
}

// ---------- live usage websocket ----------
function connectUsageSocket() {
  if (RECONNECT_TIMER) {
    clearTimeout(RECONNECT_TIMER);
    RECONNECT_TIMER = null;
  }

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const path = (META && META.usageWsPath) || "/ws/usage";
  const socket = new WebSocket(`${proto}//${location.host}${path}`);
  USAGE_SOCKET = socket;

  socket.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === "usage") {
      scheduleRender(msg.clients, msg.usage);
    }
  });

  socket.addEventListener("close", () => {
    // if we got logged out, don't loop forever reconnecting to a 401
    if (!LOGGING_OUT && !RECONNECT_TIMER) {
      RECONNECT_TIMER = setTimeout(() => {
        RECONNECT_TIMER = null;
        connectUsageSocket();
      }, 3000);
    }
  });

  socket.addEventListener("error", () => {
    socket.close();
  });
}

document.getElementById("createBtn").addEventListener("click", createClient);
document.getElementById("newLabel").addEventListener("keydown", (e) => {
  if (e.key === "Enter") createClient();
});
document.getElementById("refreshBtn").addEventListener("click", () => loadClients());
document.getElementById("logoutBtn").addEventListener("click", async () => {
  LOGGING_OUT = true;
  if (USAGE_SOCKET) USAGE_SOCKET.close();
  await fetch("/api/logout", { method: "POST" });
  window.location.href = "/login";
});

// Flush a deferred background refresh as soon as the admin stops interacting
// with the list — on blur, once a selection is cleared, and as a periodic
// safety net in case neither of those fires (e.g. they just stop typing).
document.addEventListener("focusout", () => setTimeout(flushPendingRenderIfIdle, 0));
document.addEventListener("selectionchange", () => {
  if (window.getSelection().toString().length === 0) flushPendingRenderIfIdle();
});
setInterval(flushPendingRenderIfIdle, 3000);

(async function init() {
  await loadMeta();
  await loadClients();
  // live usage now streams in every 5s over the websocket instead of polling
  connectUsageSocket();
})();
