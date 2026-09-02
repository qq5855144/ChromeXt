"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");

const read = (path) => fs.readFileSync(path, "utf8");

const mainHook = read("app/src/main/java/org/matrix/chromext/MainHook.kt");
const webViewHook = read("app/src/main/java/org/matrix/chromext/hook/WebView.kt");
const extensionHook = read("app/src/main/java/org/matrix/chromext/hook/ExtensionHook.kt");
const extensionRuntime = read("app/src/main/java/org/matrix/chromext/extension/ExtensionRuntime.kt");

assert.ok(mainHook.includes("initHooks(ExtensionHook)"), "extension-only must initialize ExtensionHook");
assert.ok(!mainHook.includes("initHooks(UserScriptHook)"), "extension-only must not initialize UserScriptHook");
assert.ok(!webViewHook.includes("ScriptDbManager"), "WebView path must not invoke UserScript storage/runtime");
assert.ok(!webViewHook.includes("Listener.startAction"), "WebView path must not use the UserScript console bridge");
assert.ok(!extensionHook.includes("ScriptDbManager"), "ExtensionHook must not depend on UserScript storage");
assert.ok(!extensionRuntime.includes("ScriptDbManager"), "ExtensionRuntime must not depend on UserScript storage");
assert.ok(!extensionRuntime.includes("GM.js"), "ExtensionRuntime must not load GM runtime assets");

console.log("Extension-only runtime boundary checks passed");
