const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const DIST = path.resolve(__dirname, "dist");
const EXT = path.resolve(__dirname, "extension");

// Files to copy as-is to dist/
const STATIC_FILES = [
  "manifest.json",
  "popup.html",
  "popup.css",
  "popup.js",
  "content.js",
  "content.css",
  "lib/storage.js",
  "offscreen.html",
];

// Icon files
const ICON_FILES = ["icon16.png", "icon48.png", "icon128.png"];

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyStatic() {
  // Copy extension files
  for (const file of STATIC_FILES) {
    const src = path.join(EXT, file);
    if (fs.existsSync(src)) {
      copyFile(src, path.join(DIST, file));
    }
  }

  // Copy icons
  for (const icon of ICON_FILES) {
    const src = path.join(EXT, "icons", icon);
    if (fs.existsSync(src)) {
      copyFile(src, path.join(DIST, "icons", icon));
    }
  }

  // Copy ONNX Runtime WASM and worker files
  const wasmDir = path.join(DIST, "lib");
  fs.mkdirSync(wasmDir, { recursive: true });

  // The WASM + MJS worker files from onnxruntime-web
  const ortDist = path.join(__dirname, "node_modules", "onnxruntime-web", "dist");
  for (const f of fs.readdirSync(ortDist)) {
    if (f.endsWith(".wasm") || f.startsWith("ort-wasm-simd-threaded.") && f.endsWith(".mjs")) {
      copyFile(path.join(ortDist, f), path.join(wasmDir, f));
    }
  }

  // Piper phonemizer WASM + espeak-ng data (bundled locally — Chrome MV3
  // blocks remote script/WASM loading, so we can't let piper-tts-web fetch
  // these from the CDN at runtime).
  const piperWasmDir = path.join(__dirname, "node_modules", "@diffusionstudio", "piper-wasm", "build");
  for (const f of ["piper_phonemize.wasm", "piper_phonemize.data"]) {
    const src = path.join(piperWasmDir, f);
    if (fs.existsSync(src)) {
      copyFile(src, path.join(wasmDir, f));
    } else {
      console.warn(`[build] Missing piper asset: ${src}`);
    }
  }
}

async function build() {
  // Clean dist
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  const watch = process.argv.includes("--watch");

  const sharedBundleOpts = {
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "chrome120",
    loader: { ".wasm": "file" },
    define: { "process.env.NODE_ENV": '"production"' },
  };

  // Stub Node built-ins that are dead-code-reachable from piper-tts-web's
  // emscripten glue (it guards them with `typeof process !== 'undefined'`
  // at runtime, but esbuild still walks the require() calls statically).
  const stubNodeBuiltinsPlugin = {
    name: "stub-node-builtins",
    setup(build) {
      const empty = { contents: "module.exports = {};", loader: "js" };
      build.onResolve({ filter: /^(fs|path|url|crypto|worker_threads)$/ }, (args) => ({
        path: args.path,
        namespace: "stub-node",
      }));
      build.onLoad({ filter: /.*/, namespace: "stub-node" }, () => empty);
    },
  };

  // Bundle offscreen.js (dispatcher — lightweight, no kokoro-js)
  const offscreenCtx = await esbuild.context({
    entryPoints: [path.join(EXT, "offscreen.js")],
    outfile: path.join(DIST, "offscreen.js"),
    ...sharedBundleOpts,
  });

  // Bundle tts-worker.js (heavy — contains kokoro-js, piper-tts-web, ONNX Runtime)
  const workerCtx = await esbuild.context({
    entryPoints: [path.join(EXT, "tts-worker.js")],
    outfile: path.join(DIST, "tts-worker.js"),
    plugins: [stubNodeBuiltinsPlugin],
    ...sharedBundleOpts,
  });

  // Bundle background.js (IIFE for service worker)
  const backgroundCtx = await esbuild.context({
    entryPoints: [path.join(EXT, "background.js")],
    bundle: true,
    outfile: path.join(DIST, "background.js"),
    format: "iife",
    platform: "browser",
    target: "chrome120",
  });

  // Copy static files
  copyStatic();

  if (watch) {
    await offscreenCtx.watch();
    await workerCtx.watch();
    await backgroundCtx.watch();
    console.log("Watching for changes...");

    // Also watch static files
    const staticPaths = STATIC_FILES.map((f) => path.join(EXT, f));
    for (const p of staticPaths) {
      if (fs.existsSync(p)) {
        fs.watchFile(p, { interval: 500 }, () => {
          console.log(`Static file changed: ${path.basename(p)}`);
          copyStatic();
        });
      }
    }
  } else {
    await offscreenCtx.rebuild();
    await workerCtx.rebuild();
    await backgroundCtx.rebuild();
    await offscreenCtx.dispose();
    await workerCtx.dispose();
    await backgroundCtx.dispose();

    // Report sizes
    const offscreenSize = fs.statSync(path.join(DIST, "offscreen.js")).size;
    const workerSize = fs.statSync(path.join(DIST, "tts-worker.js")).size;
    const bgSize = fs.statSync(path.join(DIST, "background.js")).size;
    console.log(`Built to dist/`);
    console.log(`  offscreen.js:   ${(offscreenSize / 1024).toFixed(0)} KB`);
    console.log(`  tts-worker.js:  ${(workerSize / 1024).toFixed(0)} KB`);
    console.log(`  background.js:  ${(bgSize / 1024).toFixed(0)} KB`);
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
