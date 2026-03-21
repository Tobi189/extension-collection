(() => {
  if (window.__comicFuzDownloaderLoaded) return;
  window.__comicFuzDownloaderLoaded = true;

  const SELECTORS = {
    viewer: '[data-testid="viewer-action-area"], .InternalViewer_viewer__xBDA7',
    spread: '.-KWKsa_spread',
    page: 'img.G54Y0W_page',
    counter: '.InternalViewerFooter_footer__page_state__count__D_VQn'
  };

  function q(sel, root = document) {
    return root.querySelector(sel);
  }

  function qa(sel, root = document) {
    return Array.from(root.querySelectorAll(sel));
  }

  function isVisibleRect(rect) {
    if (!rect || rect.width < 10 || rect.height < 10) return false;

    const overlapW = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
    const overlapH = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);

    return overlapW > 10 && overlapH > 10;
  }

  function getPageIndex(img) {
    const alt = img.getAttribute("alt") || "";
    const m = alt.match(/page_(\d+)/i);
    return m ? Number(m[1]) : null;
  }

  function getActiveSpread() {
    const spreads = qa(SELECTORS.spread).filter((el) => isVisibleRect(el.getBoundingClientRect()));
    if (!spreads.length) return null;

    spreads.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return br.width * br.height - ar.width * ar.height;
    });

    return spreads[0];
  }

  function getVisiblePages() {
    const spread = getActiveSpread();
    if (!spread) return [];

    return qa(SELECTORS.page, spread)
      .map((img) => {
        const rect = img.getBoundingClientRect();
        return {
          img,
          rect,
          index: getPageIndex(img),
          src: img.currentSrc || img.src || ""
        };
      })
      .filter((x) => isVisibleRect(x.rect) && x.index !== null)
      .sort((a, b) => a.rect.left - b.rect.left);
  }

  function getReaderInfo() {
    const spread = getActiveSpread();
    if (!spread) {
      return { ok: false, error: "Visible spread not found." };
    }

    const pages = getVisiblePages();
    if (!pages.length) {
      return { ok: false, error: "Visible pages not found." };
    }

    const leftPage = pages[0] || null;
    const rightPage = pages[1] || pages[0] || null;
    const counterText = q(SELECTORS.counter)?.textContent?.trim() || null;

    return {
      ok: true,
      counterText,
      pageCount: pages.length,
      leftPage: leftPage
        ? {
            index: leftPage.index,
            alt: leftPage.img.alt,
            src: leftPage.src
          }
        : null,
      rightPage: rightPage
        ? {
            index: rightPage.index,
            alt: rightPage.img.alt,
            src: rightPage.src
          }
        : null
    };
  }

  async function blobToDataUrl(blob) {
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("Failed to read blob."));
      reader.readAsDataURL(blob);
    });
  }

  async function exportViaFetch(img) {
    const src = img.currentSrc || img.src;
    if (!src) {
      throw new Error("Image source not found.");
    }

    const res = await fetch(src, {
      credentials: "include",
      cache: "force-cache"
    });

    if (!res.ok) {
      throw new Error(`Fetch failed with status ${res.status}.`);
    }

    const blob = await res.blob();
    return await blobToDataUrl(blob);
  }

  function exportViaCanvas(img) {
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;

    if (!width || !height) {
      throw new Error("Image has no usable dimensions.");
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("2D canvas context unavailable.");
    }

    ctx.drawImage(img, 0, 0, width, height);
    return canvas.toDataURL("image/png");
  }

  async function exportPageImage(pageIndex) {
    const pages = getVisiblePages();
    const target = pages.find((p) => p.index === pageIndex);

    if (!target) {
      return { ok: false, error: `Visible page ${pageIndex} not found.` };
    }

    try {
      let dataUrl;

      try {
        dataUrl = await exportViaFetch(target.img);
      } catch {
        dataUrl = exportViaCanvas(target.img);
      }

      return { ok: true, dataUrl };
    } catch (err) {
      return {
        ok: false,
        error: String(err?.message || err)
      };
    }
  }

  function dispatchClickSequence(el, clientX, clientY) {
    const opts = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX,
      clientY,
      button: 0,
      buttons: 1
    };

    try {
      el.dispatchEvent(new PointerEvent("pointerover", opts));
      el.dispatchEvent(new PointerEvent("pointerenter", opts));
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
    } catch {}

    el.dispatchEvent(new MouseEvent("mouseover", opts));
    el.dispatchEvent(new MouseEvent("mouseenter", opts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
  }

  function goNext() {
    const spread = getActiveSpread();
    const viewer = q(SELECTORS.viewer) || spread;

    if (!spread || !viewer) {
      return { ok: false, error: "Spread not found." };
    }

    const rect = spread.getBoundingClientRect();
    const x = rect.left + rect.width * 0.15;
    const y = rect.top + rect.height * 0.5;

    const realTarget = document.elementFromPoint(x, y) || spread;

    dispatchClickSequence(realTarget, x, y);

    if (realTarget !== spread) {
      dispatchClickSequence(spread, x, y);
    }

    if (viewer !== spread && viewer !== realTarget) {
      dispatchClickSequence(viewer, x, y);
    }

    return { ok: true };
  }

  function hasPageChanged(previousKey) {
    const info = getReaderInfo();
    if (!info?.ok) return { ok: false, changed: false };

    const currentKey = JSON.stringify({
      left: info.leftPage?.index ?? null,
      right: info.rightPage?.index ?? null,
      counter: info.counterText ?? null
    });

    return {
      ok: true,
      changed: currentKey !== previousKey,
      currentKey
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      if (msg?.type === "PING") {
        sendResponse({ ok: true });
        return;
      }

      if (msg?.type === "GET_READER_INFO") {
        sendResponse(getReaderInfo());
        return;
      }

      if (msg?.type === "EXPORT_PAGE_IMAGE") {
        sendResponse(await exportPageImage(msg.pageIndex));
        return;
      }

      if (msg?.type === "GO_NEXT") {
        sendResponse(goNext());
        return;
      }

      if (msg?.type === "HAS_PAGE_CHANGED") {
        sendResponse(hasPageChanged(msg.previousKey));
        return;
      }

      sendResponse({ ok: false, error: "Unknown command." });
    })();

    return true;
  });
})();