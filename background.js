// ============================================================
// Auto Flow - Chrome/Chromium Version (Background Service Worker)
// Uses DOM automation + Chrome DevTools Protocol (CDP) for trusted actions.
// ============================================================

let stopRequested = false;

// ---- Open Side Panel when extension icon is clicked ----

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ---- Download filename enforcement ----
// Chrome ignores the `filename` param for blob URL downloads.
// This listener intercepts the download and forces the correct filename & conflictAction.
const pendingFilenames = new Map();

chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  const pending = pendingFilenames.get(downloadItem.url);
  if (pending) {
    pendingFilenames.delete(downloadItem.url);
    const filename = typeof pending === "string" ? pending : pending.filename;
    const conflictAction = (typeof pending === "object" && pending.conflictAction) ? pending.conflictAction : "overwrite";
    suggest({ filename, conflictAction });
  }
});

// ---- Utilities ----

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sanitizeFilename(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 40) || "image";
}

function isFlowUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host === "flow.google.com" || host.endsWith(".flow.google.com")) return true;
    if (host.endsWith("labs.google") && (parsed.pathname.includes("/flow") || parsed.hash.includes("/flow"))) return true;
    return false;
  } catch {
    return false;
  }
}

// ---- Send progress to side panel ----

function broadcast(type, data) {
  chrome.runtime.sendMessage({ type, ...data }).catch(() => {});
}

// ---- Find the active Flow tab ----

async function findFlowTab() {
  const patterns = [
    "https://labs.google/fx/tools/flow/*",
    "https://labs.google/fx/*/tools/flow/*",
    "https://flow.google.com/*"
  ];
  const allTabs = [];
  for (const pattern of patterns) {
    allTabs.push(...(await chrome.tabs.query({ url: pattern })));
  }
  const unique = [...new Map(allTabs.map(t => [t.id, t])).values()];
  unique.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return unique[0] || null;
}

// ---- Get project ID from the Flow URL ----

function extractProjectIdFromUrl(url) {
  if (!url) return null;
  const match = url.match(/projects?\/([a-zA-Z0-9_-]+)/i) || 
                url.match(/[?&]project(?:Id)?=([a-zA-Z0-9_-]+)/i);
  return match ? match[1] : null;
}

async function getProjectId(tab) {
  if (tab?.url) {
    const fromUrl = extractProjectIdFromUrl(tab.url);
    if (fromUrl) return fromUrl;
  }
  const tabId = typeof tab === "object" ? tab.id : tab;
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      const match = window.location.href.match(/projects?\/([a-zA-Z0-9_-]+)/i) ||
                    window.location.href.match(/[?&]project(?:Id)?=([a-zA-Z0-9_-]+)/i);
      return match ? match[1] : null;
    }
  }).catch(() => null);

  return result?.[0]?.result || null;
}

// ---- CDP Trusted Click Helper (bypasses bot-detection with genuine hardware click) ----

async function cdpClick(tabId, x, y) {
  const target = { tabId };
  let attached = false;
  try {
    await chrome.debugger.attach(target, '1.3');
    attached = true;
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', clickCount: 1
    });
    await sleep(80);
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', clickCount: 1
    });
    return true;
  } catch (err) {
    console.warn("CDP click failed, falling back:", err);
    return false;
  } finally {
    if (attached) {
      try { await chrome.debugger.detach(target); } catch (_) {}
    }
  }
}

// ---- Canvas Image Extraction & DOM Automation ----

async function getAllCanvasImages(tabId) {
  const res = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      return Array.from(document.querySelectorAll('flow-tile-container img, flow-image-tile img, flow-grid-tile-container img, img'))
        .map(i => i.src)
        .filter(src => src && (src.includes('flow.google.com') || src.includes('google') || src.startsWith('blob:') || src.startsWith('data:')));
    }
  }).catch(() => null);
  return res?.[0]?.result || [];
}

async function scrollTileIntoView(tabId, imgSrc) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (src) => {
      const imgEl = Array.from(document.querySelectorAll('img')).find(img => img.src === src);
      const tile = imgEl?.closest('flow-tile-container, flow-grid-tile-container') || imgEl;
      tile?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    },
    args: [imgSrc]
  }).catch(() => {});
}

async function checkFlowErrors(tabId) {
  const res = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      const toasts = Array.from(document.querySelectorAll('[role="alert"], .mat-mdc-snack-bar-container, mat-snack-bar-container'))
        .filter(el => el.offsetParent !== null)
        .map(el => (el.innerText || '').toLowerCase().trim()).filter(Boolean);
      const rl = toasts.find(t => /rate limit|too many|try again later|quota|limit reached/.test(t));
      if (rl) return { fatal: true, message: 'Rate limited: ' + rl.substring(0, 160) };
      const bl = toasts.find(t => /unusual activity/.test(t));
      if (bl) return { fatal: true, message: 'Account blocked: ' + bl.substring(0, 160) };
      return null;
    }
  }).catch(() => null);
  return res?.[0]?.result || null;
}

async function submitPrompt(tabId, promptText) {
  const prepResult = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (prompt) => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));

      function getPromptBox() {
        const boxes = Array.from(document.querySelectorAll('.base-prompt-box, flow-prompt-box, .prompt-box-container'));
        return boxes.find(el => el.offsetParent !== null && el.getClientRects().length > 0) || boxes[0] || null;
      }

      function getEditor(box) {
        box = box || getPromptBox();
        return box?.querySelector('flow-rich-text-editor .ProseMirror[contenteditable="true"]') ||
               box?.querySelector('.ProseMirror[contenteditable="true"]') ||
               document.querySelector('.ProseMirror[contenteditable="true"]') || null;
      }

      function getGenBtn(box) {
        const icons = Array.from(document.querySelectorAll('mat-icon, i.google-symbols, i'));
        const arrowBtn = icons.find(el => (el.textContent || '').trim() === 'arrow_forward')?.closest('button');
        if (arrowBtn && arrowBtn.offsetParent !== null) return arrowBtn;

        box = box || getPromptBox();
        return document.querySelector('button.generate-icon-button') ||
               box?.querySelector('button[aria-label="Start generation"]') ||
               box?.querySelector('flow-generate-icon-button button[type="submit"]') ||
               document.querySelector('button[aria-label="Start generation"]') ||
               document.querySelector('flow-generate-icon-button button') || null;
      }

      function isOff(btn) {
        return !btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true' ||
               btn.classList.contains('mat-mdc-button-disabled');
      }

      const ed = getEditor();
      if (!ed) return { success: false, fatalError: 'Prompt editor not found — is a Flow project open?' };

      ed.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      document.execCommand('insertText', false, prompt);
      ed.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(500);

      let btn = null;
      for (let k = 0; k < 25; k++) {
        btn = getGenBtn();
        if (btn && !isOff(btn)) break;
        await sleep(200);
      }

      if (!btn || isOff(btn)) {
        return { success: false, error: 'Generate button remained disabled' };
      }

      btn.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      await sleep(50);
      const rect = btn.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);

      return { success: true, coords: { x, y } };
    },
    args: [promptText]
  }).catch(() => null);

  const prep = prepResult?.[0]?.result;
  if (!prep) throw new Error("Flow tab lost — is it still open?");
  if (!prep.success) {
    if (prep.fatalError) throw new Error(prep.fatalError);
    return prep;
  }

  const cdpOk = await cdpClick(tabId, prep.coords.x, prep.coords.y);
  if (!cdpOk) {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        const icons = Array.from(document.querySelectorAll('mat-icon, i.google-symbols, i'));
        const btn = icons.find(el => (el.textContent || '').trim() === 'arrow_forward')?.closest('button') ||
                    document.querySelector('button[aria-label="Start generation"]');
        if (btn) {
          const opts = { bubbles: true, cancelable: true, composed: true };
          btn.dispatchEvent(new PointerEvent('pointerdown', opts));
          btn.dispatchEvent(new MouseEvent('mousedown', opts));
          btn.dispatchEvent(new PointerEvent('pointerup', opts));
          btn.dispatchEvent(new MouseEvent('mouseup', opts));
          btn.click();
        }
      }
    }).catch(() => {});
  }

  return { success: true };
}

// ---- Download an image with optional PNG conversion ----

async function downloadImage(tabId, imageUrl, filename, conflictAction = "overwrite", format = "jpeg") {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (url, fmt) => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      let retries = 3;
      let delay = 2000;

      for (let attempt = 0; attempt < retries; attempt++) {
        try {
          const response = await fetch(url);
          if (response.status === 429) {
            if (attempt < retries - 1) { await wait(delay); delay *= 2; continue; }
            throw new Error("Rate limit exceeded after retries");
          }
          if (!response.ok) throw new Error("HTTP " + response.status);
          const rawBlob = await response.blob();

          if (fmt === "png") {
            const bmp = await createImageBitmap(rawBlob);
            const canvas = new OffscreenCanvas(bmp.width, bmp.height);
            const ctx = canvas.getContext("2d");
            ctx.drawImage(bmp, 0, 0);
            const pngBlob = await canvas.convertToBlob({ type: "image/png" });
            return { blobUrl: URL.createObjectURL(pngBlob), size: pngBlob.size };
          }
          return { blobUrl: URL.createObjectURL(rawBlob), size: rawBlob.size };
        } catch (e) {
          if (attempt === retries - 1) return { error: e.message };
          await wait(delay);
          delay *= 2;
        }
      }
    },
    args: [imageUrl, format]
  }).catch(() => null);

  const imgResult = result?.[0]?.result;
  if (!imgResult?.blobUrl) {
    throw new Error("Download failed: " + (imgResult?.error || "unknown"));
  }

  const effectiveConflict = (conflictAction === "prompt") ? "uniquify" : (conflictAction || "overwrite");
  pendingFilenames.set(imgResult.blobUrl, { filename, conflictAction: effectiveConflict });

  await new Promise((resolve, reject) => {
    chrome.downloads.download({
      url: imgResult.blobUrl,
      filename: filename,
      saveAs: (conflictAction === "prompt"),
      conflictAction: effectiveConflict
    }, (downloadId) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(downloadId);
    });
  });

  setTimeout(() => {
    chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (url) => URL.revokeObjectURL(url),
      args: [imgResult.blobUrl]
    }).catch(() => {});
  }, 15000);
}

// ---- Manifest Helpers ----

function buildManifest(prompts, settings) {
  const startIndex = parseInt(settings?.startIndex || "1", 10) || 1;
  const endIndex = parseInt(settings?.endIndex || "", 10) || prompts.length;

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    settings,
    prompts: prompts.map((prompt, i) => {
      const absoluteLineNum = i + 1;
      const inRange = absoluteLineNum >= startIndex && absoluteLineNum <= endIndex;
      return {
        imageNum: absoluteLineNum,
        prompt,
        status: inRange ? "pending" : "skipped"
      };
    })
  };
}

function saveManifest(manifest) {
  chrome.storage.local.set({ manifest });
}

function applyVariables(prompt, variables) {
  if (!variables || Object.keys(variables).length === 0) return prompt;
  let result = prompt;
  for (const [key, value] of Object.entries(variables)) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\[${escapedKey}\\]`, 'gi');
    result = result.replace(regex, value);
  }
  return result;
}

function parseVariables(variablesText) {
  const variables = {};
  if (variablesText && variablesText.trim() !== "") {
    const lines = variablesText.split("\n");
    for (const line of lines) {
      const match = line.match(/^\[(.*?)\]\s*=\s*(.*)$/);
      if (match) {
        variables[match[1].trim().toLowerCase()] = match[2].trim();
      }
    }
  }
  return variables;
}

function getFilename(imageNum, prompt, settings) {
  const folder = sanitizeFilename(settings?.folder || "Flow_Images");
  const num = String(imageNum).padStart(3, "0");
  const ext = (settings?.format === "png") ? "png" : "jpg";

  if (settings?.fileNaming === "prompt") {
    const promptSlug = sanitizeFilename(prompt).substring(0, 30);
    return `${folder}/${num}-${promptSlug}.${ext}`;
  }
  return `${folder}/${num}.${ext}`;
}

// ---- Processing Engine (Supports Sequential and Concurrent Batch Modes) ----

async function processEntries(entries, manifest, settings, logPrefix = "") {
  const tab = await findFlowTab();
  if (!tab) {
    broadcast("BATCH_ERROR", { message: "Flow tab not found. Make sure labs.google/fx/tools/flow is open." });
    return;
  }

  const projectId = await getProjectId(tab);
  if (!projectId) {
    broadcast("BATCH_ERROR", { message: "No active project found in Flow URL. Open a project first." });
    return;
  }

  const variables = parseVariables(settings?.variablesText);
  const delaySec = parseInt(settings?.delaySec, 10) || 2;
  const batchSize = Math.max(1, parseInt(settings?.batchSize, 10) || 1);
  const conflictAction = settings?.conflictAction || "overwrite";
  const format = settings?.format || "jpeg";
  const total = manifest.prompts.length;
  let completed = 0;

  broadcast("BATCH_STARTED", { total });

  // Snapshot initial images currently on canvas
  const knownImages = new Set(await getAllCanvasImages(tab.id));

  if (batchSize <= 1) {
    // ---- Sequential Mode ----
    for (let i = 0; i < entries.length; i++) {
      if (stopRequested) {
        broadcast("BATCH_PROGRESS", { index: i, total, status: "stopped", message: "Stopped by user." });
        for (let j = i; j < entries.length; j++) {
          if (entries[j].status !== "done") entries[j].status = "pending";
        }
        saveManifest(manifest);
        break;
      }

      const entry = entries[i];
      const prompt = applyVariables(entry.prompt, variables);
      const label = logPrefix ? `[${logPrefix} #${entry.imageNum}]` : `[#${entry.imageNum}/${total}]`;
      const promptPreview = prompt.substring(0, 50) + (prompt.length > 50 ? "…" : "");

      broadcast("BATCH_PROGRESS", {
        index: entry.imageNum - 1, total, status: "generating",
        message: `${label} Submitting: "${promptPreview}"`
      });

      try {
        const submitRes = await submitPrompt(tab.id, prompt);
        if (!submitRes.success) throw new Error(submitRes.error || "Submission failed");

        // Wait for newly generated image on canvas (up to 120s)
        const deadline = Date.now() + 120 * 1000;
        let imageUrl = null;
        while (Date.now() < deadline) {
          if (stopRequested) break;
          await sleep(500);

          const err = await checkFlowErrors(tab.id);
          if (err?.fatal) throw new Error(err.message);

          const currentImages = await getAllCanvasImages(tab.id);
          const newImg = currentImages.find(src => !knownImages.has(src));
          if (newImg) {
            imageUrl = newImg;
            knownImages.add(newImg);
            await scrollTileIntoView(tab.id, imageUrl);
            break;
          }
        }

        if (!imageUrl) {
          if (stopRequested) break;
          throw new Error("Generation timed out after 120s");
        }

        broadcast("BATCH_PROGRESS", {
          index: entry.imageNum - 1, total, status: "downloading",
          message: `${label} Downloading...`
        });

        const filename = getFilename(entry.imageNum, prompt, settings);
        try {
          await downloadImage(tab.id, imageUrl, filename, conflictAction, format);
          completed++;
          entry.status = "done";
          delete entry.error;
          broadcast("BATCH_PROGRESS", {
            index: entry.imageNum - 1, total, status: "done",
            message: `${label} ✅ Saved: ${filename}`
          });
        } catch (dlErr) {
          entry.status = "failed";
          entry.error = "Download failed: " + dlErr.message;
          broadcast("BATCH_PROGRESS", {
            index: entry.imageNum - 1, total, status: "failed",
            message: `${label} ❌ ${entry.error}`
          });
        }
        saveManifest(manifest);

        if (i < entries.length - 1 && !stopRequested) {
          broadcast("BATCH_PROGRESS", {
            index: entry.imageNum - 1, total, status: "waiting",
            message: `Waiting ${delaySec}s before next prompt...`
          });
          await sleep(delaySec * 1000);
        }

      } catch (err) {
        entry.status = "failed";
        entry.error = err.message;
        saveManifest(manifest);
        broadcast("BATCH_PROGRESS", {
          index: entry.imageNum - 1, total, status: "failed",
          message: `${label} ❌ ${err.message}`
        });

        const isFatal = /quota|auth|blocked|rate limit|403|unusual activity/i.test(err.message);
        if (isFatal) {
          broadcast("BATCH_ERROR", { message: "⛔ Fatal: " + err.message });
          for (let j = i + 1; j < entries.length; j++) {
            if (entries[j].status !== "done") entries[j].status = "pending";
          }
          saveManifest(manifest);
          break;
        }

        if (i < entries.length - 1 && !stopRequested) {
          await sleep(delaySec * 1000);
        }
      }
    }
  } else {
    // ---- Pipelined Concurrent Batch Mode (batchSize > 1) ----
    const inFlight = [];
    let nextIndex = 0;

    while ((nextIndex < entries.length || inFlight.length > 0) && !stopRequested) {
      // Dispatch prompts up to batchSize with 2s safe spacing
      while (inFlight.length < batchSize && nextIndex < entries.length && !stopRequested) {
        const entry = entries[nextIndex++];
        const prompt = applyVariables(entry.prompt, variables);
        const label = logPrefix ? `[${logPrefix} #${entry.imageNum}]` : `[#${entry.imageNum}/${total}]`;
        const promptPreview = prompt.substring(0, 50) + (prompt.length > 50 ? "…" : "");

        broadcast("BATCH_PROGRESS", {
          index: entry.imageNum - 1, total, status: "generating",
          message: `${label} Submitting: "${promptPreview}"`
        });

        try {
          const submitRes = await submitPrompt(tab.id, prompt);
          if (!submitRes.success) throw new Error(submitRes.error || "Submission failed");
          inFlight.push({ entry, prompt, label, startTime: Date.now() });
          broadcast("BATCH_PROGRESS", {
            index: entry.imageNum - 1, total, status: "generating",
            message: `${label} Generating on canvas...`
          });
          // Spacing delay between entries so the prompt box is cleared and ready
          await sleep(2000);
        } catch (subErr) {
          entry.status = "failed";
          entry.error = subErr.message;
          saveManifest(manifest);
          broadcast("BATCH_PROGRESS", {
            index: entry.imageNum - 1, total, status: "failed",
            message: `${label} ❌ ${subErr.message}`
          });
        }
      }

      if (inFlight.length === 0 && nextIndex >= entries.length) break;

      await sleep(500);

      // Check for errors
      const err = await checkFlowErrors(tab.id);
      if (err?.fatal) {
        broadcast("BATCH_ERROR", { message: "⛔ Fatal: " + err.message });
        for (const job of inFlight) {
          job.entry.status = "failed";
          job.entry.error = err.message;
        }
        for (let j = nextIndex; j < entries.length; j++) {
          if (entries[j].status !== "done") entries[j].status = "pending";
        }
        saveManifest(manifest);
        break;
      }

      // Harvest newly generated images from canvas
      const currentImages = await getAllCanvasImages(tab.id);
      for (const src of currentImages) {
        if (!knownImages.has(src) && inFlight.length > 0) {
          knownImages.add(src);
          const job = inFlight.shift();
          await scrollTileIntoView(tab.id, src);

          broadcast("BATCH_PROGRESS", {
            index: job.entry.imageNum - 1, total, status: "downloading",
            message: `${job.label} Downloading...`
          });
          const filename = getFilename(job.entry.imageNum, job.prompt, settings);

          try {
            await downloadImage(tab.id, src, filename, conflictAction, format);
            completed++;
            job.entry.status = "done";
            delete job.entry.error;
            broadcast("BATCH_PROGRESS", {
              index: job.entry.imageNum - 1, total, status: "done",
              message: `${job.label} ✅ Saved: ${filename}`
            });
          } catch (dlErr) {
            job.entry.status = "failed";
            job.entry.error = "Download failed: " + dlErr.message;
            broadcast("BATCH_PROGRESS", {
              index: job.entry.imageNum - 1, total, status: "failed",
              message: `${job.label} ❌ ${job.entry.error}`
            });
          }
          saveManifest(manifest);
        }
      }

      // Check timeouts for in-flight jobs (>120s)
      const now = Date.now();
      while (inFlight.length > 0 && now - inFlight[0].startTime > 120 * 1000) {
        const timedOut = inFlight.shift();
        timedOut.entry.status = "failed";
        timedOut.entry.error = "Generation timed out after 120s";
        broadcast("BATCH_PROGRESS", {
          index: timedOut.entry.imageNum - 1, total, status: "failed",
          message: `${timedOut.label} ❌ Timed out after 120s`
        });
        saveManifest(manifest);
      }
    }

    if (stopRequested) {
      for (let j = nextIndex; j < entries.length; j++) {
        if (entries[j].status !== "done") entries[j].status = "pending";
      }
      saveManifest(manifest);
    }
  }

  const doneCount = manifest.prompts.filter(p => p.status === "done").length;
  const failedEntries = manifest.prompts.filter(p => p.status === "failed");
  const pendingEntries = manifest.prompts.filter(p => p.status === "pending");
  const failedNums = failedEntries.map(f => f.imageNum);
  const pendingNums = pendingEntries.map(p => p.imageNum);

  broadcast("BATCH_COMPLETE", {
    total: manifest.prompts.length,
    completed: doneCount,
    doneCount,
    failed: failedEntries.length,
    pending: pendingEntries.length,
    failedNums,
    pendingNums
  });

  if (failedEntries.length === 0 && pendingEntries.length === 0) {
    chrome.storage.local.remove(['manifest']);
  }
}

// ---- Run Batch ----

async function runBatch(config) {
  stopRequested = false;
  const { prompts, settings } = config;

  let manifest;
  if (config.manifest) {
    manifest = config.manifest;
    manifest.settings = { ...manifest.settings, ...settings };

    const startIndex = parseInt(settings?.startIndex || "1", 10) || 1;
    const endIndex = parseInt(settings?.endIndex || "", 10) || manifest.prompts.length;

    manifest.prompts = manifest.prompts.map((p) => {
      const inRange = p.imageNum >= startIndex && p.imageNum <= endIndex;
      if (inRange) {
        if (p.status !== "done") {
          p.status = "pending";
        }
      } else {
        if (p.status !== "done") {
          p.status = "skipped";
        }
      }
      return p;
    });

    saveManifest(manifest);
  } else {
    manifest = buildManifest(prompts, settings);
    saveManifest(manifest);
  }

  const pendingEntries = manifest.prompts.filter(p => p.status === "pending");
  if (pendingEntries.length === 0) {
    const doneCount = manifest.prompts.filter(p => p.status === "done").length;
    broadcast("BATCH_COMPLETE", {
      total: manifest.prompts.length,
      completed: doneCount,
      doneCount,
      failed: 0,
      pending: 0,
      failedNums: [],
      pendingNums: []
    });
    return;
  }

  await processEntries(pendingEntries, manifest, settings);
}

// ---- Retry Failed ----

async function retryFailed(manifest) {
  stopRequested = false;

  const failedEntries = manifest.prompts.filter(p => p.status === "failed");
  failedEntries.forEach(p => {
    p.status = "pending";
    delete p.error;
  });
  saveManifest(manifest);

  await processEntries(failedEntries, manifest, manifest.settings, "Retry");
}

// ---- Message listener ----

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "RUN_BATCH") {
    runBatch(message).catch(err => {
      broadcast("BATCH_ERROR", { message: "Fatal error: " + err.message });
    });
    return false;
  }

  if (message.type === "STOP_BATCH") {
    stopRequested = true;
    return false;
  }

  if (message.type === "RETRY_FAILED") {
    chrome.storage.local.get(['manifest'], (data) => {
      if (!data.manifest) {
        broadcast("BATCH_ERROR", { message: "No manifest found. Nothing to retry." });
        return;
      }
      if (message.settings) {
        data.manifest.settings = { ...data.manifest.settings, ...message.settings };
        saveManifest(data.manifest);
      }
      retryFailed(data.manifest).catch(err => {
        broadcast("BATCH_ERROR", { message: "Fatal error during retry: " + err.message });
      });
    });
    return false;
  }

  if (message.type === "REGENERATE_SELECTED") {
    sendResponse({ ok: true });
    chrome.storage.local.get(['manifest'], (data) => {
      if (!data.manifest) return;
      const manifest = data.manifest;

      if (message.settings) {
        manifest.settings = { ...manifest.settings, ...message.settings };
      }

      const nums = new Set(message.nums);
      manifest.prompts.forEach(p => {
        if (nums.has(p.imageNum)) {
          p.status = "pending";
          delete p.error;
        }
      });
      saveManifest(manifest);

      stopRequested = false;
      const pendingEntries = manifest.prompts.filter(p => nums.has(p.imageNum));
      processEntries(pendingEntries, manifest, manifest.settings, "Regenerate").catch(err => {
        broadcast("BATCH_ERROR", { message: "Fatal error: " + err.message });
      });
    });
    return false;
  }

  if (message.type === "CHECK_CONNECTION") {
    (async () => {
      try {
        const tab = await findFlowTab();
        if (!tab) return sendResponse({ connected: false, reason: "No Flow tab open. Open labs.google/fx/tools/flow first!" });
        const projectId = await getProjectId(tab);
        if (!projectId) return sendResponse({ connected: false, reason: "Flow tab found, but no project opened. Open or create a project!" });
        sendResponse({ connected: true, tabId: tab.id, projectId });
      } catch (e) {
        sendResponse({ connected: false, reason: e.message });
      }
    })();
    return true; // Keep channel open for async response
  }

  return false;
});

// ---- Listen for tab changes to notify side panel ----

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" || changeInfo.url) {
    if (isFlowUrl(tab.url)) {
      broadcast("CONNECTION_CHANGED", {});
    }
  }
});

chrome.tabs.onActivated.addListener(() => {
  broadcast("CONNECTION_CHANGED", {});
});
