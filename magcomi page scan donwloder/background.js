/* global JSZip */
importScripts("jszip.min.js");

// ------------ CONFIG ------------
const CANVAS_SEL = "canvas.page-image.js-page-image";
const SPREAD_CONTAINER_SEL = "div.image-container.js-viewer-content.is-spread";

// RTL navigation anchors (swap if “next” behaves opposite)
const NEXT_SEL = "a.page-navigation-forward.rtl.js-slide-forward";
const PREV_SEL = "a.page-navigation-backward.rtl.js-slide-backward";

// Timing
const POPUP_CLOSE_DELAY_MS = 650;
const BETWEEN_CAPTURES_MS = 220;
const AFTER_NEXT_WAIT_MS = 650;
const END_CHECK_MS = 900;
const END_EPS_PX = 1.5;

// SIMPLE FIX: skip tiny “empty” images
const MIN_PNG_BYTES = 50 * 1024; // 50 KB. Raise to 80KB if needed.

// Auto state per tab
// tabId -> { stop, pageIndex, fileIndex, zip, startedAt, namePrefix }
const autoState = new Map();

// ------------ helpers ------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab.");
  return tab;
}

function dataUrlToBlob(dataUrl) {
  const [meta, b64] = dataUrl.split(",");
  const mime = meta.match(/data:(.*?);base64/)?.[1] || "image/png";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

async function blobToDataUrl(blob) {
  return await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function decodeImageBitmap(dataUrl) {
  const blob = dataUrlToBlob(dataUrl);
  return await createImageBitmap(blob);
}

function clampCrop(crop, maxW, maxH) {
  const x = Math.max(0, Math.floor(crop.x));
  const y = Math.max(0, Math.floor(crop.y));
  const w = Math.max(1, Math.floor(crop.w));
  const h = Math.max(1, Math.floor(crop.h));

  const x2 = Math.min(maxW, x + w);
  const y2 = Math.min(maxH, y + h);

  return { x, y, w: Math.max(1, x2 - x), h: Math.max(1, y2 - y) };
}

async function cropToPngBlob(shotDataUrl, crop) {
  const bmp = await decodeImageBitmap(shotDataUrl);
  const safe = clampCrop(crop, bmp.width, bmp.height);

  const canvas = new OffscreenCanvas(safe.w, safe.h);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bmp, safe.x, safe.y, safe.w, safe.h, 0, 0, safe.w, safe.h);

  return await canvas.convertToBlob({ type: "image/png" });
}

async function downloadBlobAsFile(blob, filename) {
  const dataUrl = await blobToDataUrl(blob);
  await chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: false
  });
}

async function getFrameInfo(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: (CANVAS_SELECTOR, CONTAINER_SEL) => {
      function rectOk(r) {
        if (!r) return false;
        if (r.width < 30 || r.height < 30) return false;
        const vw = window.innerWidth, vh = window.innerHeight;
        const overlapW = Math.min(r.right, vw) - Math.max(r.left, 0);
        const overlapH = Math.min(r.bottom, vh) - Math.max(r.top, 0);
        return overlapW > 10 && overlapH > 10;
      }

      function getSideForCanvas(c) {
        const wrap = c.closest(".page-area.js-page-area");
        if (!wrap) return "LEFT"; // default
        if (wrap.classList.contains("align-right")) return "RIGHT";
        if (wrap.classList.contains("align-left")) return "LEFT";
        return "LEFT";
      }

      const canvases = Array.from(document.querySelectorAll(CANVAS_SELECTOR));

      // Score visible canvases and keep their DOM node + rect
      const scored = [];
      for (const c of canvases) {
        const r = c.getBoundingClientRect();
        if (!rectOk(r)) continue;

        const area = r.width * r.height;
        const vw = window.innerWidth, vh = window.innerHeight;
        const overlapW = Math.min(r.right, vw) - Math.max(r.left, 0);
        const overlapH = Math.min(r.bottom, vh) - Math.max(r.top, 0);
        const visArea = Math.max(0, overlapW) * Math.max(0, overlapH);

        scored.push({ c, r, score: area + visArea * 2 });
      }

      if (scored.length < 1) {
        return { ok: false, error: "No visible page canvases in this frame." };
      }

      scored.sort((a, b) => b.score - a.score);

      // Top1 always exists
      const top1 = scored[0];
      const top2 = scored[1] || null;

      let leftRect, rightRect, twoPages, singleSide;

      if (top2) {
        // Two-page mode: decide left/right by x position
        const r1 = top1.r, r2 = top2.r;
        const left = r1.left <= r2.left ? r1 : r2;
        const right = r1.left <= r2.left ? r2 : r1;

        leftRect = left;
        rightRect = right;
        twoPages = true;
        singleSide = null;
      } else {
        // Single-page mode: only one canvas is meaningful
        leftRect = top1.r;
        rightRect = top1.r;
        twoPages = false;
        singleSide = getSideForCanvas(top1.c); // "LEFT" or "RIGHT"
      }

      const spreadRect = {
        left: Math.min(leftRect.left, rightRect.left),
        top: Math.min(leftRect.top, rightRect.top),
        width: Math.max(leftRect.right, rightRect.right) - Math.min(leftRect.left, rightRect.left),
        height: Math.max(leftRect.bottom, rightRect.bottom) - Math.min(leftRect.top, rightRect.top)
      };

      const container = document.querySelector(CONTAINER_SEL);
      const rightCss = container ? getComputedStyle(container).right : null;
      const rightOffset = rightCss ? parseFloat(rightCss) : null;

      return {
        ok: true,
        viewport: { w: window.innerWidth, h: window.innerHeight },
        leftRect: { left: leftRect.left, top: leftRect.top, width: leftRect.width, height: leftRect.height },
        rightRect: { left: rightRect.left, top: rightRect.top, width: rightRect.width, height: rightRect.height },
        spreadRect,
        rightOffset,
        twoPages,
        singleSide // "LEFT" or "RIGHT" when twoPages=false
      };
    },
    args: [CANVAS_SEL, SPREAD_CONTAINER_SEL]
  });

  // choose best frame by spread area
  let best = null;
  let bestArea = -1;
  let bestErr = null;

  for (const r of results) {
    const res = r?.result;
    if (!res) continue;
    if (res.ok) {
      const area = res.spreadRect.width * res.spreadRect.height;
      if (area > bestArea) {
        bestArea = area;
        best = res;
      }
    } else if (!bestErr) {
      bestErr = res;
    }
  }

  if (best) return best;
  throw new Error(bestErr?.error || "No frame returned usable canvas rects.");
}

// ------------ click nav across frames ------------
async function clickNav(tabId, selector) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: (sel) => {
      const el = document.querySelector(sel);
      if (!el) return { ok: false };

      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));

      return { ok: true };
    },
    args: [selector]
  });

  return results.some((r) => r?.result?.ok);
}

// ------------ capture one to blob ------------
async function captureOneToBlob(tab, mode) {
  await sleep(POPUP_CLOSE_DELAY_MS);

  const info = await getFrameInfo(tab.id);

  const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const bmp = await decodeImageBitmap(shot);

  const scaleX = bmp.width / info.viewport.w;
  const scaleY = bmp.height / info.viewport.h;

  let rect = info.spreadRect;
  if (mode === "LEFT") rect = info.leftRect;
  if (mode === "RIGHT") rect = info.rightRect;

  const crop = {
    x: rect.left * scaleX,
    y: rect.top * scaleY,
    w: rect.width * scaleX,
    h: rect.height * scaleY
  };

  const blob = await cropToPngBlob(shot, crop);
  return { blob, rightOffset: info.rightOffset };
}

// ------------ end detection ------------
async function didMoveAfterNext(tabId, beforeOffset) {
  const start = Date.now();

  while (Date.now() - start < END_CHECK_MS) {
    await sleep(80);
    try {
      const info = await getFrameInfo(tabId);
      if (typeof info.rightOffset === "number" && typeof beforeOffset === "number") {
        if (Math.abs(info.rightOffset - beforeOffset) > END_EPS_PX) return true;
      }
    } catch {
      // ignore
    }
  }
  return false;
}

// ------------ zip finalize ------------
async function finalizeZipAndDownload(tabId, reason = "end") {
  const st = autoState.get(tabId);
  if (!st) return;

  try {
    const zipBlob = await st.zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 6 }
    });

    const zipName = `${st.namePrefix}_${reason}_${Date.now()}.zip`;
    await downloadBlobAsFile(zipBlob, zipName);
  } finally {
    autoState.delete(tabId);
  }
}

// ------------ SIMPLE FIX: add file if not tiny ------------
function addToZipIfGood(st, blob) {
  if (blob.size < MIN_PNG_BYTES) {
    // skip bad/empty
    return false;
  }
  const n = String(st.fileIndex).padStart(3, "0"); // change 3->4 if you want 0001
  st.zip.file(`${n}.png`, blob);
  st.fileIndex += 1;
  return true;
}

// ------------ AUTO LOOP (ZIP) ------------
async function runAutoZip(tab) {
  const st = autoState.get(tab.id);
  if (!st) return;

  while (!st.stop) {
    try {
      // Check whether we are in single-page or two-page mode
      const frame = await getFrameInfo(tab.id);

      if (!frame.twoPages) {
        // Single page: capture ONLY the side that exists
        const side = frame.singleSide || "LEFT";
        const r = await captureOneToBlob(tab, side);

        const n = String(st.fileIndex).padStart(3, "0");
        st.zip.file(`${n}.png`, r.blob);
        st.fileIndex += 1;

      } else {
        // Two pages: capture RIGHT then LEFT (or swap if you want)
        const r1 = await captureOneToBlob(tab, "RIGHT");
        {
          const n1 = String(st.fileIndex).padStart(3, "0");
          st.zip.file(`${n1}.png`, r1.blob);
          st.fileIndex += 1;
        }
        if (st.stop) break;

        await sleep(BETWEEN_CAPTURES_MS);

        const r2 = await captureOneToBlob(tab, "LEFT");
        {
          const n2 = String(st.fileIndex).padStart(3, "0");
          st.zip.file(`${n2}.png`, r2.blob);
          st.fileIndex += 1;
        }
        if (st.stop) break;
      }

      // Offset before next
      let before = null;
      try {
        before = frame.rightOffset;
      } catch {}

      // Next
      const clicked = await clickNav(tab.id, NEXT_SEL);
      if (!clicked) {
        console.warn("NEXT not found; stopping.");
        break;
      }

      await sleep(AFTER_NEXT_WAIT_MS);

      // End?
      if (typeof before === "number") {
        const moved = await didMoveAfterNext(tab.id, before);
        if (!moved) {
          console.warn("Offset did not change; end reached.");
          break;
        }
      }

      st.pageIndex += 1;
    } catch (e) {
      console.error("Auto capture failed:", e);
      break;
    }
  }

  await finalizeZipAndDownload(tab.id, st.stop ? "stopped" : "end");
}

// ------------ messages ------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      const tab = await getActiveTab();

      // Manual downloads (still available)
      if (msg?.type === "CAPTURE_LEFT") {
        const r = await captureOneToBlob(tab, "LEFT");
        await downloadBlobAsFile(r.blob, `left_${Date.now()}.png`);
        sendResponse({ ok: true });
        return;
      }
      if (msg?.type === "CAPTURE_RIGHT") {
        const r = await captureOneToBlob(tab, "RIGHT");
        await downloadBlobAsFile(r.blob, `right_${Date.now()}.png`);
        sendResponse({ ok: true });
        return;
      }
      if (msg?.type === "CAPTURE_SPREAD") {
        const r = await captureOneToBlob(tab, "SPREAD");
        await downloadBlobAsFile(r.blob, `spread_${Date.now()}.png`);
        sendResponse({ ok: true });
        return;
      }

      // Auto ZIP start/stop
      if (msg?.type === "AUTO_START") {
        if (autoState.has(tab.id)) {
          sendResponse({ ok: true, alreadyRunning: true });
          return;
        }
        autoState.set(tab.id, {
          stop: false,
          pageIndex: 1,
          fileIndex: 1,
          zip: new JSZip(),
          startedAt: Date.now(),
          namePrefix: "magcomi_pages"
        });

        runAutoZip(tab); // fire & forget
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === "AUTO_STOP") {
        const st = autoState.get(tab.id);
        if (st) st.stop = true;
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: false, error: "Unknown command." });
    } catch (e) {
      console.error("Background error:", e);
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();

  return true;
});