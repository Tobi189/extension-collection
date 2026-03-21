importScripts('jszip.min.js');

const POPUP_CLOSE_DELAY_MS = 400;
const BETWEEN_CAPTURES_MS = 150;
const AFTER_NEXT_WAIT_MS = 900;

const autoState = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true
  });

  if (!tab?.id) {
    throw new Error('No active tab.');
  }

  if (tab.url && tab.url.startsWith('chrome-extension://')) {
    const tabs = await chrome.tabs.query({});
    const pageTab = tabs.find((t) =>
      t.active &&
      t.url &&
      !t.url.startsWith('chrome-extension://') &&
      !t.url.startsWith('chrome://')
    );

    if (pageTab?.id) return pageTab;
  }

  return tab;
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    return;
  } catch {}

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js']
  });
}

async function askTab(tabId, message) {
  await ensureContentScript(tabId);
  return chrome.tabs.sendMessage(tabId, message);
}

function dataUrlToBlob(dataUrl) {
  const [meta, b64] = dataUrl.split(',');
  const mime = meta.match(/data:(.*?);base64/)?.[1] || 'image/png';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);

  for (let i = 0; i < bin.length; i += 1) {
    bytes[i] = bin.charCodeAt(i);
  }

  return new Blob([bytes], { type: mime });
}

async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function decodeImageBitmap(dataUrl) {
  return createImageBitmap(dataUrlToBlob(dataUrl));
}

function clampCrop(crop, maxW, maxH) {
  const x = Math.max(0, Math.floor(crop.x));
  const y = Math.max(0, Math.floor(crop.y));
  const w = Math.max(1, Math.floor(crop.w));
  const h = Math.max(1, Math.floor(crop.h));

  return {
    x,
    y,
    w: Math.max(1, Math.min(maxW, x + w) - x),
    h: Math.max(1, Math.min(maxH, y + h) - y)
  };
}

async function cropToPngBlob(shotDataUrl, crop) {
  const bitmap = await decodeImageBitmap(shotDataUrl);
  const safe = clampCrop(crop, bitmap.width, bitmap.height);

  const canvas = new OffscreenCanvas(safe.w, safe.h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, safe.x, safe.y, safe.w, safe.h, 0, 0, safe.w, safe.h);

  return canvas.convertToBlob({ type: 'image/png' });
}

async function downloadBlobAsFile(blob, filename) {
  const dataUrl = await blobToDataUrl(blob);
  await chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: false
  });
}

async function captureOneToBlob(tab, mode) {
  await sleep(POPUP_CLOSE_DELAY_MS);

  const info = await askTab(tab.id, { type: 'GET_READER_INFO' });
  if (!info?.ok) {
    throw new Error(info?.error || 'Failed to get reader info.');
  }

  const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const bitmap = await decodeImageBitmap(shot);

  const scaleX = bitmap.width / info.viewport.w;
  const scaleY = bitmap.height / info.viewport.h;

  let rect = info.spreadRect;
  if (mode === 'LEFT') rect = info.leftRect;
  if (mode === 'RIGHT') rect = info.rightRect;

  const crop = {
    x: rect.left * scaleX,
    y: rect.top * scaleY,
    w: rect.width * scaleX,
    h: rect.height * scaleY
  };

  const blob = await cropToPngBlob(shot, crop);
  return { blob, info };
}

async function getMovementKey(tabId) {
  const info = await askTab(tabId, { type: 'GET_READER_INFO' });
  if (!info?.ok) return null;

  const aria = info.status?.aria;
  return JSON.stringify({
    id: info.status?.activeSlideId || null,
    index: aria?.index || null,
    transformX: info.status?.transformX || null
  });
}

async function didReaderAdvance(tabId, beforeKey) {
  const start = Date.now();

  while (Date.now() - start < 3000) {
    await sleep(120);
    const afterKey = await getMovementKey(tabId);
    if (afterKey && afterKey !== beforeKey) return true;
  }

  return false;
}

function addBlobToZip(state, blob) {
  const n = String(state.fileIndex).padStart(3, '0');
  state.zip.file(`${n}.png`, blob);
  state.fileIndex += 1;
}

async function finalizeZipAndDownload(tabId, reason = 'done') {
  const state = autoState.get(tabId);
  if (!state) return;

  try {
    if (state.fileIndex === 1) {
      autoState.delete(tabId);
      return;
    }

    const zipBlob = await state.zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    });

    await downloadBlobAsFile(zipBlob, `splide_reader_${reason}_${Date.now()}.zip`);
  } finally {
    autoState.delete(tabId);
  }
}

async function runAutoZip(tab) {
  const state = autoState.get(tab.id);
  if (!state) return;

  const seen = new Set();

  while (!state.stop) {
    try {
      const info = await askTab(tab.id, { type: 'GET_READER_INFO' });
      console.log('AUTO info:', info);

      if (!info?.ok) {
        console.log('STOP: GET_READER_INFO failed');
        break;
      }

      const aria = info.status?.aria;
      const currentKey = JSON.stringify({
        id: info.status?.activeSlideId || null,
        index: aria?.index || null,
        transformX: info.status?.transformX || null
      });

      console.log('AUTO currentKey:', currentKey);

      if (seen.has(currentKey)) {
        console.log('STOP: seen duplicate key');
        break;
      }
      seen.add(currentKey);

      if (!info.twoPages) {
        const side = info.singleSide || 'LEFT';
        console.log('CAPTURE single side:', side);
        const capture = await captureOneToBlob(tab, side);
        addBlobToZip(state, capture.blob);
      } else {
        console.log('CAPTURE right');
        const right = await captureOneToBlob(tab, 'RIGHT');
        addBlobToZip(state, right.blob);

        if (state.stop) break;
        await sleep(BETWEEN_CAPTURES_MS);

        console.log('CAPTURE left');
        const left = await captureOneToBlob(tab, 'LEFT');
        addBlobToZip(state, left.blob);
      }

      if (state.stop) break;

      const beforeKey = await getMovementKey(tab.id);
      console.log('AUTO before move key:', beforeKey);

      const nav = await askTab(tab.id, { type: 'GO_NEXT' });
      console.log('AUTO nav result:', nav);

      if (!nav?.ok) {
        console.log('STOP: GO_NEXT failed');
        break;
      }

      await sleep(AFTER_NEXT_WAIT_MS);

      const moved = await didReaderAdvance(tab.id, beforeKey);
      console.log('AUTO moved:', moved);

      if (!moved) {
        console.log('STOP: didReaderAdvance false');
        break;
      }
    } catch (err) {
      console.error('STOP: exception', err);
      break;
    }
  }

  await finalizeZipAndDownload(tab.id, state.stop ? 'stopped' : 'end');
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      const tab = await getActiveTab();

      if (msg?.type === 'CAPTURE_LEFT') {
        const result = await captureOneToBlob(tab, 'LEFT');
        await downloadBlobAsFile(result.blob, `left_${Date.now()}.png`);
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === 'CAPTURE_RIGHT') {
        const result = await captureOneToBlob(tab, 'RIGHT');
        await downloadBlobAsFile(result.blob, `right_${Date.now()}.png`);
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === 'CAPTURE_SPREAD') {
        const result = await captureOneToBlob(tab, 'SPREAD');
        await downloadBlobAsFile(result.blob, `spread_${Date.now()}.png`);
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === 'TOGGLE_OVERLAY') {
        const result = await askTab(tab.id, { type: 'TOGGLE_OVERLAY' });
        sendResponse(result);
        return;
      }

      if (msg?.type === 'AUTO_START') {
        if (autoState.has(tab.id)) {
          sendResponse({ ok: true, alreadyRunning: true });
          return;
        }

        autoState.set(tab.id, {
          stop: false,
          fileIndex: 1,
          zip: new JSZip()
        });

        runAutoZip(tab);
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === 'AUTO_STOP') {
        const state = autoState.get(tab.id);
        if (state) state.stop = true;
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === 'READER_STATUS') {
        const info = await askTab(tab.id, { type: 'GET_READER_INFO' });
        sendResponse({ ok: true, info });
        return;
      }

      sendResponse({ ok: false, error: 'Unknown command.' });
    } catch (err) {
      console.error(err);
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
  })();

  return true;
});