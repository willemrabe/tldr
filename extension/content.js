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
    volumeHigh: `<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8.5v7a4.47 4.47 0 0 0 2.5-3.5zM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06A9 9 0 0 0 14 3.23z"/></svg>`,
    volumeLow: `<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8.5v7a4.47 4.47 0 0 0 2.5-3.5z"/></svg>`,
    volumeMute: `<svg viewBox="0 0 24 24"><path d="M16.5 12A4.5 4.5 0 0 0 14 8.5v2.09l2.41 2.41c.06-.31.09-.65.09-1zm2.5 0a7 7 0 0 1-.57 2.8l1.5 1.5A8.93 8.93 0 0 0 21 12a9 9 0 0 0-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3 3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 0 0 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4 9.91 6.09 12 8.18V4z"/></svg>`,
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
  let volumeLevel = 1.0;
  let volumeSaveTimer = null;
  let isSeeking = false;
  let cancelGeneration = false;
  let currentBlob = null;
  let currentFilename = "";

  // ── Streaming playback state ──
  let currentChunkIndex = 0;
  let playbackTimeOffset = 0;
  let totalEstimatedDuration = 0;
  let allChunksComplete = false;
  let isPaused = false;
  let isWaitingForChunk = false;
  let chunkBlobUrls = [];
  let streamingResults = null;
  let streamingChunks = null;
  let streamingTotal = 0;

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
      const vizBars = Array.from({length: 12}, (_, i) =>
        `<div class="kokoro-prog-viz-bar" style="animation-delay:${(i * 0.12).toFixed(2)}s"></div>`
      ).join("");
      const orbs = Array.from({length: 2}, (_, i) =>
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

    // Clean up previous streaming session
    if (streamingResults) {
      chunkBlobUrls.forEach((url) => { if (url) URL.revokeObjectURL(url); });
      chunkBlobUrls = [];
      streamingResults = null;
    }

    try {
      const settings = await chrome.runtime.sendMessage({ action: "get-settings" });

      // Restore saved playback speed and volume
      if (settings.playbackSpeed != null) {
        const idx = SPEEDS.indexOf(settings.playbackSpeed);
        speedIndex = idx >= 0 ? idx : 2;
      }
      if (settings.volume != null) volumeLevel = settings.volume;

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

      // Launch workers but DON'T await — let them run in background
      const workers = [];
      for (let i = 0; i < Math.min(PARALLEL_WORKERS, total); i++) {
        workers.push(worker());
      }

      const allWorkersPromise = Promise.all(workers);

      // Handle background completion: stitch for download, save history
      allWorkersPromise.then(() => {
        allChunksComplete = true;
        // Rebuild chunkMap with all actual durations
        currentChunkMap = buildChunkMap(results, total, chunks);
        stitchForDownload(results, settings);
        chrome.runtime.sendMessage({
          action: "save-history",
          chunkMap: currentChunkMap, text: selectedText,
          voice: settings.voice, speed: settings.speed,
          filename: `Autlaut_${Date.now()}_${location.hostname.replace(/\./g, "_")}.wav`,
        });
      }).catch((err) => {
        if (!cancelGeneration) {
          cancelGeneration = true;
          showError(err.message || "Failed to generate audio");
        }
      });

      // Step 3: Wait only for chunk 0, then start playback immediately
      await waitForChunk(results, 0);
      if (cancelGeneration) return;

      const partialChunkMap = buildChunkMap(results, total, chunks);
      hideProgress();
      hideFAB();
      setupHighlighting(partialChunkMap);
      startStreamingPlayback(results, total, chunks, settings);

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

  // ── Streaming Playback Helpers ──

  const SILENCE_DURATION = 0.2;

  function waitForChunk(results, idx) {
    return new Promise((resolve) => {
      const check = () => {
        if (cancelGeneration || results[idx]) { resolve(); return; }
        setTimeout(check, 50);
      };
      check();
    });
  }

  function buildChunkMap(results, total, chunkTexts) {
    const ESTIMATED_CHARS_PER_SECOND = 65;
    const chunkMap = [];
    let currentTime = 0;
    for (let i = 0; i < total; i++) {
      const duration = results[i] ? results[i].duration : chunkTexts[i].length / ESTIMATED_CHARS_PER_SECOND;
      chunkMap.push({ start: currentTime, end: currentTime + duration, text: chunkTexts[i] });
      currentTime += duration + SILENCE_DURATION;
    }
    totalEstimatedDuration = currentTime;
    return chunkMap;
  }

  function startStreamingPlayback(results, total, chunkTexts, settings) {
    currentChunkIndex = 0;
    playbackTimeOffset = 0;
    isPaused = false;
    allChunksComplete = false;
    chunkBlobUrls = new Array(total).fill(null);
    streamingResults = results;
    streamingChunks = chunkTexts;
    streamingTotal = total;

    createPlayer();
    player.querySelector("#kokoro-title").textContent =
      selectedText.slice(0, 60) + (selectedText.length > 60 ? "..." : "");
    requestAnimationFrame(() => player.classList.add("visible"));
    playChunk(0);
  }

  function playChunk(idx) {
    if (cancelGeneration || idx >= streamingTotal) {
      onPlaybackComplete();
      return;
    }

    const result = streamingResults[idx];
    if (!result) {
      isWaitingForChunk = true;
      showChunkLoading();
      waitForChunk(streamingResults, idx).then(() => {
        isWaitingForChunk = false;
        hideChunkLoading();
        if (!cancelGeneration && !isPaused) playChunk(idx);
      });
      return;
    }

    currentChunkIndex = idx;

    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
    }

    if (!chunkBlobUrls[idx]) {
      chunkBlobUrls[idx] = URL.createObjectURL(result.blob);
    }

    audio = new Audio(chunkBlobUrls[idx]);
    audio.playbackRate = SPEEDS[speedIndex];
    audio.volume = volumeLevel;
    audio.addEventListener("timeupdate", onStreamingTimeUpdate);
    audio.addEventListener("ended", onChunkEnded);

    if (!isPaused) {
      audio.play().catch(() => {});
    }

    // Update chunkMap with actual durations as they become known
    currentChunkMap = buildChunkMap(streamingResults, streamingTotal, streamingChunks);
    updateStreamingProgressBar();
  }

  function onStreamingTimeUpdate() {
    const effectiveTime = playbackTimeOffset + (audio ? audio.currentTime : 0);
    updateHighlight(effectiveTime);
    updateStreamingProgressBar();
  }

  function onChunkEnded() {
    const completedChunk = streamingResults[currentChunkIndex];
    if (completedChunk) {
      playbackTimeOffset += completedChunk.duration + SILENCE_DURATION;
    }

    const nextIdx = currentChunkIndex + 1;
    if (nextIdx >= streamingTotal) {
      onPlaybackComplete();
      return;
    }

    // Silence gap scaled by playback speed
    const silenceMs = (SILENCE_DURATION * 1000) / SPEEDS[speedIndex];
    setTimeout(() => {
      if (!cancelGeneration && !isPaused) {
        playChunk(nextIdx);
      }
    }, silenceMs);
  }

  function onPlaybackComplete() {
    if (player) {
      player.querySelector("#kokoro-play-pause").innerHTML = ICONS.play;
    }
    highlightSpans.forEach((s) => {
      s.classList.remove("kokoro-active");
      s.classList.add("kokoro-played");
    });
  }

  function updateStreamingProgressBar() {
    if (!audio || !player) return;
    const effectiveTime = playbackTimeOffset + audio.currentTime;
    const totalDuration = totalEstimatedDuration || 1;
    const pct = Math.min(100, (effectiveTime / totalDuration) * 100);
    player.querySelector("#kokoro-progress-bar").style.width = `${pct}%`;
    const thumb = player.querySelector("#kokoro-progress-thumb");
    if (thumb) thumb.style.left = `${pct}%`;
    player.querySelector("#kokoro-time").textContent =
      `${fmtTime(effectiveTime)} / ${fmtTime(totalDuration)}`;
  }

  function seekToAbsoluteTime(targetTime) {
    if (!streamingResults) return;

    // Find target chunk
    let targetChunkIdx = -1;
    for (let i = 0; i < currentChunkMap.length; i++) {
      if (targetTime >= currentChunkMap[i].start && targetTime < currentChunkMap[i].end) {
        targetChunkIdx = i;
        break;
      }
      // In silence gap — snap to start of next chunk
      if (i < currentChunkMap.length - 1 &&
          targetTime >= currentChunkMap[i].end && targetTime < currentChunkMap[i + 1].start) {
        targetChunkIdx = i + 1;
        targetTime = currentChunkMap[i + 1].start;
        break;
      }
    }

    if (targetChunkIdx === -1) {
      if (currentChunkMap.length > 0 && targetTime >= currentChunkMap[currentChunkMap.length - 1].end) {
        targetChunkIdx = currentChunkMap.length - 1;
      } else {
        targetChunkIdx = 0;
        targetTime = 0;
      }
    }

    // Can't seek to a chunk that hasn't loaded
    if (!streamingResults[targetChunkIdx]) {
      for (let i = targetChunkIdx - 1; i >= 0; i--) {
        if (streamingResults[i]) { targetChunkIdx = i; break; }
      }
      targetTime = currentChunkMap[targetChunkIdx]?.start || 0;
    }

    const withinChunkTime = targetTime - currentChunkMap[targetChunkIdx].start;

    // Recalculate playbackTimeOffset
    let offset = 0;
    for (let i = 0; i < targetChunkIdx; i++) {
      const d = streamingResults[i] ? streamingResults[i].duration : (currentChunkMap[i].end - currentChunkMap[i].start);
      offset += d + SILENCE_DURATION;
    }
    playbackTimeOffset = offset;

    // Same chunk — just seek within
    if (targetChunkIdx === currentChunkIndex && audio) {
      audio.currentTime = Math.min(withinChunkTime, audio.duration || withinChunkTime);
      return;
    }

    // Different chunk — switch
    playChunk(targetChunkIdx);
    if (audio && withinChunkTime > 0) {
      const seekOnce = () => {
        audio.currentTime = Math.min(withinChunkTime, audio.duration);
      };
      audio.addEventListener("loadedmetadata", seekOnce, { once: true });
    }
  }

  function showChunkLoading() {
    if (!player) return;
    const timeEl = player.querySelector("#kokoro-time");
    if (timeEl) timeEl.textContent = "Buffering...";
    player.querySelector("#kokoro-progress-bar")?.classList.add("buffering");
  }

  function hideChunkLoading() {
    if (!player) return;
    player.querySelector("#kokoro-progress-bar")?.classList.remove("buffering");
    updateStreamingProgressBar();
  }

  function stitchForDownload(results, settings) {
    (async () => {
      const SAMPLE_RATE = 24000;
      const silenceBlob = createSilenceWAV(SILENCE_DURATION, SAMPLE_RATE);
      const silencePCM = await extractPCM(silenceBlob);
      const pcmParts = [];
      for (const r of results) {
        if (!r) continue;
        const pcm = await extractPCM(r.blob);
        pcmParts.push(pcm);
        pcmParts.push(silencePCM);
      }
      const fullBlob = buildWAV(pcmParts, SAMPLE_RATE);
      const timestamp = Date.now();
      const domain = location.hostname.replace(/\./g, "_");
      currentFilename = `Autlaut_${timestamp}_${domain}.wav`;
      currentBlob = fullBlob;
    })();
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
    const normalizedFull = fullText.replace(/\s+/g, " ");
    const chunkPositions = chunkMap.map((chunk) => {
      const cleanChunk = chunk.text.trim();
      const idx = fullText.indexOf(cleanChunk, searchStart);
      if (idx >= 0) { searchStart = idx + cleanChunk.length; return { start: idx, end: idx + cleanChunk.length }; }
      // Try whitespace-normalized match
      const normalizedChunk = cleanChunk.replace(/\s+/g, " ");
      const normIdx = normalizedFull.indexOf(normalizedChunk, Math.max(0, searchStart - 50));
      if (normIdx >= 0) { searchStart = normIdx + normalizedChunk.length; return { start: normIdx, end: normIdx + normalizedChunk.length }; }
      const prefix = cleanChunk.slice(0, 40);
      const fuzzyIdx = fullText.indexOf(prefix, Math.max(0, searchStart - 50));
      if (fuzzyIdx >= 0) { searchStart = fuzzyIdx + cleanChunk.length; return { start: fuzzyIdx, end: fuzzyIdx + cleanChunk.length }; }
      return null;
    });

    // Build initial node ranges
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

    // Phase 1: Collect all wrap tasks (no DOM mutation yet)
    let nodeRanges = buildNodeRanges();
    const wrapTasks = [];
    chunkPositions.forEach((pos, chunkIdx) => {
      if (!pos) return;
      for (const nr of nodeRanges) {
        const overlapStart = Math.max(pos.start, nr.start);
        const overlapEnd = Math.min(pos.end, nr.end);
        if (overlapStart >= overlapEnd) continue;
        wrapTasks.push({ chunkIdx, absStart: overlapStart, absEnd: overlapEnd });
      }
    });

    // Phase 2: Execute wraps front-to-back with incremental nodeRange updates
    wrapTasks.sort((a, b) => a.absStart - b.absStart);
    nodeRanges = buildNodeRanges();

    for (const task of wrapTasks) {
      // Find the node range containing this task's text
      const nrIdx = nodeRanges.findIndex((nr) => task.absStart >= nr.start && task.absEnd <= nr.end);
      if (nrIdx === -1) continue;
      const nr = nodeRanges[nrIdx];
      const localStart = task.absStart - nr.start;
      const localEnd = task.absEnd - nr.start;
      try {
        const range = document.createRange();
        range.setStart(nr.node, localStart);
        range.setEnd(nr.node, localEnd);
        const span = document.createElement("span");
        span.className = "kokoro-chunk";
        span.dataset.chunkIdx = task.chunkIdx;
        range.surroundContents(span);
        highlightSpans.push(span);
        // Incrementally update nodeRanges after the split
        const replacements = [];
        if (localStart > 0) {
          replacements.push({ node: nr.node, start: nr.start, end: nr.start + localStart });
        }
        // Skip the span's inner text node (it's wrapped)
        if (localEnd < nr.end - nr.start) {
          const suffix = span.nextSibling;
          if (suffix && suffix.nodeType === Node.TEXT_NODE) {
            replacements.push({ node: suffix, start: nr.start + localEnd, end: nr.end });
          }
        }
        nodeRanges.splice(nrIdx, 1, ...replacements);
      } catch { /* cross-element boundary — skip */ }
    }
  }

  function clearHighlights() {
    const parents = new Set();
    highlightSpans.forEach((span) => {
      const parent = span.parentNode;
      if (parent) {
        while (span.firstChild) parent.insertBefore(span.firstChild, span);
        parent.removeChild(span);
        parents.add(parent);
      }
    });
    parents.forEach((p) => p.normalize());
    highlightSpans = [];
    currentChunkMap = [];
  }

  function updateHighlight(currentTime) {
    let activeIdx = -1;
    for (let i = 0; i < currentChunkMap.length; i++) {
      if (currentTime >= currentChunkMap[i].start && currentTime < currentChunkMap[i].end) { activeIdx = i; break; }
    }
    // Bridge silence gaps: keep previous chunk highlighted until next starts
    if (activeIdx === -1) {
      for (let i = 0; i < currentChunkMap.length - 1; i++) {
        if (currentTime >= currentChunkMap[i].end && currentTime < currentChunkMap[i + 1].start) { activeIdx = i; break; }
      }
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
      <div id="kokoro-progress-wrap"><div id="kokoro-progress-bar"></div><div id="kokoro-progress-thumb"></div></div>
      <div id="kokoro-controls">
        <button id="kokoro-back" title="Back 10s" aria-label="Back 10 seconds">${ICONS.back10}</button>
        <button id="kokoro-play-pause" title="Play/Pause" aria-label="Play or pause">${ICONS.pause}</button>
        <button id="kokoro-fwd" title="Forward 10s" aria-label="Forward 10 seconds">${ICONS.fwd10}</button>
        <span id="kokoro-time">0:00 / 0:00</span>
        <span id="kokoro-title"></span>
        <button id="kokoro-download" title="Download audio" aria-label="Download audio">${ICONS.download}</button>
        <div id="kokoro-volume-group">
          <button id="kokoro-volume-btn" title="Volume" aria-label="Volume">${volumeLevel === 0 ? ICONS.volumeMute : volumeLevel < 0.5 ? ICONS.volumeLow : ICONS.volumeHigh}</button>
          <input id="kokoro-volume-slider" type="range" min="0" max="100" value="${Math.round(volumeLevel * 100)}" aria-label="Volume" />
        </div>
        <button id="kokoro-speed-btn" title="Playback speed" aria-label="Playback speed">${SPEEDS[speedIndex]}x</button>
        <button id="kokoro-help-btn" title="Keyboard shortcuts" aria-label="Keyboard shortcuts">?</button>
        <button id="kokoro-close" title="Close" aria-label="Close player">${ICONS.close}</button>
      </div>
      <div id="kokoro-shortcuts-popover" role="tooltip" aria-hidden="true">
        <div class="kokoro-popover-title">Keyboard Shortcuts</div>
        <div class="kokoro-popover-row"><kbd>Space</kbd> Play / Pause</div>
        <div class="kokoro-popover-row"><kbd>&#8592;</kbd> Rewind 5s</div>
        <div class="kokoro-popover-row"><kbd>&#8594;</kbd> Forward 5s</div>
      </div>`;
    document.body.appendChild(player);
    player.querySelector("#kokoro-play-pause").addEventListener("click", togglePlayPause);
    player.querySelector("#kokoro-back").addEventListener("click", () => seekRelative(-10));
    player.querySelector("#kokoro-fwd").addEventListener("click", () => seekRelative(10));
    player.querySelector("#kokoro-speed-btn").addEventListener("click", cycleSpeed);
    player.querySelector("#kokoro-close").addEventListener("click", closePlayer);
    player.querySelector("#kokoro-progress-wrap").addEventListener("mousedown", onSeekStart);
    player.querySelector("#kokoro-download").addEventListener("click", () => {
      if (currentBlob) {
        saveBlob(currentBlob, currentFilename);
      } else if (!allChunksComplete) {
        showError("Download available after all chunks finish loading");
      }
    });
    player.querySelector("#kokoro-volume-btn").addEventListener("click", () => {
      player.querySelector("#kokoro-volume-group").classList.toggle("expanded");
    });
    player.querySelector("#kokoro-volume-slider").addEventListener("input", (e) => {
      volumeLevel = e.target.value / 100;
      if (audio) audio.volume = volumeLevel;
      updateVolumeIcon();
      clearTimeout(volumeSaveTimer);
      volumeSaveTimer = setTimeout(() => {
        chrome.runtime.sendMessage({ action: "save-setting", key: "volume", value: volumeLevel });
      }, 300);
    });
    player.querySelector("#kokoro-help-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      const popover = player.querySelector("#kokoro-shortcuts-popover");
      const isVisible = popover.classList.toggle("visible");
      popover.setAttribute("aria-hidden", !isVisible);
    });
    return player;
  }

  // playAudio is no longer used — replaced by startStreamingPlayback + playChunk

  function togglePlayPause() {
    if (!audio) return;
    const btn = player.querySelector("#kokoro-play-pause");
    if (audio.paused) {
      isPaused = false;
      audio.play();
      btn.innerHTML = ICONS.pause;
    } else {
      isPaused = true;
      audio.pause();
      btn.innerHTML = ICONS.play;
    }
  }

  function seekRelative(s) {
    if (!audio) return;
    if (streamingResults) {
      const effectiveTime = playbackTimeOffset + audio.currentTime;
      const targetTime = Math.max(0, Math.min(totalEstimatedDuration, effectiveTime + s));
      seekToAbsoluteTime(targetTime);
    } else {
      audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + s));
    }
  }

  function onSeekStart(e) {
    if (!audio || (!audio.duration && !streamingResults)) return;
    e.preventDefault();
    isSeeking = true;
    player.querySelector("#kokoro-progress-wrap").classList.add("seeking");
    seekToPosition(e);
    document.addEventListener("mousemove", onSeekMove);
    document.addEventListener("mouseup", onSeekEnd);
  }

  function onSeekMove(e) {
    if (!isSeeking) return;
    seekToPosition(e);
  }

  function onSeekEnd() {
    if (!isSeeking) return;
    isSeeking = false;
    player?.querySelector("#kokoro-progress-wrap")?.classList.remove("seeking");
    document.removeEventListener("mousemove", onSeekMove);
    document.removeEventListener("mouseup", onSeekEnd);
  }

  function seekToPosition(e) {
    if (!player) return;
    const wrap = player.querySelector("#kokoro-progress-wrap");
    const rect = wrap.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    if (streamingResults) {
      seekToAbsoluteTime(ratio * totalEstimatedDuration);
    } else if (audio && audio.duration) {
      audio.currentTime = ratio * audio.duration;
    }
  }

  function cycleSpeed() {
    speedIndex = (speedIndex + 1) % SPEEDS.length;
    if (audio) audio.playbackRate = SPEEDS[speedIndex];
    player.querySelector("#kokoro-speed-btn").textContent = `${SPEEDS[speedIndex]}x`;
    chrome.runtime.sendMessage({ action: "save-setting", key: "playbackSpeed", value: SPEEDS[speedIndex] });
  }

  function updateVolumeIcon() {
    if (!player) return;
    const btn = player.querySelector("#kokoro-volume-btn");
    if (btn) btn.innerHTML = volumeLevel === 0 ? ICONS.volumeMute : volumeLevel < 0.5 ? ICONS.volumeLow : ICONS.volumeHigh;
  }

  function updateProgressBar() {
    if (!audio || !player) return;
    const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
    player.querySelector("#kokoro-progress-bar").style.width = `${pct}%`;
    const thumb = player.querySelector("#kokoro-progress-thumb");
    if (thumb) thumb.style.left = `${pct}%`;
    player.querySelector("#kokoro-time").textContent =
      `${fmtTime(audio.currentTime)} / ${fmtTime(audio.duration || 0)}`;
  }

  function fmtTime(s) {
    if (isNaN(s)) return "0:00";
    const m = Math.floor(s / 60);
    return `${m}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
  }

  function closePlayer() {
    cancelGeneration = true;

    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio = null;
    }

    // Revoke all chunk blob URLs
    if (chunkBlobUrls) {
      chunkBlobUrls.forEach((url) => { if (url) URL.revokeObjectURL(url); });
      chunkBlobUrls = [];
    }

    // Reset streaming state
    streamingResults = null;
    streamingChunks = null;
    streamingTotal = 0;
    currentChunkIndex = 0;
    playbackTimeOffset = 0;
    totalEstimatedDuration = 0;
    allChunksComplete = false;
    isPaused = false;
    isWaitingForChunk = false;

    if (player) {
      const closingPlayer = player;
      player = null;
      closingPlayer.classList.remove("visible");
      setTimeout(() => closingPlayer.remove(), 300);
    }
    // Clean up any in-progress seek listeners on document
    document.removeEventListener("mousemove", onSeekMove);
    document.removeEventListener("mouseup", onSeekEnd);
    isSeeking = false;
    clearTimeout(volumeSaveTimer);
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
    else if (e.code === "Escape") {
      const popover = player?.querySelector("#kokoro-shortcuts-popover");
      if (popover) { popover.classList.remove("visible"); popover.setAttribute("aria-hidden", "true"); }
    }
  });

  document.addEventListener("click", (e) => {
    if (!player) return;
    if (!e.target.closest("#kokoro-shortcuts-popover") && !e.target.closest("#kokoro-help-btn")) {
      const popover = player.querySelector("#kokoro-shortcuts-popover");
      if (popover) { popover.classList.remove("visible"); popover.setAttribute("aria-hidden", "true"); }
    }
  });
})();
