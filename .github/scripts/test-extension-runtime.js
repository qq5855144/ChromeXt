"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("app/src/main/assets/extension.js", "utf8");
const events = new Map();
const calls = [];

const emit = (name, detail) => {
  for (const listener of events.get(name) || []) listener({ detail });
};

const native = {
  addEventListener(name, listener) {
    if (!events.has(name)) events.set(name, new Set());
    events.get(name).add(listener);
  },
  dispatch(action, payload) {
    assert.equal(action, "extensionApi");
    const request = JSON.parse(payload);
    calls.push(request);
    if (request.api === "runtime.sendMessageResponse") {
      queueMicrotask(() =>
        emit("cx_extension_response", {
          ok: true,
          extensionId: request.extensionId,
          requestId: request.requestId,
          value: null,
        })
      );
      return;
    }
    if (request.api === "tabs.sendMessage") {
      queueMicrotask(() =>
        emit("cx_extension_response", {
          ok: false,
          extensionId: request.extensionId,
          requestId: request.requestId,
          error: "Target tab is not available",
        })
      );
      return;
    }
    const value =
      request.api === "runtime.getPlatformInfo"
        ? { os: "android", arch: "arm64", nacl_arch: "" }
        : request.api === "scripting.getRegisteredContentScripts"
          ? []
          : null;
    queueMicrotask(() =>
      emit("cx_extension_response", {
        ok: true,
        extensionId: request.extensionId,
        requestId: request.requestId,
        value,
      })
    );
  },
};

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  queueMicrotask,
  Blob,
  structuredClone,
  navigator: { language: "en-US", languages: ["en-US", "en"] },
  document: {
    readyState: "complete",
    addEventListener() {},
    documentElement: {},
    head: {},
  },
  XMLHttpRequest: class {
    open() {}
    send() {
      this.status = 404;
      this.responseText = "";
    }
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

vm.runInNewContext(`${source}\n;globalThis.__cxFactory=__cxCreateExtensionApi;`, sandbox, {
  filename: "extension.js",
});

const manifest = {
  id: "abcdefghijklmnopabcdefghijklmnop",
  name: "Runtime smoke test",
  version: "1.0.0",
  manifest_version: 3,
  enabled: true,
  baseUrl: "http://127.0.0.1:12345/",
  host_permissions: ["https://example.com/*"],
  permissions: ["scripting"],
};
const context = {
  type: "content",
  url: "https://example.com/page",
  frameId: null,
  extensionId: manifest.id,
};
const chrome = sandbox.__cxFactory(manifest, context, native);

(async () => {
  const publicManifest = chrome.runtime.getManifest();
  assert.equal(publicManifest.name, manifest.name);
  assert.equal(publicManifest.id, undefined);
  assert.equal(publicManifest.baseUrl, undefined);

  const platform = await chrome.runtime.getPlatformInfo();
  assert.equal(platform.os, "android");

  let received = 0;
  chrome.runtime.onMessage.addListener((message) => {
    received += 1;
    return { echoed: message };
  });

  emit("cx_extension_message", {
    extensionId: manifest.id,
    target: "extension",
    senderContext: { contextId: "background:test:top" },
    messageId: "ignored",
    message: "not-for-content",
  });
  assert.equal(received, 0, "content contexts must ignore extension-only messages");

  emit("cx_extension_message", {
    extensionId: manifest.id,
    target: "content",
    senderContext: { contextId: "background:test:top" },
    messageId: "accepted",
    message: "hello",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(received, 1, "content-targeted messages must reach listeners");
  assert.ok(calls.some((call) => call.api === "runtime.sendMessageResponse"));

  emit("cx_extension_message", {
    extensionId: manifest.id,
    target: "content",
    senderContext: { contextId: context.contextId },
    messageId: "self",
    message: "self",
  });
  assert.equal(received, 1, "a message must not be delivered back to its sender context");

  const registered = await chrome.scripting.getRegisteredContentScripts();
  assert.deepEqual(Array.from(registered), []);
  assert.ok(calls.some((call) => call.api === "scripting.getRegisteredContentScripts"));

  await assert.rejects(
    chrome.tabs.sendMessage("missing-tab", { ping: true }),
    /Target tab is not available/
  );

  console.log("WebExtension runtime smoke test passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
