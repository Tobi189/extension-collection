document.addEventListener("DOMContentLoaded", async()=>{
  const shortcutEl = document.getElementById("shortcut");
  try{
    const commands = await chrome.commands.getAll();
    const cmd = commands.find( (c) => c.name === "open_controls");

    shortcutEl.textContent = cmd?.shortcut || "Not set";
  }catch(err){
    shortcutEl.textContent = "Unavailable";
    console.error(err);
  }
})


const statusEl = document.getElementById("status");

function setStatus(text, isError = false) {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.classList.toggle("error", !!isError);
}

function formatReaderStatus(response) {
  const info = response?.info;
  if (!info?.ok) {
    return info?.error || "Reader not found.";
  }

  return [
    `left=${info.leftPage?.index ?? "-"}`,
    `right=${info.rightPage?.index ?? "-"}`,
    `counter=${info.counterText ?? "-"}`,
    `pagesVisible=${info.pageCount ?? "-"}`
  ].join(" | ");
}

function call(type) {
  setStatus("Working...");

  chrome.runtime.sendMessage({ type }, (response) => {
    if (chrome.runtime.lastError) {
      setStatus(chrome.runtime.lastError.message, true);
      return;
    }

    if (type === "READER_STATUS") {
      setStatus(formatReaderStatus(response), !response?.info?.ok);
      return;
    }

    if (type === "AUTO_STATUS") {
      if (!response?.ok) {
        setStatus(response?.error || "Failed to read auto status.", true);
        return;
      }

      if (response.running) {
        setStatus(`Auto ZIP running. Pages captured: ${response.pageCount ?? 0}`);
      } else {
        setStatus("Auto ZIP is not running.");
      }
      return;
    }

    if (!response?.ok) {
      setStatus(response?.error || "Action failed.", true);
      return;
    }

    if (type === "CAPTURE_LEFT") {
      setStatus(`Downloaded left page ${response.pageIndex}.`);
      return;
    }

    if (type === "CAPTURE_RIGHT") {
      setStatus(`Downloaded right page ${response.pageIndex}.`);
      return;
    }

    if (type === "CAPTURE_SPREAD") {
      setStatus(
        `Downloaded spread PNG: ${response.filename} ` +
        `(left=${response.leftIndex ?? "-"}, right=${response.rightIndex ?? "-"})`
      );
      return;
    }

    if (type === "AUTO_START") {
      setStatus(response.alreadyRunning ? "Auto ZIP is already running." : "Auto ZIP started.");
      return;
    }

    if (type === "AUTO_STOP") {
      setStatus(response.wasRunning ? "Stop requested." : "Auto ZIP was not running.");
      return;
    }

    setStatus("Done.");
  });
}

function bind(id, type) {
  const el = document.getElementById(id);
  if (!el) return;

  el.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    call(type);
  });
}

bind("checkStatus", "READER_STATUS");
bind("startAuto", "AUTO_START");
bind("stopAuto", "AUTO_STOP");
bind("autoStatus", "AUTO_STATUS");
bind("downloadSpread", "CAPTURE_SPREAD");
bind("downloadLeft", "CAPTURE_LEFT");
bind("downloadRight", "CAPTURE_RIGHT");