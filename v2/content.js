(() => {
  const SELECT_LEFT =
    ".page-area.js-page-area.align-left canvas.page-image.js-page-image";
  const SELECT_RIGHT =
    ".page-area.js-page-area.align-right canvas.page-image.js-page-image";

  let overlayOn = false;
  let overlayEl = null;

  function ensureOverlay() {
    if (overlayEl) return;
    overlayEl = document.createElement("div");
    overlayEl.style.position = "fixed";
    overlayEl.style.inset = "0";
    overlayEl.style.zIndex = "2147483647";
    overlayEl.style.display = "none";
    overlayEl.style.pointerEvents = "none";
    overlayEl.style.outline = "0";
    document.documentElement.appendChild(overlayEl);
  }

  function drawBoxes(leftRect, rightRect) {
    ensureOverlay();
    overlayEl.innerHTML = "";

    const mk = (r, label) => {
      const d = document.createElement("div");
      d.style.position = "fixed";
      d.style.left = `${r.left}px`;
      d.style.top = `${r.top}px`;
      d.style.width = `${r.width}px`;
      d.style.height = `${r.height}px`;
      d.style.border = "3px solid rgba(0,255,255,0.9)";
      d.style.boxSizing = "border-box";
      d.style.background = "rgba(0,0,0,0.05)";
      d.style.pointerEvents = "none";
      d.title = label;
      overlayEl.appendChild(d);
    };

    mk(leftRect, "LEFT");
    mk(rightRect, "RIGHT");
  }

  function getRects() {
    const left = document.querySelector(SELECT_LEFT);
    const right = document.querySelector(SELECT_RIGHT);

    if (!left || !right) {
      return { ok: false, error: "Could not find left/right canvases (selectors mismatch or not loaded yet)." };
    }

    const leftRect = left.getBoundingClientRect();
    const rightRect = right.getBoundingClientRect();

    // captureVisibleTab captures viewport pixels. Scale CSS px -> device px.
    const dpr = window.devicePixelRatio || 1;

    const toCrop = (r) => ({
      x: r.left * dpr,
      y: r.top * dpr,
      w: r.width * dpr,
      h: r.height * dpr
    });

    // Spread bounding box covering both
    const minLeft = Math.min(leftRect.left, rightRect.left);
    const minTop = Math.min(leftRect.top, rightRect.top);
    const maxRight = Math.max(leftRect.right, rightRect.right);
    const maxBottom = Math.max(leftRect.bottom, rightRect.bottom);

    const spreadRect = {
      left: minLeft,
      top: minTop,
      width: maxRight - minLeft,
      height: maxBottom - minTop
    };

    if (overlayOn) drawBoxes(leftRect, rightRect);

    return {
        ok: true,
        viewport: { w: window.innerWidth, h: window.innerHeight },
        leftRect: { left: leftRect.left, top: leftRect.top, width: leftRect.width, height: leftRect.height },
        rightRect: { left: rightRect.left, top: rightRect.top, width: rightRect.width, height: rightRect.height },
        spreadRect: { left: spreadRect.left, top: spreadRect.top, width: spreadRect.width, height: spreadRect.height }
        };
  }

  function toggleOverlay() {
    ensureOverlay();
    overlayOn = !overlayOn;
    overlayEl.style.display = overlayOn ? "block" : "none";
    // redraw once
    if (overlayOn) {
      const r = getRects();
      if (r.ok) {
        // (getRects already draws boxes when overlayOn)
      }
    }
    return { ok: true, overlayOn };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    try {
      if (msg?.type === "GET_CANVAS_RECTS") {
        sendResponse(getRects());
        return true;
      }
      if (msg?.type === "TOGGLE_OVERLAY") {
        sendResponse(toggleOverlay());
        return true;
      }
      sendResponse({ ok: false, error: "Unknown command." });
      return true;
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
      return true;
    }
  });
})();