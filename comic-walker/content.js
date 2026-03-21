(() => {
  if (window.__splideReaderCaptureLoaded) return;
  window.__splideReaderCaptureLoaded = true;

  let overlayOn = false;
  let overlayRoot = null;

  function q(sel, root = document) {
    return root.querySelector(sel);
  }

  function qa(sel, root = document) {
    return Array.from(root.querySelectorAll(sel));
  }

  function rectToObj(r) {
    return {
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height
    };
  }

  function isVisibleRect(r) {
    if (!r) return false;
    if (r.width < 8 || r.height < 8) return false;

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const visibleW = Math.min(r.right, vw) - Math.max(r.left, 0);
    const visibleH = Math.min(r.bottom, vh) - Math.max(r.top, 0);

    return visibleW > 8 && visibleH > 8;
  }

  function getSplideRoot() {
    const roots = Array.from(document.querySelectorAll('.splide'));

    const candidates = roots
        .map((root) => {
        const rect = root.getBoundingClientRect();
        const visibleW = Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0);
        const visibleH = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
        const visible = visibleW > 20 && visibleH > 20;
        const canvasCount = root.querySelectorAll('canvas').length;
        const area = Math.max(0, rect.width) * Math.max(0, rect.height);

        return { root, visible, canvasCount, area };
        })
        .filter((x) => x.visible && x.canvasCount > 0)
        .sort((a, b) => b.area - a.area);

    return candidates[0]?.root || null;
    }

  function getSplideList(root) {
    return q('.splide__list', root) || q('[id^="splide"][id$="-list"]', root);
  }

  function getActiveSlide(root) {
    return q('.splide__slide.is-active', root) || q('.splide__slide.is-visible', root) || q('.splide__slide', root);
  }

  function parseAriaLabel(text) {
    const m = String(text || '').match(/(\d+)\s+of\s+(\d+)/i);
    if (!m) return null;
    return { index: Number(m[1]), total: Number(m[2]) };
  }

  function getVisibleCanvasesInSlide(slide) {
    const canvases = qa('canvas', slide)
      .map((canvas) => {
        const rect = canvas.getBoundingClientRect();
        return {
          el: canvas,
          rect,
          area: rect.width * rect.height
        };
      })
      .filter((x) => isVisibleRect(x.rect))
      .sort((a, b) => b.area - a.area);

    return canvases;
  }

  function choosePageRects(slide) {
    const canvases = getVisibleCanvasesInSlide(slide);

    if (canvases.length === 0) {
      return null;
    }

    if (canvases.length === 1) {
      const only = canvases[0].rect;
      return {
        twoPages: false,
        singleSide: 'LEFT',
        leftRect: rectToObj(only),
        rightRect: rectToObj(only)
      };
    }

    const topTwo = canvases.slice(0, 2).sort((a, b) => a.rect.left - b.rect.left);
    const left = topTwo[0].rect;
    const right = topTwo[1].rect;

    return {
      twoPages: true,
      singleSide: null,
      leftRect: rectToObj(left),
      rightRect: rectToObj(right)
    };
  }

  function computeSpreadRect(leftRect, rightRect) {
    return {
      left: Math.min(leftRect.left, rightRect.left),
      top: Math.min(leftRect.top, rightRect.top),
      right: Math.max(leftRect.right, rightRect.right),
      bottom: Math.max(leftRect.bottom, rightRect.bottom),
      width: Math.max(leftRect.right, rightRect.right) - Math.min(leftRect.left, rightRect.left),
      height: Math.max(leftRect.bottom, rightRect.bottom) - Math.min(leftRect.top, rightRect.top)
    };
  }

  function ensureOverlayRoot() {
    if (overlayRoot) return overlayRoot;

    overlayRoot = document.createElement('div');
    overlayRoot.id = 'mcv-overlay-root';
    overlayRoot.style.position = 'fixed';
    overlayRoot.style.inset = '0';
    overlayRoot.style.pointerEvents = 'none';
    overlayRoot.style.zIndex = '2147483647';
    overlayRoot.style.display = 'none';
    document.documentElement.appendChild(overlayRoot);

    return overlayRoot;
  }

  function makeOverlayBox(rect, label, color) {
    const box = document.createElement('div');
    box.style.position = 'fixed';
    box.style.left = `${rect.left}px`;
    box.style.top = `${rect.top}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
    box.style.boxSizing = 'border-box';
    box.style.border = `3px solid ${color}`;
    box.style.background = 'rgba(0,0,0,0.04)';
    box.style.color = color;
    box.style.font = '12px system-ui';
    box.style.padding = '2px 4px';
    box.textContent = label;
    return box;
  }

  function renderOverlay(info) {
    const root = ensureOverlayRoot();
    root.innerHTML = '';
    root.appendChild(makeOverlayBox(info.spreadRect, 'SPREAD', '#00ffff'));
    root.appendChild(makeOverlayBox(info.leftRect, 'LEFT', '#00ff66'));
    root.appendChild(makeOverlayBox(info.rightRect, 'RIGHT', '#ffcc00'));
    root.style.display = overlayOn ? 'block' : 'none';
  }

  function getReaderInfo() {
    const splideRoot = getSplideRoot();
    if (!splideRoot) {
      return { ok: false, error: 'Splide root not found.' };
    }

    const list = getSplideList(splideRoot);
    const activeSlide = getActiveSlide(splideRoot);

    if (!activeSlide) {
      return { ok: false, error: 'Active slide not found.' };
    }

    const pages = choosePageRects(activeSlide);
    if (!pages) {
      return {
        ok: false,
        error: 'No visible canvases found in active slide.',
        status: {
          activeSlideId: activeSlide.id || null,
          aria: parseAriaLabel(activeSlide.getAttribute('aria-label')),
          transformX: list ? getComputedStyle(list).transform : null
        }
      };
    }

    const spreadRect = computeSpreadRect(pages.leftRect, pages.rightRect);

    const info = {
      ok: true,
      viewport: {
        w: window.innerWidth,
        h: window.innerHeight,
        dpr: window.devicePixelRatio || 1
      },
      leftRect: pages.leftRect,
      rightRect: pages.rightRect,
      spreadRect,
      twoPages: pages.twoPages,
      singleSide: pages.singleSide,
      status: {
        activeSlideId: activeSlide.id || null,
        aria: parseAriaLabel(activeSlide.getAttribute('aria-label')),
        transformX: list ? getComputedStyle(list).transform : null
      }
    };

    if (overlayOn) {
      renderOverlay(info);
    }

    return info;
  }

  function toggleOverlay() {
    overlayOn = !overlayOn;
    const root = ensureOverlayRoot();

    if (!overlayOn) {
      root.style.display = 'none';
      root.innerHTML = '';
      return { ok: true, overlayOn: false };
    }

    const info = getReaderInfo();
    if (info.ok) {
      renderOverlay(info);
    } else {
      root.style.display = 'none';
    }

    return { ok: true, overlayOn: true, readerOk: info.ok };
  }

  function fireClick(el) {
    const opts = { bubbles: true, cancelable: true, view: window };

    try {
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', opts));
    } catch {}

    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  function goNext() {
  const splideRoot = getSplideRoot();
  if (!splideRoot) {
    return { ok: false, error: 'Splide root not found.' };
  }

  const nextArrow =
    splideRoot.querySelector('.splide__arrow--next') ||
    document.querySelector('.splide__arrow--next') ||
    splideRoot.querySelector('[aria-label*="Next"]') ||
    splideRoot.querySelector('[aria-label*="next"]');

  if (nextArrow) {
    nextArrow.click();
    return { ok: true, method: 'arrow-click' };
  }

  const active = splideRoot.querySelector('.splide__slide.is-active');
  const next = active?.nextElementSibling;

  if (next && next.matches('.splide__slide')) {
    next.click();
    return { ok: true, method: 'next-slide-click' };
  }

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
  document.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
  return { ok: true, method: 'keyboard-fallback' };
}

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    try {
      if (msg?.type === 'PING') {
        sendResponse({ ok: true });
        return true;
      }

      if (msg?.type === 'GET_READER_INFO') {
        sendResponse(getReaderInfo());
        return true;
      }

      if (msg?.type === 'TOGGLE_OVERLAY') {
        sendResponse(toggleOverlay());
        return true;
      }

      if (msg?.type === 'GO_NEXT') {
        sendResponse(goNext());
        return true;
      }

      sendResponse({ ok: false, error: 'Unknown command.' });
      return true;
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message || err) });
      return true;
    }
  });
})();