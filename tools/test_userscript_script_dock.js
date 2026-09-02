"use strict";

const fs = require("fs");
const assert = require("assert");

const dock = fs.readFileSync("app/src/main/assets/script_dock.js", "utf8");
const local = fs.readFileSync(
  "app/src/main/java/org/matrix/chromext/script/Local.kt",
  "utf8"
);
const manager = fs.readFileSync(
  "app/src/main/java/org/matrix/chromext/script/Manager.kt",
  "utf8"
);

function contains(source, text, message) {
  assert.ok(source.includes(text), message || `Missing: ${text}`);
}

contains(
  dock,
  "if (window !== window.top) return;",
  "Script Dock must never render inside child frames"
);
contains(
  dock,
  'attachShadow({ mode: "closed" })',
  "Script Dock must stay isolated from page CSS/DOM"
);
contains(
  dock,
  "ChromeXt.scripts",
  "Dock must render scripts from the live page runtime"
);
contains(
  dock,
  "ChromeXt.commands",
  "Dock must read GM_registerMenuCommand runtime commands"
);
contains(
  dock,
  "Reflect.apply(command.listener",
  "Menu commands must invoke the original registered JS listener"
);
contains(
  dock,
  'const MANAGER_URL = "about:blank#XT"',
  "Dock manager icon must use the stable ChromeXt manager entry"
);
contains(
  dock,
  'const SETTINGS_ORIGIN = "chromext-internal://script-dock"',
  "Dock position must use the reserved persistent settings key"
);
contains(
  dock,
  "ChromeXtDockInitialY",
  "Dock must restore the persisted vertical position during injection"
);
contains(
  dock,
  'name: "filters"',
  "Dock must persist its position through ChromeXt syncData"
);
contains(
  dock,
  "if (wasDragging) {\n      persistPosition();",
  "Dock must save a completed or cancelled Android drag"
);
contains(
  dock,
  'addEventListener("lostpointercapture"',
  "Dock must finish and save a drag when pointer capture is lost"
);
contains(
  dock,
  "M5.955.002C3-.071.275 2.386.043 5.335",
  "Dock must embed the supplied Tampermonkey icon"
);
contains(
  dock,
  '${iconTampermonkey}',
  "Floating dock button must render the Tampermonkey icon"
);
contains(
  dock,
  "window.visualViewport",
  "Dock must react to keyboard/visual viewport changes"
);
contains(
  dock,
  "MutationObserver",
  "Dock must survive SPA removal of its host"
);
contains(
  dock,
  'document.querySelector("script[nonce],style[nonce]")',
  "Dock must inherit a compatible CSP nonce when one exists"
);

contains(local, 'ctx.assets\n            .open("script_dock.js")', "Local must load script_dock.js");
contains(
  local,
  '.replace("Symbol.ChromeXtDockAccess", "Symbol." + name)',
  "Dock must receive the private ChromeXt runtime symbol"
);
contains(
  local,
  '"window.location.assign(MANAGER_URL); opened = true;"',
  "Dock manager navigation must stay in the current real tab instead of relying on a popup"
);
contains(
  manager,
  'private const val SCRIPT_DOCK_SETTINGS_ORIGIN = "chromext-internal://script-dock"',
  "Native settings key must match the JS dock"
);
contains(
  manager,
  "if (frameId == null)",
  "Native injection must restrict the dock to the top frame"
);
contains(
  manager,
  'Local.scriptDock.replace("ChromeXtDockInitialY", dockY.toString())',
  "Native injection must pass the persisted vertical position"
);
contains(
  manager,
  "if(document.documentElement){bootChromeXtScriptDock();}",
  "Dock should start immediately when the document root exists"
);
contains(
  manager,
  "document.addEventListener('DOMContentLoaded',bootChromeXtScriptDock,{once:true})",
  "Dock must defer safely on very early WebView injection"
);

console.log("UserScript Script Dock regression checks passed");
