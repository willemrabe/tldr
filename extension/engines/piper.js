/* Autlaut — Piper TTS engine adapter (VITS via @mintplex-labs/piper-tts-web) */
import { TtsSession, PATH_MAP } from "@mintplex-labs/piper-tts-web";

const DEFAULT_VOICE = "de_DE-thorsten-medium";

let session = null;
let sessionVoice = null;
let loading = null;

// Convert a WAV Blob into a base64 data URL and extract duration from its header.
async function blobToWavInfo(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // Header sanity: "RIFF"...."WAVE"
  let sampleRate = 22050;
  let numChannels = 1;
  let bitsPerSample = 16;
  let dataSize = bytes.length - 44;
  try {
    const view = new DataView(buf);
    numChannels = view.getUint16(22, true) || 1;
    sampleRate = view.getUint32(24, true) || 22050;
    bitsPerSample = view.getUint16(34, true) || 16;
    // Walk past "data" chunk header
    // Standard layout puts the data chunk size at byte 40
    dataSize = view.getUint32(40, true) || dataSize;
  } catch {
    // keep fallbacks
  }
  const bytesPerSample = (bitsPerSample / 8) || 2;
  const duration = dataSize / (sampleRate * numChannels * bytesPerSample);

  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, Math.min(i + CHUNK, bytes.length))
    );
  }
  return {
    dataUrl: "data:audio/wav;base64," + btoa(binary),
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
  };
}

// Prettier labels: "de_DE-thorsten-medium" → "Thorsten (DE, medium)"
const LANG_NAMES = {
  ar_JO: "AR", ca_ES: "CA", cs_CZ: "CS", da_DK: "DA",
  de_DE: "DE", el_GR: "EL", en_GB: "EN-GB", en_US: "EN-US",
  es_ES: "ES", es_MX: "ES-MX", fa_IR: "FA", fi_FI: "FI",
  fr_FR: "FR", hu_HU: "HU", is_IS: "IS", it_IT: "IT",
  ka_GE: "KA", kk_KZ: "KK", lb_LU: "LB", ne_NP: "NE",
  nl_BE: "NL-BE", nl_NL: "NL", no_NO: "NO", pl_PL: "PL",
  pt_BR: "PT-BR", pt_PT: "PT", ro_RO: "RO", ru_RU: "RU",
  sk_SK: "SK", sl_SI: "SL", sr_RS: "SR", sv_SE: "SV",
  sw_CD: "SW", tr_TR: "TR", uk_UA: "UK", vi_VN: "VI",
  zh_CN: "ZH", cy_GB: "CY",
};

function piperVoiceMeta(id) {
  // id shape: "de_DE-thorsten-medium" or "de_DE-thorsten_emotional-medium"
  const match = id.match(/^([a-z]{2}_[A-Z]{2})-(.+)-([a-z_]+)$/);
  if (!match) return { id, label: id, language: "??" };
  const [, lang, speaker, quality] = match;
  const speakerPretty = speaker
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  const langLabel = LANG_NAMES[lang] || lang;
  return {
    id,
    label: `${speakerPretty} (${langLabel}, ${quality})`,
    language: lang,
  };
}

// Stable ordering: German voices first, then the rest alphabetically.
const ALL_VOICES = Object.keys(PATH_MAP)
  .map(piperVoiceMeta)
  .sort((a, b) => {
    const aDe = a.language === "de_DE" ? 0 : 1;
    const bDe = b.language === "de_DE" ? 0 : 1;
    if (aDe !== bDe) return aDe - bDe;
    return a.label.localeCompare(b.label);
  });

// Build the shape of wasmPaths that piper-tts-web's TtsSession expects,
// from a single `lib/` base URL. Both files live alongside the ORT WASM
// in dist/lib/ — see build.js.
function piperWasmPathsFrom(libBase) {
  const base = String(libBase).endsWith("/") ? libBase : libBase + "/";
  return {
    onnxWasm: base,
    piperWasm: base + "piper_phonemize.wasm",
    piperData: base + "piper_phonemize.data",
  };
}

async function ensureSession(voiceId, libBase, onProgress) {
  if (session && sessionVoice === voiceId) return session;

  // The library uses a module-level singleton. Reset it so a voice swap
  // actually reloads the ONNX model instead of reusing the previous one.
  TtsSession._instance = null;
  session = null;
  sessionVoice = null;

  loading = TtsSession.create({
    voiceId,
    wasmPaths: piperWasmPathsFrom(libBase),
    progress: (p) => {
      if (onProgress) onProgress(p);
    },
    logger: () => {},
  });

  session = await loading;
  sessionVoice = voiceId;
  loading = null;
  return session;
}

// Cached base URL captured at load time so generate() can lazy-load a
// model on first use without the caller having to re-supply wasmPaths.
let lastLibBase = null;

export const piperEngine = {
  id: "piper",

  async load({ wasmPaths, voice, onProgress }) {
    if (!wasmPaths) {
      throw new Error("Piper engine requires a wasmPaths base URL");
    }
    lastLibBase = wasmPaths;
    // If a specific voice was requested, eagerly load it (preview path).
    // Otherwise this is a "just activate the engine" call from get-voices —
    // don't trigger the 60+MB model download until the user actually runs TTS.
    if (voice) {
      await ensureSession(voice, wasmPaths, onProgress);
    }
  },

  getVoices() {
    return ALL_VOICES;
  },

  async generate({ text, voice }, ctx = {}) {
    const targetVoice = voice || DEFAULT_VOICE;
    if (!session || sessionVoice !== targetVoice) {
      // Lazy-load on first generate, or when switching voices in-place.
      const libBase = ctx.wasmPaths || lastLibBase;
      if (!libBase) {
        throw new Error("Piper cannot lazy-load: no wasmPaths available");
      }
      await ensureSession(targetVoice, libBase, ctx.onProgress);
    }
    const blob = await session.predict(text);
    return await blobToWavInfo(blob);
  },

  dispose() {
    TtsSession._instance = null;
    session = null;
    sessionVoice = null;
    loading = null;
  },

  currentVoice() {
    return sessionVoice;
  },

  defaultVoice: DEFAULT_VOICE,
};
