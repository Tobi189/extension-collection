const statusEl = document.getElementById("status");
const startBtn = document.getElementById("startBtn");
const delayInput = document.getElementById("delayMs");

document.addEventListener("DOMContentLoaded", async()=>{
  const shortcutEl = document.getElementById("shortcut");
  try{
    const commands = await chrome.commands.getAll();
    const cmd = commands.find( (c) => c.name === "suggested_key");

    shortcutEl.textContent = cmd?.shortcut || "Not set";
  }catch(err){
    shortcutEl.textContent = "Unavailable";
    console.error(err);
  }
});

function setStatus(text) {
  statusEl.textContent = text;
}

startBtn.addEventListener("click", async () => {
  const delayMs = Number(delayInput.value || 1200);
  setStatus("Starting...");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.id) {
      setStatus("No active tab found.");
      return;
    }

    const result = await chrome.runtime.sendMessage({
      type: "start-download",
      tabId: tab.id,
      delayMs
    });

    if (!result?.ok) {
      setStatus(result?.message || "Failed.");
      return;
    }

    setStatus(`${result.message}\nFolder: ${result.folder}`);
  } catch (error) {
    setStatus(`Error: ${error.message}`);
  }
});