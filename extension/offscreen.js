/* Autlaut — Offscreen TTS Engine (worker pool dispatcher) */

const DEFAULT_WORKERS = 2;
const MAX_WORKERS = 4;
const SAMPLE_RATE = 24000;
const FIRST_CHUNK_MAX = 150;
const REST_CHUNK_MAX = 300;

const wasmPaths = chrome.runtime.getURL("lib/");

// --- Worker pool ---

let workers = [];
let workerReady = [];
let targetWorkerCount = DEFAULT_WORKERS;
let msgId = 0;
const pending = new Map(); // id → { resolve, reject }

function spawnWorker(index) {
  const w = new Worker(chrome.runtime.getURL("tts-worker.js"), { type: "module" });
  w.onmessage = (e) => {
    const data = e.data;
    if (data.type === "progress") {
      chrome.runtime.sendMessage({
        target: "background",
        action: "model-progress",
        progress: data.progress,
      }).catch(() => {});
      return;
    }
    const p = pending.get(data.id);
    if (p) {
      pending.delete(data.id);
      if (data.error) p.reject(new Error(data.error));
      else p.resolve(data.result);
    }
  };
  w.onerror = (err) => {
    console.error(`[Autlaut] Worker ${index} error:`, err);
  };
  return w;
}

function ensurePoolSize(count) {
  count = Math.max(1, Math.min(MAX_WORKERS, count));
  targetWorkerCount = count;

  // Add workers if needed
  while (workers.length < count) {
    workers.push(spawnWorker(workers.length));
    workerReady.push(false);
  }
}

function sendToWorker(workerIdx, msg) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    workers[workerIdx].postMessage({ ...msg, id });
  });
}

async function ensureWorkersReady(count) {
  ensurePoolSize(count || targetWorkerCount);

  const initPromises = [];
  for (let i = 0; i < targetWorkerCount; i++) {
    if (!workerReady[i]) {
      initPromises.push(
        sendToWorker(i, { action: "init", wasmPaths }).then(() => {
          workerReady[i] = true;
        })
      );
    }
  }
  if (initPromises.length > 0) await Promise.all(initPromises);
}

// Round-robin dispatch
let nextWorker = 0;

function pickWorker() {
  const idx = nextWorker % targetWorkerCount;
  nextWorker = (nextWorker + 1) % targetWorkerCount;
  return idx;
}

// --- Progressive text chunking ---

// Common abbreviations that end with a period but aren't sentence-enders.
const ABBREVS = new Set([
  "mr","mrs","ms","dr","prof","sr","jr","st","sgt","col","gen","lt","maj","capt",
  "gov","rep","sen","dept","corp","inc","ltd","co","vs","etc","approx",
  "jan","feb","mar","apr","jun","jul","aug","sep","sept","oct","nov","dec",
  "mon","tue","wed","thu","fri","sat","sun",
  "fig","vol","no","ed","rev","pg",
]);

// Split text into sentences using heuristics:
// - Split on .!? followed by whitespace then an uppercase letter or quote
// - Don't split after known abbreviations or single-letter initials (A. B. Y.C.)
// - Also split on newlines that look like paragraph breaks
function splitSentences(text) {
  const sentences = [];
  let start = 0;
  const s = text.trim();

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];

    // Paragraph break: double newline
    if (ch === "\n" && (s[i + 1] === "\n" || (s[i + 1] === "\r" && s[i + 2] === "\n"))) {
      const sentence = s.slice(start, i).trim();
      if (sentence) sentences.push(sentence);
      // Skip blank lines
      while (i < s.length && /[\r\n\s]/.test(s[i])) i++;
      start = i;
      i--; // loop will increment
      continue;
    }

    if (ch !== "." && ch !== "!" && ch !== "?") continue;

    // Consume any trailing punctuation/quotes: ." ?) etc.
    let end = i + 1;
    while (end < s.length && /["'\u201D\u2019)}\]]/.test(s[end])) end++;

    // Must be followed by whitespace then something
    if (end >= s.length) {
      // End of text — final sentence
      continue;
    }
    if (!/\s/.test(s[end])) continue;

    // Find the next non-whitespace character
    let next = end;
    while (next < s.length && /\s/.test(s[next])) next++;
    if (next >= s.length) continue;

    // Period-specific checks: skip abbreviations and initials
    if (ch === ".") {
      // Single-letter initial: "A. B." or "Y.C."
      const wordStart = findWordStart(s, i);
      const wordBefore = s.slice(wordStart, i).toLowerCase();
      if (wordBefore.length <= 2) continue; // single/double letter + period = likely initial
      if (ABBREVS.has(wordBefore)) continue;

      // Next char must be uppercase or a quote/paren to indicate new sentence
      if (!/[A-Z\u00C0-\u024F"'\u201C\u2018([]/.test(s[next])) continue;
    }

    // This looks like a real sentence boundary
    const sentence = s.slice(start, end).trim();
    if (sentence) sentences.push(sentence);
    start = end;
    // Skip whitespace
    while (start < s.length && /\s/.test(s[start])) start++;
    i = start - 1;
  }

  const last = s.slice(start).trim();
  if (last) sentences.push(last);
  return sentences;
}

function findWordStart(s, dotIndex) {
  let i = dotIndex - 1;
  // Skip over preceding dots (for initials like Y.C.)
  while (i >= 0 && (s[i] === "." || /[A-Za-z]/.test(s[i]))) i--;
  return i + 1;
}

// Split a single long sentence at word boundaries, preferring commas/semicolons/dashes as break points.
function splitLongSentence(sentence, maxChars) {
  if (sentence.length <= maxChars) return [sentence];

  const chunks = [];
  const words = sentence.split(/\s+/);
  let part = "";

  for (const word of words) {
    if (part && part.length + word.length + 1 > maxChars) {
      chunks.push(part.trim());
      part = word;
    } else {
      part = part ? `${part} ${word}` : word;
    }
  }
  if (part.trim()) chunks.push(part.trim());
  return chunks;
}

function chunkText(text) {
  const sentences = splitSentences(text);
  if (sentences.length === 0) return [text.trim()];

  const chunks = [];
  let current = "";
  let isFirst = true;

  for (const sentence of sentences) {
    const maxChars = isFirst ? FIRST_CHUNK_MAX : REST_CHUNK_MAX;

    if (!current) {
      // Start a new chunk with this sentence
      current = sentence;
    } else if (current.length + sentence.length + 1 <= maxChars) {
      // Sentence fits — append to current chunk
      current += " " + sentence;
    } else {
      // Sentence doesn't fit — flush current chunk as-is (always at sentence boundary)
      chunks.push(current);
      isFirst = false;
      current = sentence;
    }
  }
  if (current) chunks.push(current);

  // Only split chunks that are a single sentence longer than the limit
  const final = [];
  for (let i = 0; i < chunks.length; i++) {
    const maxChars = i === 0 ? FIRST_CHUNK_MAX : REST_CHUNK_MAX;
    if (chunks[i].length <= maxChars) {
      final.push(chunks[i]);
    } else {
      final.push(...splitLongSentence(chunks[i], maxChars));
    }
  }
  return final;
}

// --- Message handler ---

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== "offscreen") return;

  const handle = async () => {
    switch (msg.action) {
      case "tts-init": {
        await ensureWorkersReady(msg.workers || DEFAULT_WORKERS);
        return { ok: true };
      }

      case "model-status": {
        return {
          ready: workerReady.some(Boolean),
          loading: workers.length > 0 && !workerReady.some(Boolean),
        };
      }

      case "get-voices": {
        await ensureWorkersReady();
        return await sendToWorker(0, { action: "voices" });
      }

      case "tts-prepare": {
        const chunks = chunkText(msg.text);
        return { chunks, total: chunks.length };
      }

      case "tts-chunk": {
        await ensureWorkersReady(msg.workers || targetWorkerCount);
        const workerIdx = pickWorker();
        return await sendToWorker(workerIdx, {
          action: "generate",
          text: msg.text,
          voice: msg.voice || "bm_daniel",
          speed: msg.speed || 1.0,
          index: msg.index,
        });
      }

      case "tts-preview": {
        const previewText = "The quick brown fox jumps over the lazy dog. How vexingly quick daft zebras jump!";
        await ensureWorkersReady();
        const result = await sendToWorker(0, {
          action: "generate",
          text: previewText,
          voice: msg.voice || "bm_daniel",
          speed: msg.speed || 1.0,
          index: 0,
        });
        return { dataUrl: result.dataUrl };
      }

      default:
        return { error: `Unknown action: ${msg.action}` };
    }
  };

  handle().then(sendResponse).catch((err) => {
    sendResponse({ error: err.message || String(err) });
  });
  return true;
});
