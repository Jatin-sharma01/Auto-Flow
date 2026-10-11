# Auto-Flow Features Needed

This document tracks planned, in-progress, and completed features for the Auto-Flow chrome extension.

## Feature List

- [x] **Slice Image Generation by Prompt Line Indices**
  - **Description**: Add settings for `Start Prompt Index` and `End Prompt Index`. When loading a single master prompt file (e.g. 800 prompts), the user can specify a range (e.g. process prompts 46 to 423). The extension will skip other prompts, only generate the selected range, and name the output files dynamically matching their absolute line numbers in the original file (e.g. prompt #46 is downloaded as `046.png`).
  - **Completed**: 2026-06-12

---

## Completed Features

- [x] **Chrome DevTools Protocol (CDP) Trusted Clicks & DOM Automation Rewrite**
  - **Description**: Replaced direct API and synthetic DOM click events with trusted hardware mouse clicks via CDP (`chrome.debugger`), bypassing Flow's bot-detection and Angular button event barriers.
  - **Completed**: 2026-10-11

- [x] **Concurrent Pipelined Batch Mode**
  - **Description**: Added toggle and slider for concurrent generation (2 to 5 images in flight with 2s safe dispatch spacing), harvesting canvas tiles as they finish.
  - **Completed**: 2026-10-11

- [x] **Image Format Selection (JPEG / PNG)**
  - **Description**: Added selector in settings allowing downloads in JPEG or converted PNG via OffscreenCanvas.
  - **Completed**: 2026-10-11

- [x] **Slice Image Generation by Prompt Line Indices**
  - **Description**: Add settings for `Start Prompt Index` and `End Prompt Index`. When loading a single master prompt file, the user can specify a range (e.g. process prompts 46 to 423).
  - **Completed**: 2026-10-11

- [x] **Dynamic Template Variables**
  - **Description**: Parse variables in `[key] = value` format and substitute them dynamically into prompts during generation.
  - **Completed**: 2026-10-11

- [x] **Selective Image Regeneration**
  - **Description**: Interactive tag selector to regenerate specific image numbers on demand without resetting the whole batch.
  - **Completed**: 2026-10-11
