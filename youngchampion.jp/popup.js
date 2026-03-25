async function send(type) {
  try {
    await chrome.runtime.sendMessage({ type });
    window.close();
  } catch (err) {
    console.error(err);
  }
}

document.getElementById("startAuto").addEventListener("click", () => send("AUTO_START"));
document.getElementById("stopAuto").addEventListener("click", () => send("AUTO_STOP"));
document.getElementById("downloadSpread").addEventListener("click", () => send("DOWNLOAD_SPREAD"));
document.getElementById("downloadLeft").addEventListener("click", () => send("DOWNLOAD_LEFT"));
document.getElementById("downloadRight").addEventListener("click", () => send("DOWNLOAD_RIGHT"));

(async () => {
  try {
    const commands = await chrome.commands.getAll();
    const actionCmd = commands.find((c) => c.name === "_execute_action");
    document.getElementById("shortcut").textContent = actionCmd?.shortcut || "Not set";
  } catch (err) {
    document.getElementById("shortcut").textContent = "Unavailable";
  }
})();