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
const backgroundHost = fs.readFileSync(
  "app/src/main/java/org/matrix/chromext/extension/ExtensionBackgroundHost.kt",
  "utf8"
);
const popupHost = fs.readFileSync(
  "app/src/main/java/org/matrix/chromext/extension/ExtensionPopup.kt",
  "utf8"
);
const extensionUrl = fs.readFileSync(
  "app/src/main/java/org/matrix/chromext/extension/ExtensionUrl.kt",
  "utf8"
);
const userScriptHook = fs.readFileSync(
  "app/src/main/java/org/matrix/chromext/hook/UserScript.kt",
  "utf8"
);
const webViewHook = fs.readFileSync(
  "app/src/main/java/org/matrix/chromext/hook/WebView.kt",
  "utf8"
);
const ui = fs.readFileSync("app/src/main/assets/userscript_manager.js", "utf8");
const addon = fs.readFileSync(
  "app/src/main/assets/extension_manager_addon.js",
  "utf8"
);
const popupAddon = fs.readFileSync(
  "app/src/main/assets/extension_popup_addon.js",
  "utf8"
);
const compatAsset = fs.readFileSync(
  "app/src/main/assets/extension_compat.js",
  "utf8"
);
const installerUi = fs.readFileSync(
  "app/src/main/assets/extension_install_fix.js",
  "utf8"
);
const bridge = fs.readFileSync(
  "app/src/main/java/org/matrix/chromext/extension/ExtensionBridge.kt",
  "utf8"
);
const remoteInstaller = fs.readFileSync(
  "app/src/main/java/org/matrix/chromext/extension/RemoteExtensionInstaller.kt",
  "utf8"
);
const localFiles = fs.readFileSync(
  "app/src/main/java/org/matrix/chromext/extension/LocalFiles.kt",
  "utf8"
);
const local = fs.readFileSync(
  "app/src/main/java/org/matrix/chromext/script/Local.kt",
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
  backgroundHost.includes("fun prepare(") && backgroundHost.includes("WeakReference"),
  "background compatibility must be lazily attached to an existing live tab"
);
assert.equal(
  /getTabId|getInspectPages|wakeUpDevTools/.test(backgroundHost),
  false,
  "lazy extension backgrounds must never synchronously probe DevTools"
);
assert.ok(
  bridge.includes("ExtensionBackgroundHost.prepare") &&
    bridge.includes("messageRoutes") &&
    bridge.includes("deliverMessageResponse"),
  "runtime messaging must lazily start backgrounds and retain a point-to-point response route"
);
assert.equal(
  bridge.includes('Chrome.broadcast("cx_extension_message"'),
  false,
  "runtime messages must not scan/broadcast through all DevTools pages"
);
assert.equal(
  bridge.includes('Chrome.broadcast("cx_extension_message_response"'),
  false,
  "runtime message responses must return directly to the sender"
);

assert.ok(
  popupHost.includes('manifest.optJSONObject("page_action")') &&
    popupHost.includes("globalThis.chrome=__cxCreateExtensionApi") &&
    popupHost.includes("__chromextExtensionFrame") &&
    popupHost.includes("ExtensionCompat.script") &&
    popupHost.includes("ResizeObserver"),
  "popup documents must create chrome.*, load compatibility namespaces and report their sheet size"
);
assert.ok(
  popupAddon.includes("allow-same-origin") &&
    popupAddon.includes("allow-popups-to-escape-sandbox") &&
    popupAddon.includes("cx-extension-popup-sheet") &&
    popupAddon.includes("cx-extension-toolbar-icon") &&
    popupAddon.includes('data.action !== "extensionApi"') &&
    popupAddon.includes('op: "popup"'),
  "manager must expose an extension-icon action and render the popup as a storage-capable bottom sheet"
);
assert.ok(
  backgroundHost.includes("ExtensionCompat.script") && pages.includes("ExtensionCompat.script"),
  "background and full extension pages must load the same soft compatibility namespaces"
);
assert.ok(
  compatAsset.includes("declarativeNetRequest") &&
    compatAsset.includes("webRequest") &&
    compatAsset.includes("userScripts") &&
    compatAsset.includes("MAX_NUMBER_OF_DYNAMIC_RULES"),
  "complex MV3 extensions must receive boot-safe webRequest, DNR and userScripts API shapes"
);
assert.ok(
  local.includes('ctx.assets.open("extension_popup_addon.js")'),
  "manager must load the isolated extension popup layer"
);

assert.ok(
  extensionUrl.includes('PREFIX = "chrome-extension://"') &&
    extensionUrl.includes("LocalFiles.managementList()") &&
    extensionUrl.includes("manifestDerivedId") &&
    extensionUrl.includes("declaresPage") &&
    extensionUrl.includes("registerAlias"),
  "ChromeXt must resolve standard chrome-extension URLs, including legacy-id recovery"
);
assert.ok(
  userScriptHook.includes("ExtensionUrl.resolve(url)") &&
    userScriptHook.includes("proxy.newLoadUrlParams(resolved)"),
  "Chromium navigation must rewrite chrome-extension URLs before the browser rejects them"
);
assert.ok(
  webViewHook.includes("ExtensionUrl.resolve(url)") && webViewHook.includes('name == "loadUrl"'),
  "WebView hosts must rewrite chrome-extension URLs onto the loopback resource server"
);
assert.ok(
  remoteInstaller.includes("ExtensionUrl.registerAlias(sourceId, internalId)") &&
    remoteInstaller.includes("webStoreId(source)"),
  "Chrome Web Store installs must remember the public extension id for virtual URL routing"
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

const chunkMatch = installerUi.match(/const CHUNK_SIZE = (\d+) \* 1024/);
assert.ok(chunkMatch, "reliable installer must declare an explicit upload chunk size");
assert.ok(
  Number(chunkMatch[1]) <= 16,
  "console/debug bridge chunks must stay small enough for Android Chromium/WebView"
);
assert.ok(
  installerUi.includes("dispatchAndWait") &&
    installerUi.includes("extension_install_progress") &&
    installerUi.includes("installFromUrl"),
  "extension install UI must wait for native ACKs and expose direct URL install"
);
assert.ok(
  bridge.includes("taggedUploadResult") &&
    bridge.includes('"installUrl"') &&
    bridge.includes('put("seq"'),
  "native extension bridge must correlate upload ACKs and direct installs"
);
assert.ok(
  remoteInstaller.includes("clients2.google.com/service/update2/crx") &&
    remoteInstaller.includes("MAX_PACKAGE_BYTES") &&
    remoteInstaller.includes("instanceFollowRedirects = false"),
  "direct installer must support Chrome Web Store downloads with bounded redirects and size"
);
assert.ok(
  localFiles.includes("MIN_UNPACKED_BYTES = 256 * 1024 * 1024L") &&
    localFiles.includes("MAX_UNPACKED_BYTES = 512 * 1024 * 1024L") &&
    localFiles.includes("MAX_UNPACK_RATIO = 20L") &&
    localFiles.includes("MAX_SINGLE_FILE_BYTES = 256 * 1024 * 1024L") &&
    localFiles.includes("coerceAtLeast(MIN_UNPACKED_BYTES)") &&
    localFiles.includes("coerceAtMost(MAX_UNPACKED_BYTES)"),
  "extension unpacking must use adaptive limits instead of the old fixed 96 MB cap"
);
assert.equal(
  localFiles.includes("Extension expands beyond 96 MB"),
  false,
  "the obsolete 96 MB unpack failure must not remain"
);
assert.ok(
  local.includes('ctx.assets.open("extension_install_fix.js")'),
  "manager must load the reliable extension installer layer"
);

console.log("Extension navigation, runtime, action popup, virtual URL and installation safety checks passed");
