chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "start-download") return;

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) return;

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: startDownloadInPage
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "download-file") {
    chrome.downloads.download({
      url: message.url,
      filename: message.filename,
      saveAs: false
    });
  }
});

async function startDownloadInPage() {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const sanitizeFolderName = (name) => {
    return (name || "downloads")
      .replace(/[\\/:*?"<>|]/g, "_")
      .trim();
  };

  const getCounterInfo = () => {
    const counter = document.querySelector(".pswp__counter");
    if (!counter) return null;

    const text = counter.textContent.trim();
    const match = text.match(/(\d+)\s*\/\s*(\d+)/);
    if (!match) return null;

    return {
      current: Number(match[1]),
      total: Number(match[2])
    };
  };

  const getActiveSlide = () => {
    return document.querySelector(".pswp__item[aria-hidden='false']");
  };

  const getActiveImage = () => {
    const slide = getActiveSlide();
    if (!slide) return null;
    return slide.querySelector(".pswp__img");
  };

  const getNextButton = () => {
    return document.querySelector(".pswp__button--arrow--next");
  };

  const getExtensionFromUrl = (url) => {
    try {
      const cleanUrl = url.split("?")[0].split("#")[0];
      const lastPart = cleanUrl.split("/").pop() || "";
      const match = lastPart.match(/\.([a-zA-Z0-9]+)$/);
      if (!match) return "jpg";

      const ext = match[1].toLowerCase();
      if (["jpg", "jpeg", "png", "webp", "gif", "bmp"].includes(ext)) {
        return ext;
      }
    } catch (e) {}

    return "jpg";
  };

  const downloadImage = async (url, filename) => {
    chrome.runtime.sendMessage({
      type: "download-file",
      url,
      filename
    });

    await sleep(1000);
  };

  const waitForSlideChange = async (oldIndex, oldSrc, timeoutMs = 20000) => {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const counter = getCounterInfo();
      const img = getActiveImage();

      const indexChanged = counter && counter.current !== oldIndex;
      const srcChanged = img && img.src && img.src !== oldSrc;
      const loaded = img && img.complete;

      if (indexChanged && img && loaded) {
        return img;
      }

      if (srcChanged && img && loaded) {
        return img;
      }

      await sleep(250);
    }

    return null;
  };

  const folderName = sanitizeFolderName(document.title);

  const startCounter = getCounterInfo();
  if (!startCounter) {
    alert("Could not find slideshow counter.");
    return;
  }

  let currentIndex = startCounter.current;
  const totalImages = startCounter.total;

  let currentImage = getActiveImage();
  if (!currentImage || !currentImage.src) {
    alert("Could not find active slideshow image.");
    return;
  }

  // Download currently open image first
  {
    const ext = getExtensionFromUrl(currentImage.src);
    const fileNumber = String(currentIndex).padStart(3, "0");
    const filename = `${folderName}/${fileNumber}.${ext}`;
    await downloadImage(currentImage.src, filename);
  }

  while (currentIndex < totalImages) {
    const nextButton = getNextButton();
    if (!nextButton) {
      alert("Next button not found.");
      return;
    }

    const oldIndex = currentIndex;
    const oldSrc = currentImage.src;

    nextButton.click();

    const newImage = await waitForSlideChange(oldIndex, oldSrc);
    if (!newImage) {
      alert(`Stopped at image ${oldIndex + 1}. Could not detect next active slide.`);
      return;
    }

    const newCounter = getCounterInfo();
    if (!newCounter) {
      alert("Counter disappeared.");
      return;
    }

    currentIndex = newCounter.current;
    currentImage = newImage;

    const ext = getExtensionFromUrl(currentImage.src);
    const fileNumber = String(currentIndex).padStart(3, "0");
    const filename = `${folderName}/${fileNumber}.${ext}`;

    await downloadImage(currentImage.src, filename);
  }

  alert("All images downloaded.");
}