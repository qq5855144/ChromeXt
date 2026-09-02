"use strict";

/** Browser-independent WebExtension compatibility runtime. */
const __cxCreateExtensionApi = (manifest, context, native) => {
  const extensionId = manifest.id;
  let sequence = 0;
  const pending = new Map();
  const messagePending = new Map();

  class ChromeEvent {
    constructor() {
      this.listeners = new Set();
    }
    addListener(listener) {
      if (typeof listener === "function") this.listeners.add(listener);
    }
    removeListener(listener) {
      this.listeners.delete(listener);
    }
    hasListener(listener) {
      return this.listeners.has(listener);
    }
    hasListeners() {
      return this.listeners.size > 0;
    }
    dispatch(...args) {
      let result;
      [...this.listeners].forEach((listener) => {
        try {
          const value = listener(...args);
          if (value !== undefined) result = value;
        } catch (error) {
          console.error(`[ChromeXt Extension ${extensionId}] event listener failed`, error);
        }
      });
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
      if (typeof structuredClone === "function") return structuredClone(value);
    } catch {}
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return null;
    }
  };

  const runtimeManifest = clone(manifest) || {};
  ["id", "enabled", "port", "baseUrl", "popupUrl", "optionsUrl", "__messages", "__commands"].forEach(
    (key) => delete runtimeManifest[key]
  );

  const invokeCallback = (callback, error, value) => {
    if (typeof callback !== "function") return;
    if (error) runtime.lastError = { message: String(error.message || error) };
    try {
      callback(value);
    } finally {
      runtime.lastError = undefined;
    }
  };

  const nextId = (kind = "request") => `${extensionId}:${context.type}:${kind}:${Date.now()}:${++sequence}`;

  const request = (api, rawArgs = []) => {
    const args = [...rawArgs];
    const last = args.length ? args[args.length - 1] : null;
    const callback = typeof last === "function" ? args.pop() : null;
    const requestId = nextId();
    return new Promise((resolve, reject) => {
      pending.set(requestId, { resolve, reject, callback });
      native.dispatch(
        "extensionApi",
        JSON.stringify({ extensionId, requestId, api, args: clone(args), context })
      );
    });
  };

  const sendMessage = (apiName, rawArgs) => {
    const args = [...rawArgs];
    const last = args.length ? args[args.length - 1] : null;
    const callback = typeof last === "function" ? args.pop() : null;
    const requestId = nextId("message-ack");
    const messageId = nextId("message");
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!messagePending.has(messageId)) return;
        messagePending.delete(messageId);
        invokeCallback(callback, null, undefined);
        resolve(undefined);
      }, 5000);
      messagePending.set(messageId, { resolve, callback, timer });
      native.dispatch(
        "extensionApi",
        JSON.stringify({
          extensionId,
          requestId,
          messageId,
          api: apiName,
          args: clone(args),
          context,
        })
      );
    });
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

  native.addEventListener("cx_extension_message_response", (event) => {
    const detail = event.detail || {};
    if (detail.extensionId !== extensionId) return;
    const task = messagePending.get(detail.messageId);
    if (!task) return;
    messagePending.delete(detail.messageId);
    clearTimeout(task.timer);
    invokeCallback(task.callback, null, detail.value);
    task.resolve(detail.value);
  });

  native.addEventListener("cx_extension_message", (event) => {
    const detail = event.detail || {};
    if (detail.extensionId !== extensionId) return;
    let responded = false;
    const sendResponse = (value) => {
      if (responded || !detail.messageId) return;
      responded = true;
      native.dispatch(
        "extensionApi",
        JSON.stringify({
          extensionId,
          requestId: nextId("response-ack"),
          messageId: detail.messageId,
          api: "runtime.sendMessageResponse",
          args: [clone(value)],
          context,
        })
      );
    };
    const result = runtime.onMessage.dispatch(detail.message, detail.sender || {}, sendResponse);
    if (result && typeof result.then === "function") {
      result.then(sendResponse).catch((error) => console.error(error));
    } else if (result !== undefined && result !== true) {
      sendResponse(result);
    }
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
    const details = Object.assign({}, args[0] || {});
    if (typeof details.func === "function") details.func = details.func.toString();
    details.args = clone(details.args || []);
    return [details].concat(args.slice(1));
  };

  const getURL = (path = "") => (manifest.baseUrl || "") + String(path).replace(/^\//, "");

  const localeCandidates = [];
  const addLocale = (locale) => {
    if (!locale) return;
    const normalized = String(locale).replace("-", "_");
    if (!localeCandidates.includes(normalized)) localeCandidates.push(normalized);
    const short = normalized.split("_")[0];
    if (short && !localeCandidates.includes(short)) localeCandidates.push(short);
  };
  addLocale(navigator.language);
  (navigator.languages || []).forEach(addLocale);
  addLocale(manifest.default_locale);

  let localeMessages = null;
  const loadLocaleMessages = () => {
    if (localeMessages) return localeMessages;
    localeMessages = {};
    for (const locale of localeCandidates) {
      try {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", getURL(`_locales/${locale}/messages.json`), false);
        xhr.send(null);
        if (xhr.status >= 200 && xhr.status < 300) {
          localeMessages = JSON.parse(xhr.responseText || "{}");
          break;
        }
      } catch {}
    }
    return localeMessages;
  };

  const getMessage = (name, substitutions) => {
    const entry = loadLocaleMessages()[name];
    if (!entry) return "";
    let message = typeof entry === "string" ? entry : entry.message || "";
    const values = Array.isArray(substitutions) ? substitutions : substitutions == null ? [] : [substitutions];
    values.forEach((value, index) => {
      message = message.split(`$${index + 1}`).join(String(value));
    });
    if (entry.placeholders && typeof entry.placeholders === "object") {
      Object.keys(entry.placeholders).forEach((placeholder) => {
        const content = entry.placeholders[placeholder]?.content || "";
        message = message.replace(new RegExp(`\\$${placeholder}\\$`, "gi"), content);
      });
    }
    return message.replace(/\$\$/g, "$");
  };

  const localCommands = Object.entries(manifest.commands || {}).map(([name, info]) =>
    Object.assign({ name }, info || {})
  );
  const alarms = new Map();
  const alarmEvent = new ChromeEvent();

  const chrome = {
    runtime: Object.assign(runtime, {
      id: extensionId,
      getManifest: () => clone(runtimeManifest),
      getURL,
      getPlatformInfo: apiMethod("runtime.getPlatformInfo"),
      sendMessage: (...args) => sendMessage("runtime.sendMessage", args),
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
          postMessage: (message) => sendMessage("runtime.sendMessage", [message]).then((value) => onMessage.dispatch(value)),
          disconnect: () => onDisconnect.dispatch(port),
        };
        setTimeout(() => runtime.onConnect.dispatch(port), 0);
        return port;
      },
    }),
    storage: { onChanged: storageChanged },
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
      sendMessage: (...args) => sendMessage("tabs.sendMessage", args),
      executeScript: (tabId, details, callback) => request("scripting.executeScript", [{ target: { tabId }, code: details && details.code }, callback]),
      insertCSS: (tabId, details, callback) => request("scripting.insertCSS", [{ target: { tabId }, css: details && details.code }, callback]),
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
    alarms: {
      onAlarm: alarmEvent,
      create: (name, info) => {
        if (typeof name === "object") { info = name; name = ""; }
        name = name || "";
        info = info || {};
        const delay = Math.max(0, Number(info.delayInMinutes || 0) * 60000 || Number(info.when || Date.now()) - Date.now());
        const period = Number(info.periodInMinutes || 0) * 60000;
        const fire = () => alarmEvent.dispatch({ name, scheduledTime: Date.now(), periodInMinutes: period ? period / 60000 : undefined });
        const timer = period ? setInterval(fire, Math.max(period, 60000)) : setTimeout(fire, delay);
        alarms.set(name, { name, scheduledTime: Date.now() + delay, periodInMinutes: period ? period / 60000 : undefined, timer, period: !!period });
      },
      get: (name, callback) => { const alarm = alarms.get(name); const value = alarm ? { name: alarm.name, scheduledTime: alarm.scheduledTime, periodInMinutes: alarm.periodInMinutes } : undefined; if (callback) callback(value); return Promise.resolve(value); },
      getAll: (callback) => { const value = [...alarms.values()].map(({ name, scheduledTime, periodInMinutes }) => ({ name, scheduledTime, periodInMinutes })); if (callback) callback(value); return Promise.resolve(value); },
      clear: (name, callback) => { const alarm = alarms.get(name); if (alarm) { alarm.period ? clearInterval(alarm.timer) : clearTimeout(alarm.timer); alarms.delete(name); } const value = !!alarm; if (callback) callback(value); return Promise.resolve(value); },
      clearAll: (callback) => { [...alarms.keys()].forEach((name) => chrome.alarms.clear(name)); if (callback) callback(true); return Promise.resolve(true); },
    },
    management: {
      getSelf: (callback) => { const value = { id: extensionId, name: manifest.name, version: manifest.version, enabled: true, type: "extension" }; if (callback) callback(value); return Promise.resolve(value); },
      getAll: (callback) => { const value = [{ id: extensionId, name: manifest.name, version: manifest.version, enabled: true, type: "extension" }]; if (callback) callback(value); return Promise.resolve(value); },
    },
    windows: {
      WINDOW_ID_CURRENT: -2,
      getCurrent: (callback) => { const value = { id: 0, focused: true, incognito: false }; if (callback) callback(value); return Promise.resolve(value); },
    },
    contextMenus: (() => {
      const items = new Map();
      const onClicked = new ChromeEvent();
      return {
        onClicked,
        create: (props, callback) => { const id = props && props.id != null ? props.id : `cx-menu-${items.size + 1}`; items.set(id, Object.assign({}, props, { id })); if (callback) callback(); return id; },
        update: (id, props, callback) => { if (items.has(id)) items.set(id, Object.assign({}, items.get(id), props)); if (callback) callback(); return Promise.resolve(); },
        remove: (id, callback) => { items.delete(id); if (callback) callback(); return Promise.resolve(); },
        removeAll: (callback) => { items.clear(); if (callback) callback(); return Promise.resolve(); },
      };
    })(),
  };

  chrome.browserAction = chrome.action;
  chrome.pageAction = chrome.action;
  chrome.extension = {
    getURL,
    getBackgroundPage: () => context.type === "background" ? window : null,
    getViews: () => [window],
    isAllowedIncognitoAccess: (callback) => { if (callback) callback(false); return Promise.resolve(false); },
  };

  ["local", "sync", "session"].forEach((areaName) => {
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
  });

  if (context.type === "background") {
    setTimeout(() => {
      runtime.onStartup.dispatch();
      runtime.onInstalled.dispatch({ reason: "browser_update", temporary: false });
    }, 0);
  }

  if (context.type === "content") {
    setTimeout(() => webNavigationCommitted.dispatch({ frameId: context.frameId || 0, parentFrameId: context.frameId ? 0 : -1, tabId: -1, timeStamp: Date.now(), url: context.url }), 0);
    const completed = () => webNavigationCompleted.dispatch({ frameId: context.frameId || 0, parentFrameId: context.frameId ? 0 : -1, tabId: -1, timeStamp: Date.now(), url: context.url });
    if (document.readyState === "complete") setTimeout(completed, 0);
    else window.addEventListener("load", completed, { once: true });
  }

  return chrome;
};
