/* Autlaut — TTS Web Worker (runs a pluggable engine: kokoro or piper) */
import { kokoroEngine } from "./engines/kokoro.js";
import { piperEngine } from "./engines/piper.js";

const ENGINES = {
  [kokoroEngine.id]: kokoroEngine,
  [piperEngine.id]: piperEngine,
};

let currentEngine = null;
let currentEngineId = null;

function emitProgress(progress) {
  self.postMessage({ type: "progress", progress });
}

async function initEngine({ engine, voice, wasmPaths }) {
  const engineId = engine || kokoroEngine.id;
  const impl = ENGINES[engineId];
  if (!impl) throw new Error(`Unknown engine: ${engineId}`);

  // Engine switch — tear down the old one first
  if (currentEngine && currentEngineId !== engineId) {
    try { currentEngine.dispose(); } catch {}
    currentEngine = null;
    currentEngineId = null;
  }

  await impl.load({ wasmPaths, voice, onProgress: emitProgress });
  currentEngine = impl;
  currentEngineId = engineId;
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    switch (msg.action) {
      case "init": {
        await initEngine({
          engine: msg.engine,
          voice: msg.voice,
          wasmPaths: msg.wasmPaths,
        });
        self.postMessage({ id: msg.id, result: { ok: true, engine: currentEngineId } });
        return;
      }

      case "voices": {
        if (!currentEngine) throw new Error("Engine not loaded");
        self.postMessage({
          id: msg.id,
          result: { engine: currentEngineId, voices: currentEngine.getVoices() },
        });
        return;
      }

      case "generate": {
        if (!currentEngine) throw new Error("Engine not loaded");

        // Each engine.generate(args, ctx) — ctx carries wasmPaths so piper
        // can lazy-load a model on first use without the dispatcher having
        // to do a separate init hop.
        const { dataUrl, duration } = await currentEngine.generate(
          {
            text: msg.text,
            voice: msg.voice,
            speed: msg.speed || 1.0,
          },
          {
            wasmPaths: msg.wasmPaths,
            onProgress: emitProgress,
          }
        );
        self.postMessage({
          id: msg.id,
          result: { dataUrl, duration, index: msg.index },
        });
        return;
      }

      default:
        self.postMessage({ id: msg.id, error: `Unknown action: ${msg.action}` });
    }
  } catch (err) {
    self.postMessage({ id: msg.id, error: err.message || String(err) });
  }
};
