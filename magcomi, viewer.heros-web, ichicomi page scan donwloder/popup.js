document.addEventListener("DOMContentLoaded", async()=>{
  const shortcutEl = document.getElementById("shortcut");
  try{
    const commands = await chrome.commands.getAll();
    const cmd = commands.find( (c) => c.name === "_execute_action");

    shortcutEl.textContent = cmd?.shortcut || "Not set";
  }catch(err){
    shortcutEl.textContent = "Unavailable";
    console.error(err);
  }
})

function fire(type) {
  chrome.runtime.sendMessage({ type });
  window.close();
}

function bind(btnId, type) {
  const el = document.getElementById(btnId);
  if (!el) return;

  // prevent page click-through
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

bind("startAuto", "AUTO_START");
bind("stopAuto", "AUTO_STOP");

bind("downloadSpread", "CAPTURE_SPREAD");
bind("downloadLeft", "CAPTURE_LEFT");
bind("downloadRight", "CAPTURE_RIGHT");