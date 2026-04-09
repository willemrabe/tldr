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

// Message handler
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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

  if (msg.action === "check-server") {
    checkServer(msg.url).then(sendResponse);
    return true;
  }

  if (msg.action === "get-voices") {
    fetchVoices(msg.url).then(sendResponse);
    return true;
  }

  if (msg.action === "tts-prepare") {
    ttsPrepare(msg).then(sendResponse).catch((err) =>
      sendResponse({ error: err.message })
    );
    return true;
  }

  if (msg.action === "tts-chunk") {
    ttsChunk(msg).then(sendResponse).catch((err) =>
      sendResponse({ error: err.message })
    );
    return true;
  }

  if (msg.action === "tts-preview") {
    ttsPreview(msg).then(sendResponse).catch((err) =>
      sendResponse({ error: err.message })
    );
    return true;
  }
});

async function checkServer(url) {
  try {
    const resp = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return { ok: false };
    const data = await resp.json();
    return { ok: data.status === "ok" };
  } catch {
    return { ok: false };
  }
}

async function fetchVoices(url) {
  try {
    const resp = await fetch(`${url}/voices`, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return { voices: [] };
    return await resp.json();
  } catch {
    return { voices: [] };
  }
}

async function ttsPrepare(msg) {
  const settings = await KokoroStorage.getSettings();
  const resp = await fetch(`${settings.serverUrl}/tts/prepare`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: msg.text }),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`Server error: ${resp.status}`);
  return await resp.json();
}

async function ttsChunk(msg) {
  const settings = await KokoroStorage.getSettings();
  const resp = await fetch(`${settings.serverUrl}/tts/chunk`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: msg.text,
      voice: settings.voice,
      speed: settings.speed,
      index: msg.index,
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!resp.ok) throw new Error(`Chunk ${msg.index} failed: ${resp.status}`);

  const duration = parseFloat(resp.headers.get("X-Chunk-Duration") || "0");
  const buffer = await resp.arrayBuffer();
  // Convert to base64 data URL to pass through messaging
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const dataUrl = "data:audio/wav;base64," + btoa(binary);

  return { dataUrl, duration, index: msg.index };
}

const PREVIEW_TEXT = "The quick brown fox jumps over the lazy dog. How vexingly quick daft zebras jump!";

async function ttsPreview(msg) {
  const settings = await KokoroStorage.getSettings();
  const resp = await fetch(`${settings.serverUrl}/tts/chunk`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: PREVIEW_TEXT,
      voice: msg.voice,
      speed: msg.speed,
      index: 0,
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`Preview failed: ${resp.status}`);

  const buffer = await resp.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const dataUrl = "data:audio/wav;base64," + btoa(binary);
  return { dataUrl };
}

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
