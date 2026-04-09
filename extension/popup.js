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

  await loadSettings();
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
    const newSettings = {
      serverUrl: document.getElementById("server-url").value.replace(/\/+$/, ""),
      voice: document.getElementById("voice-select").value,
      speed: parseFloat(document.getElementById("speed-range").value),
    };
    await sendMessage({ action: "save-settings", settings: newSettings });
    const status = document.getElementById("settings-status");
    status.textContent = "Settings saved";
    setTimeout(() => (status.textContent = ""), 2000);
    checkServer();
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

// --- Server Check ---

async function checkServer() {
  const settings = await sendMessage({ action: "get-settings" });
  const result = await sendMessage({ action: "check-server", url: settings.serverUrl });
  const dot = document.getElementById("status-dot");
  if (result.ok) {
    dot.className = "dot online";
    dot.title = "Server online";
  } else {
    dot.className = "dot offline";
    dot.title = "Server offline — start the TTS server";
  }
}

// --- History ---

async function loadHistory() {
  const history = await sendMessage({ action: "get-history" });
  const list = document.getElementById("history-list");
  const empty = document.getElementById("history-empty");
  const clearBtn = document.getElementById("clear-history-btn");

  list.innerHTML = "";

  if (!history || history.length === 0) {
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
        <span>${entry.voice || "af_heart"}</span>
      </div>
      <button class="delete-btn" data-id="${entry.id}" title="Remove">&#x2715;</button>
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

  clearBtn.onclick = async () => {
    if (confirm("Remove all history entries?")) {
      await sendMessage({ action: "clear-history" });
      loadHistory();
    }
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
