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

// ---- Generate a single image via DOM automation ----
// Types the prompt into ProseMirror, clicks "Start generation",
// then polls the tile grid for a new completed image.

async function generateImage(tabId, projectId, prompt, settings) {
  const timeoutMs = 5 * 60 * 1000; // 5 minutes

  const result = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: async (promptText, timeoutMs) => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));

      // ---- DOM helpers ----
      function getPromptBox() {
        const boxes = Array.from(document.querySelectorAll('.base-prompt-box'));
        return boxes.find(el => el.offsetParent !== null && el.getClientRects().length > 0) ||
               boxes[0] || null;
      }
      function getEditor(box) {
        box = box || getPromptBox();
        return box?.querySelector('flow-rich-text-editor .ProseMirror[contenteditable="true"]') ||
               box?.querySelector('.ProseMirror[contenteditable="true"]') || null;
      }
      function getGenBtn(box) {
        box = box || getPromptBox();
        return box?.querySelector('button[aria-label="Start generation"]') ||
               box?.querySelector('flow-generate-icon-button button[type="submit"]') || null;
      }
      function editorText(ed) {
        ed = ed || getEditor();
        if (!ed) return '';
        const c = ed.cloneNode(true);
        c.querySelectorAll('.prosemirror-placeholder, .ProseMirror-widget').forEach(n => n.remove());
        return (c.innerText || c.textContent || '').replace(/\u00a0/g, ' ').trim();
      }
      function isOff(btn) {
        return !btn || btn.disabled || btn.getAttribute('aria-disabled') === 'true' ||
               btn.classList.contains('mat-mdc-button-disabled');
      }
      const norm = s => s.replace(/\s+/g, ' ').trim().toLowerCase();

      // ---- Clear the editor ----
      async function clearEditor() {
        const clrBtn = getPromptBox()?.querySelector('button[aria-label="Clear prompt"]');
        if (clrBtn) { clrBtn.click(); await sleep(300); }
        const ed = getEditor();
        if (ed && editorText(ed)) {
          ed.focus();
          try {
            const sel = window.getSelection(), range = document.createRange();
            range.selectNodeContents(ed); sel.removeAllRanges(); sel.addRange(range);
            document.execCommand('delete', false, null);
          } catch (e) {}
          await sleep(150);
        }
        // Remove any ingredient chips
        for (let i = 0; i < 12; i++) {
          const chip = getPromptBox()?.querySelector('flow-ingredient-bar button.chip-container');
          if (!chip) break;
          const icon = chip.querySelector('.hover-icon-overlay, mat-icon');
          (icon || chip).click();
          await sleep(200);
        }
      }

      // ---- Type into ProseMirror ----
      async function typePrompt(text) {
        await clearEditor();
        const ed = getEditor();
        if (!ed) return false;
        ed.focus();
        try {
          const sel = window.getSelection(), range = document.createRange();
          range.selectNodeContents(ed); range.collapse(false);
          sel.removeAllRanges(); sel.addRange(range);
        } catch (e) {}

        // Method 1: clipboard paste
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        ed.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
        await sleep(300);
        if (norm(editorText()) === norm(text)) return true;

        // Method 2: execCommand
        await clearEditor(); getEditor()?.focus();
        try { document.execCommand('insertText', false, text); } catch (e) {}
        await sleep(300);
        if (norm(editorText()) === norm(text)) return true;

        // Method 3: InputEvent
        await clearEditor(); const ed3 = getEditor(); ed3?.focus();
        try {
          ed3.dispatchEvent(new InputEvent('beforeinput', {
            inputType: 'insertText', data: text, bubbles: true, cancelable: true
          }));
        } catch (e) {}
        await sleep(300);
        return norm(editorText()) === norm(text);
      }

      // ---- Tile helpers ----
      function resultTiles() {
        return Array.from(document.querySelectorAll('flow-grid-tile-container'))
          .filter(el => !el.querySelector('flow-collection-tile'));
      }
      function pendingTiles() {
        return Array.from(document.querySelectorAll('flow-pending-tile'));
      }
      function parseTile(tile) {
        const img = tile.querySelector('img[data-media-id], img.image, img.thumbnail, img');
        const vid = tile.querySelector('video');
        const isPending = !!tile.querySelector('flow-pending-tile');
        const mediaId = img?.getAttribute('data-media-id') || '';
        const src = img?.src || vid?.src || '';
        return { isPending, mediaId, src };
      }

      // ============ MAIN FLOW ============
      try {
        if (!getEditor()) return { success: false, error: 'Prompt editor not found — is a Flow project open?' };

        // 1. Snapshot existing tile IDs
        const existingIds = new Set(
          resultTiles().map(parseTile)
            .filter(t => !t.isPending && (t.mediaId || t.src))
            .map(t => t.mediaId || t.src)
        );

        // 2. Type the prompt
        if (!await typePrompt(promptText)) {
          return { success: false, error: 'Could not type prompt into the Flow editor' };
        }

        // 3. Wait for the Generate button to become enabled
        let btn = null;
        for (let i = 0; i < 25; i++) {
          btn = getGenBtn();
          if (btn && !isOff(btn)) break;
          await sleep(200);
        }
        if (!btn || isOff(btn)) {
          return { success: false, error: 'Generate button is disabled or not found' };
        }

        // 4. Click Generate
        btn.click();
        await sleep(500);

        // 5. Wait for generation to start (pending tiles appear or prompt clears)
        let started = false;
        for (let i = 0; i < 30; i++) {
          if (pendingTiles().length > 0) { started = true; break; }
          if (!editorText() && isOff(getGenBtn())) { started = true; break; }
          await sleep(200);
        }
        if (!started) {
          // Retry click
          const btn2 = getGenBtn();
          if (btn2 && !isOff(btn2)) { btn2.click(); await sleep(1000); }
        }

        // 6. Poll for completion
        const deadline = Date.now() + timeoutMs;
        let sawPending = false;

        while (Date.now() < deadline) {
          const pending = pendingTiles();

          // Check for generation failures inside pending tiles
          for (const pt of pending) {
            const txt = (pt.innerText || '').toLowerCase();
            if (/fail|error|couldn|could not|try again|blocked|violat|unsafe|not allowed|policy/.test(txt)) {
              return { success: false, error: 'Generation failed: ' + txt.substring(0, 160) };
            }
          }

          // Check toast/snackbar errors
          const toasts = Array.from(document.querySelectorAll('[role="alert"], .mat-mdc-snack-bar-container, mat-snack-bar-container'))
            .filter(el => el.offsetParent !== null)
            .map(el => (el.innerText || '').toLowerCase().trim()).filter(Boolean);
          const rl = toasts.find(t => /rate limit|too many|try again later|quota|limit reached/.test(t));
          if (rl) return { success: false, error: 'Rate limited: ' + rl.substring(0, 160) };
          const blocked = toasts.find(t => /unusual activity/.test(t));
          if (blocked) return { success: false, error: 'Account blocked: ' + blocked.substring(0, 160) };

          if (pending.length > 0) sawPending = true;

          // Look for new completed tiles
          const newTiles = resultTiles().map(parseTile)
            .filter(t => !t.isPending && (t.mediaId || t.src) && !existingIds.has(t.mediaId || t.src));

          if (newTiles.length > 0 && (pending.length === 0 || sawPending)) {
            return { success: true, imageUrl: newTiles[0].src, mediaId: newTiles[0].mediaId };
          }

          await sleep(500);
        }

        return { success: false, error: 'Generation timed out after ' + Math.round(timeoutMs / 1000) + 's' };
      } catch (e) {
        return { success: false, error: e.message || String(e) };
      }
    },
    args: [prompt, timeoutMs]
  }).catch(() => null);

  const response = result?.[0]?.result;
  if (!response) throw new Error("Flow tab lost — is it still open?");
  if (!response.success) throw new Error(response.error);

  return response.imageUrl;
}

// ---- Download an image as PNG (Chrome-native approach) ----

async function downloadImage(tabId, imageUrl, filename) {
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
      conflictAction: "uniquify"
    }, (downloadId) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      resolve(downloadId);
    });
  });

  // Clean up blob URL
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
  const delayMin = (settings.delayMin ?? 6) * 1000;
  const delayMax = (settings.delayMax ?? 12) * 1000;
  const total = entries.length;
  let completed = 0;

  broadcast("BATCH_STARTED", { total });

  for (let i = 0; i < entries.length; i++) {
    if (stopRequested) {
      broadcast("BATCH_PROGRESS", { index: i, total, status: "stopped", message: "Stopped by user." });
      // Mark remaining entries as pending so they can be resumed
      for (let j = i; j < entries.length; j++) {
        if (entries[j].status !== "done") entries[j].status = "pending";
      }
      saveManifest(manifest);
      break;
    }

    const entry = entries[i];
    const prompt = applyVariables(entry.prompt, variables);
    const label = logPrefix ? `[${logPrefix} ${entry.imageNum}]` : `[${entry.imageNum}/${manifest.prompts.length}]`;
    const promptPreview = prompt.substring(0, 60) + (prompt.length > 60 ? "…" : "");

    broadcast("BATCH_PROGRESS", {
      index: i, total, status: "generating",
      message: `${label} Generating: "${promptPreview}"`
    });

    try {
      const mediaId = await generateImage(tab.id, projectId, prompt, settings);

      broadcast("BATCH_PROGRESS", {
        index: i, total, status: "downloading",
        message: `${label} Downloading...`
      });

      const filename = getFilename(entry.imageNum, prompt, settings);
      await downloadImage(tab.id, mediaId, filename);

      completed++;
      entry.status = "done";
      delete entry.error;
      saveManifest(manifest);

      broadcast("BATCH_PROGRESS", {
        index: i, total, status: "done",
        message: `${label} ✅ Saved: ${filename}`
      });

      if (i < entries.length - 1 && !stopRequested) {
        const delay = delayMin + Math.random() * (delayMax - delayMin);
        const delaySec = Math.ceil(delay / 1000);
        broadcast("BATCH_PROGRESS", {
          index: i + 1, total, status: "waiting",
          message: `Waiting ${delaySec}s before next prompt...`
        });
        await sleep(delay);
      }

    } catch (err) {
      entry.status = "failed";
      entry.error = err.message;
      saveManifest(manifest);

      // Fatal errors: stop immediately
      if (err.message.includes("quota") || err.message.includes("auth") || err.message.includes("403")) {
        broadcast("BATCH_PROGRESS", {
          index: i, total, status: "failed",
          message: `${label} ❌ ${err.message}`
        });
        broadcast("BATCH_ERROR", { message: "⛔ Fatal: " + err.message });
        // Mark remaining entries as pending
        for (let j = i + 1; j < entries.length; j++) {
          if (entries[j].status !== "done") entries[j].status = "pending";
        }
        saveManifest(manifest);
        break;
      }

      // Non-fatal: skip and continue
      broadcast("BATCH_PROGRESS", {
        index: i, total, status: "failed",
        message: `${label} ❌ Skipped — ${err.message}`
      });

      if (i < entries.length - 1 && !stopRequested) {
        const delay = delayMin + Math.random() * (delayMax - delayMin);
        const delaySec = Math.ceil(delay / 1000);
        broadcast("BATCH_PROGRESS", {
          index: i + 1, total, status: "waiting",
          message: `Waiting ${delaySec}s before next prompt...`
        });
        await sleep(delay);
      }
    }
  }

  // Build final report from manifest
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

  // Only clear manifest if everything is done
  if (failedEntries.length === 0 && pendingEntries.length === 0) {
    chrome.storage.local.remove(['manifest']);
  }

  if (completed > 0 && tab.id) {
    await sleep(300);
    chrome.tabs.reload(tab.id);
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
