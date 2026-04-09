/* Autlaut — Content Script */
(() => {
  const ICONS = {
    speaker: `<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8.5v7a4.47 4.47 0 0 0 2.5-3.5zM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06A9 9 0 0 0 14 3.23z"/></svg>`,
    play: `<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>`,
    pause: `<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>`,
    close: `<svg viewBox="0 0 24 24"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`,
    loading: `<svg viewBox="0 0 24 24"><path d="M12 4V1L8 5l4 4V6a6 6 0 0 1 6 6 6 6 0 0 1-6 6 6 6 0 0 1-6-6H4a8 8 0 0 0 8 8 8 8 0 0 0 8-8 8 8 0 0 0-8-8z"/></svg>`,
    back10: `<svg viewBox="0 0 24 24"><path d="M11.99 5V1l-5 5 5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6h-2c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/><text x="10" y="16" font-size="7" fill="white" text-anchor="middle" font-family="sans-serif">10</text></svg>`,
    fwd10: `<svg viewBox="0 0 24 24"><path d="M12.01 5V1l5 5-5 5V7c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6h2c0 4.42-3.58 8-8 8s-8-3.58-8-8 3.58-8 8-8z"/><text x="14" y="16" font-size="7" fill="white" text-anchor="middle" font-family="sans-serif">10</text></svg>`,
    download: `<svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>`,
  };

  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
  const PARALLEL_WORKERS = 3;

  let fab = null;
  let player = null;
  let progressOverlay = null;
  let audio = null;
  let currentChunkMap = [];
  let highlightSpans = [];
  let selectedText = "";
  let selectedRange = null;
  let speedIndex = 2;
  let cancelGeneration = false;
  let currentBlob = null;
  let currentFilename = "";

  // ── Floating Action Button ──

  function createFAB() {
    if (fab) return fab;
    fab = document.createElement("button");
    fab.id = "kokoro-fab";
    fab.innerHTML = ICONS.speaker;
    fab.title = "Read with Autlaut";
    fab.setAttribute("aria-label", "Read aloud with Autlaut");
    fab.addEventListener("click", onFABClick);
    document.body.appendChild(fab);
    return fab;
  }

  function showFAB(x, y) {
    const f = createFAB();
    f.style.left = `${x - 20}px`;
    f.style.top = `${y - 50}px`;
    f.classList.remove("loading");
    f.innerHTML = ICONS.speaker;
    requestAnimationFrame(() => f.classList.add("visible"));
  }

  function hideFAB() {
    if (fab) fab.classList.remove("visible");
  }

  function setFABLoading(loading) {
    if (!fab) return;
    if (loading) {
      fab.classList.add("loading");
      fab.innerHTML = ICONS.loading;
    } else {
      fab.classList.remove("loading");
      fab.innerHTML = ICONS.speaker;
    }
  }

  // ── Selection Detection ──

  document.addEventListener("mouseup", (e) => {
    if (e.target.closest("#kokoro-fab") || e.target.closest("#kokoro-player") || e.target.closest("#kokoro-progress"))
      return;
    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel?.toString().trim();
      if (text && text.length > 2 && sel.rangeCount > 0) {
        selectedText = text;
        try {
          const range = sel.getRangeAt(0);
          selectedRange = range.cloneRange();
          const rect = range.getBoundingClientRect();
          showFAB(rect.left + rect.width / 2 + window.scrollX, rect.top + window.scrollY);
        } catch {
          selectedRange = null;
          hideFAB();
        }
      } else {
        hideFAB();
      }
    }, 10);
  });

  document.addEventListener("mousedown", (e) => {
    if (e.target.closest("#kokoro-fab") || e.target.closest("#kokoro-player") || e.target.closest("#kokoro-progress"))
      return;
    hideFAB();
  });

  // ── Context Menu ──

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === "tts-from-context-menu") {
      selectedText = msg.text;
      const sel = window.getSelection();
      try { selectedRange = sel?.rangeCount ? sel.getRangeAt(0).cloneRange() : null; } catch { selectedRange = null; }
      generateAndPlay();
    }
  });

  // ── Progress Overlay ──

  function showProgress(done, total, status) {
    if (!progressOverlay) {
      progressOverlay = document.createElement("div");
      progressOverlay.id = "kokoro-progress";
      const vizBars = Array.from({length: 28}, (_, i) =>
        `<div class="kokoro-prog-viz-bar" style="animation-delay:${(i * 0.08).toFixed(2)}s"></div>`
      ).join("");
      const orbs = Array.from({length: 5}, (_, i) =>
        `<div class="kokoro-prog-orb kokoro-prog-orb-${i}"></div>`
      ).join("");
      progressOverlay.innerHTML = `
        ${orbs}
        <div class="kokoro-prog-inner">
          <div class="kokoro-prog-visualizer">${vizBars}</div>
          <div class="kokoro-prog-bar-wrap"><div class="kokoro-prog-bar-fill"></div></div>
          <div class="kokoro-prog-text"></div>
          <button class="kokoro-prog-cancel" aria-label="Cancel generation">Cancel</button>
        </div>
      `;
      progressOverlay.querySelector(".kokoro-prog-cancel").addEventListener("click", () => {
        cancelGeneration = true;
        hideProgress();
        setFABLoading(false);
      });
      document.body.appendChild(progressOverlay);
    }

    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    progressOverlay.querySelector(".kokoro-prog-bar-fill").style.width = `${pct}%`;
    progressOverlay.querySelector(".kokoro-prog-text").textContent = status || `Processing chunk ${done} / ${total}`;
    progressOverlay.classList.add("visible");
  }

  function hideProgress() {
    if (progressOverlay) {
      progressOverlay.classList.remove("visible");
      setTimeout(() => { progressOverlay?.remove(); progressOverlay = null; }, 300);
    }
  }

  // ── TTS Generation (parallel chunked) ──

  async function onFABClick(e) {
    e.stopPropagation();
    e.preventDefault();
    generateAndPlay();
  }

  async function generateAndPlay() {
    if (!selectedText) return;
    cancelGeneration = false;
    setFABLoading(true);

    try {
      const settings = await chrome.runtime.sendMessage({ action: "get-settings" });

      // Step 1: Ask background to chunk the text (background handles fetch to avoid CORS)
      showProgress(0, 0, "Preparing text...");
      const prepResult = await chrome.runtime.sendMessage({ action: "tts-prepare", text: selectedText });
      if (prepResult.error) throw new Error(prepResult.error);
      const { chunks, total } = prepResult;

      showProgress(0, total, `0 / ${total} chunks`);

      // Step 2: Fetch chunks in parallel via background service worker
      const results = new Array(total).fill(null);
      let completed = 0;
      let nextIdx = 0;

      async function worker() {
        while (nextIdx < total && !cancelGeneration) {
          const idx = nextIdx++;
          const result = await chrome.runtime.sendMessage({
            action: "tts-chunk",
            text: chunks[idx],
            index: idx,
          });
          if (result.error) throw new Error(result.error);

          // Convert data URL back to blob
          const resp = await fetch(result.dataUrl);
          const blob = await resp.blob();
          results[idx] = { blob, duration: result.duration, text: chunks[idx] };
          completed++;
          showProgress(completed, total, `${completed} / ${total} chunks`);
        }
      }

      const workers = [];
      for (let i = 0; i < Math.min(PARALLEL_WORKERS, total); i++) {
        workers.push(worker());
      }
      await Promise.all(workers).catch((err) => {
        cancelGeneration = true;
        throw err;
      });

      if (cancelGeneration) return;

      // Step 3: Stitch audio blobs and build chunk map
      showProgress(total, total, "Stitching audio...");

      const SILENCE_DURATION = 0.2;
      const SAMPLE_RATE = 24000;
      const silenceBlob = createSilenceWAV(SILENCE_DURATION, SAMPLE_RATE);

      const pcmParts = [];
      const chunkMap = [];
      let currentTime = 0;
      const silencePCM = await extractPCM(silenceBlob);

      for (const r of results) {
        if (!r) continue;
        const pcm = await extractPCM(r.blob);
        pcmParts.push(pcm);
        chunkMap.push({ start: currentTime, end: currentTime + r.duration, text: r.text });
        currentTime += r.duration;
        // Add silence between chunks
        pcmParts.push(silencePCM);
        currentTime += SILENCE_DURATION;
      }

      const fullBlob = buildWAV(pcmParts, SAMPLE_RATE);
      const audioBlobUrl = URL.createObjectURL(fullBlob);

      // Store blob for on-demand download (no auto-download)
      const timestamp = Date.now();
      const domain = location.hostname.replace(/\./g, "_");
      currentFilename = `Autlaut_${timestamp}_${domain}.wav`;
      currentBlob = fullBlob;

      // Save history (lightweight)
      chrome.runtime.sendMessage({
        action: "save-history",
        chunkMap, text: selectedText,
        voice: settings.voice, speed: settings.speed, filename: currentFilename,
      });

      hideProgress();
      hideFAB();
      setupHighlighting(chunkMap);
      playAudio(audioBlobUrl, chunkMap);

    } catch (err) {
      hideProgress();
      if (!cancelGeneration) showError(err.message || "Failed to connect to TTS server");
    } finally {
      setFABLoading(false);
    }
  }

  /** Create a tiny WAV blob of silence for inter-chunk gaps */
  function createSilenceWAV(seconds, sampleRate) {
    const numSamples = Math.floor(seconds * sampleRate);
    const buffer = new ArrayBuffer(44 + numSamples * 2);
    const view = new DataView(buffer);
    const writeStr = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + numSamples * 2, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, numSamples * 2, true);
    // samples are already zero (silence)
    return new Blob([buffer], { type: "audio/wav" });
  }

  /** Extract raw PCM data from a WAV blob (skip 44-byte header) */
  async function extractPCM(blob) {
    const buf = await blob.arrayBuffer();
    return new Uint8Array(buf, 44);
  }

  /** Build a single valid WAV file from an array of PCM Uint8Arrays */
  function buildWAV(pcmParts, sampleRate) {
    let totalBytes = 0;
    for (const p of pcmParts) totalBytes += p.byteLength;
    const buffer = new ArrayBuffer(44 + totalBytes);
    const view = new DataView(buffer);
    const writeStr = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + totalBytes, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, totalBytes, true);
    const out = new Uint8Array(buffer, 44);
    let offset = 0;
    for (const p of pcmParts) {
      out.set(p, offset);
      offset += p.byteLength;
    }
    return new Blob([buffer], { type: "audio/wav" });
  }

  function saveBlob(blob, filename) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
  }

  function showError(msg) {
    setFABLoading(false);
    console.error("[Autlaut]", msg);
    const toast = document.createElement("div");
    toast.textContent = `Autlaut: ${msg}`;
    Object.assign(toast.style, {
      position: "fixed", bottom: "80px", left: "50%", transform: "translateX(-50%)",
      background: "#d32f2f", color: "#fff", padding: "10px 20px", borderRadius: "8px",
      zIndex: "2147483647", fontSize: "13px", fontFamily: "-apple-system, sans-serif",
      boxShadow: "0 4px 12px rgba(0,0,0,0.3)", maxWidth: "400px",
    });
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  // ── Highlighting ──

  function setupHighlighting(chunkMap) {
    clearHighlights();
    if (!selectedRange) return;
    currentChunkMap = chunkMap;
    highlightSpans = [];

    const container = selectedRange.commonAncestorContainer;
    const parentEl = container.nodeType === Node.TEXT_NODE ? container.parentElement : container;
    const walker = document.createTreeWalker(parentEl, NodeFilter.SHOW_TEXT, null);

    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) {
      if (selectedRange.intersectsNode(node)) textNodes.push(node);
    }
    if (textNodes.length === 0) return;

    const fullText = textNodes.map((n) => n.textContent).join("");

    let searchStart = 0;
    const chunkPositions = chunkMap.map((chunk) => {
      const cleanChunk = chunk.text.trim();
      const idx = fullText.indexOf(cleanChunk, searchStart);
      if (idx >= 0) { searchStart = idx + cleanChunk.length; return { start: idx, end: idx + cleanChunk.length }; }
      const prefix = cleanChunk.slice(0, 40);
      const fuzzyIdx = fullText.indexOf(prefix, Math.max(0, searchStart - 50));
      if (fuzzyIdx >= 0) { searchStart = fuzzyIdx + cleanChunk.length; return { start: fuzzyIdx, end: fuzzyIdx + cleanChunk.length }; }
      return null;
    });

    function buildNodeRanges() {
      const walker2 = document.createTreeWalker(parentEl, NodeFilter.SHOW_TEXT, null);
      const ranges = [];
      let n2, off = 0;
      while ((n2 = walker2.nextNode())) {
        if (selectedRange.intersectsNode(n2)) {
          ranges.push({ node: n2, start: off, end: off + n2.textContent.length });
          off += n2.textContent.length;
        }
      }
      return ranges;
    }

    // Build node ranges once, not per chunk
    let nodeRanges = buildNodeRanges();

    chunkPositions.forEach((pos, chunkIdx) => {
      if (!pos) return;
      for (const nr of nodeRanges) {
        const overlapStart = Math.max(pos.start, nr.start);
        const overlapEnd = Math.min(pos.end, nr.end);
        if (overlapStart >= overlapEnd) continue;
        try {
          const range = document.createRange();
          range.setStart(nr.node, overlapStart - nr.start);
          range.setEnd(nr.node, overlapEnd - nr.start);
          const span = document.createElement("span");
          span.className = "kokoro-chunk";
          span.dataset.chunkIdx = chunkIdx;
          range.surroundContents(span);
          highlightSpans.push(span);
          // Rebuild after DOM mutation from surroundContents
          nodeRanges = buildNodeRanges();
        } catch { /* cross-element boundary */ }
        break;
      }
    });
  }

  function clearHighlights() {
    highlightSpans.forEach((span) => {
      const parent = span.parentNode;
      if (parent) { while (span.firstChild) parent.insertBefore(span.firstChild, span); parent.removeChild(span); parent.normalize(); }
    });
    highlightSpans = [];
    currentChunkMap = [];
  }

  function updateHighlight(currentTime) {
    let activeIdx = -1;
    for (let i = 0; i < currentChunkMap.length; i++) {
      if (currentTime >= currentChunkMap[i].start && currentTime < currentChunkMap[i].end) { activeIdx = i; break; }
    }
    highlightSpans.forEach((span) => {
      const idx = parseInt(span.dataset.chunkIdx, 10);
      span.classList.toggle("kokoro-active", idx === activeIdx);
      span.classList.toggle("kokoro-played", idx < activeIdx);
    });
    if (activeIdx >= 0) {
      const activeSpan = highlightSpans.find((s) => parseInt(s.dataset.chunkIdx) === activeIdx);
      if (activeSpan) {
        const rect = activeSpan.getBoundingClientRect();
        if (rect.top < 60 || rect.bottom > window.innerHeight - 80) {
          activeSpan.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }
    }
  }

  // ── Audio Player ──

  function createPlayer() {
    if (player) player.remove();
    player = document.createElement("div");
    player.id = "kokoro-player";
    player.innerHTML = `
      <div id="kokoro-progress-wrap"><div id="kokoro-progress-bar"></div></div>
      <div id="kokoro-controls">
        <button id="kokoro-back" title="Back 10s" aria-label="Back 10 seconds">${ICONS.back10}</button>
        <button id="kokoro-play-pause" title="Play/Pause" aria-label="Play or pause">${ICONS.pause}</button>
        <button id="kokoro-fwd" title="Forward 10s" aria-label="Forward 10 seconds">${ICONS.fwd10}</button>
        <span id="kokoro-time">0:00 / 0:00</span>
        <span id="kokoro-title"></span>
        <button id="kokoro-download" title="Download audio" aria-label="Download audio">${ICONS.download}</button>
        <button id="kokoro-speed-btn" title="Playback speed" aria-label="Playback speed">1x</button>
        <button id="kokoro-close" title="Close" aria-label="Close player">${ICONS.close}</button>
      </div>`;
    document.body.appendChild(player);
    player.querySelector("#kokoro-play-pause").addEventListener("click", togglePlayPause);
    player.querySelector("#kokoro-back").addEventListener("click", () => seekRelative(-10));
    player.querySelector("#kokoro-fwd").addEventListener("click", () => seekRelative(10));
    player.querySelector("#kokoro-speed-btn").addEventListener("click", cycleSpeed);
    player.querySelector("#kokoro-close").addEventListener("click", closePlayer);
    player.querySelector("#kokoro-progress-wrap").addEventListener("click", seekToClick);
    player.querySelector("#kokoro-download").addEventListener("click", () => {
      if (currentBlob) saveBlob(currentBlob, currentFilename);
    });
    return player;
  }

  function playAudio(blobUrl, chunkMap) {
    if (audio) {
      const oldSrc = audio.src;
      audio.pause();
      audio.src = "";
      if (oldSrc.startsWith("blob:")) URL.revokeObjectURL(oldSrc);
    }
    audio = new Audio(blobUrl);
    currentChunkMap = chunkMap;
    createPlayer();
    player.querySelector("#kokoro-title").textContent =
      selectedText.slice(0, 60) + (selectedText.length > 60 ? "..." : "");
    audio.addEventListener("timeupdate", () => { updateProgressBar(); updateHighlight(audio.currentTime); });
    audio.addEventListener("ended", () => {
      player.querySelector("#kokoro-play-pause").innerHTML = ICONS.play;
      highlightSpans.forEach((s) => { s.classList.remove("kokoro-active"); s.classList.add("kokoro-played"); });
    });
    audio.addEventListener("loadedmetadata", () => updateProgressBar());
    audio.playbackRate = SPEEDS[speedIndex];
    audio.play();
    requestAnimationFrame(() => player.classList.add("visible"));
  }

  function togglePlayPause() {
    if (!audio) return;
    const btn = player.querySelector("#kokoro-play-pause");
    if (audio.paused) { audio.play(); btn.innerHTML = ICONS.pause; }
    else { audio.pause(); btn.innerHTML = ICONS.play; }
  }

  function seekRelative(s) { if (audio) audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + s)); }

  function seekToClick(e) {
    if (!audio || !audio.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    audio.currentTime = ((e.clientX - rect.left) / rect.width) * audio.duration;
  }

  function cycleSpeed() {
    speedIndex = (speedIndex + 1) % SPEEDS.length;
    if (audio) audio.playbackRate = SPEEDS[speedIndex];
    player.querySelector("#kokoro-speed-btn").textContent = `${SPEEDS[speedIndex]}x`;
  }

  function updateProgressBar() {
    if (!audio || !player) return;
    const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
    player.querySelector("#kokoro-progress-bar").style.width = `${pct}%`;
    player.querySelector("#kokoro-time").textContent =
      `${fmtTime(audio.currentTime)} / ${fmtTime(audio.duration || 0)}`;
  }

  function fmtTime(s) {
    if (isNaN(s)) return "0:00";
    const m = Math.floor(s / 60);
    return `${m}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
  }

  function closePlayer() {
    if (audio) {
      const src = audio.src;
      audio.pause();
      audio.src = "";
      audio = null;
      if (src.startsWith("blob:")) URL.revokeObjectURL(src);
    }
    if (player) { player.classList.remove("visible"); setTimeout(() => { player?.remove(); player = null; }, 300); }
    currentBlob = null;
    currentFilename = "";
    clearHighlights();
  }

  // ── Keyboard Shortcuts ──

  document.addEventListener("keydown", (e) => {
    if (!audio || !player) return;
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) return;
    if (e.code === "Space" && e.target === document.body) { e.preventDefault(); togglePlayPause(); }
    else if (e.code === "ArrowLeft") seekRelative(-5);
    else if (e.code === "ArrowRight") seekRelative(5);
  });
})();
