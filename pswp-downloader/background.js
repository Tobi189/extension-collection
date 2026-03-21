async function notify(title, message) {
  try {
    await chrome.notifications.create({
      type: "basic",
      iconUrl: "icon128.png",
      title,
      message
    });
  } catch (e) {
    console.log(title + ": " + message);
  }
}

chrome.runtime.onInstalled.addListener(() => {
  console.log("Extension installed/updated.");
});

chrome.commands.onCommand.addListener(async (command) => {
  console.log("onCommand fired:", command);

  if (command !== "start-download") return;

  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true
    });

    if (!tab?.id) {
      await notify("Downloader", "Shortcut fired, but no active tab was found.");
      return;
    }

    const result = await runDownloader(tab.id, 1200);

    if (result?.ok) {
      await notify("Downloader", result.message || "Download complete.");
    } else {
      await notify("Downloader", result?.message || "Download failed.");
    }
  } catch (error) {
    console.error("Shortcut failed:", error);
    await notify("Downloader", "Shortcut fired, but an error occurred: " + (error?.message || String(error)));
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "download-file") {
    chrome.downloads.download(
      {
        url: message.url,
        filename: message.filename,
        saveAs: false
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          sendResponse({
            ok: false,
            error: chrome.runtime.lastError.message
          });
          return;
        }

        sendResponse({
          ok: true,
          downloadId
        });
      }
    );

    return true;
  }

  if (message.type === "start-download") {
    const tabId = sender.tab?.id ?? message.tabId;
    const delayMs = Number(message.delayMs || 1200);

    if (!tabId) {
      sendResponse({ ok: false, message: "No active tab found." });
      return false;
    }

    runDownloader(tabId, delayMs)
      .then((result) => sendResponse(result))
      .catch((error) =>
        sendResponse({
          ok: false,
          message: error?.message || String(error)
        })
      );

    return true;
  }
});

async function runDownloader(tabId, delayMs) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: startDownloadInPage,
    args: [delayMs]
  });

  return result;
}

async function startDownloadInPage(delayMs = 1200) {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const selectors = {
    img: ".pswp__img",
    next: ".pswp__button.pswp__button--arrow--next, .pswp__button--arrow--next",
    counter: ".pswp__counter",
    activeSlide: ".pswp__item[aria-hidden='false']"
  };

  function sanitizeFolderName(name) {
    return (name || "downloads")
      .replace(/[\\/:*?\"<>|]/g, "_")
      .replace(/\s+/g, " ")
      .trim();
  }

  function getCounterInfo() {
    const counter = document.querySelector(selectors.counter);
    if (!counter) return null;

    const text = (counter.textContent || "").trim();
    const match = text.match(/(\d+)\s*\/\s*(\d+)/);
    if (!match) return null;

    return {
      current: Number(match[1]),
      total: Number(match[2])
    };
  }

  function getVisibleImage() {
    const activeSlide = document.querySelector(selectors.activeSlide);
    if (activeSlide) {
      const img = activeSlide.querySelector(selectors.img);
      if (img && (img.currentSrc || img.src)) return img;
    }

    const imgs = Array.from(document.querySelectorAll(selectors.img));
    const visible = imgs.find((img) => {
      const rect = img.getBoundingClientRect();
      const style = window.getComputedStyle(img);
      return (
        (img.currentSrc || img.src) &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    });

    return visible || imgs.find((img) => img.currentSrc || img.src) || null;
  }

  function getNextButton() {
    return document.querySelector(selectors.next);
  }

  function getExtensionFromUrl(url) {
    try {
      const cleanUrl = String(url || "").split("?")[0].split("#")[0];
      const lastPart = cleanUrl.split("/").pop() || "";
      const match = lastPart.match(/\.([a-zA-Z0-9]+)$/);
      if (!match) return "jpg";

      const ext = match[1].toLowerCase();
      if (["jpg", "jpeg", "png", "webp", "gif", "bmp"].includes(ext)) {
        return ext;
      }
    } catch (_) {}

    return "jpg";
  }

  async function sendDownload(url, folder, index) {
    const ext = getExtensionFromUrl(url);
    const fileNumber = String(index).padStart(3, "0");
    const filename = `${folder}/${fileNumber}.${ext}`;

    return await chrome.runtime.sendMessage({
      type: "download-file",
      url,
      filename
    });
  }

  async function waitForImageReady(timeoutMs = 15000) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const img = getVisibleImage();
      const src = img?.currentSrc || img?.src || "";

      if (img && src && img.complete && img.naturalWidth > 0) {
        return img;
      }

      await sleep(4000);
    }

    return null;
  }

  async function waitForImageChange(previousSrc, previousIndex, timeoutMs = 20000) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const img = getVisibleImage();
      const src = img?.currentSrc || img?.src || "";
      const counter = getCounterInfo();
      const indexChanged = counter && counter.current !== previousIndex;
      const srcChanged = src && src !== previousSrc;

      if (img && src && img.complete && img.naturalWidth > 0 && (indexChanged || srcChanged)) {
        return { img, counter };
      }

      await sleep(200);
    }

    return null;
  }

  const nextButton = getNextButton();
  if (!nextButton) {
    return { ok: false, message: "Next button not found." };
  }

  const initialImg = await waitForImageReady();
  if (!initialImg) {
    return { ok: false, message: "No visible image found." };
  }

  const folder = sanitizeFolderName(document.title || "downloaded-images");
  const counter = getCounterInfo();
  const total = counter?.total || 1;
  let currentIndex = counter?.current || 1;

  const downloaded = [];
  const seen = new Set();

  let currentSrc = initialImg.currentSrc || initialImg.src;

  if (currentSrc && !seen.has(currentSrc)) {
    seen.add(currentSrc);
    const response = await sendDownload(currentSrc, folder, currentIndex);
    downloaded.push({ index: currentIndex, url: currentSrc, response });
    await sleep(500);
  }

  while (currentIndex < total) {
    const button = getNextButton();
    if (!button) {
      return {
        ok: false,
        message: `Stopped at item ${currentIndex}: next button not found.`,
        downloaded
      };
    }

    const oldSrc = currentSrc;
    const oldIndex = currentIndex;

    button.click();
    await sleep(delayMs);

    const changed = await waitForImageChange(oldSrc, oldIndex);
    if (!changed) {
      return {
        ok: false,
        message: `Stopped at item ${oldIndex + 1}: could not detect a new visible image after clicking next.`,
        downloaded
      };
    }

    const img = changed.img;
    currentSrc = img.currentSrc || img.src;

    const newCounter = changed.counter || getCounterInfo();
    if (newCounter?.current) {
      currentIndex = newCounter.current;
    } else {
      currentIndex += 1;
    }

    if (currentSrc && !seen.has(currentSrc)) {
      seen.add(currentSrc);
      const response = await sendDownload(currentSrc, folder, currentIndex);
      downloaded.push({ index: currentIndex, url: currentSrc, response });
      await sleep(500);
    } else if (currentIndex <= oldIndex) {
      return {
        ok: false,
        message: "Slideshow did not advance to a new image.",
        downloaded
      };
    }
  }

  return {
    ok: true,
    message: `Downloaded ${downloaded.length} image(s).`,
    folder,
    downloaded
  };
}