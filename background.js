// ============================================================
// Auto Flow - Chrome/Chromium Version (Background Service Worker)
// Uses DOM automation (typing + clicking) to interact with Flow.
// ============================================================

let stopRequested = false;

// ---- Open Side Panel when extension icon is clicked ----

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ---- Download filename enforcement ----
// Chrome ignores the `filename` param for blob URL downloads.
// This listener intercepts the download and forces the correct filename.
const pendingFilenames = new Map();

chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  const desiredName = pendingFilenames.get(downloadItem.url);
  if (desiredName) {
    pendingFilenames.delete(downloadItem.url);
    suggest({ filename: desiredName, conflictAction: "uniquify" });
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

async function getProjectId(tabId) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      const match = window.location.href.match(/project\/([a-f0-9-]+)/);
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

// ---- Generate a single image via DOM automation + CDP ----

async function generateSingleImage(tabId, promptText, timeoutMs = 2 * 60 * 1000) {
  // 1. Prepare editor, type prompt, and calculate button screen coordinates
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

      function getAllImages() {
        return Array.from(document.querySelectorAll('flow-tile-container img, flow-image-tile img, flow-grid-tile-container img, img'))
          .map(i => i.src)
          .filter(src => src && (src.includes('flow.google.com') || src.includes('google') || src.startsWith('blob:') || src.startsWith('data:')));
      }

      const ed = getEditor();
      if (!ed) return { success: false, fatalError: 'Prompt editor not found — is a Flow project open?' };

      const existingImages = getAllImages();

      // Type prompt using verified execCommand method
      ed.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      document.execCommand('insertText', false, prompt);
      ed.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(600);

      // Verify button is enabled
      let btn = null;
      for (let k = 0; k < 25; k++) {
        btn = getGenBtn();
        if (btn && !isOff(btn)) break;
        await sleep(200);
      }

      if (!btn || isOff(btn)) {
        return { success: false, error: 'Generate button remained disabled' };
      }

      // Bring button into view and get its screen coordinates
      btn.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      await sleep(50);
      const rect = btn.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);

      return { success: true, coords: { x, y }, existingImages };
    },
    args: [promptText]
  }).catch(() => null);

  const prep = prepResult?.[0]?.result;
  if (!prep) throw new Error("Flow tab lost — is it still open?");
  if (!prep.success) {
    if (prep.fatalError) throw new Error(prep.fatalError);
    return prep;
  }

  // 2. Dispatch trusted OS-level click via Chrome DevTools Protocol (CDP)
  const cdpOk = await cdpClick(tabId, prep.coords.x, prep.coords.y);
  if (!cdpOk) {
    // Fallback: synthetic click
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

  // 3. Poll for the newly generated image on canvas
  const pollResult = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (existingImgList, timeoutMs) => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const existingSet = new Set(existingImgList);

      function getAllImages() {
        return Array.from(document.querySelectorAll('flow-tile-container img, flow-image-tile img, flow-grid-tile-container img, img'))
          .map(i => i.src)
          .filter(src => src && (src.includes('flow.google.com') || src.includes('google') || src.startsWith('blob:') || src.startsWith('data:')));
      }

      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        await sleep(400);

        // Check for error toasts / alerts
        const toasts = Array.from(document.querySelectorAll('[role="alert"], .mat-mdc-snack-bar-container, mat-snack-bar-container'))
          .filter(el => el.offsetParent !== null)
          .map(el => (el.innerText || '').toLowerCase().trim()).filter(Boolean);

        const rl = toasts.find(t => /rate limit|too many|try again later|quota|limit reached/.test(t));
        if (rl) return { success: false, fatalError: 'Rate limited: ' + rl.substring(0, 160) };

        const blocked = toasts.find(t => /unusual activity/.test(t));
        if (blocked) return { success: false, fatalError: 'Account blocked: ' + blocked.substring(0, 160) };

        const currentImages = getAllImages();
        for (const src of currentImages) {
          if (!existingSet.has(src)) {
            // Smoothly scroll new tile into view
            const imgEl = Array.from(document.querySelectorAll('img')).find(img => img.src === src);
            const tile = imgEl?.closest('flow-tile-container, flow-grid-tile-container') || imgEl;
            tile?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            return { success: true, imageUrl: src };
          }
        }
      }

      return { success: false, error: 'Generation timed out after 120s' };
    },
    args: [prep.existingImages, timeoutMs]
  }).catch(() => null);

  const poll = pollResult?.[0]?.result;
  if (!poll) throw new Error("Flow tab lost during generation polling.");
  if (!poll.success && poll.fatalError) throw new Error(poll.fatalError);

  return poll;
}

// ---- Download an image as PNG (Chrome-native approach) ----

async function downloadImage(tabId, imageUrl, filename, conflictAction) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (url) => {
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
          const blob = await response.blob();
          return { blobUrl: URL.createObjectURL(blob), size: blob.size };
        } catch (e) {
          if (attempt === retries - 1) return { error: e.message };
          await wait(delay);
          delay *= 2;
        }
      }
    },
    args: [imageUrl]
  }).catch(() => null);

  const imgResult = result?.[0]?.result;
  if (!imgResult?.blobUrl) {
    throw new Error("Download failed: " + (imgResult?.error || "unknown"));
  }

  pendingFilenames.set(imgResult.blobUrl, filename);

  await new Promise((resolve, reject) => {
    chrome.downloads.download({
      url: imgResult.blobUrl,
      filename: filename,
      saveAs: false,
      conflictAction: conflictAction || "uniquify"
    }, (downloadId) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(downloadId);
    });
  });

  chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (url) => URL.revokeObjectURL(url),
    args: [imgResult.blobUrl]
  }).catch(() => {});
}

// ---- Manifest Helpers ----

function buildManifest(prompts, settings) {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    settings,
    prompts: prompts.map((prompt, i) => ({
      imageNum: i + 1,
      prompt,
      status: "pending"
    }))
  };
}

function saveManifest(manifest) {
  chrome.storage.local.set({ manifest });
}

function applyVariables(prompt, variables) {
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
  const folder = sanitizeFilename(settings.folder || "Flow_Images");
  const num = String(imageNum).padStart(3, "0");
  if (settings.fileNaming === "prompt") {
    const promptSlug = sanitizeFilename(prompt).substring(0, 30);
    return `${folder}/${num}-${promptSlug}.png`;
  }
  return `${folder}/${num}.png`;
}

// ---- Process a list of manifest entries ----

async function processEntries(entries, manifest, settings, logPrefix = "") {
  const tab = await findFlowTab();
  if (!tab?.id) {
    broadcast("BATCH_ERROR", { message: "No Google Flow tab found. Open a Flow project first!" });
    return;
  }

  const projectId = await getProjectId(tab.id);
  if (!projectId) {
    broadcast("BATCH_ERROR", { message: "No Flow project open. Create or open a project in Flow first!" });
    return;
  }

  const variables = parseVariables(settings.variablesText);
  const delaySec = Math.max(1, parseInt(settings.delay, 10) || 2);
  const total = manifest.prompts.length;
  let completed = 0;

  broadcast("BATCH_STARTED", { total });

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (stopRequested) {
      broadcast("BATCH_PROGRESS", { index: i, total, status: "stopped", message: "Stopped by user." });
      for (let j = i; j < entries.length; j++) {
        if (entries[j].status !== "done") entries[j].status = "pending";
      }
      saveManifest(manifest);
      break;
    }

    const label = logPrefix ? `[${logPrefix} ${entry.imageNum}]` : `[${entry.imageNum}/${manifest.prompts.length}]`;
    const prompt = applyVariables(entry.prompt, variables);

    broadcast("BATCH_PROGRESS", {
      index: i, total, status: "generating",
      message: `${label} Generating: "${prompt.substring(0, 50)}…"`
    });

    try {
      const response = await generateSingleImage(tab.id, prompt);
      if (!response.success || !response.imageUrl) {
        throw new Error(response.error || "Generation failed in Flow");
      }

      broadcast("BATCH_PROGRESS", { index: i, total, status: "downloading", message: `${label} Downloading...` });
      const filename = getFilename(entry.imageNum, prompt, settings);

      try {
        await downloadImage(tab.id, response.imageUrl, filename, settings.conflictAction || "uniquify");
        completed++;
        entry.status = "done";
        delete entry.error;
        broadcast("BATCH_PROGRESS", { index: i, total, status: "done", message: `${label} ✅ Saved: ${filename}` });
      } catch (dlErr) {
        entry.status = "failed";
        entry.error = "Download failed: " + dlErr.message;
        broadcast("BATCH_PROGRESS", { index: i, total, status: "failed", message: `${label} ❌ ${entry.error}` });
      }
      saveManifest(manifest);

      if (i < entries.length - 1 && !stopRequested) {
        broadcast("BATCH_PROGRESS", {
          index: i, total, status: "waiting",
          message: `Waiting ${delaySec}s before next prompt...`
        });
        await sleep(delaySec * 1000);
      }

    } catch (err) {
      entry.status = "failed";
      entry.error = err.message;
      saveManifest(manifest);
      broadcast("BATCH_PROGRESS", { index: i, total, status: "failed", message: `${label} ❌ ${err.message}` });

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
        broadcast("BATCH_PROGRESS", {
          index: i, total, status: "waiting",
          message: `Waiting ${delaySec}s before next prompt...`
        });
        await sleep(delaySec * 1000);
      }
    }
  }

  const doneCount = manifest.prompts.filter(p => p.status === "done").length;
  const failedEntries = manifest.prompts.filter(p => p.status === "failed");
  const pendingEntries = manifest.prompts.filter(p => p.status === "pending");
  const failedNums = failedEntries.map(f => f.imageNum);
  const pendingNums = pendingEntries.map(p => p.imageNum);

  broadcast("BATCH_DONE", {
    completed,
    doneCount,
    failed: failedEntries.length,
    pending: pendingEntries.length,
    total: manifest.prompts.length,
    failedNums,
    pendingNums
  });

  if (failedEntries.length === 0 && pendingEntries.length === 0) {
    chrome.storage.local.remove(['manifest']);
  }
}

// ---- Batch Processing ----

async function runBatch(config) {
  const { prompts, settings } = config;
  stopRequested = false;

  // Build or resume manifest
  let manifest;
  if (config.manifest) {
    // Imported or resumed manifest
    manifest = config.manifest;
    if (settings) {
      manifest.settings = { ...manifest.settings, ...settings };
      saveManifest(manifest);
    }
  } else {
    manifest = buildManifest(prompts, settings);
    saveManifest(manifest);
  }

  // Process only pending entries
  const pendingEntries = manifest.prompts.filter(p => p.status === "pending");
  if (pendingEntries.length === 0) {
    broadcast("BATCH_ERROR", { message: "No pending images to generate." });
    return;
  }

  await processEntries(pendingEntries, manifest, manifest.settings);
}

// ---- Retry Failed Images ----

async function retryFailed(manifest) {
  stopRequested = false;

  const failedEntries = manifest.prompts.filter(p => p.status === "failed");
  if (failedEntries.length === 0) {
    broadcast("BATCH_ERROR", { message: "No failed images to retry." });
    return;
  }

  await processEntries(failedEntries, manifest, manifest.settings, "Retry");
}

// ---- Message Handler ----

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "RUN_BATCH") {
    sendResponse({ ok: true });
    runBatch(message).catch(err => {
      broadcast("BATCH_ERROR", { message: "Fatal error: " + err.message });
    });
    return false;
  }

  if (message.type === "RETRY_FAILED") {
    sendResponse({ ok: true });
    chrome.storage.local.get(['manifest'], (data) => {
      if (!data.manifest) {
        broadcast("BATCH_ERROR", { message: "No manifest found. Nothing to retry." });
        return;
      }
      retryFailed(data.manifest).catch(err => {
        broadcast("BATCH_ERROR", { message: "Fatal error during retry: " + err.message });
      });
    });
    return false;
  }

  if (message.type === "EXPORT_MANIFEST") {
    chrome.storage.local.get(['manifest'], (data) => {
      sendResponse({ manifest: data.manifest || null });
    });
    return true; // async sendResponse
  }

  if (message.type === "IMPORT_MANIFEST") {
    const manifest = message.manifest;
    if (manifest && manifest.prompts) {
      saveManifest(manifest);
      sendResponse({ ok: true, pending: manifest.prompts.filter(p => p.status !== "done").length });
    } else {
      sendResponse({ ok: false, error: "Invalid manifest file." });
    }
    return false;
  }

  if (message.type === "STOP_BATCH") {
    stopRequested = true;
    sendResponse({ ok: true });
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
        if (!tab) return sendResponse({ connected: false, reason: "No Flow tab open." });
        const projectId = await getProjectId(tab.id);
        if (!projectId) return sendResponse({ connected: false, reason: "No project open in Flow." });
        sendResponse({ connected: true, tabId: tab.id, projectId });
      } catch (e) {
        sendResponse({ connected: false, reason: e.message });
      }
    })();
    return true;
  }

  return false;
});
