const statusEl = document.getElementById('status');
const startBtn = document.getElementById('startBtn');
const delayInput = document.getElementById('delayMs');

function setStatus(text) {
  statusEl.textContent = text;
}

startBtn.addEventListener('click', async () => {
  const delayMs = Number(delayInput.value || 1200);
  setStatus('Starting...');

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    setStatus('No active tab found.');
    return;
  }

  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async (delay) => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

        const selectors = {
          img: '.pswp__img',
          next: '.pswp__button.pswp__button--arrow--next',
          counter: '.pswp__counter'
        };

        function getVisibleImage() {
          const imgs = Array.from(document.querySelectorAll(selectors.img));
          const visible = imgs.find((img) => {
            const style = window.getComputedStyle(img);
            const rect = img.getBoundingClientRect();
            return img.src && style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
          });
          return visible || imgs.find((img) => img.src) || null;
        }

        function getCounter() {
          const counter = document.querySelector(selectors.counter);
          if (!counter) return { current: null, total: null };
          const text = (counter.textContent || '').trim();
          const match = text.match(/(\d+)\s*\/\s*(\d+)/);
          if (!match) return { current: null, total: null };
          return { current: Number(match[1]), total: Number(match[2]) };
        }

        async function waitForImageReady(timeoutMs = 15000) {
          const start = Date.now();
          while (Date.now() - start < timeoutMs) {
            const img = getVisibleImage();
            if (img && img.src && img.complete && img.naturalWidth > 0) {
              return img;
            }
            await sleep(200);
          }
          return null;
        }

        async function waitForImageChange(previousSrc, timeoutMs = 15000) {
          const start = Date.now();
          while (Date.now() - start < timeoutMs) {
            const img = getVisibleImage();
            const src = img?.currentSrc || img?.src || '';
            if (img && src && src !== previousSrc && img.complete && img.naturalWidth > 0) {
              return img;
            }
            await sleep(200);
          }
          return null;
        }

        async function sendDownload(url, folder, index) {
          return await chrome.runtime.sendMessage({
            type: 'downloadImage',
            url,
            folder,
            index
          });
        }

        const nextButton = document.querySelector(selectors.next);
        if (!nextButton) {
          return { ok: false, message: 'Next button not found.' };
        }

        const initialImg = await waitForImageReady();
        if (!initialImg) {
          return { ok: false, message: 'No visible image found.' };
        }

        const folder = (document.title || 'downloaded-images').trim();
        const counter = getCounter();
        const total = counter.total || 1;
        const downloaded = [];
        const seen = new Set();

        let currentSrc = initialImg.currentSrc || initialImg.src;
        if (currentSrc && !seen.has(currentSrc)) {
          seen.add(currentSrc);
          const response = await sendDownload(currentSrc, folder, 1);
          downloaded.push({ index: 1, url: currentSrc, response });
        }

        for (let index = 2; index <= total; index += 1) {
          nextButton.click();
          await sleep(delay);

          const changedImg = await waitForImageChange(currentSrc);
          if (!changedImg) {
            return {
              ok: false,
              message: `Stopped at item ${index}: could not detect a new visible image after clicking next.`,
              downloaded
            };
          }

          const newSrc = changedImg.currentSrc || changedImg.src;
          currentSrc = newSrc;

          if (newSrc && !seen.has(newSrc)) {
            seen.add(newSrc);
            const response = await sendDownload(newSrc, folder, index);
            downloaded.push({ index, url: newSrc, response });
          }
        }

        return {
          ok: true,
          message: `Downloaded ${downloaded.length} image(s).`,
          downloaded
        };
      },
      args: [delayMs]
    });

    if (!result?.ok) {
      setStatus(result?.message || 'Failed.');
      return;
    }

    setStatus(`${result.message}\nFolder: ${tab.title}`);
  } catch (error) {
    setStatus(`Error: ${error.message}`);
  }
});
