/* global JSZip */
importScripts("jszip.min.js");

const POPUP_DELAY = 650;
const NAV_DELAY = 700;
const autoState = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true
  });
  if (!tab?.id) throw new Error("No active tab found.");
  return tab;
}

function dataUrlToBlob(dataUrl) {
  const [meta, base64] = dataUrl.split(",");
  const mime = /data:(.*?);base64/.exec(meta)?.[1] || "image/png";
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

async function captureVisibleTabPng(windowId) {
  return chrome.tabs.captureVisibleTab(windowId, { format: "png" });
}

async function blobToDataUrl(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }

  return `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
}

function unionRect(rects) {
  let left = rects[0].left;
  let top = rects[0].top;
  let right = rects[0].right;
  let bottom = rects[0].bottom;

  for (let i = 1; i < rects.length; i++) {
    left = Math.min(left, rects[i].left);
    top = Math.min(top, rects[i].top);
    right = Math.max(right, rects[i].right);
    bottom = Math.max(bottom, rects[i].bottom);
  }

  return {
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top
  };
}

async function cropRectsFromScreenshot(dataUrl, rectEntries, viewport) {
  const img = await createImageBitmap(dataUrlToBlob(dataUrl));
  const scaleX = img.width / viewport.width;
  const scaleY = img.height / viewport.height;
  const out = [];

  try {
    for (const entry of rectEntries) {
      const srcX = Math.max(0, Math.round(entry.rect.left * scaleX));
      const srcY = Math.max(0, Math.round(entry.rect.top * scaleY));
      const srcW = Math.max(1, Math.round(entry.rect.width * scaleX));
      const srcH = Math.max(1, Math.round(entry.rect.height * scaleY));

      if (srcX >= img.width || srcY >= img.height) continue;

      const safeW = Math.min(srcW, img.width - srcX);
      const safeH = Math.min(srcH, img.height - srcY);

      if (safeW <= 0 || safeH <= 0) continue;

      const canvas = new OffscreenCanvas(safeW, safeH);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, srcX, srcY, safeW, safeH, 0, 0, safeW, safeH);

      const blob = await canvas.convertToBlob({ type: "image/png" });
      const buffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(buffer);

      let binary = "";
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
      }

      out.push({
        ...entry,
        pngDataUrl: "data:image/png;base64," + btoa(binary)
      });
    }

    return out;
  } finally {
    img.close();
  }
}

async function downloadPngDataUrl(pngDataUrl, filename) {
  await chrome.downloads.download({
    url: pngDataUrl,
    filename,
    saveAs: false
  });
}

async function getViewerState(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => {
      function rectObj(r) {
        return {
          left: r.left,
          top: r.top,
          right: r.right,
          bottom: r.bottom,
          width: r.width,
          height: r.height
        };
      }

      function intersectRect(a, b) {
        const left = Math.max(a.left, b.left);
        const top = Math.max(a.top, b.top);
        const right = Math.min(a.right, b.right);
        const bottom = Math.min(a.bottom, b.bottom);
        const width = Math.max(0, right - left);
        const height = Math.max(0, bottom - top);
        return { left, top, right, bottom, width, height };
      }

      const root = document.querySelector("#xCVPages");
      if (!root) return { ok: false };

      const viewport = {
        left: 0,
        top: 0,
        right: window.innerWidth,
        bottom: window.innerHeight,
        width: window.innerWidth,
        height: window.innerHeight
      };

      const imageCountEl = document.querySelector('[id^="articleImageCount-"]');
      const totalMangaPages = Number(imageCountEl?.textContent?.trim() || 0);

      const children = Array.from(root.children).filter(
        (el) => el.classList && el.classList.contains("-cv-page")
      );

      // Ignore any leading PR/empty blocks before the real manga starts.
      const firstRealIndex = children.findIndex(
        (el) =>
          !el.classList.contains("mode-empty") &&
          !el.classList.contains("mode-pr")
      );

      const startIndex = firstRealIndex === -1 ? 0 : firstRealIndex;

      // Stop at the first PR/empty block AFTER manga has started.
      const relativeStop = children
        .slice(startIndex)
        .findIndex(
          (el) =>
            el.classList.contains("mode-empty") &&
            el.classList.contains("mode-pr") &&
            el.classList.contains("-cv-page")
        );

      const endIndex =
        relativeStop === -1 ? children.length : startIndex + relativeStop;

      const mangaPages = [];
      let mangaNumber = 1;

      for (let i = startIndex; i < endIndex; i++) {
        const el = children[i];

        if (el.classList.contains("mode-empty")) continue;

        mangaPages.push({
          domIndex: i,
          mangaNumber,
          el
        });

        mangaNumber += 1;
      }

      const visibleRendered = [];

      for (const page of mangaPages) {
        const pageEl = page.el;
        if (!pageEl.classList.contains("mode-rendered")) continue;

        const canvas = pageEl.querySelector("canvas");
        if (!canvas) continue;

        const r = canvas.getBoundingClientRect();
        const rect = rectObj(r);
        const intersection = intersectRect(rect, viewport);

        if (intersection.width <= 0 || intersection.height <= 0) continue;

        visibleRendered.push({
          domIndex: page.domIndex,
          mangaNumber: page.mangaNumber,
          rect,
          intersection
        });
      }

      visibleRendered.sort((a, b) => a.intersection.left - b.intersection.left);

      return {
        ok: true,
        viewport,
        railRight: getComputedStyle(root).right,
        totalMangaPages,
        startIndex,
        endIndex,
        visibleRendered
      };
    }
  });

  const goodStates = results
    .map((x) => x.result)
    .filter((x) => x?.ok);

  if (!goodStates.length) {
    throw new Error("Viewer not found.");
  }

  goodStates.sort((a, b) => {
    const aScore = (a.visibleRendered?.length || 0) * 1000 + (a.totalMangaPages || 0);
    const bScore = (b.visibleRendered?.length || 0) * 1000 + (b.totalMangaPages || 0);
    return bScore - aScore;
  });

  return goodStates[0];
}

async function captureSelection(tab, kind) {
  await sleep(POPUP_DELAY);

  const state = await getViewerState(tab.id);
  const pages = state.visibleRendered;

  if (!pages.length) {
    throw new Error("No visible rendered pages.");
  }

  let rectEntry;

  if (kind === "left") {
    rectEntry = {
      filename: `page_${String(pages[0].mangaNumber).padStart(3, "0")}.png`,
      rect: pages[0].intersection
    };
  } else if (kind === "right") {
    const p = pages[pages.length - 1];
    rectEntry = {
      filename: `page_${String(p.mangaNumber).padStart(3, "0")}.png`,
      rect: p.intersection
    };
  } else if (kind === "spread") {
    rectEntry = {
      filename: `spread_${String(pages[0].mangaNumber).padStart(3, "0")}_${String(pages[pages.length - 1].mangaNumber).padStart(3, "0")}.png`,
      rect: unionRect(pages.map((p) => p.intersection))
    };
  } else {
    throw new Error("Unknown selection type.");
  }

  const screenshot = await captureVisibleTabPng(tab.windowId);
  const crops = await cropRectsFromScreenshot(screenshot, [rectEntry], state.viewport);

  if (!crops.length) throw new Error("Capture failed.");
  return crops[0];
}

async function downloadLeft(tab) {
  const crop = await captureSelection(tab, "left");
  await downloadPngDataUrl(crop.pngDataUrl, crop.filename);
}

async function downloadRight(tab) {
  const crop = await captureSelection(tab, "right");
  await downloadPngDataUrl(crop.pngDataUrl, crop.filename);
}

async function downloadSpread(tab) {
  const crop = await captureSelection(tab, "spread");
  await downloadPngDataUrl(crop.pngDataUrl, crop.filename);
}

async function captureVisiblePagesForZip(tab) {
  const state = await getViewerState(tab.id);
  const pages = state.visibleRendered;

  if (!pages.length) {
    return {
      totalMangaPages: state.totalMangaPages,
      items: []
    };
  }

  const screenshot = await captureVisibleTabPng(tab.windowId);
  const entries = pages.map((p) => ({
    domIndex: p.domIndex,
    mangaNumber: p.mangaNumber,
    filename: `page_${String(p.mangaNumber).padStart(3, "0")}.png`,
    rect: p.intersection
  }));

  const crops = await cropRectsFromScreenshot(screenshot, entries, state.viewport);

  return {
    totalMangaPages: state.totalMangaPages,
    items: crops.map((c) => ({
      domIndex: c.domIndex,
      mangaNumber: c.mangaNumber,
      filename: c.filename,
      pngDataUrl: c.pngDataUrl
    }))
  };
}

async function clickNext(tabId) {
  const before = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => {
      const root = document.querySelector("#xCVPages");
      const nav = document.querySelector("#xCVLeftNav");
      if (!root || !nav) return { ok: false };

      const beforeRight = getComputedStyle(root).right;
      nav.click();
      return { ok: true, beforeRight };
    }
  });

  const beforeState = before.map((x) => x.result).find((x) => x?.ok);
  if (!beforeState) return false;

  await sleep(NAV_DELAY);

  const after = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => {
      const root = document.querySelector("#xCVPages");
      if (!root) return { ok: false };
      return {
        ok: true,
        afterRight: getComputedStyle(root).right
      };
    }
  });

  const afterState = after.map((x) => x.result).find((x) => x?.ok);
  if (!afterState) return false;

  return beforeState.beforeRight !== afterState.afterRight;
}

async function runAutoZip(tab) {
  const zip = new JSZip();
  const seen = new Set();

  while (autoState.get(tab.id)?.running) {
    const batch = await captureVisiblePagesForZip(tab);

    for (const item of batch.items) {
      if (!item.pngDataUrl) continue;
      if (seen.has(item.mangaNumber)) continue;

      seen.add(item.mangaNumber);
      zip.file(item.filename, item.pngDataUrl.split(",")[1], { base64: true });
    }

    if (batch.totalMangaPages > 0 && seen.size >= batch.totalMangaPages) {
      break;
    }

    const moved = await clickNext(tab.id);
    if (!moved) break;

    await sleep(150);
  }

  const zipBlob = await zip.generateAsync({ type: "blob" });
  const zipDataUrl = await blobToDataUrl(zipBlob);

  await chrome.downloads.download({
    url: zipDataUrl,
    filename: `pages_${Date.now()}.zip`,
    saveAs: false
  });

  autoState.delete(tab.id);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    const tab = await getActiveTab();

    switch (message?.type) {
      case "DOWNLOAD_LEFT":
        await downloadLeft(tab);
        break;

      case "DOWNLOAD_RIGHT":
        await downloadRight(tab);
        break;

      case "DOWNLOAD_SPREAD":
        await downloadSpread(tab);
        break;

      case "AUTO_START":
        if (!autoState.get(tab.id)?.running) {
          autoState.set(tab.id, { running: true });
          runAutoZip(tab).catch((err) => {
            autoState.delete(tab.id);
            console.error(err);
          });
        }
        break;

      case "AUTO_STOP":
        if (autoState.get(tab.id)) {
          autoState.set(tab.id, { running: false });
        }
        break;
    }

    sendResponse({ ok: true });
  })().catch((err) => {
    console.error(err);
    sendResponse({ ok: false, error: String(err?.message || err) });
  });

  return true;
});