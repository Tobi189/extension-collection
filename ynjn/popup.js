document.addEventListener("DOMContentLoaded", async () => {
  const shortcutEl = document.getElementById("shortcut");
  try {
    const commands = await chrome.commands.getAll();
    const cmd = commands.find((c) => c.name === "_execute_action");
    shortcutEl.textContent = cmd?.shortcut || "Not set";
  } catch (err) {
    shortcutEl.textContent = "Unavailable";
    console.error(err);
  }
});

function fire(type) {
  chrome.runtime.sendMessage({ type });
  window.close();
}

function bind(btnId, type) {
  const el = document.getElementById(btnId);
  if (!el) return;

  el.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    fire(type);
  });

  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fire(type);
    }
  });
}

async function checkStatus() {
  const statusEl = document.getElementById("status");
  if (!statusEl) return;

  statusEl.textContent = "Checking...";

  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_STATUS" });

    if (!res?.ok) {
      statusEl.textContent = `Error: ${res?.error || "Unknown error"}`;
      return;
    }

    const lines = [];
    lines.push(`Mode: ${res.twoPages ? "2-page" : "1-page"}`);

    if (typeof res.totalPages === "number") {
      lines.push(`Pages: ${res.totalPages}`);
    }
    if (typeof res.currentLeft === "number") {
      lines.push(`Current left page: ${res.currentLeft}`);
    }
    if (typeof res.currentRight === "number") {
      lines.push(`Current right page: ${res.currentRight}`);
    }
    if (typeof res.translateX === "number") {
      lines.push(`translateX: ${res.translateX}`);
    }

    statusEl.textContent = lines.join("\n");
  } catch (err) {
    statusEl.textContent = `Error: ${err?.message || err}`;
  }
}

const checkBtn = document.getElementById("checkStatus");
if (checkBtn) {
  checkBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    checkStatus();
  });
}

bind("startAuto", "AUTO_START");
bind("stopAuto", "AUTO_STOP");
bind("downloadSpread", "CAPTURE_SPREAD");
bind("downloadLeft", "CAPTURE_LEFT");
bind("downloadRight", "CAPTURE_RIGHT");