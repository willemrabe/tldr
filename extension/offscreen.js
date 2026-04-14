/* Autlaut — Offscreen TTS Engine (worker pool dispatcher) */

const DEFAULT_WORKERS = 2;
const MAX_WORKERS = 4;
const FIRST_CHUNK_MAX = 150;
const REST_CHUNK_MAX = 300;
const DEFAULT_ENGINE = "kokoro";

// ONNX Runtime WASM (shared by kokoro and piper) lives under lib/.
// Piper's emscripten phonemizer WASM + espeak-ng data file also live there.
// We pass a single base URL to the worker; each engine adapter knows how
// to turn it into the shape its underlying library expects.
const wasmPaths = chrome.runtime.getURL("lib/");

// --- Worker pool ---

let workers = [];
let workerReady = [];
let workerEngine = []; // engine id each worker is currently initialized for
let workerVoice = [];  // piper: voice id currently loaded (kokoro: unused)
let targetWorkerCount = DEFAULT_WORKERS;
let currentEngineId = DEFAULT_ENGINE;
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
    workerEngine.push(null);
    workerVoice.push(null);
  }
}

function sendToWorker(workerIdx, msg) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    workers[workerIdx].postMessage({ ...msg, id });
  });
}

async function ensureWorkersReady({ engine, voice, count } = {}) {
  const targetEngine = engine || currentEngineId || DEFAULT_ENGINE;
  const targetVoice = voice || null;
  ensurePoolSize(count || targetWorkerCount);

  // If engine changed globally, mark current workers as needing reinit.
  if (targetEngine !== currentEngineId) {
    for (let i = 0; i < workers.length; i++) {
      if (workerEngine[i] && workerEngine[i] !== targetEngine) {
        workerReady[i] = false;
      }
    }
    currentEngineId = targetEngine;
  }

  const initPromises = [];
  for (let i = 0; i < targetWorkerCount; i++) {
    const engineMismatch = workerEngine[i] !== targetEngine;
    // Piper needs per-voice loading. Kokoro shares one model across voices,
    // so we don't care about voice here.
    const voiceMismatch =
      targetEngine === "piper" &&
      targetVoice &&
      workerVoice[i] !== targetVoice;

    if (!workerReady[i] || engineMismatch || voiceMismatch) {
      initPromises.push(
        sendToWorker(i, {
          action: "init",
          engine: targetEngine,
          voice: targetVoice,
          wasmPaths,
        }).then(() => {
          workerReady[i] = true;
          workerEngine[i] = targetEngine;
          workerVoice[i] = targetEngine === "piper" ? targetVoice : null;
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

// Pick a preview sentence that actually exercises the target language.
// We key off the engine first, then the voice prefix for multilingual engines.
function previewTextFor(engine, voice) {
  const EN_PREVIEW = "The quick brown fox jumps over the lazy dog. How vexingly quick daft zebras jump!";
  const DE_PREVIEW = "Der schnelle braune Fuchs springt über den faulen Hund. Zwölf laxe Typen qualmen gerade.";
  const FR_PREVIEW = "Portez ce vieux whisky au juge blond qui fume sur son île intérieure.";
  const ES_PREVIEW = "El veloz zorro marrón salta sobre el perro perezoso. ¡Qué bien suena el español!";
  const IT_PREVIEW = "Ma la volpe, col suo balzo, ha raggiunto il quieto Fido.";

  if (engine === "piper" && typeof voice === "string") {
    if (voice.startsWith("de_DE")) return DE_PREVIEW;
    if (voice.startsWith("fr_FR")) return FR_PREVIEW;
    if (voice.startsWith("es_")) return ES_PREVIEW;
    if (voice.startsWith("it_IT")) return IT_PREVIEW;
    // fall through to English for en_US / en_GB and any other language
    return EN_PREVIEW;
  }
  return EN_PREVIEW;
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
        await ensureWorkersReady({
          engine: msg.engine,
          voice: msg.voice,
          count: msg.workers || DEFAULT_WORKERS,
        });
        return { ok: true, engine: currentEngineId };
      }

      case "model-status": {
        return {
          ready: workerReady.some(Boolean),
          loading: workers.length > 0 && !workerReady.some(Boolean),
          engine: currentEngineId,
        };
      }

      case "get-voices": {
        // Intentionally no voice — piper lists voices statically, so the
        // engine just needs to be "activated" (no model download).
        await ensureWorkersReady({ engine: msg.engine });
        return await sendToWorker(0, { action: "voices" });
      }

      case "tts-prepare": {
        const chunks = chunkText(msg.text);
        return { chunks, total: chunks.length };
      }

      case "tts-chunk": {
        await ensureWorkersReady({
          engine: msg.engine,
          voice: msg.voice,
          count: msg.workers || targetWorkerCount,
        });
        const workerIdx = pickWorker();
        return await sendToWorker(workerIdx, {
          action: "generate",
          text: msg.text,
          voice: msg.voice,
          speed: msg.speed || 1.0,
          index: msg.index,
          wasmPaths,
        });
      }

      case "tts-preview": {
        const previewText = previewTextFor(msg.engine, msg.voice);
        await ensureWorkersReady({ engine: msg.engine, voice: msg.voice });
        const result = await sendToWorker(0, {
          action: "generate",
          text: previewText,
          voice: msg.voice,
          speed: msg.speed || 1.0,
          index: 0,
          wasmPaths,
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
