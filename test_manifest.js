// Test buildManifest range slicing logic for Auto-Flow Chrome Extension

// Redefining buildManifest exactly as in background.js for test environment
function buildManifest(prompts, settings) {
  const startIndex = parseInt(settings.startIndex || "1", 10) || 1;
  const endIndex = parseInt(settings.endIndex || "", 10) || prompts.length;

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

const mockPrompts = [
  "Prompt 1",
  "Prompt 2",
  "Prompt 3",
  "Prompt 4",
  "Prompt 5"
];

console.log("Running Auto-Flow manifest generation tests...");

// Test Case 1: Default (no indices specified)
{
  const settings = { startIndex: "", endIndex: "" };
  const manifest = buildManifest(mockPrompts, settings);
  if (manifest.prompts.length !== 5) throw new Error("Test Case 1 failed: prompt count mismatch");
  if (manifest.prompts.some(p => p.status !== "pending")) throw new Error("Test Case 1 failed: all should be pending");
  if (manifest.prompts[0].imageNum !== 1 || manifest.prompts[4].imageNum !== 5) throw new Error("Test Case 1 failed: image numbers incorrect");
}
console.log("✔ Test Case 1 passed (Default range)");

// Test Case 2: Specific range (indices 2 to 4)
{
  const settings = { startIndex: "2", endIndex: "4" };
  const manifest = buildManifest(mockPrompts, settings);
  
  // prompt 1 (index 0, line 1) -> outside range -> status: skipped, imageNum: 1
  if (manifest.prompts[0].status !== "skipped" || manifest.prompts[0].imageNum !== 1) throw new Error("Test Case 2 failed: prompt 1 status or imageNum incorrect");
  
  // prompt 2 (index 1, line 2) -> in range -> status: pending, imageNum: 2
  if (manifest.prompts[1].status !== "pending" || manifest.prompts[1].imageNum !== 2) throw new Error("Test Case 2 failed: prompt 2 status or imageNum incorrect");
  
  // prompt 3 (index 2, line 3) -> in range -> status: pending, imageNum: 3
  if (manifest.prompts[2].status !== "pending" || manifest.prompts[2].imageNum !== 3) throw new Error("Test Case 2 failed: prompt 3 status or imageNum incorrect");
  
  // prompt 4 (index 3, line 4) -> in range -> status: pending, imageNum: 4
  if (manifest.prompts[3].status !== "pending" || manifest.prompts[3].imageNum !== 4) throw new Error("Test Case 2 failed: prompt 4 status or imageNum incorrect");
  
  // prompt 5 (index 4, line 5) -> outside range -> status: skipped, imageNum: 5
  if (manifest.prompts[4].status !== "skipped" || manifest.prompts[4].imageNum !== 5) throw new Error("Test Case 2 failed: prompt 5 status or imageNum incorrect");
}
console.log("✔ Test Case 2 passed (Specific range 2 to 4)");

// Test Case 3: Start index only
{
  const settings = { startIndex: "3", endIndex: "" };
  const manifest = buildManifest(mockPrompts, settings);
  if (manifest.prompts[0].status !== "skipped") throw new Error("Test Case 3 failed: prompt 1 should be skipped");
  if (manifest.prompts[1].status !== "skipped") throw new Error("Test Case 3 failed: prompt 2 should be skipped");
  if (manifest.prompts[2].status !== "pending") throw new Error("Test Case 3 failed: prompt 3 should be pending");
  if (manifest.prompts[3].status !== "pending") throw new Error("Test Case 3 failed: prompt 4 should be pending");
  if (manifest.prompts[4].status !== "pending") throw new Error("Test Case 3 failed: prompt 5 should be pending");
}
console.log("✔ Test Case 3 passed (Start index only)");

// Helper to simulate the manifest re-evaluation logic from background.js
function reevaluateManifest(manifest, settings) {
  manifest.settings = settings;
  const startIndex = parseInt(settings.startIndex || "1", 10) || 1;
  const endIndex = parseInt(settings.endIndex || "", 10) || manifest.prompts.length;

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
  return manifest;
}

// Test Case 4: Re-evaluate range on resume/settings change
{
  const initialSettings = { startIndex: "1", endIndex: "2" };
  const manifest = buildManifest(mockPrompts, initialSettings);
  
  // Simulate prompt 1 being successfully generated (status: done)
  manifest.prompts[0].status = "done";
  // Prompt 2 remains pending, Prompts 3, 4, 5 are skipped.
  
  // Now change range settings to 2 to 4
  const newSettings = { startIndex: "2", endIndex: "4" };
  const updatedManifest = reevaluateManifest(manifest, newSettings);
  
  // Prompt 1: was done, should remain done (even though it is now outside the range 2-4)
  if (updatedManifest.prompts[0].status !== "done") {
    throw new Error("Test Case 4 failed: prompt 1 status should remain done");
  }
  
  // Prompt 2: in range, status was pending, should remain pending
  if (updatedManifest.prompts[1].status !== "pending") {
    throw new Error("Test Case 4 failed: prompt 2 status should remain pending");
  }
  
  // Prompt 3: in range, status was skipped, should become pending
  if (updatedManifest.prompts[2].status !== "pending") {
    throw new Error("Test Case 4 failed: prompt 3 status should become pending");
  }
  
  // Prompt 4: in range, status was skipped, should become pending
  if (updatedManifest.prompts[3].status !== "pending") {
    throw new Error("Test Case 4 failed: prompt 4 status should become pending");
  }
  
  // Prompt 5: outside range, status was skipped, should remain skipped
  if (updatedManifest.prompts[4].status !== "skipped") {
    throw new Error("Test Case 4 failed: prompt 5 status should remain skipped");
  }

  // Verify settings are updated
  if (updatedManifest.settings.startIndex !== "2" || updatedManifest.settings.endIndex !== "4") {
    throw new Error("Test Case 4 failed: manifest settings not updated");
  }
}
console.log("✔ Test Case 4 passed (Settings update & status re-evaluation on resume)");


// Test Case 5: Flow URL and Project ID Detection Logic
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

function extractProjectId(href) {
  if (!href) return null;
  const match = href.match(/projects?\/([a-zA-Z0-9_-]+)/i) || 
                href.match(/[?&]project(?:Id)?=([a-zA-Z0-9_-]+)/i);
  return match ? match[1] : null;
}

{
  const valid = [
    "https://labs.google/fx/tools/flow",
    "https://labs.google/fx/tools/flow/",
    "https://labs.google/fx/en/tools/flow",
    "https://labs.google/fx/en-US/tools/flow",
    "https://labs.google/fx/tools/flow/project/abc-123-xyz",
    "https://labs.google/fx/tools/flow?project=abc-123",
    "https://labs.google/flow/project/abc",
    "https://flow.google.com/project/16202ab9-d3d3-4a3b-b642-874f32b28fbb"
  ];
  for (const u of valid) {
    if (!isFlowUrl(u)) throw new Error("Test Case 5 failed: should match " + u);
  }

  const invalid = [
    "https://google.com/search?q=flow",
    "https://other.com/flow",
    "https://labs.google/about"
  ];
  for (const u of invalid) {
    if (isFlowUrl(u)) throw new Error("Test Case 5 failed: should reject " + u);
  }

  if (extractProjectId("https://labs.google/fx/tools/flow/project/a1b2c3d4") !== "a1b2c3d4") {
    throw new Error("Test Case 5 failed: extractProjectId basic");
  }
  if (extractProjectId("https://labs.google/fx/tools/flow/project/PROJECT_ABC") !== "PROJECT_ABC") {
    throw new Error("Test Case 5 failed: extractProjectId uppercase");
  }
  if (extractProjectId("https://labs.google/fx/tools/flow") !== null) {
    throw new Error("Test Case 5 failed: extractProjectId on non-project");
  }
}
console.log("✔ Test Case 5 passed (Flow URL matching and Project ID extraction)");

// Test Case 6: Batch Chunking, Prompt Slicing, and Selective Regeneration
{
  const testPrompts = Array.from({ length: 10 }, (_, i) => `Prompt ${i + 1}`);
  // Slice prompts 3 to 8
  const manifest = buildManifest(testPrompts, { startIndex: "3", endIndex: "8", batchSize: 3 });

  // Out of range (1, 2, 9, 10) must be skipped; in range (3..8) must be pending
  const pendingEntries = manifest.prompts.filter(p => p.status === "pending");
  if (pendingEntries.length !== 6) throw new Error("Test Case 6 failed: pending count mismatch");
  if (pendingEntries[0].imageNum !== 3 || pendingEntries[5].imageNum !== 8) {
    throw new Error("Test Case 6 failed: sliced range image numbers incorrect");
  }

  // Verify batch chunking of size 3
  const batchSize = 3;
  const batches = [];
  for (let i = 0; i < pendingEntries.length; i += batchSize) {
    batches.push(pendingEntries.slice(i, i + batchSize));
  }
  if (batches.length !== 2) throw new Error("Test Case 6 failed: batch count mismatch");
  if (batches[0].length !== 3 || batches[1].length !== 3) throw new Error("Test Case 6 failed: batch size mismatch");
  if (batches[0][0].imageNum !== 3 || batches[1][2].imageNum !== 8) throw new Error("Test Case 6 failed: batch elements mismatch");

  // Mark pending items as done
  pendingEntries.forEach(p => { p.status = "done"; });

  // Test Selective Regeneration: user selects image #4 and #7 to regenerate
  const selectedNums = new Set([4, 7]);
  manifest.prompts.forEach(p => {
    if (selectedNums.has(p.imageNum)) {
      p.status = "pending";
      delete p.error;
    }
  });

  const regenEntries = manifest.prompts.filter(p => selectedNums.has(p.imageNum));
  if (regenEntries.length !== 2) throw new Error("Test Case 6 failed: regen count mismatch");
  if (regenEntries[0].status !== "pending" || regenEntries[1].status !== "pending") {
    throw new Error("Test Case 6 failed: regenerated items not pending");
  }
  // Ensure untouched items are still done or skipped
  if (manifest.prompts[2].status !== "done") throw new Error("Test Case 6 failed: #3 should still be done");
  if (manifest.prompts[0].status !== "skipped") throw new Error("Test Case 6 failed: #1 should still be skipped");
}
console.log("✔ Test Case 6 passed (Batch Chunking, Prompt Slicing, and Selective Regeneration)");

// Test Case 7: Dynamic Variables Parsing & Application
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

{
  const text = "[hero] = A valiant knight\n[foe] = A fiery dragon\n# Ignored comment\n";
  const vars = parseVariables(text);
  if (vars["hero"] !== "A valiant knight" || vars["foe"] !== "A fiery dragon") {
    throw new Error("Test Case 7 failed: variables parsing mismatch");
  }

  const prompt = "A photo of [hero] fighting [foe] in [hero]'s armor";
  const result = applyVariables(prompt, vars);
  if (result !== "A photo of A valiant knight fighting A fiery dragon in A valiant knight's armor") {
    throw new Error("Test Case 7 failed: variables substitution mismatch: " + result);
  }
}
console.log("✔ Test Case 7 passed (Dynamic Variables Parsing & Application)");

// Test Case 8: Filename & Format Selection
function sanitizeFilename(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 40) || "image";
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

{
  // JPEG format by number
  const fn1 = getFilename(1, "A cute dog", { folder: "My_Folder", format: "jpeg", fileNaming: "number" });
  if (fn1 !== "my-folder/001.jpg") throw new Error("Test Case 8 failed: fn1 was " + fn1);

  // PNG format by prompt
  const fn2 = getFilename(46, "A cute dog in high detail", { folder: "My_Folder", format: "png", fileNaming: "prompt" });
  if (fn2 !== "my-folder/046-a-cute-dog-in-high-detail.png") throw new Error("Test Case 8 failed: fn2 was " + fn2);
}
console.log("✔ Test Case 8 passed (Filename & Format Selection)");

// Test Case 9: Pipelined Concurrent Queue Logic
{
  const entries = [
    { imageNum: 1, prompt: "P1" },
    { imageNum: 2, prompt: "P2" },
    { imageNum: 3, prompt: "P3" },
    { imageNum: 4, prompt: "P4" }
  ];
  const batchSize = 2;
  const inFlight = [];
  let nextIndex = 0;
  const dispatched = [];
  const harvested = [];

  // Simulate pipeline step 1: Fill in-flight up to batchSize (2)
  while (inFlight.length < batchSize && nextIndex < entries.length) {
    const entry = entries[nextIndex++];
    inFlight.push(entry);
    dispatched.push(entry.imageNum);
  }
  if (inFlight.length !== 2 || dispatched.join() !== "1,2") {
    throw new Error("Test Case 9 failed: initial in-flight dispatch");
  }

  // Simulate harvest 1 item
  harvested.push(inFlight.shift().imageNum);

  // Pipeline step 2: Refill in-flight
  while (inFlight.length < batchSize && nextIndex < entries.length) {
    const entry = entries[nextIndex++];
    inFlight.push(entry);
    dispatched.push(entry.imageNum);
  }
  if (inFlight.length !== 2 || dispatched.join() !== "1,2,3") {
    throw new Error("Test Case 9 failed: refilled in-flight dispatch");
  }
}
console.log("✔ Test Case 9 passed (Pipelined Concurrent Queue Logic)");

console.log("🎉 All tests passed successfully!");

