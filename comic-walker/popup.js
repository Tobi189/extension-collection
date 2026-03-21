function call(type) {
  chrome.runtime.sendMessage({ type }, (response) => {
    if (chrome.runtime.lastError) {
      console.error(chrome.runtime.lastError.message);
      return;
    }

    if (type === "READER_STATUS" && response?.ok) {
      const statusEl = document.getElementById("status");
      if (!statusEl) return;

      const info = response.info;
      const aria = info?.status?.aria;

      const parts = [
        info?.ok ? "reader: found" : "reader: not found",
        aria ? `slide ${aria.index}/${aria.total}` : "slide unknown",
        info?.twoPages ? "mode: spread" : `mode: single ${info?.singleSide || ""}`.trim()
      ];

      statusEl.textContent = parts.join(" | ");
      return;
    }

    window.close();
  });
}

function bind(btnId, type) {
  const el = document.getElementById(btnId);
  if (!el) return;

  el.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    call(type);
  });
}

bind("checkStatus", "READER_STATUS");
bind("toggleOverlay", "TOGGLE_OVERLAY");
bind("startAuto", "AUTO_START");
bind("stopAuto", "AUTO_STOP");
bind("downloadSpread", "CAPTURE_SPREAD");
bind("downloadLeft", "CAPTURE_LEFT");
bind("downloadRight", "CAPTURE_RIGHT");