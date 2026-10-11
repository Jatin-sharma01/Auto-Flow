// ============================================================
// Auto Flow - Side Panel Script (Chrome)
// Handles UI interaction and communicates with the background
// ============================================================

const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const clearBtn = document.getElementById("clearBtn");
const retryBtn = document.getElementById("retryBtn");
const exportBtn = document.getElementById("exportBtn");
const importBtn = document.getElementById("importBtn");
const importFileInput = document.getElementById("importFileInput");
const promptList = document.getElementById("promptList");
const variablesList = document.getElementById("variablesList");
const logContainer = document.getElementById("logContainer");
const summary = document.getElementById("summary");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const uploadBtn = document.getElementById("uploadBtn");
const fileInput = document.getElementById("fileInput");
const promptCount = document.getElementById("promptCount");
const delaySlider = document.getElementById("delaySlider");
const delayVal = document.getElementById("delayVal");
const conflictSelect = document.getElementById("conflictSelect");
const regenerateTitle = document.getElementById("regenerateTitle");
const regenerateTags = document.getElementById("regenerateTags");
const regenerateBtn = document.getElementById("regenerateBtn");
const formatSelect = document.getElementById("formatSelect");
const batchToggle = document.getElementById("batchToggle");
const batchSliderRow = document.getElementById("batchSliderRow");
const batchSlider = document.getElementById("batchSlider");
const batchVal = document.getElementById("batchVal");

// ---- Batch Mode Controls ----
if (batchToggle) {
  batchToggle.addEventListener("change", (e) => {
    if (batchSliderRow) batchSliderRow.style.display = e.target.checked ? "block" : "none";
  });
}

if (batchSlider && batchVal) {
  batchSlider.addEventListener("input", (e) => {
    batchVal.textContent = e.target.value;
  });
}

// ---- Interval Delay Slider ----
if (delaySlider && delayVal) {
  delaySlider.addEventListener("input", (e) => {
    delayVal.textContent = e.target.value + "s";
  });
}

// ---- Prompt counter ----

function updatePromptCount() {
  const lines = promptList.value.split("\n").filter(p => p.trim() !== "");
  if (lines.length === 0) {
    promptCount.innerHTML = "";
  } else {
    promptCount.innerHTML = `<span>${lines.length}</span> prompt${lines.length === 1 ? "" : "s"} loaded`;
  }
}

promptList.addEventListener("input", updatePromptCount);

// ---- File upload ----

uploadBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    const text = event.target.result;
    let prompts;

    if (file.name.endsWith(".csv") || file.name.endsWith(".tsv")) {
      const sep = file.name.endsWith(".tsv") ? "\t" : ",";
      const rows = text.split("\n").map(r => r.trim()).filter(r => r !== "");
      if (rows.length === 0) return;

      const firstRow = rows[0].toLowerCase();
      let promptCol = 0;
      if (firstRow.includes("prompt")) {
        const headers = firstRow.split(sep).map(h => h.trim().replace(/"/g, ""));
        promptCol = headers.findIndex(h => h === "prompt" || h === "prompts" || h === "text");
        if (promptCol === -1) promptCol = 0;
        rows.shift();
      }

      prompts = rows.map(row => {
        const cols = row.split(sep).map(c => c.trim().replace(/^"|"$/g, ""));
        return cols[promptCol] || "";
      }).filter(p => p !== "");
    } else {
      prompts = text.split("\n").map(p => p.trim()).filter(p => p !== "");
    }

    promptList.value = prompts.join("\n");
    updatePromptCount();
    uploadBtn.textContent = `📄 ${prompts.length} loaded`;
    setTimeout(() => { uploadBtn.textContent = "📄 Load .txt"; }, 2000);
  };
  reader.readAsText(file);
  fileInput.value = "";
});

// ---- Check connection ----

function checkConnection() {
  chrome.runtime.sendMessage({ type: "CHECK_CONNECTION" }, (response) => {
    if (chrome.runtime.lastError || !response) {
      statusDot.className = "status-dot disconnected";
      statusText.textContent = "Extension error — reload the extension.";
      startBtn.disabled = true;
      return;
    }
    if (response.connected) {
      statusDot.className = "status-dot connected";
      statusText.textContent = "Connected to Flow (Project: " + (response.projectId ? response.projectId.substring(0, 8) + "…" : "Active") + ")";
      startBtn.disabled = false;
    } else {
      statusDot.className = "status-dot disconnected";
      statusText.textContent = response.reason || "Not connected.";
      startBtn.disabled = true;
    }
  });
}

// Initial check on load
checkConnection();

// Auto-check periodically so UI connects as soon as user opens or navigates to Flow tab
setInterval(checkConnection, 3000);

// Check when sidepanel window gains focus
window.addEventListener("focus", checkConnection);

// Allow clicking status bar to force an immediate refresh
const statusBar = document.getElementById("statusBar");
if (statusBar) {
  statusBar.style.cursor = "pointer";
  statusBar.title = "Click to refresh connection";
  statusBar.addEventListener("click", () => {
    statusDot.className = "status-dot checking";
    statusText.textContent = "Checking connection...";
    checkConnection();
  });
}

// ---- Settings Helper ----

function getSettings() {
  const isBatch = batchToggle?.checked || false;
  const batchSize = isBatch ? (parseInt(batchSlider?.value, 10) || 2) : 1;
  return {
    model: document.getElementById("modelSelect")?.value,
    aspectRatio: document.getElementById("aspectSelect")?.value,
    fileNaming: document.getElementById("namingSelect")?.value,
    conflictAction: conflictSelect ? conflictSelect.value : "overwrite",
    format: formatSelect ? formatSelect.value : "jpeg",
    batchSize: batchSize,
    folder: document.getElementById("folderInput")?.value.trim() || "Flow_Images",
    delaySec: delaySlider ? (parseInt(delaySlider.value, 10) || 2) : 2,
    startIndex: document.getElementById("startIndexInput")?.value || "",
    endIndex: document.getElementById("endIndexInput")?.value || "",
    variablesText: variablesList ? variablesList.value : ""
  };
}

function restoreSettings(settings) {
  if (!settings) return;
  if (settings.model && document.getElementById("modelSelect")) document.getElementById("modelSelect").value = settings.model;
  if (settings.aspectRatio && document.getElementById("aspectSelect")) document.getElementById("aspectSelect").value = settings.aspectRatio;
  if (settings.fileNaming && document.getElementById("namingSelect")) document.getElementById("namingSelect").value = settings.fileNaming;
  if (settings.conflictAction && conflictSelect) conflictSelect.value = settings.conflictAction;
  if (settings.format && formatSelect) formatSelect.value = settings.format;
  if (settings.batchSize && settings.batchSize > 1) {
    if (batchToggle) batchToggle.checked = true;
    if (batchSliderRow) batchSliderRow.style.display = "block";
    if (batchSlider) {
      batchSlider.value = settings.batchSize;
      if (batchVal) batchVal.textContent = settings.batchSize;
    }
  } else {
    if (batchToggle) batchToggle.checked = false;
    if (batchSliderRow) batchSliderRow.style.display = "none";
  }
  if (settings.folder && document.getElementById("folderInput")) document.getElementById("folderInput").value = settings.folder;
  if (settings.delaySec && delaySlider) {
    delaySlider.value = settings.delaySec;
    if (delayVal) delayVal.textContent = settings.delaySec + "s";
  }
  if (settings.startIndex !== undefined && document.getElementById("startIndexInput")) document.getElementById("startIndexInput").value = settings.startIndex;
  if (settings.endIndex !== undefined && document.getElementById("endIndexInput")) document.getElementById("endIndexInput").value = settings.endIndex;
  if (settings.variablesText && variablesList) variablesList.value = settings.variablesText;
}

// ---- Regenerate Tags ----

function renderTags(manifest) {
  if (!regenerateTags || !regenerateTitle || !regenerateBtn) return;
  regenerateTags.innerHTML = "";
  if (!manifest || !manifest.prompts || manifest.prompts.length === 0) {
    regenerateTitle.style.display = "none";
    regenerateTags.style.display = "none";
    regenerateBtn.style.display = "none";
    return;
  }

  regenerateTitle.style.display = "block";
  regenerateTags.style.display = "flex";

  manifest.prompts.forEach(p => {
    const tag = document.createElement("div");
    tag.className = `tag ${p.status || "pending"}`;
    tag.textContent = `#${p.imageNum}`;
    tag.dataset.num = p.imageNum;
    tag.title = `Status: ${p.status || "pending"}${p.error ? " - " + p.error : ""}`;

    tag.addEventListener("click", () => {
      tag.classList.toggle("selected");
      updateRegenerateBtn();
    });

    regenerateTags.appendChild(tag);
  });
  updateRegenerateBtn();
}

function updateRegenerateBtn() {
  if (!regenerateTags || !regenerateBtn) return;
  const selected = regenerateTags.querySelectorAll(".tag.selected").length;
  if (selected > 0) {
    regenerateBtn.style.display = "flex";
    regenerateBtn.textContent = `🔄 Regenerate Selected (${selected})`;
  } else {
    regenerateBtn.style.display = "none";
  }
}

if (regenerateBtn) {
  regenerateBtn.addEventListener("click", () => {
    const selected = Array.from(regenerateTags.querySelectorAll(".tag.selected")).map(t => parseInt(t.dataset.num, 10));
    if (selected.length === 0) return;

    logContainer.innerHTML = "";
    logContainer.classList.add("visible");
    summary.classList.remove("visible");

    startBtn.style.display = "none";
    retryBtn.style.display = "none";
    stopBtn.style.display = "flex";
    clearBtn.style.display = "none";
    exportBtn.style.display = "none";
    regenerateBtn.style.display = "none";
    promptList.disabled = true;

    const settings = getSettings();
    chrome.runtime.sendMessage({ type: "REGENERATE_SELECTED", nums: selected, settings });
  });
}

// ---- Start batch ----

startBtn.addEventListener("click", () => {
  const prompts = promptList.value.split("\n").map(p => p.trim()).filter(p => p !== "");

  if (prompts.length === 0) {
    alert("Please enter at least one prompt.");
    return;
  }

  const settings = getSettings();

  logContainer.innerHTML = "";
  logContainer.classList.add("visible");
  summary.classList.remove("visible");

  startBtn.style.display = "none";
  retryBtn.style.display = "none";
  stopBtn.style.display = "flex";
  clearBtn.style.display = "none";
  exportBtn.style.display = "none";
  if (regenerateBtn) regenerateBtn.style.display = "none";
  promptList.disabled = true;

  chrome.storage.local.get(['manifest'], (data) => {
    const isSamePrompts = data.manifest && 
      data.manifest.prompts.length === prompts.length &&
      data.manifest.prompts.every((p, idx) => p.prompt === prompts[idx]);

    if (isSamePrompts && data.manifest.prompts.some(p => p.status === "pending")) {
      chrome.runtime.sendMessage({ type: "RUN_BATCH", manifest: data.manifest, prompts, settings });
    } else {
      chrome.runtime.sendMessage({ type: "RUN_BATCH", prompts, settings });
    }
  });
});

// ---- Stop batch ----

stopBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "STOP_BATCH" });
  stopBtn.disabled = true;
  stopBtn.textContent = "Stopping...";
});

// ---- Listen for progress from background ----

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "CONNECTION_CHANGED") {
    checkConnection();
  }
  if (message.type === "BATCH_PROGRESS") {
    addLogEntry(message.message, message.status);
  }
  if (message.type === "BATCH_COMPLETE") {
    showSummary(message);
    resetButtons();
    chrome.storage.local.get(['manifest'], (data) => {
      renderTags(data.manifest);
    });
  }
  if (message.type === "BATCH_ERROR") {
    addLogEntry(message.message, "failed");
    resetButtons();
    chrome.storage.local.get(['manifest'], (data) => {
      renderTags(data.manifest);
    });
  }
});

// ---- Logging ----

function addLogEntry(text, status) {
  const entry = document.createElement("div");
  entry.className = `log-entry ${status || ""}`;
  entry.textContent = text;
  logContainer.appendChild(entry);
  logContainer.scrollTop = logContainer.scrollHeight;
}

// ---- Summary ----

function showSummary(data) {
  summary.classList.add("visible");

  if (data.failed > 0) {
    summary.className = "summary partial visible";
    summary.innerHTML = `⚠️ Completed: ${data.completed}/${data.total} (${data.failed} failed)`;
  } else {
    summary.className = "summary success visible";
    summary.innerHTML = `✅ All ${data.completed} images generated & saved!`;
  }
}

// ---- Reset buttons ----

function resetButtons() {
  startBtn.style.display = "flex";
  startBtn.textContent = "🚀 Start Generating";
  stopBtn.style.display = "none";
  stopBtn.disabled = false;
  stopBtn.textContent = "⏹ Stop";
  clearBtn.style.display = "flex";
  exportBtn.style.display = "flex";
  promptList.disabled = false;
}

// ---- Retry Failed ----

retryBtn.addEventListener("click", () => {
  logContainer.innerHTML = "";
  logContainer.classList.add("visible");
  summary.classList.remove("visible");

  startBtn.style.display = "none";
  retryBtn.style.display = "none";
  stopBtn.style.display = "flex";
  clearBtn.style.display = "none";
  exportBtn.style.display = "none";
  if (regenerateBtn) regenerateBtn.style.display = "none";
  promptList.disabled = true;

  const settings = getSettings();
  chrome.runtime.sendMessage({ type: "RETRY_FAILED", settings });
});

// ---- Export Manifest ----

exportBtn.addEventListener("click", () => {
  chrome.storage.local.get(['manifest'], (data) => {
    if (!data.manifest) {
      alert("No progress data to export.");
      return;
    }
    const jsonStr = JSON.stringify(data.manifest, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const dateStr = new Date().toISOString().replace(/[:.]/g, "-").substring(0, 19);

    const a = document.createElement("a");
    a.href = url;
    a.download = `flow-progress-${dateStr}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
});

// ---- Import Manifest ----

importBtn.addEventListener("click", () => importFileInput.click());

importFileInput.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const manifest = JSON.parse(event.target.result);
      if (!manifest.prompts || !Array.isArray(manifest.prompts)) {
        alert("Invalid manifest file: missing prompts array.");
        return;
      }

      chrome.storage.local.set({ manifest }, () => {
        promptList.value = manifest.prompts.map(p => p.prompt).join("\n");
        updatePromptCount();

        restoreSettings(manifest.settings);

        const done = manifest.prompts.filter(p => p.status === "done").length;
        const failed = manifest.prompts.filter(p => p.status === "failed").length;
        const pending = manifest.prompts.filter(p => p.status === "pending").length;
        const total = manifest.prompts.length;

        summary.className = "summary partial visible";
        summary.innerHTML = `📥 Imported: ${done}/${total} done, ${failed} failed, ${pending} pending`;

        if (pending > 0) {
          startBtn.textContent = `▶ Resume (${pending} remaining)`;
        }
        if (failed > 0) {
          retryBtn.style.display = "flex";
          const failedNums = manifest.prompts.filter(p => p.status === "failed").map(p => p.imageNum).join(", ");
          retryBtn.textContent = `🔄 Retry Failed (${failedNums})`;
        }
        exportBtn.style.display = "flex";
        renderTags(manifest);

        importBtn.textContent = "✅ Imported!";
        setTimeout(() => { importBtn.textContent = "📤 Import"; }, 2000);
      });
    } catch (err) {
      alert("Error parsing JSON: " + err.message);
    }
  };
  reader.readAsText(file);
  importFileInput.value = "";
});

// ---- Clear All ----

clearBtn.addEventListener("click", () => {
  if (confirm("Clear prompts, log, and saved progress?")) {
    promptList.value = "";
    promptList.disabled = false;
    logContainer.innerHTML = "";
    logContainer.classList.remove("visible");
    summary.classList.remove("visible");
    updatePromptCount();

    stopBtn.style.display = "none";
    retryBtn.style.display = "none";
    exportBtn.style.display = "none";
    if (regenerateBtn) regenerateBtn.style.display = "none";
    renderTags(null);
    startBtn.textContent = "🚀 Start Generating";

    chrome.storage.local.remove(['manifest']);
  }
});

// ---- Restore state on load ----

chrome.storage.local.get(['manifest'], (data) => {
  if (!data.manifest) return;
  const manifest = data.manifest;

  renderTags(manifest);

  promptList.value = manifest.prompts.map(p => p.prompt).join("\n");
  updatePromptCount();

  restoreSettings(manifest.settings);

  const failed = manifest.prompts.filter(p => p.status === "failed").length;
  const pending = manifest.prompts.filter(p => p.status === "pending").length;

  if (pending > 0) {
    startBtn.textContent = `▶ Resume (${pending} remaining)`;
  }
  if (failed > 0) {
    retryBtn.style.display = "flex";
    const failedNums = manifest.prompts.filter(p => p.status === "failed").map(p => p.imageNum).join(", ");
    retryBtn.textContent = `🔄 Retry Failed (${failedNums})`;
  }
  exportBtn.style.display = "flex";
});
