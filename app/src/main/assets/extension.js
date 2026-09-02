"use strict";

/**
 * ChromeXt WebExtension compatibility runtime.
 *
 * This file is embedded into every extension execution context by LocalFiles.kt. It deliberately
 * implements the WebExtension surface in JavaScript and forwards privileged operations to the
 * ChromeXt native bridge, so it does not depend on the host browser shipping Chromium's extension
 * subsystem.
 */
const __cxCreateExtensionApi = (manifest, context, native) => {
  const extensionId = manifest.id;
  let sequence = 0;
  const pending = new Map();

  class ChromeEvent {
    #listeners = new Set();
    addListener(listener) {
      if (typeof listener === "function") this.#listeners.add(listener);
    }
    removeListener(listener) {
      this.#listeners.delete(listener);
    }
    hasListener(listener) {
      return this.#listeners.has(listener);
    }
    hasListeners() {
      return this.#listeners.size > 0;
    }
    dispatch(...args) {
      let result;
      for (const listener of [...this.#listeners]) {
        try {
          const value = listener(...args);
          if (value !== undefined) result = value;
        } catch (error) {
          console.error(`[ChromeXt Extension ${extensionId}] event listener failed`, error);
        }
      }
      return result;
    }
  }

  const runtime = {
    lastError: undefined,
    onMessage: new ChromeEvent(),
    onMessageExternal: new ChromeEvent(),
    onInstalled: new ChromeEvent(),
    onStartup: new ChromeEvent(),
    onConnect: new ChromeEvent(),
    onConnectExternal: new ChromeEvent(),
  };
  const storageChanged = new ChromeEvent();
  const webNavigationCommitted = new ChromeEvent();
  const webNavigationCompleted = new ChromeEvent();
  const commandsChanged = new ChromeEvent();

  const clone = (value) => {
    if (value === undefined) return null;
    try {
      return structuredClone(value);
    } catch {
      try {
        return JSON.parse(JSON.stringify(value));
      } catch {
        return null;
      }
    }
  };

  const invokeCallback = (callback, error, value) => {
    if (typeof callback !== "function") return;
    if (error) runtime.lastError = { message: String(error) };
    try {
      callback(value);
    } finally {
      runtime.lastError = undefined;
    }
  };

  const request = (api, rawArgs = []) => {
    const args = [...rawArgs];
    const callback = typeof args.at(-1) === "function" ? args.pop() : null;
    const requestId = `${extensionId}:${context.type}:${Date.now()}:${++sequence}`;
    const promise = new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject, callback });
      native.dispatch(
        "extensionApi",
        JSON.stringify({
          extensionId,
          requestId,
          api,
          args: clone(args),
          context,
        })
      );
    });
    return promise;
  };

  native.addEventListener("cx_extension_response", (event) => {
    const detail = event.detail || {};
    if (detail.extensionId !== extensionId) return;
    const task = pending.get(detail.requestId);
    if (!task) return;
    pending.delete(detail.requestId);
    if (detail.ok) {
      invokeCallback(task.callback, null, detail.value);
      task.resolve(detail.value);
    } else {
      const error = new Error(detail.error || "WebExtension API request failed");
      invokeCallback(task.callback, error);
      task.reject(error);
    }
  });

  native.addEventListener("cx_extension_message", (event) => {
    const detail = event.detail || {};
    if (detail.extensionId !== extensionId) return;
    let responded = false;
    const sendResponse = () => {
      responded = true;
    };
    const result = runtime.onMessage.dispatch(detail.message, detail.sender || {}, sendResponse);
    if (result && typeof result.then === "function") result.catch(console.error);
    return responded;
  });

  native.addEventListener("cx_extension_storage", (event) => {
    const detail = event.detail || {};
    if (detail.extensionId === extensionId)
      storageChanged.dispatch(detail.changes || {}, detail.areaName || "local");
  });

  const apiMethod = (name, transform) => (...args) => {
    if (transform) args = transform(args);
    return request(name, args);
  };

  const normalizeExecuteScript = (args) => {
    const details = { ...(args[0] || {}) };
    if (typeof details.func === "function") details.func = details.func.toString();
    details.args = clone(details.args || []);
    return [details, ...args.slice(1)];
  };

  const getURL = (path = "") => {
    const root = manifest.baseUrl || "";
    return root + String(path).replace(/^\//, "");
  };

  const getMessage = (name, substitutions) => {
    const entry = manifest.__messages?.[name];
    if (!entry) return "";
    let message = typeof entry === "string" ? entry : entry.message || "";
    const values = Array.isArray(substitutions) ? substitutions : substitutions == null ? [] : [substitutions];
    values.forEach((value, index) => {
      message = message.replaceAll(`$${index + 1}`, String(value));
    });
    return message.replace(/\$\$/g, "$");
  };

  const localCommands = Array.isArray(manifest.__commands) ? manifest.__commands : [];

  const chrome = {
    runtime: Object.assign(runtime, {
      id: extensionId,
      getManifest: () => clone(manifest),
      getURL,
      getPlatformInfo: apiMethod("runtime.getPlatformInfo"),
      sendMessage: apiMethod("runtime.sendMessage"),
      openOptionsPage: () => {
        if (manifest.optionsUrl) window.open(manifest.optionsUrl, "_blank");
        return Promise.resolve();
      },
      connect: (connectInfo = {}) => {
        const onMessage = new ChromeEvent();
        const onDisconnect = new ChromeEvent();
        const port = {
          name: connectInfo.name || "",
          sender: { id: extensionId, url: context.url },
          onMessage,
          onDisconnect,
          postMessage: (message) => request("runtime.sendMessage", [message]),
          disconnect: () => onDisconnect.dispatch(port),
        };
        queueMicrotask(() => runtime.onConnect.dispatch(port));
        return port;
      },
    }),
    storage: {
      onChanged: storageChanged,
    },
    tabs: {
      onActivated: new ChromeEvent(),
      onCreated: new ChromeEvent(),
      onRemoved: new ChromeEvent(),
      onUpdated: new ChromeEvent(),
      query: apiMethod("tabs.query"),
      getCurrent: apiMethod("tabs.getCurrent"),
      create: apiMethod("tabs.create"),
      update: apiMethod("tabs.update"),
      remove: apiMethod("tabs.remove"),
      reload: apiMethod("tabs.reload"),
      sendMessage: apiMethod("tabs.sendMessage"),
      executeScript: (tabId, details, callback) =>
        request("scripting.executeScript", [
          {
            target: { tabId },
            code: details?.code,
          },
          callback,
        ]),
      insertCSS: (tabId, details, callback) =>
        request("scripting.insertCSS", [
          {
            target: { tabId },
            css: details?.code,
          },
          callback,
        ]),
    },
    scripting: {
      executeScript: apiMethod("scripting.executeScript", normalizeExecuteScript),
      insertCSS: apiMethod("scripting.insertCSS"),
      removeCSS: () => Promise.resolve(),
      registerContentScripts: () => Promise.resolve(),
      unregisterContentScripts: () => Promise.resolve(),
      getRegisteredContentScripts: () => Promise.resolve([]),
    },
    permissions: {
      getAll: apiMethod("permissions.getAll"),
      contains: apiMethod("permissions.contains"),
      request: apiMethod("permissions.request"),
      remove: apiMethod("permissions.remove"),
      onAdded: new ChromeEvent(),
      onRemoved: new ChromeEvent(),
    },
    downloads: {
      download: apiMethod("downloads.download"),
      onCreated: new ChromeEvent(),
      onChanged: new ChromeEvent(),
      onErased: new ChromeEvent(),
    },
    notifications: {
      create: apiMethod("notifications.create"),
      clear: () => Promise.resolve(true),
      onClicked: new ChromeEvent(),
      onClosed: new ChromeEvent(),
      onButtonClicked: new ChromeEvent(),
    },
    cookies: {
      get: apiMethod("cookies.get"),
      set: apiMethod("cookies.set"),
      remove: apiMethod("cookies.remove"),
      getAll: async (details = {}) => {
        if (!details.name) return [];
        const value = await request("cookies.get", [details]);
        return value ? [value] : [];
      },
      onChanged: new ChromeEvent(),
    },
    i18n: {
      getMessage,
      getUILanguage: () => navigator.language,
      getAcceptLanguages: (callback) => {
        const value = [...(navigator.languages || [navigator.language])];
        if (callback) callback(value);
        return Promise.resolve(value);
      },
    },
    webNavigation: {
      onBeforeNavigate: new ChromeEvent(),
      onCommitted: webNavigationCommitted,
      onDOMContentLoaded: new ChromeEvent(),
      onCompleted: webNavigationCompleted,
      onErrorOccurred: new ChromeEvent(),
    },
    commands: {
      onCommand: commandsChanged,
      getAll: (callback) => {
        const value = clone(localCommands);
        if (callback) callback(value);
        return Promise.resolve(value);
      },
    },
    action: {
      onClicked: new ChromeEvent(),
      setBadgeText: () => Promise.resolve(),
      setBadgeBackgroundColor: () => Promise.resolve(),
      setTitle: () => Promise.resolve(),
      setIcon: () => Promise.resolve(),
      enable: () => Promise.resolve(),
      disable: () => Promise.resolve(),
      openPopup: () => {
        if (manifest.popupUrl) window.open(manifest.popupUrl, "_blank");
        return Promise.resolve();
      },
    },
    contextMenus: (() => {
      const items = new Map();
      const onClicked = new ChromeEvent();
      return {
        onClicked,
        create: (props, callback) => {
          const id = props?.id ?? `cx-menu-${items.size + 1}`;
          items.set(id, { ...props, id });
          if (callback) callback();
          return id;
        },
        update: (id, props, callback) => {
          if (items.has(id)) items.set(id, { ...items.get(id), ...props });
          if (callback) callback();
          return Promise.resolve();
        },
        remove: (id, callback) => {
          items.delete(id);
          if (callback) callback();
          return Promise.resolve();
        },
        removeAll: (callback) => {
          items.clear();
          if (callback) callback();
          return Promise.resolve();
        },
      };
    })(),
  };

  chrome.browserAction = chrome.action;
  chrome.pageAction = chrome.action;
  chrome.extension = {
    getURL,
    getBackgroundPage: () => context.type === "background" ? window : null,
    getViews: () => [window],
    isAllowedIncognitoAccess: (callback) => {
      if (callback) callback(false);
      return Promise.resolve(false);
    },
  };

  for (const areaName of ["local", "sync", "session"]) {
    chrome.storage[areaName] = {
      get: apiMethod(`storage.${areaName}.get`),
      set: apiMethod(`storage.${areaName}.set`),
      remove: apiMethod(`storage.${areaName}.remove`),
      clear: apiMethod(`storage.${areaName}.clear`),
      getBytesInUse: async () => {
        const value = await request(`storage.${areaName}.get`, [null]);
        return new Blob([JSON.stringify(value || {})]).size;
      },
      QUOTA_BYTES: 10 * 1024 * 1024,
    };
  }

  if (context.type === "background") {
    queueMicrotask(() => {
      runtime.onStartup.dispatch();
      runtime.onInstalled.dispatch({ reason: "browser_update", temporary: false });
    });
  }

  if (context.type === "content") {
    queueMicrotask(() => webNavigationCommitted.dispatch({
      frameId: context.frameId || 0,
      parentFrameId: context.frameId ? 0 : -1,
      tabId: -1,
      timeStamp: Date.now(),
      url: context.url,
    }));
    const completed = () => webNavigationCompleted.dispatch({
      frameId: context.frameId || 0,
      parentFrameId: context.frameId ? 0 : -1,
      tabId: -1,
      timeStamp: Date.now(),
      url: context.url,
    });
    if (document.readyState === "complete") queueMicrotask(completed);
    else window.addEventListener("load", completed, { once: true });
  }

  return chrome;
};
