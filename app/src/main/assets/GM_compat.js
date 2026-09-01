const globalThis = (() => {
  const base = GM.globalThis;
  const grants = Array.isArray(GM_info.script.grants) ? GM_info.script.grants : [];
  const canFocus = grants.includes("window.focus");
  const canTrackUrl = grants.includes("window.onurlchange");

  if (canTrackUrl) {
    let lastUrl = location.href;
    const notify = () => {
      const url = location.href;
      if (url === lastUrl) return;
      const oldUrl = lastUrl;
      lastUrl = url;
      const event = new Event("urlchange");
      Object.defineProperties(event, {
        url: { value: url, enumerable: true },
        oldUrl: { value: oldUrl, enumerable: true },
      });
      base.dispatchEvent(event);
    };

    const history = base.history;
    const marker = Symbol.for("ChromeXt.urlchange.history");
    for (const method of ["pushState", "replaceState"]) {
      const original = history?.[method];
      if (typeof original !== "function" || original[marker]) continue;
      const wrapped = function () {
        const result = Reflect.apply(original, this, arguments);
        queueMicrotask(notify);
        return result;
      };
      Object.defineProperty(wrapped, marker, { value: true });
      try {
        history[method] = wrapped;
      } catch {
        // Navigation API / DOM events below still provide a best-effort fallback.
      }
    }

    base.addEventListener("popstate", notify);
    base.addEventListener("hashchange", notify);
    if (base.navigation && typeof base.navigation.addEventListener === "function") {
      base.navigation.addEventListener("navigatesuccess", notify);
    }
  }

  if (!canFocus && !canTrackUrl) return base;
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "focus" && canFocus) {
        return () =>
          LockedChromeXt.unlock(key).dispatch("focus", { requestFocus: true });
      }
      if (prop === "onurlchange" && canTrackUrl) return null;
      return Reflect.get(target, prop, receiver);
    },
    set(target, prop, value, receiver) {
      if (prop === "onurlchange" && canTrackUrl) {
        if (typeof value === "function") target.addEventListener("urlchange", value);
        return true;
      }
      return Reflect.set(target, prop, value, receiver);
    },
  });
})();
const window = globalThis;
const self = globalThis;
const parent = globalThis;
const frames = globalThis;
const top = globalThis;
delete GM.globalThis;
delete GM_info.script.code;
delete GM_info.script.sync_code;
delete GM.key;
delete GM.name;
Object.freeze(GM_info.script);
const ChromeXt = GM.ChromeXt;
if (typeof GM_xmlhttpRequest == "function" && !GM_xmlhttpRequest.strict) {
  GM_xmlhttpRequest.addCookie = GM_info.script.grants.includes("GM_cookie");
  Object.defineProperty(GM_xmlhttpRequest, "strict", { value: true });
}
// Kotlin separator

const GM_cookie = new (class CookieManager {
  #cache = [];
  #timeout = 3000;
  #fallbackWarned = false;

  get store() {
    return this.#cache;
  }

  #cookieUrl(details = {}) {
    const url = new URL(details.url || location.href, location.href);
    this.#assertAccess(url);
    return url;
  }

  #warnFallback(error) {
    if (this.#fallbackWarned) return;
    this.#fallbackWarned = true;
    console.warn(
      "ChromeXt: GM_cookie is using document.cookie fallback; HttpOnly and cross-origin cookies are unavailable.",
      error
    );
  }

  #globToRegExp(pattern) {
    return new RegExp(
      "^" +
        pattern
          .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*") +
        "$"
    );
  }

  #matchGrantPattern(pattern, url) {
    if (pattern === "<all_urls>")
      return ["http:", "https:", "file:", "ftp:"].includes(url.protocol);
    const match = /^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)$/.exec(pattern);
    if (!match) return false;
    const [, scheme, hostPattern, pathPattern] = match;
    if (scheme === "*" && !["http:", "https:"].includes(url.protocol)) return false;
    if (scheme !== "*" && url.protocol !== scheme + ":") return false;
    const host = url.hostname.toLowerCase();
    const expectedHost = hostPattern.toLowerCase();
    if (expectedHost !== "*") {
      if (expectedHost.startsWith("*.")) {
        const suffix = expectedHost.slice(2);
        if (!(host === suffix || host.endsWith("." + suffix))) return false;
      } else if (host !== expectedHost) {
        return false;
      }
    }
    return this.#globToRegExp(pathPattern).test(url.pathname + url.search + url.hash);
  }

  #includePatternMatches(pattern, url) {
    if (pattern.startsWith("/") && pattern.endsWith("/") && pattern.length > 2) {
      try {
        return new RegExp(pattern.slice(1, -1)).test(url.href);
      } catch {
        return false;
      }
    }
    return this.#globToRegExp(pattern).test(url.href);
  }

  #assertAccess(url) {
    if (url.origin === location.origin) return;
    const matches = Array.isArray(GM_info.script.matches) ? GM_info.script.matches : [];
    const includes = Array.isArray(GM_info.script.includes) ? GM_info.script.includes : [];
    const allowed =
      matches.some((pattern) => this.#matchGrantPattern(pattern, url)) ||
      includes.some((pattern) => this.#includePatternMatches(pattern, url));
    if (!allowed) {
      throw new Error(`GM_cookie access denied for ${url.href}: URL is outside @match/@include`);
    }
  }

  #domainMatches(hostname, domain) {
    if (!domain) return true;
    const normalized = String(domain).replace(/^\./, "").toLowerCase();
    const host = hostname.toLowerCase();
    return host === normalized || host.endsWith("." + normalized);
  }

  #fallbackList(details = {}) {
    const url = this.#cookieUrl(details);
    if (url.origin !== location.origin) {
      throw new Error("GM_cookie fallback only supports the current origin");
    }
    if (!this.#domainMatches(url.hostname, details.domain)) return [];

    const cookies = document.cookie
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        const name = index === -1 ? part : part.slice(0, index);
        const value = index === -1 ? "" : part.slice(index + 1);
        return new CookieParam({
          name,
          value,
          domain: url.hostname,
          path: "/",
          secure: url.protocol === "https:",
          httpOnly: false,
          session: true,
          expires: -1,
          sourceScheme: url.protocol === "https:" ? "Secure" : "NonSecure",
          sourcePort: url.port
            ? Number(url.port)
            : url.protocol === "https:"
            ? 443
            : 80,
        });
      });

    const props = ["domain", "name", "path"].filter((key) => key in details);
    return cookies.filter((cookie) =>
      props.every((prop) => {
        if (prop === "domain") return this.#domainMatches(cookie.domain, details.domain);
        return cookie[prop] === details[prop];
      })
    );
  }

  #fallbackSet(details) {
    const url = this.#cookieUrl(details);
    if (url.origin !== location.origin) {
      throw new Error("GM_cookie fallback only supports the current origin");
    }
    if (details.httpOnly === true) {
      throw new Error("GM_cookie fallback cannot set HttpOnly cookies");
    }
    if (!this.#domainMatches(url.hostname, details.domain)) {
      throw new Error("Cookie domain is outside the current origin");
    }
    if (typeof details.name !== "string" || !("value" in details)) {
      throw new TypeError("Cookie name and value are required");
    }

    const parts = [`${details.name}=${details.value}`];
    parts.push(`Path=${details.path || "/"}`);
    if (details.domain) parts.push(`Domain=${details.domain}`);
    if (details.secure === true) parts.push("Secure");
    if (typeof details.sameSite === "string") {
      parts.push(`SameSite=${details.sameSite}`);
    }
    if (Number.isFinite(details.expirationDate)) {
      parts.push(`Expires=${new Date(details.expirationDate * 1000).toUTCString()}`);
    }
    document.cookie = parts.join("; ");
  }

  #fallbackDelete(details) {
    const url = this.#cookieUrl(details);
    if (url.origin !== location.origin) {
      throw new Error("GM_cookie fallback only supports the current origin");
    }
    if (typeof details.name !== "string") {
      throw new TypeError("Cookie name is required");
    }
    if (!this.#domainMatches(url.hostname, details.domain)) {
      throw new Error("Cookie domain is outside the current origin");
    }
    const parts = [
      `${details.name}=`,
      `Path=${details.path || "/"}`,
      "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
      "Max-Age=0",
    ];
    if (details.domain) parts.push(`Domain=${details.domain}`);
    document.cookie = parts.join("; ");
  }

  #command(method, params) {
    const uuid = Math.random();
    const payload = { method, params, uuid, id: GM_info.script.id };
    const ChromeXt = LockedChromeXt.unlock(key);
    const self = this;

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        ChromeXt.removeEventListener("cookie", listener);
      };

      const finish = (handler, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        handler(value);
      };

      function listener(e) {
        const data = e?.detail;
        if (!data || e.type !== "cookie" || data.id !== payload.id || data.uuid !== uuid)
          return;

        e.stopImmediatePropagation();
        const responses = Array.isArray(data.response) ? data.response : [];
        const response = responses.find((entry) => entry && entry.id === 2);
        if (!response) {
          finish(reject, new TypeError(`Response not found for ${method}`));
          return;
        }
        if (response.error) {
          finish(
            reject,
            new TypeError(
              "CDP Error: " + (response.error.message || JSON.stringify(response.error))
            )
          );
          return;
        }

        if (method === "Network.getCookies" && response.result?.cookies) {
          self.#cache = response.result.cookies.map((cookie) => new CookieParam(cookie));
        }
        finish(resolve, response.result);
      }

      ChromeXt.addEventListener("cookie", listener);
      timer = setTimeout(() => {
        finish(reject, new Error("Chrome DevTools cookie backend is unavailable"));
      }, this.#timeout);

      try {
        ChromeXt.dispatch("cookie", payload);
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  export(url = location.origin, store, httpOnly = false) {
    const cookies = store || this.store;
    if (!Array.isArray(cookies)) return;
    const parsedUrl = url instanceof URL ? url : new URL(url, location.href);
    if (cookies === this.store && parsedUrl.origin !== location.origin) return;
    return cookies
      .map((it) => (it instanceof CookieParam ? it : new CookieParam(it)))
      .filter((it) => it.match(parsedUrl, httpOnly))
      .map((cookie) => cookie.toHeader());
  }

  async list(details = {}, callback) {
    if (typeof details === "function") {
      callback = details;
      details = {};
    }
    if (details == null) details = {};
    let cookies;
    let error;

    try {
      if (typeof details !== "object") throw new TypeError("Invalid parameters");
      const url = this.#cookieUrl(details);
      try {
        await this.#command("Network.getCookies", { urls: [url.href] });
        const props = ["domain", "name", "path"].filter((key) => key in details);
        cookies =
          props.length === 0
            ? this.#cache
            : this.#cache.filter((item) =>
                props.every((prop) => {
                  if (prop === "domain")
                    return this.#domainMatches(item.domain, details.domain);
                  return item[prop] === details[prop];
                })
              );
      } catch (cdpError) {
        this.#warnFallback(cdpError);
        cookies = this.#fallbackList(details);
      }
      this.#cache = cookies;
    } catch (e) {
      error = e instanceof Error ? e : new Error(String(e));
    }

    if (typeof callback === "function") callback(cookies, error?.message);
    if (error) throw error;
    return cookies;
  }

  async #dispatch(method, details, callback, fallback) {
    let result;
    let error;
    try {
      result = await this.#command(method, details);
    } catch (cdpError) {
      this.#warnFallback(cdpError);
      try {
        result = fallback();
      } catch (fallbackError) {
        error = fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError));
      }
    }
    if (typeof callback === "function") callback(error?.message);
    if (error) throw error;
    return result;
  }

  set(details, callback) {
    const input = Array.isArray(details) ? details : [details];
    if (input.some((cookie) => !cookie || typeof cookie !== "object")) {
      const error = new TypeError("Invalid parameters");
      if (typeof callback === "function") callback(error.message);
      return Promise.reject(error);
    }

    const cookies = input.map((cookie) => {
      const normalized = { ...cookie };
      if (typeof normalized.expirationDate === "number") {
        normalized.expires = normalized.expirationDate;
        delete normalized.expirationDate;
      }
      if (normalized.domain == null && normalized.url == null) {
        normalized.url = window.location.href;
      }
      if (normalized.url != null) {
        this.#cookieUrl(normalized);
      } else if (normalized.domain != null) {
        const domain = String(normalized.domain).replace(/^\./, "");
        if (!this.#domainMatches(location.hostname, domain)) {
          this.#assertAccess(new URL(`${location.protocol}//${domain}/`));
        }
      }
      return normalized;
    });

    return this.#dispatch(
      "Network.setCookies",
      { cookies },
      callback,
      () => {
        cookies.forEach((cookie) =>
          this.#fallbackSet({
            ...cookie,
            expirationDate: cookie.expires,
          })
        );
      }
    );
  }

  delete(details, callback) {
    if (!details || typeof details !== "object") {
      const error = new TypeError("Invalid parameters");
      if (typeof callback === "function") callback(error.message);
      return Promise.reject(error);
    }
    const normalized = { ...details };
    if (normalized.domain == null && normalized.url == null) {
      normalized.url = window.location.href;
    }
    if (normalized.url != null) {
      this.#cookieUrl(normalized);
    } else if (normalized.domain != null) {
      const domain = String(normalized.domain).replace(/^\./, "");
      if (!this.#domainMatches(location.hostname, domain)) {
        this.#assertAccess(new URL(`${location.protocol}//${domain}/`));
      }
    }
    return this.#dispatch(
      "Network.deleteCookies",
      normalized,
      callback,
      () => this.#fallbackDelete(normalized)
    );
  }
})();

class CookieParam {
  #header;
  constructor(data) {
    if (
      typeof data == "object" &&
      typeof data.name == "string" &&
      "value" in data
    ) {
      Object.assign(this, data);
      if (typeof this.header == "string") {
        this.#header = this.header;
        delete this.header;
      }
    } else {
      throw TypeError("Invalid parameters for cookie");
    }
  }
  static fromHeader(str, url) {
    const props = str
      .split(";")
      .map((it) => it.trim())
      .filter((it) => it.length > 0);
    const defn = props.shift().split("=");
    if (defn.length < 2) return;
    const cookie = new CookieParam({
      name: defn.shift(),
      value: defn.join("="),
      header: str,
    });
    props.forEach((prop) => {
      const parts = prop.split("=");
      const key = parts.shift().toLowerCase();
      var value = parts.join("=");
      if (key === "expires") {
        cookie.expires = new Date(value).getTime() / 1000;
      } else if (key === "max-age") {
        cookie.maxAge = Number(value);
        cookie.expires = cookie.maxAge + new Date().getTime() / 1000;
      } else if (key === "secure") {
        cookie.secure = true;
      } else if (key === "httponly") {
        cookie.httpOnly = true;
      } else {
        cookie[key] = value;
      }
    });
    cookie.url = url;
    cookie.session = cookie.expires == -1;
    return cookie;
  }
  set url(url) {
    if (!(url instanceof URL)) url = new URL(url || location.origin);
    this.domain = this.domain || url.hostname;
    if (url.port.length != 0) {
      this.sourcePort = Number(url.port);
    } else if (url.protocol == "https:") {
      this.sourcePort = 443;
    } else if (url.protocol == "http:") {
      this.sourcePort = 80;
    }
    if (url.protocol.endsWith("s:")) this.sourceScheme = "Secure";
  }
  httpOnly = false;
  path = "/";
  secure = false;
  expires = -1;
  priority = "Medium";
  sourceScheme = "NonSecure";
  capitalize(s) {
    return s && s[0].toUpperCase() + s.slice(1);
  }
  toHeader() {
    if (typeof this.#header == "string") return this.#header;
    let header = [this.name + "=" + this.value];
    if (this.domain) header.push(`Domain=${this.domain}`);
    if (Number.isFinite(this.maxAge) && this.maxAge > 0) {
      header.push(`Max-Age=${this.maxAge}`);
    }
    if (Number.isFinite(this.expires) && this.expires != -1) {
      const date = new Date();
      date.setTime(this.expires * 1000);
      header.push(`Expires=${date.toUTCString()}`);
    }
    const props = ["path", "sameSite", "httpOnly", "secure"];
    for (const prop of props) {
      if (!(prop in this)) continue;
      const val = this[prop];
      if (typeof val == "string" && val.length != 0) {
        header.push(this.capitalize(prop) + `=${this.capitalize(val)}`);
      } else if (val === true) {
        header.push(this.capitalize(prop));
      }
    }
    return header.join("; ");
  }
  match(url, httpOnly) {
    if (!(url instanceof URL)) url = new URL(url);
    if (httpOnly && this.httpOnly !== true) return false;
    if ("path" in this && !url.pathname.startsWith(this.path)) return false;
    if ("domain" in this) {
      let domain = this.domain;
      if (domain.startsWith(".")) domain = domain.slice(1);
      const host = url.hostname.toLowerCase();
      domain = domain.toLowerCase();
      if (!(host === domain || host.endsWith("." + domain))) return false;
    }
    const expires = this.expirationDate || this.expires;
    if (expires > 0) return expires * 1000 > Date.now();
    return true;
  }
}
