/* Autlaut — Popup Script */
let previewAudio = null;

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
  await checkServer();
});

// --- Settings ---

async function loadSettings() {
  const settings = await sendMessage({ action: "get-settings" });
  document.getElementById("server-url").value = settings.serverUrl;
  document.getElementById("speed-range").value = settings.speed;
  document.getElementById("speed-value").textContent = `${settings.speed}x`;

  // Load voices
  const voiceData = await sendMessage({ action: "get-voices", url: settings.serverUrl });
  const select = document.getElementById("voice-select");
  if (voiceData.voices && voiceData.voices.length > 0) {
    select.innerHTML = "";
    voiceData.voices.forEach((v) => {
      const opt = document.createElement("option");
      opt.value = v;
      opt.textContent = v;
      if (v === settings.voice) opt.selected = true;
      select.appendChild(opt);
    });
  }

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
      const serverUrl = document.getElementById("server-url").value.trim().replace(/\/+$/, "");
      if (!/^https?:\/\/.+/.test(serverUrl)) {
        showStatus("Invalid server URL", "error");
        return;
      }
      const speed = parseFloat(document.getElementById("speed-range").value);
      if (isNaN(speed) || speed < 0.5 || speed > 2) {
        showStatus("Speed must be between 0.5 and 2", "error");
        return;
      }
      const newSettings = {
        serverUrl,
        voice: document.getElementById("voice-select").value,
        speed,
      };
      // Request host permission for non-localhost servers
      if (!/^https?:\/\/localhost[:/]/.test(serverUrl)) {
        const origin = new URL(serverUrl).origin + "/*";
        const granted = await chrome.permissions.request({ origins: [origin] });
        if (!granted) {
          showStatus("Host permission denied — cannot reach server", "error");
          return;
        }
      }
      await sendMessage({ action: "save-settings", settings: newSettings });
      showStatus("Settings saved");
      checkServer();
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

// --- Server Toggle ---

let serverOnline = false;

async function checkServer() {
  const settings = await sendMessage({ action: "get-settings" });
  const result = await sendMessage({ action: "check-server", url: settings.serverUrl });
  const btn = document.getElementById("server-toggle");
  const label = btn.querySelector(".server-label");

  serverOnline = result.ok;
  if (result.ok) {
    btn.className = "server-toggle online";
    btn.title = "Server online — click to stop";
    btn.setAttribute("aria-label", "Server online — click to stop");
    label.textContent = "Online";
  } else {
    btn.className = "server-toggle offline";
    btn.title = "Server offline — click to start";
    btn.setAttribute("aria-label", "Server offline — click to start");
    label.textContent = "Offline";
  }
}

document.getElementById("server-toggle").addEventListener("click", async () => {
  const btn = document.getElementById("server-toggle");
  const label = btn.querySelector(".server-label");

  if (serverOnline) {
    // Stop
    label.textContent = "Stopping...";
    btn.className = "server-toggle starting";
    await sendMessage({ action: "stop-server" });
    // Brief delay before re-checking
    await new Promise((r) => setTimeout(r, 500));
    await checkServer();
  } else {
    // Start
    label.textContent = "Starting...";
    btn.className = "server-toggle starting";
    const result = await sendMessage({ action: "start-server" });
    if (result && result.ok) {
      await checkServer();
    } else {
      const errorMsg = result?.error || "Could not start server";
      // Check if native messaging host not installed
      if (errorMsg.includes("not found") || errorMsg.includes("native messaging host")) {
        label.textContent = "Not set up";
        btn.title = "Run install_host.sh first — see README";
      } else {
        label.textContent = "Error";
        btn.title = errorMsg;
      }
      btn.className = "server-toggle offline";
      setTimeout(() => checkServer(), 3000);
    }
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
  setTimeout(() => (status.textContent = ""), 2000);
}
