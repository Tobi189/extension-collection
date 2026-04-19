/* global JSZip */
importScripts("jszip.min.js");

// ------------ CONFIG ------------
const ACTIVE_SLIDE_SEL =
  ".swiper-slide.swiper-slide-active";
const NEXT_SLIDE_SEL =
  ".swiper-slide.swiper-slide-next";
const PREV_SLIDE_SEL =
  ".swiper-slide.swiper-slide-prev";

const CANVAS_IN_SLIDE_SEL =
  "canvas.relative.max-h-full.max-w-full";

const LEFT_HIT_SEL = "#viewercomic-main-left";
const RIGHT_HIT_SEL = "#viewercomic-main-right";
const WRAPPER_SEL = ".swiper-wrapper";

const POPUP_CLOSE_DELAY_MS = 650;
const BETWEEN_CAPTURES_MS = 220;
const AFTER_MOVE_WAIT_MS = 650;
const END_CHECK_MS = 900;
const END_EPS_PX = 1.5;

// ------------ STATE ------------
const autoState = new Map();

// ------------ HELPERS ------------
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

function parseTranslateX(transformText) {
  if (!transformText) return null;

  let m = transformText.match(/translate3d\(\s*([-0-9.]+)px\s*,/i);
  if (m) return parseFloat(m[1]);

  m = transformText.match(/matrix\(\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*([-0-9.]+)\s*,/i);
  if (m) return parseFloat(m[1]);

  return null;
}

async function getViewerInfo(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: ({ WRAPPER_SEL, CANVAS_SEL }) => {
      function rectOk(r) {
        if (!r) return false;
        if (r.width < 40 || r.height < 40) return false;

        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const overlapW = Math.min(r.right, vw) - Math.max(r.left, 0);
        const overlapH = Math.min(r.bottom, vh) - Math.max(r.top, 0);

        return overlapW > 20 && overlapH > 20;
      }

      function visibleArea(r) {
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const overlapW = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
        const overlapH = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
        return overlapW * overlapH;
      }

      function parseTranslateX(transformText) {
        if (!transformText) return null;

        let m = transformText.match(/translate3d\(\s*([-0-9.]+)px\s*,/i);
        if (m) return parseFloat(m[1]);

        m = transformText.match(/matrix\(\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*([-0-9.]+)\s*,/i);
        if (m) return parseFloat(m[1]);

        return null;
      }

      function getIndicator() {
        const nodes = Array.from(document.querySelectorAll("div, span"));
        for (const el of nodes) {
          const txt = (el.textContent || "").trim();
          const m = txt.match(/^(\d+)\s*\/\s*(\d+)$/);
          if (m) {
            return {
              current: parseInt(m[1], 10),
              total: parseInt(m[2], 10)
            };
          }
        }
        return null;
      }

      const wrapper = document.querySelector(WRAPPER_SEL);
      if (!wrapper) {
        return { ok: false, error: "swiper wrapper not found" };
      }

      // ONLY use actual visible canvases as pages
      const canvases = Array.from(document.querySelectorAll(CANVAS_SEL))
        .map((canvas) => {
          const rect = canvas.getBoundingClientRect();
          const slide = canvas.closest(".swiper-slide");
          return { canvas, rect, slide };
        })
        .filter((x) => rectOk(x.rect))
        .map((x) => ({
          ...x,
          area: visibleArea(x.rect)
        }))
        .filter((x) => x.area > 20000) // ignore tiny junk
        .sort((a, b) => {
          // left-to-right
          if (Math.abs(a.rect.left - b.rect.left) > 8) {
            return a.rect.left - b.rect.left;
          }
          return b.area - a.area;
        });

      if (!canvases.length) {
        return { ok: false, error: "No visible real page canvases found." };
      }

      // keep at most 2 visible real pages
      const pageCanvases = canvases.slice(0, 2);

      const leftRect = {
        left: pageCanvases[0].rect.left,
        top: pageCanvases[0].rect.top,
        width: pageCanvases[0].rect.width,
        height: pageCanvases[0].rect.height,
        right: pageCanvases[0].rect.right,
        bottom: pageCanvases[0].rect.bottom
      };

      const rightRect = pageCanvases[1]
        ? {
            left: pageCanvases[1].rect.left,
            top: pageCanvases[1].rect.top,
            width: pageCanvases[1].rect.width,
            height: pageCanvases[1].rect.height,
            right: pageCanvases[1].rect.right,
            bottom: pageCanvases[1].rect.bottom
          }
        : leftRect;

      const spreadRect = {
        left: Math.min(leftRect.left, rightRect.left),
        top: Math.min(leftRect.top, rightRect.top),
        width: Math.max(leftRect.right, rightRect.right) - Math.min(leftRect.left, rightRect.left),
        height: Math.max(leftRect.bottom, rightRect.bottom) - Math.min(leftRect.top, rightRect.top)
      };

      const styleText = wrapper.getAttribute("style") || "";
      const translateX =
        parseTranslateX(styleText) ?? parseTranslateX(getComputedStyle(wrapper).transform);

      const indicator = getIndicator();

      let currentLeft = null;
      let currentRight = null;
      let totalPages = null;

      if (indicator) {
        totalPages = indicator.total;
        currentLeft = indicator.current;
        currentRight =
          pageCanvases.length === 2
            ? Math.min(indicator.current + 1, indicator.total)
            : null;
      }

      return {
        ok: true,
        viewport: { w: window.innerWidth, h: window.innerHeight },
        leftRect,
        rightRect,
        spreadRect,
        translateX,
        twoPages: pageCanvases.length === 2,
        currentLeft,
        currentRight,
        totalPages
      };
    },
    args: [{
      WRAPPER_SEL: ".swiper-wrapper",
      CANVAS_SEL: ".swiper-slide canvas.relative.max-h-full.max-w-full"
    }]
  });

  if (!result?.ok) {
    throw new Error(result?.error || "Could not read viewer info.");
  }

  return result;
}

async function clickZone(tabId, selector) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (sel) => {
      const el = document.querySelector(sel);
      if (!el) return { ok: false, error: "Click target not found." };

      const rect = el.getBoundingClientRect();
      const x = rect.left + Math.min(rect.width / 2, 40);
      const y = rect.top + rect.height / 2;

      const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
      el.dispatchEvent(new MouseEvent("mousemove", opts));
      el.dispatchEvent(new MouseEvent("mousedown", opts));
      el.dispatchEvent(new MouseEvent("mouseup", opts));
      el.dispatchEvent(new MouseEvent("click", opts));

      return { ok: true };
    },
    args: [selector]
  });

  return !!result?.ok;
}

async function captureOneToBlob(tab, mode) {
  await sleep(POPUP_CLOSE_DELAY_MS);

  const info = await getViewerInfo(tab.id);
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
  return {
    blob,
    translateX: info.translateX,
    twoPages: info.twoPages,
    currentLeft: info.currentLeft,
    currentRight: info.currentRight,
    totalPages: info.totalPages
  };
}

async function didMoveAfterClick(tabId, beforeTranslateX) {
  const start = Date.now();

  while (Date.now() - start < END_CHECK_MS) {
    await sleep(80);
    try {
      const info = await getViewerInfo(tabId);
      if (typeof info.translateX === "number" && typeof beforeTranslateX === "number") {
        if (Math.abs(info.translateX - beforeTranslateX) > END_EPS_PX) return true;
      }
    } catch {
      // ignore
    }
  }

  return false;
}

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

function addBlobToZip(st, blob) {
  if (!blob || blob.size < 30000) return false;

  const n = String(st.fileIndex).padStart(3, "0");
  st.zip.file(`${n}.png`, blob);
  st.fileIndex += 1;
  return true;
}

async function runAutoZip(tab) {
  const st = autoState.get(tab.id);
  if (!st) return;

  while (!st.stop) {
    try {
      const frame = await getViewerInfo(tab.id);

      if (frame.twoPages) {
        const rRight = await captureOneToBlob(tab, "RIGHT");
        addBlobToZip(st, rRight.blob);
        if (st.stop) break;

        await sleep(BETWEEN_CAPTURES_MS);

        const rLeft = await captureOneToBlob(tab, "LEFT");
        addBlobToZip(st, rLeft.blob);
        if (st.stop) break;
      } else {
        const rSingle = await captureOneToBlob(tab, "LEFT");
        addBlobToZip(st, rSingle.blob);
        if (st.stop) break;
      }

      const before = frame.translateX;

      const clicked = await clickZone(tab.id, LEFT_HIT_SEL);
      if (!clicked) {
        break;
      }

      await sleep(AFTER_MOVE_WAIT_MS);

      if (typeof before === "number") {
        const moved = await didMoveAfterClick(tab.id, before);
        if (!moved) {
          break;
        }
      }
    } catch (e) {
      console.error("Auto capture failed:", e);
      break;
    }
  }

  await finalizeZipAndDownload(tab.id, st.stop ? "stopped" : "end");
}

// ------------ MESSAGES ------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      const tab = await getActiveTab();

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

      if (msg?.type === "GET_STATUS") {
        const info = await getViewerInfo(tab.id);
        sendResponse({ ok: true, ...info });
        return;
      }

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
          namePrefix: "ynjn_pages"
        });

        runAutoZip(tab);
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