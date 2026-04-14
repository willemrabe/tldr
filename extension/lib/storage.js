/* Autlaut — shared storage helpers */
const KokoroStorage = {
  async getHistory() {
    const data = await chrome.storage.local.get("history");
    return data.history || [];
  },

  async addEntry(entry) {
    const history = await this.getHistory();
    history.unshift(entry);
    // Keep last 200 entries
    if (history.length > 200) history.length = 200;
    try {
      await chrome.storage.local.set({ history });
    } catch (err) {
      // Storage quota exceeded — trim to half and retry
      if (history.length > 10) {
        history.length = Math.floor(history.length / 2);
        await chrome.storage.local.set({ history });
      } else {
        throw err;
      }
    }
  },

  async removeEntry(id) {
    const history = await this.getHistory();
    const filtered = history.filter((e) => e.id !== id);
    await chrome.storage.local.set({ history: filtered });
  },

  async clearHistory() {
    await chrome.storage.local.set({ history: [] });
  },

  async getSettings() {
    const data = await chrome.storage.local.get("settings");
    return Object.assign(
      {
        engine: "kokoro",
        voice: "bm_lewis",
        speed: 1.0,
        playbackSpeed: 1.0,
        volume: 1.0,
        workers: 2,
      },
      data.settings || {}
    );
  },

  async saveSettings(settings) {
    await chrome.storage.local.set({ settings });
  },
};

// Make available in both content scripts and service worker
if (typeof globalThis !== "undefined") {
  globalThis.KokoroStorage = KokoroStorage;
}
