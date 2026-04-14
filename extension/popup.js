/* Autlaut — Popup Script */
let previewAudio = null;

// Per-engine sensible defaults so a fresh engine pick doesn't land on a
// voice the other engine doesn't know about.
const ENGINE_DEFAULT_VOICE = {
  kokoro: "bm_lewis",
  piper: "de_DE-thorsten-medium",
};

const ENGINE_HINTS = {
  kokoro: "Kokoro — 82M-parameter English/multilingual model. No German voice yet.",
  piper: "Piper — VITS. German (Thorsten et al.) + 40+ languages. Each voice downloads its own model on first use.",
};

document.addEventListener("DOMContentLoaded", async () => {
  // Tab switching
  document.querySelectorAll("nav .tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("nav .tab").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach((s) => s.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
    });
  });

  // Show loading spinners while data loads
  document.getElementById("history-list").innerHTML = '<div class="loading-spinner"></div>';
  document.getElementById("settings-form").style.opacity = "0.4";

  await loadSettings();
  document.getElementById("settings-form").style.opacity = "";
  await loadHistory();
  await checkModel();
});

// Listen for model progress updates
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "model-progress" && msg.progress) {
    const btn = document.getElementById("model-toggle");
    const label = btn.querySelector(".server-label");
    const p = msg.progress;
    // Kokoro: { status: "progress" | "done", loaded, total }
    // Piper:  { url, loaded, total }  (no status field)
    if (p.status === "done") {
      label.textContent = "Loading...";
    } else if (p.total && p.loaded != null) {
      const pct = Math.round((p.loaded / p.total) * 100);
      label.textContent = `${pct}%`;
    }
  }
});

// --- Settings ---

// Populate the voice <select> for the given engine. When switching engines,
// piper needs a concrete voice ID to load because each voice is its own ONNX
// model. For kokoro we can ask without a voice hint.
async function populateVoices(engine, preferredVoice) {
  const select = document.getElementById("voice-select");
  const previousValue = select.value;
  select.innerHTML = '<option value="">Loading voices...</option>';
  select.disabled = true;

  const voiceData = await sendMessage({
    action: "get-voices",
    engine,
  });

  select.innerHTML = "";
  select.disabled = false;

  const voices = Array.isArray(voiceData.voices) ? voiceData.voices : [];
  if (voices.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(no voices available)";
    select.appendChild(opt);
    return "";
  }

  voices.forEach((v) => {
    // engine.getVoices() now returns { id, label, language } objects.
    // Fall back to bare strings for defensiveness.
    const id = typeof v === "string" ? v : v.id;
    const label = typeof v === "string" ? v : v.label || v.id;
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = label;
    select.appendChild(opt);
  });

  // Pick the best value to leave selected: the caller's preferred voice →
  // the previously selected voice (if still valid) → engine default → first.
  const ids = voices.map((v) => (typeof v === "string" ? v : v.id));
  const choice = [preferredVoice, previousValue, ENGINE_DEFAULT_VOICE[engine]]
    .filter(Boolean)
    .find((id) => ids.includes(id)) || ids[0];
  select.value = choice;
  return choice;
}

function setEngineHint(engine) {
  const el = document.getElementById("engine-hint");
  if (el) el.textContent = ENGINE_HINTS[engine] || "";
}

async function loadSettings() {
  const settings = await sendMessage({ action: "get-settings" });
  document.getElementById("speed-range").value = settings.speed;
  document.getElementById("speed-value").textContent = `${settings.speed}x`;
  document.getElementById("workers-select").value = String(settings.workers || 2);

  const engineSelect = document.getElementById("engine-select");
  const currentEngine = settings.engine || "kokoro";
  engineSelect.value = currentEngine;
  setEngineHint(currentEngine);

  // Load voices for the currently selected engine.
  await populateVoices(currentEngine, settings.voice);

  // Engine switch: repopulate voices. This may trigger a piper model download
  // on first use — offscreen surfaces progress through the same model-progress
  // relay Kokoro already uses.
  engineSelect.addEventListener("change", async () => {
    const nextEngine = engineSelect.value;
    setEngineHint(nextEngine);
    const preferred = ENGINE_DEFAULT_VOICE[nextEngine];
    await populateVoices(nextEngine, preferred);
  });

  // Speed slider live update
  document.getElementById("speed-range").addEventListener("input", (e) => {
    document.getElementById("speed-value").textContent = `${e.target.value}x`;
  });

  // Voice preview
  document.getElementById("preview-voice-btn").addEventListener("click", previewVoice);

  // Save
  document.getElementById("save-settings-btn").addEventListener("click", async () => {
    const btn = document.getElementById("save-settings-btn");
    btn.disabled = true;
    btn.textContent = "Saving...";
    try {
      const speed = parseFloat(document.getElementById("speed-range").value);
      if (isNaN(speed) || speed < 0.5 || speed > 2) {
        showStatus("Speed must be between 0.5 and 2", "error");
        return;
      }
      const workers = parseInt(document.getElementById("workers-select").value, 10);
      const newSettings = {
        engine: engineSelect.value,
        voice: document.getElementById("voice-select").value,
        speed,
        workers,
      };
      await sendMessage({ action: "save-settings", settings: newSettings });
      showStatus("Settings saved");
    } catch {
      showStatus("Failed to save settings", "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Save Settings";
    }
  });
}

// --- Voice Preview ---

async function previewVoice() {
  const btn = document.getElementById("preview-voice-btn");
  const statusEl = document.getElementById("preview-status");
  const engine = document.getElementById("engine-select").value;
  const voice = document.getElementById("voice-select").value;
  const speed = parseFloat(document.getElementById("speed-range").value);

  // If already playing, stop
  if (previewAudio && !previewAudio.paused) {
    previewAudio.pause();
    previewAudio = null;
    statusEl.textContent = "";
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>`;
    return;
  }

  btn.classList.add("loading");
  statusEl.textContent = "Generating preview...";

  try {
    const result = await sendMessage({
      action: "tts-preview",
      engine,
      voice,
      speed,
    });

    if (result.error) {
      statusEl.textContent = `Error: ${result.error}`;
      btn.classList.remove("loading");
      return;
    }

    previewAudio = new Audio(result.dataUrl);

    previewAudio.addEventListener("ended", () => {
      statusEl.textContent = "";
      btn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>`;
    });

    previewAudio.play();
    statusEl.textContent = `Playing ${voice}...`;
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`;
  } catch (err) {
    statusEl.textContent = "Failed to preview voice";
  } finally {
    btn.classList.remove("loading");
  }
}

// --- Model Toggle ---

let modelReady = false;

async function checkModel() {
  const result = await sendMessage({ action: "model-status" });
  const btn = document.getElementById("model-toggle");
  const label = btn.querySelector(".server-label");

  modelReady = result.ok;
  if (result.ok) {
    btn.className = "server-toggle online";
    btn.title = "Model loaded and ready";
    btn.setAttribute("aria-label", "Model loaded and ready");
    label.textContent = "Ready";
  } else if (result.loading) {
    btn.className = "server-toggle starting";
    btn.title = "Model loading...";
    btn.setAttribute("aria-label", "Model loading");
    label.textContent = "Loading...";
  } else {
    btn.className = "server-toggle offline";
    btn.title = "Click to download and load model (~88 MB)";
    btn.setAttribute("aria-label", "Model not loaded — click to download");
    label.textContent = "Not loaded";
  }
}

document.getElementById("model-toggle").addEventListener("click", async () => {
  if (modelReady) return; // Already loaded, nothing to do

  const btn = document.getElementById("model-toggle");
  const label = btn.querySelector(".server-label");

  label.textContent = "Downloading...";
  btn.className = "server-toggle starting";
  btn.style.pointerEvents = "none";

  try {
    const result = await sendMessage({ action: "tts-init" });
    if (result && result.ok) {
      await checkModel();
      // Reload voices now that model is ready
      const settings = await sendMessage({ action: "get-settings" });
      const engine = document.getElementById("engine-select").value || settings.engine || "kokoro";
      await populateVoices(engine, settings.voice);
    } else {
      label.textContent = "Error";
      btn.className = "server-toggle offline";
      showStatus(result?.error || "Failed to load model", "error");
    }
  } catch (err) {
    label.textContent = "Error";
    btn.className = "server-toggle offline";
    showStatus(err.message || "Failed to load model", "error");
  } finally {
    btn.style.pointerEvents = "";
  }
});

// --- History ---

async function loadHistory() {
  const history = await sendMessage({ action: "get-history" });
  const list = document.getElementById("history-list");
  const empty = document.getElementById("history-empty");
  const clearBtn = document.getElementById("clear-history-btn");

  list.innerHTML = "";

  if (!Array.isArray(history) || history.length === 0) {
    empty.style.display = "block";
    clearBtn.style.display = "none";
    return;
  }

  empty.style.display = "none";
  clearBtn.style.display = "block";

  history.forEach((entry) => {
    const item = document.createElement("div");
    item.className = "history-item";
    item.innerHTML = `
      <div class="title">${escapeHtml(entry.title || "Untitled")}</div>
      <div class="snippet">${escapeHtml(entry.selectedText || "")}</div>
      <div class="meta">
        <span>${formatDate(entry.createdAt)}</span>
        <span>${escapeHtml(entry.voice || "af_heart")}</span>
      </div>
      <button class="delete-btn" data-id="${escapeHtml(entry.id)}" title="Remove" aria-label="Remove from history">&#x2715;</button>
    `;

    item.addEventListener("click", (e) => {
      if (e.target.closest(".delete-btn")) return;
      if (entry.url) chrome.tabs.create({ url: entry.url });
    });

    item.querySelector(".delete-btn").addEventListener("click", async (e) => {
      e.stopPropagation();
      await sendMessage({ action: "remove-history", id: entry.id });
      loadHistory();
    });

    list.appendChild(item);
  });

  clearBtn.onclick = () => {
    if (clearBtn.dataset.confirming) return;
    clearBtn.dataset.confirming = "true";
    clearBtn.innerHTML = `
      <span>Remove all entries?</span>
      <span class="confirm-actions">
        <button class="confirm-yes" aria-label="Confirm clear">Yes</button>
        <button class="confirm-no" aria-label="Cancel clear">No</button>
      </span>`;
    const timeout = setTimeout(() => resetClearBtn(clearBtn), 3000);
    clearBtn.querySelector(".confirm-yes").addEventListener("click", async (e) => {
      e.stopPropagation();
      clearTimeout(timeout);
      await sendMessage({ action: "clear-history" });
      loadHistory();
    });
    clearBtn.querySelector(".confirm-no").addEventListener("click", (e) => {
      e.stopPropagation();
      clearTimeout(timeout);
      resetClearBtn(clearBtn);
    });
  };
}

// --- Helpers ---

function sendMessage(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => resolve(resp || {}));
  });
}

function escapeHtml(str) {
  const el = document.createElement("span");
  el.textContent = str;
  return el.innerHTML;
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const diff = now - d;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function resetClearBtn(btn) {
  delete btn.dataset.confirming;
  btn.textContent = "Clear All History";
}

function showStatus(msg, type = "success") {
  const status = document.getElementById("settings-status");
  status.textContent = msg;
  status.className = `status-msg${type === "error" ? " error" : ""}`;
  setTimeout(() => (status.textContent = ""), type === "error" ? 5000 : 2000);
}
