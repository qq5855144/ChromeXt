"use strict";

/**
 * Soft WebExtension compatibility namespaces.
 *
 * These shims intentionally keep complex extensions bootable on browsers that do not expose
 * Chromium's native ExtensionService. They preserve API shape and state semantics where ChromeXt
 * can do so safely; they do not claim native network-stack enforcement for DNR/webRequest.
 */
(() => {
  const api = typeof chrome !== "undefined" ? chrome : globalThis.chrome;
  if (!api?.runtime?.id) return;

  const extensionId = api.runtime.id;
  const runtimeContext = typeof __cxContext !== "undefined" && __cxContext ? __cxContext : {};
  const roots = globalThis.__cxExtensionCompatState || (globalThis.__cxExtensionCompatState = {});
  const state = roots[extensionId] || (roots[extensionId] = {
    dynamicRules: new Map(),
    sessionRules: new Map(),
    enabledRulesets: new Set(),
    userScripts: new Map(),
    privacy: new Map(),
  });

  const clone = (value) => {
    if (value === undefined) return undefined;
    try {
      if (typeof structuredClone === "function") return structuredClone(value);
    } catch (_) {}
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return value;
    }
  };

  const result = (value, callback) => {
    if (typeof callback === "function") queueMicrotask(() => callback(clone(value)));
    return Promise.resolve(clone(value));
  };

  const makeEvent = () => {
    const listeners = new Set();
    return {
      addListener(listener) {
        if (typeof listener === "function") listeners.add(listener);
      },
      removeListener(listener) {
        listeners.delete(listener);
      },
      hasListener(listener) {
        return listeners.has(listener);
      },
      hasListeners() {
        return listeners.size > 0;
      },
      dispatch() {
        const args = Array.from(arguments);
        let response;
        Array.from(listeners).forEach((listener) => {
          try {
            const value = listener.apply(null, args);
            if (value !== undefined) response = value;
          } catch (error) {
            console.error(`[ChromeXt Extension ${extensionId}] compat event failed`, error);
          }
        });
        return response;
      },
    };
  };

  const updateRuleMap = (map, options = {}) => {
    const remove = Array.isArray(options.removeRuleIds) ? options.removeRuleIds : [];
    remove.forEach((id) => map.delete(Number(id)));
    const add = Array.isArray(options.addRules) ? options.addRules : [];
    add.forEach((rule) => {
      if (rule && rule.id != null) map.set(Number(rule.id), clone(rule));
    });
  };

  if (!api.webRequest) {
    const ResourceType = {
      MAIN_FRAME: "main_frame",
      SUB_FRAME: "sub_frame",
      STYLESHEET: "stylesheet",
      SCRIPT: "script",
      IMAGE: "image",
      FONT: "font",
      OBJECT: "object",
      XMLHTTPREQUEST: "xmlhttprequest",
      PING: "ping",
      CSP_REPORT: "csp_report",
      MEDIA: "media",
      WEBSOCKET: "websocket",
      WEBTRANSPORT: "webtransport",
      WEBBUNDLE: "webbundle",
      OTHER: "other",
    };
    api.webRequest = {
      ResourceType,
      onBeforeRequest: makeEvent(),
      onBeforeSendHeaders: makeEvent(),
      onSendHeaders: makeEvent(),
      onHeadersReceived: makeEvent(),
      onAuthRequired: makeEvent(),
      onResponseStarted: makeEvent(),
      onBeforeRedirect: makeEvent(),
      onCompleted: makeEvent(),
      onErrorOccurred: makeEvent(),
      handlerBehaviorChanged: (callback) => result(undefined, callback),
      filterResponseData: () => ({
        ondata: null,
        onstop: null,
        onerror: null,
        write() {},
        close() {},
        disconnect() {},
      }),
    };
  }

  if (!api.declarativeNetRequest) {
    const ruleResources = api.runtime.getManifest()?.declarative_net_request?.rule_resources || [];
    if (state.enabledRulesets.size === 0) {
      ruleResources.forEach((item) => {
        if (item?.enabled !== false && item?.id) state.enabledRulesets.add(String(item.id));
      });
    }

    const dnrDebugEvent = makeEvent();
    api.declarativeNetRequest = {
      MAX_NUMBER_OF_DYNAMIC_RULES: 30000,
      MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: 5000,
      MAX_NUMBER_OF_REGEX_RULES: 1000,
      MAX_NUMBER_OF_ENABLED_STATIC_RULESETS: 50,
      GUARANTEED_MINIMUM_STATIC_RULES: 30000,
      ResourceType: api.webRequest?.ResourceType || {},
      RuleActionType: {
        BLOCK: "block",
        REDIRECT: "redirect",
        ALLOW: "allow",
        UPGRADE_SCHEME: "upgradeScheme",
        MODIFY_HEADERS: "modifyHeaders",
        ALLOW_ALL_REQUESTS: "allowAllRequests",
      },
      HeaderOperation: {
        APPEND: "append",
        SET: "set",
        REMOVE: "remove",
      },
      onRuleMatchedDebug: dnrDebugEvent,
      updateDynamicRules: (options, callback) => {
        updateRuleMap(state.dynamicRules, options);
        return result(undefined, callback);
      },
      getDynamicRules: (callback) => result(Array.from(state.dynamicRules.values()), callback),
      updateSessionRules: (options, callback) => {
        updateRuleMap(state.sessionRules, options);
        return result(undefined, callback);
      },
      getSessionRules: (callback) => result(Array.from(state.sessionRules.values()), callback),
      updateEnabledRulesets: (options = {}, callback) => {
        (options.disableRulesetIds || []).forEach((id) => state.enabledRulesets.delete(String(id)));
        (options.enableRulesetIds || []).forEach((id) => state.enabledRulesets.add(String(id)));
        return result(undefined, callback);
      },
      getEnabledRulesets: (callback) => result(Array.from(state.enabledRulesets), callback),
      getAvailableStaticRuleCount: (callback) => result(330000, callback),
      isRegexSupported: (regexOptions, callback) =>
        result({ isSupported: true, reason: undefined }, callback),
      getMatchedRules: (filter, callback) => result({ rulesMatchedInfo: [] }, callback),
      testMatchOutcome: (request, options, callback) => result({ matchedRules: [] }, callback),
      setExtensionActionOptions: (options, callback) => result(undefined, callback),
    };
  }

  if (!api.userScripts) {
    const matchesFilter = (entry, filter) => {
      if (!filter || !Array.isArray(filter.ids) || filter.ids.length === 0) return true;
      return filter.ids.includes(entry.id);
    };
    api.userScripts = {
      register: (scripts, callback) => {
        (scripts || []).forEach((script) => {
          if (script?.id) state.userScripts.set(String(script.id), clone(script));
        });
        return result(undefined, callback);
      },
      update: (scripts, callback) => {
        (scripts || []).forEach((script) => {
          if (!script?.id) return;
          const previous = state.userScripts.get(String(script.id)) || {};
          state.userScripts.set(String(script.id), Object.assign({}, previous, clone(script)));
        });
        return result(undefined, callback);
      },
      unregister: (filter, callback) => {
        if (!filter?.ids?.length) state.userScripts.clear();
        else filter.ids.forEach((id) => state.userScripts.delete(String(id)));
        return result(undefined, callback);
      },
      getScripts: (filter, callback) =>
        result(Array.from(state.userScripts.values()).filter((item) => matchesFilter(item, filter)), callback),
      configureWorld: (properties, callback) => result(undefined, callback),
      resetWorldConfiguration: (callback) => result(undefined, callback),
    };
  }

  const privacySetting = (key, defaultValue) => {
    const onChange = makeEvent();
    return {
      onChange,
      get: (details, callback) => {
        const value = state.privacy.has(key) ? state.privacy.get(key) : defaultValue;
        return result({ value, levelOfControl: "controllable_by_this_extension" }, callback);
      },
      set: (details, callback) => {
        const value = details?.value;
        state.privacy.set(key, value);
        queueMicrotask(() => onChange.dispatch({ value, levelOfControl: "controlled_by_this_extension" }));
        return result(undefined, callback);
      },
      clear: (details, callback) => {
        state.privacy.delete(key);
        queueMicrotask(() => onChange.dispatch({ value: defaultValue, levelOfControl: "controllable_by_this_extension" }));
        return result(undefined, callback);
      },
    };
  };

  if (!api.privacy) {
    api.privacy = {
      network: {
        networkPredictionEnabled: privacySetting("networkPredictionEnabled", true),
        webRTCIPHandlingPolicy: privacySetting("webRTCIPHandlingPolicy", "default"),
      },
      services: {
        alternateErrorPagesEnabled: privacySetting("alternateErrorPagesEnabled", true),
        autofillAddressEnabled: privacySetting("autofillAddressEnabled", true),
        autofillCreditCardEnabled: privacySetting("autofillCreditCardEnabled", true),
        passwordSavingEnabled: privacySetting("passwordSavingEnabled", true),
        safeBrowsingEnabled: privacySetting("safeBrowsingEnabled", true),
        safeBrowsingExtendedReportingEnabled: privacySetting("safeBrowsingExtendedReportingEnabled", false),
        searchSuggestEnabled: privacySetting("searchSuggestEnabled", true),
        spellingServiceEnabled: privacySetting("spellingServiceEnabled", true),
        translationServiceEnabled: privacySetting("translationServiceEnabled", true),
      },
      websites: {
        hyperlinkAuditingEnabled: privacySetting("hyperlinkAuditingEnabled", true),
        referrersEnabled: privacySetting("referrersEnabled", true),
        thirdPartyCookiesAllowed: privacySetting("thirdPartyCookiesAllowed", true),
      },
    };
  }

  if (api.tabs) {
    const suppliedTab = runtimeContext.activeTab && typeof runtimeContext.activeTab === "object"
      ? clone(runtimeContext.activeTab)
      : null;
    const safeTab = Object.assign(
      {
        id: runtimeContext.tabId || "",
        url: String(runtimeContext.activeUrl || runtimeContext.url || "about:blank"),
        title: "",
        active: true,
        highlighted: true,
        selected: true,
        pinned: false,
        incognito: false,
        windowId: 0,
        index: 0,
        status: "complete",
      },
      suppliedTab || {}
    );
    if (!safeTab.url) safeTab.url = String(runtimeContext.activeUrl || runtimeContext.url || "about:blank");

    const matchesQuery = (query = {}) => {
      if (query.active === false || query.highlighted === false) return false;
      if (query.pinned === true || query.incognito === true) return false;
      if (query.windowId != null && Number(query.windowId) !== Number(safeTab.windowId || 0)) return false;
      const urls = query.url == null ? [] : Array.isArray(query.url) ? query.url : [query.url];
      if (!urls.length) return true;
      return urls.some((pattern) => {
        const source = String(pattern)
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*");
        try {
          return new RegExp(`^${source}$`, "i").test(safeTab.url);
        } catch (_) {
          return false;
        }
      });
    };

    // Do not synchronously enumerate DevTools pages merely because a popup/background asks for
    // the active tab. The tab snapshot is captured from the real browser-owned page lifecycle.
    api.tabs.query = (query, callback) => result(matchesQuery(query) ? [safeTab] : [], callback);
    api.tabs.getCurrent = (callback) => result(safeTab, callback);
    api.tabs.get = (tabId, callback) =>
      result(String(tabId) === String(safeTab.id) ? safeTab : undefined, callback);

    api.tabs.onHighlighted ||= makeEvent();
    api.tabs.onReplaced ||= makeEvent();
    api.tabs.onDetached ||= makeEvent();
    api.tabs.onAttached ||= makeEvent();
    api.tabs.getZoom ||= (tabId, callback) => result(1, callback);
    api.tabs.setZoom ||= (tabId, factor, callback) => result(undefined, callback);
    api.tabs.detectLanguage ||= (tabId, callback) => result(navigator.language || "en", callback);
  }

  if (api.windows) {
    api.windows.onCreated ||= makeEvent();
    api.windows.onRemoved ||= makeEvent();
    api.windows.onFocusChanged ||= makeEvent();
  }

  api.runtime.setUninstallURL ||= (url, callback) => result(undefined, callback);
  api.runtime.requestUpdateCheck ||= (callback) => result({ status: "no_update" }, callback);
  if (api.extension) api.extension.inIncognitoContext = false;
})();
