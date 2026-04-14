/* Autlaut — Kokoro TTS engine adapter */
import { KokoroTTS, env } from "kokoro-js";

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const SAMPLE_RATE = 24000;
const DEFAULT_VOICE = "bm_lewis";

let tts = null;
let loading = null;

function bufferToDataUrl(wavBuffer) {
  const bytes = new Uint8Array(wavBuffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return "data:audio/wav;base64," + btoa(binary);
}

function voiceMeta(id, meta) {
  // kokoro-js voice metadata shape: { name, language, gender, ... }
  const name = meta?.name || id;
  const language = meta?.language || inferKokoroLanguage(id);
  return { id, label: name, language };
}

// Fallback language inference from the kokoro voice-id prefix:
// a* = American, b* = British, e* = Spanish, f* = French, h* = Hindi,
// i* = Italian, j* = Japanese, p* = Brazilian Portuguese, z* = Mandarin.
function inferKokoroLanguage(id) {
  const prefix = id.slice(0, 1);
  switch (prefix) {
    case "a": return "en-US";
    case "b": return "en-GB";
    case "e": return "es";
    case "f": return "fr";
    case "h": return "hi";
    case "i": return "it";
    case "j": return "ja";
    case "p": return "pt-BR";
    case "z": return "zh";
    default:  return "en";
  }
}

export const kokoroEngine = {
  id: "kokoro",

  async load({ wasmPaths, onProgress }) {
    if (tts) return;
    if (loading) return loading;

    env.wasmPaths = wasmPaths;

    loading = (async () => {
      tts = await KokoroTTS.from_pretrained(MODEL_ID, {
        dtype: "q8",
        device: "wasm",
        progress_callback: (progress) => {
          if (onProgress) onProgress(progress);
        },
      });
    })();

    try {
      await loading;
    } finally {
      loading = null;
    }
  },

  getVoices() {
    if (!tts) throw new Error("Kokoro not loaded");
    return Object.entries(tts.voices).map(([id, meta]) => voiceMeta(id, meta));
  },

  async generate({ text, voice, speed }, _ctx) {
    if (!tts) throw new Error("Kokoro not loaded");
    const audio = await tts.generate(text, {
      voice: voice || DEFAULT_VOICE,
      speed: speed || 1.0,
    });
    return {
      dataUrl: bufferToDataUrl(audio.toWav()),
      duration: audio.audio.length / SAMPLE_RATE,
    };
  },

  dispose() {
    tts = null;
    loading = null;
  },

  defaultVoice: DEFAULT_VOICE,
};
