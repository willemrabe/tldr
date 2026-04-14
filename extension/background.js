/* Autlaut — Background Service Worker */
importScripts("lib/storage.js");

// Context menu setup
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "kokoro-read",
    title: "Read with Autlaut",
    contexts: ["selection"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "kokoro-read" && info.selectionText) {
    chrome.tabs.sendMessage(tab.id, {
      action: "tts-from-context-menu",
      text: info.selectionText,
    });
  }
});

// --- Offscreen document management ---

let offscreenReady = false;

async function ensureOffscreen() {
  if (offscreenReady) {
    // Verify it still exists
    const exists = await chrome.offscreen.hasDocument();
    if (exists) return;
    offscreenReady = false;
  }

  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["WORKERS"],
      justification: "Kokoro TTS inference via ONNX Runtime WebAssembly",
    });
    offscreenReady = true;
  } catch (err) {
    // Already exists (race condition)
    if (err.message?.includes("Only a single offscreen")) {
      offscreenReady = true;
    } else {
      throw err;
    }
  }
}

async function sendToOffscreen(msg) {
  await ensureOffscreen();
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { target: "offscreen", ...msg },
      (resp) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (resp && resp.error) {
          reject(new Error(resp.error));
        } else {
          resolve(resp || {});
        }
      }
    );
  });
}

// Message handler
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Ignore messages meant for offscreen
  if (msg.target === "offscreen") return;

  if (msg.action === "save-history") {
    saveHistory(msg, sender.tab).then(sendResponse).catch((err) =>
      sendResponse({ error: err.message })
    );
    return true;
  }

  if (msg.action === "get-history") {
    KokoroStorage.getHistory().then(sendResponse).catch((err) =>
      sendResponse({ error: err.message })
    );
    return true;
  }

  if (msg.action === "remove-history") {
    KokoroStorage.removeEntry(msg.id).then(() => sendResponse({ ok: true })).catch((err) =>
      sendResponse({ error: err.message })
    );
    return true;
  }

  if (msg.action === "clear-history") {
    KokoroStorage.clearHistory().then(() => sendResponse({ ok: true })).catch((err) =>
      sendResponse({ error: err.message })
    );
    return true;
  }

  if (msg.action === "get-settings") {
    KokoroStorage.getSettings().then(sendResponse).catch((err) =>
      sendResponse({ error: err.message })
    );
    return true;
  }

  if (msg.action === "save-settings") {
    KokoroStorage.saveSettings(msg.settings).then(() =>
      sendResponse({ ok: true })
    ).catch((err) =>
      sendResponse({ error: err.message })
    );
    return true;
  }

  if (msg.action === "save-setting") {
    KokoroStorage.getSettings().then((settings) => {
      settings[msg.key] = msg.value;
      return KokoroStorage.saveSettings(settings);
    }).then(() => sendResponse({ ok: true })).catch((err) =>
      sendResponse({ error: err.message })
    );
    return true;
  }

  // --- Model status (replaces server check) ---

  if (msg.action === "check-server" || msg.action === "model-status") {
    sendToOffscreen({ action: "model-status" })
      .then((status) => sendResponse({ ok: status.ready, loading: status.loading }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.action === "get-voices") {
    (async () => {
      const settings = await KokoroStorage.getSettings();
      const engine = msg.engine || settings.engine || "kokoro";
      // Intentionally NOT passing a voice — piper's getVoices() is static
      // (whole PATH_MAP), so listing voices must not trigger the 60+MB
      // per-voice ONNX download. The model only loads on preview / first TTS.
      return sendToOffscreen({ action: "get-voices", engine });
    })().then(sendResponse).catch(() => sendResponse({ voices: [] }));
    return true;
  }

  // --- Model init (replaces server start/stop) ---

  if (msg.action === "start-server" || msg.action === "tts-init") {
    KokoroStorage.getSettings().then((s) =>
      sendToOffscreen({
        action: "tts-init",
        engine: s.engine || "kokoro",
        voice: s.voice,
        workers: s.workers || 2,
      })
    ).then(() => sendResponse({ ok: true, status: "ready" }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (msg.action === "stop-server") {
    // No-op — model stays loaded in offscreen document
    sendResponse({ ok: true });
    return true;
  }

  // --- TTS ---

  if (msg.action === "tts-prepare") {
    sendToOffscreen({ action: "tts-prepare", text: msg.text })
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (msg.action === "tts-chunk") {
    (async () => {
      const settings = await KokoroStorage.getSettings();
      return sendToOffscreen({
        action: "tts-chunk",
        engine: settings.engine || "kokoro",
        text: msg.text,
        voice: settings.voice,
        speed: settings.speed,
        index: msg.index,
        workers: settings.workers || 2,
      });
    })().then(sendResponse).catch((err) =>
      sendResponse({ error: err.message })
    );
    return true;
  }

  if (msg.action === "tts-preview") {
    (async () => {
      const settings = await KokoroStorage.getSettings();
      return sendToOffscreen({
        action: "tts-preview",
        engine: msg.engine || settings.engine || "kokoro",
        voice: msg.voice,
        speed: msg.speed,
      });
    })().then(sendResponse).catch((err) =>
      sendResponse({ error: err.message })
    );
    return true;
  }

  // --- Model progress relay ---

  if (msg.action === "model-progress") {
    // Relay progress to any listening tabs/popup
    chrome.runtime.sendMessage({
      action: "model-progress",
      progress: msg.progress,
    }).catch(() => {});
    return false;
  }
});

async function saveHistory(msg, tab) {
  const entry = {
    id: crypto.randomUUID(),
    url: tab ? tab.url : "",
    title: tab ? tab.title : "Unknown",
    selectedText: msg.text.slice(0, 300),
    filename: msg.filename,
    chunkMap: msg.chunkMap,
    voice: msg.voice,
    speed: msg.speed,
    createdAt: new Date().toISOString(),
  };

  await KokoroStorage.addEntry(entry);
  return { ok: true, historyId: entry.id };
}
