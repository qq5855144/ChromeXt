"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");

const manager = fs.readFileSync(
  "app/src/main/java/org/matrix/chromext/script/Manager.kt",
  "utf8"
);
const pages = fs.readFileSync(
  "app/src/main/java/org/matrix/chromext/extension/ExtensionPages.kt",
  "utf8"
);
const ui = fs.readFileSync("app/src/main/assets/userscript_manager.js", "utf8");
const addon = fs.readFileSync(
  "app/src/main/assets/extension_manager_addon.js",
  "utf8"
);
const listener = fs.readFileSync(
  "app/src/main/java/org/matrix/chromext/Listener.kt",
  "utf8"
);

assert.equal(
  manager.includes("ExtensionBackgroundHost.bootstrap("),
  false,
  "normal page navigation must not start or probe the extension background host"
);

const localGuard = pages.indexOf('if (!isLocalExtensionResource(url)) return null');
const enumerateExtensions = pages.indexOf("LocalFiles.managementList()");
assert.ok(localGuard >= 0, "extension page bootstrap must have a local-resource guard");
assert.ok(
  enumerateExtensions > localGuard,
  "extension enumeration/resource server startup must happen only after the local-resource guard"
);

assert.ok(
  ui.includes('id="cx-import-userscript"') && ui.includes("importUserScripts"),
  "manager must expose local UserScript import"
);
assert.ok(
  ui.includes('id="cx-install-extension"') && ui.includes("导入本地 ZIP/CRX"),
  "manager must expose local ZIP/CRX extension import"
);
assert.ok(
  addon.includes('id = "cx-import-extension-folder"') && addon.includes("导入本地文件夹"),
  "manager must expose local unpacked extension folder import"
);
assert.ok(
  listener.includes('data.optBoolean("import")') && listener.includes("userscript_import"),
  "native bridge must accept local UserScript imports"
);

console.log("Extension navigation safety and local-import regression checks passed");
