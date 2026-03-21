importScripts("jszip.min.js");

const autoState = new Map();

let controlsWindowId = null;
let readerTabId = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isUsableTab(tab) {
  return !!(
    tab &&
    typeof tab.id === "number" &&
    tab.url &&
    !tab.url.startsWith("chrome://") &&
    !tab.url.startsWith("chrome-extension://") &&
    !tab.url.startsWith("edge://") &&
    !tab.url.startsWith("about:")
  );
}

async function rememberReaderTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true
  });

  if (isUsableTab(tab)) {
    readerTabId = tab.id;
    return tab;
  }

  return null;
}

async function getReaderTab() {
  if (readerTabId) {
    const remembered = await chrome.tabs.get(readerTabId).catch(() => null);
    if (isUsableTab(remembered)) {
      return remembered;
    }
  }

  const [activeTab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true
  });

  if (isUsableTab(activeTab)) {
    readerTabId = activeTab.id;
    return activeTab;
  }

  const tabs = await chrome.tabs.query({});
  const fallback = tabs.find(isUsableTab);

  if (fallback) {
    readerTabId = fallback.id;
    return fallback;
  }

  throw new Error("No reader tab found.");
}

async function openControlsWindow() {
  await rememberReaderTab();

  const existing = controlsWindowId
    ? await chrome.windows.get(controlsWindowId).catch(() => null)
    : null;

  if (existing) {
    await chrome.windows.update(existing.id, {
      focused: true,
      drawAttention: true
    });
    return;
  }

  const win = await chrome.windows.create({
    url: chrome.runtime.getURL("controls.html"),
    type: "popup",
    width: 380,
    height: 560,
    focused: true
  });

  controlsWindowId = win.id;
}

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === controlsWindowId) {
    controlsWindowId = null;
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (isUsableTab(tab)) {
    readerTabId = tab.id;
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && isUsableTab(tab)) {
    if (tab.active) {
      readerTabId = tabId;
    }
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "open_controls") return;

  try {
    await openControlsWindow();
  } catch (err) {
    console.error("Failed to open controls window:", err);
  }
});

async function ensureContentScript(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: "PING" });
    if (pong?.ok) return;
  } catch {}

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"]
  });

  const pong = await chrome.tabs.sendMessage(tabId, { type: "PING" }).catch(() => null);
  if (!pong?.ok) {
    throw new Error("Failed to initialize content script on the reader tab.");
  }
}

async function askTab(tabId, message) {
  await ensureContentScript(tabId);
  return await chrome.tabs.sendMessage(tabId, message);
}

function dataUrlToBlob(dataUrl) {
  const [meta, b64] = dataUrl.split(",");
  const mime = meta.match(/data:(.*?);base64/)?.[1] || "application/octet-stream";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);

  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }

  return new Blob([bytes], { type: mime });
}

async function blobToDataUrl(blob) {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Failed to read blob."));
    reader.readAsDataURL(blob);
  });
}

async function downloadBlob(blob, filename) {
  const dataUrl = await blobToDataUrl(blob);
  await chrome.downloads.download({
    url: dataUrl,
    filename,
    saveAs: false
  });
}

async function exportPageBlob(tabId, pageIndex) {
  const res = await askTab(tabId, { type: "EXPORT_PAGE_IMAGE", pageIndex });

  if (!res?.ok || !res.dataUrl) {
    throw new Error(res?.error || `Failed to export page ${pageIndex}`);
  }

  return dataUrlToBlob(res.dataUrl);
}

function pad(n) {
  return String(n).padStart(3, "0");
}

async function getReaderInfoOrThrow(tabId) {
  const info = await askTab(tabId, { type: "GET_READER_INFO" });
  if (!info?.ok) {
    throw new Error(info?.error || "Reader not found.");
  }
  return info;
}

async function downloadVisiblePage(tabId, side) {
  const info = await getReaderInfoOrThrow(tabId);

  const target = side === "RIGHT" ? info.rightPage : info.leftPage;
  if (!target) {
    throw new Error(`No visible ${side.toLowerCase()} page.`);
  }

  const blob = await exportPageBlob(tabId, target.index);
  await downloadBlob(blob, `${pad(target.index)}.png`);
  return target.index;
}

async function blobToImageBitmap(blob) {
  return await createImageBitmap(blob);
}

async function combineSpreadToBlob(leftBlob, rightBlob) {
  const leftBitmap = leftBlob ? await blobToImageBitmap(leftBlob) : null;
  const rightBitmap = rightBlob ? await blobToImageBitmap(rightBlob) : null;

  if (!leftBitmap && !rightBitmap) {
    throw new Error("No visible pages were available.");
  }

  if (leftBitmap && !rightBitmap) {
    const canvas = new OffscreenCanvas(leftBitmap.width, leftBitmap.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(leftBitmap, 0, 0);
    return await canvas.convertToBlob({ type: "image/png" });
  }

  if (!leftBitmap && rightBitmap) {
    const canvas = new OffscreenCanvas(rightBitmap.width, rightBitmap.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(rightBitmap, 0, 0);
    return await canvas.convertToBlob({ type: "image/png" });
  }

  const width = leftBitmap.width + rightBitmap.width;
  const height = Math.max(leftBitmap.height, rightBitmap.height);

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");

  ctx.drawImage(leftBitmap, 0, 0);
  ctx.drawImage(rightBitmap, leftBitmap.width, 0);

  return await canvas.convertToBlob({ type: "image/png" });
}

async function downloadVisibleSpreadImage(tabId) {
  const info = await getReaderInfoOrThrow(tabId);

  let leftBlob = null;
  let rightBlob = null;

  if (info.leftPage) {
    leftBlob = await exportPageBlob(tabId, info.leftPage.index);
  }

  if (info.rightPage && info.rightPage.index !== info.leftPage?.index) {
    rightBlob = await exportPageBlob(tabId, info.rightPage.index);
  }

  const spreadBlob = await combineSpreadToBlob(leftBlob, rightBlob);
  const leftIndex = info.leftPage?.index;
  const rightIndex = info.rightPage?.index;

  const filename =
    leftIndex != null && rightIndex != null && rightIndex !== leftIndex
      ? `spread_${pad(leftIndex)}_${pad(rightIndex)}.png`
      : `spread_${pad(leftIndex ?? rightIndex ?? 0)}.png`;

  await downloadBlob(spreadBlob, filename);

  return {
    leftIndex,
    rightIndex,
    filename
  };
}

async function runAutoZip(tab) {
  const state = autoState.get(tab.id);
  if (!state) return;

  const seen = new Set();

  try {
    while (!state.stop) {
      const info = await askTab(tab.id, { type: "GET_READER_INFO" });
      if (!info?.ok) {
        throw new Error(info?.error || "Reader info unavailable.");
      }

      const key = JSON.stringify({
        left: info.leftPage?.index ?? null,
        right: info.rightPage?.index ?? null,
        counter: info.counterText ?? null
      });

      if (seen.has(key)) {
        break;
      }
      seen.add(key);

      const indexes = [];
      if (info.leftPage) indexes.push(info.leftPage.index);
      if (info.rightPage && info.rightPage.index !== info.leftPage?.index) {
        indexes.push(info.rightPage.index);
      }

      for (const index of indexes) {
        if (state.addedPages.has(index)) continue;
        state.zip.file(`${pad(index)}.png`, await exportPageBlob(tab.id, index));
        state.addedPages.add(index);
      }

      const moveRes = await askTab(tab.id, { type: "GO_NEXT" });
      if (!moveRes?.ok) {
        break;
      }

      await sleep(900);

      const moved = await askTab(tab.id, {
        type: "HAS_PAGE_CHANGED",
        previousKey: key
      });

      if (!moved?.ok || !moved.changed) {
        break;
      }
    }

    if (!state.addedPages.size) {
      state.lastResult = { ok: false, error: "No pages were captured." };
      autoState.delete(tab.id);
      return;
    }

    const zipBlob = await state.zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 6 }
    });

    const filename = `comicfuz_${Date.now()}.zip`;
    await downloadBlob(zipBlob, filename);

    state.lastResult = {
      ok: true,
      done: true,
      pageCount: state.addedPages.size,
      filename
    };
  } catch (err) {
    state.lastResult = {
      ok: false,
      done: true,
      error: String(err?.message || err)
    };
  } finally {
    autoState.delete(tab.id);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      const tab = await getReaderTab();

      if (msg?.type === "READER_STATUS") {
        const info = await askTab(tab.id, { type: "GET_READER_INFO" });
        sendResponse({ ok: true, info, tabId: tab.id, tabUrl: tab.url });
        return;
      }

      if (msg?.type === "CAPTURE_LEFT") {
        const index = await downloadVisiblePage(tab.id, "LEFT");
        sendResponse({ ok: true, pageIndex: index });
        return;
      }

      if (msg?.type === "CAPTURE_RIGHT") {
        const index = await downloadVisiblePage(tab.id, "RIGHT");
        sendResponse({ ok: true, pageIndex: index });
        return;
      }

      if (msg?.type === "CAPTURE_SPREAD") {
        const result = await downloadVisibleSpreadImage(tab.id);
        sendResponse({ ok: true, ...result });
        return;
      }

      if (msg?.type === "AUTO_START") {
        if (autoState.has(tab.id)) {
          sendResponse({ ok: true, alreadyRunning: true });
          return;
        }

        autoState.set(tab.id, {
          stop: false,
          zip: new JSZip(),
          addedPages: new Set(),
          lastResult: null
        });

        runAutoZip(tab);
        sendResponse({ ok: true, started: true });
        return;
      }

      if (msg?.type === "AUTO_STOP") {
        const state = autoState.get(tab.id);
        if (!state) {
          sendResponse({ ok: true, wasRunning: false });
          return;
        }

        state.stop = true;
        sendResponse({ ok: true, wasRunning: true });
        return;
      }

      if (msg?.type === "AUTO_STATUS") {
        const state = autoState.get(tab.id);
        if (!state) {
          sendResponse({ ok: true, running: false });
          return;
        }

        sendResponse({
          ok: true,
          running: !state.stop,
          pageCount: state.addedPages.size
        });
        return;
      }

      sendResponse({ ok: false, error: "Unknown command." });
    } catch (err) {
      console.error(err);
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
  })();

  return true;
});