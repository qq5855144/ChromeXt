const GM_cookie = new (class CookieManager {
  #cache = [];
  #backend = "unknown";

  get store() {
    return this.#cache;
  }

  get backend() {
    return this.#backend;
  }

  #normalizeError(error) {
    if (error instanceof Error) return error;
    return new Error(typeof error == "string" ? error : "Unknown cookie error");
  }

  #canUseDocumentCookie(details = {}) {
    try {
      const url = new URL(details.url || location.href, location.href);
      return url.origin == location.origin;
    } catch {
      return false;
    }
  }

  #fromDocumentCookie(details = {}) {
    if (!this.#canUseDocumentCookie(details)) {
      throw new Error("document.cookie fallback only supports the current origin");
    }
    const domain = details.domain || location.hostname;
    const path = details.path || "/";
    const cookies = document.cookie
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const index = item.indexOf("=");
        const name = index == -1 ? item : item.slice(0, index);
        const value = index == -1 ? "" : item.slice(index + 1);
        return {
          name,
          value,
          domain,
          path,
          secure: location.protocol == "https:",
          httpOnly: false,
          session: true,
          hostOnly: true,
          sameSite: "unspecified",
          expirationDate: undefined,
        };
      });
    return cookies.filter((cookie) => {
      if (details.name != undefined && cookie.name !== details.name) return false;
      if (details.domain != undefined && cookie.domain !== details.domain) return false;
      if (details.path != undefined && cookie.path !== details.path) return false;
      return true;
    });
  }

  #serializeCookie(details, remove = false) {
    if (!details || typeof details != "object" || typeof details.name != "string") {
      throw new TypeError("Cookie name is required");
    }
    if (!this.#canUseDocumentCookie(details)) {
      throw new Error("document.cookie fallback only supports the current origin");
    }
    const parts = [`${details.name}=${remove ? "" : details.value ?? ""}`];
    parts.push(`Path=${details.path || "/"}`);
    if (details.domain) parts.push(`Domain=${details.domain}`);
    if (remove) {
      parts.push("Max-Age=0");
      parts.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    } else {
      const expires = details.expirationDate ?? details.expires;
      if (Number.isFinite(expires) && expires > 0) {
        parts.push(`Expires=${new Date(expires * 1000).toUTCString()}`);
      }
      if (Number.isFinite(details.maxAge)) parts.push(`Max-Age=${details.maxAge}`);
    }
    if (details.secure) parts.push("Secure");
    if (details.sameSite && details.sameSite !== "unspecified") {
      parts.push(`SameSite=${String(details.sameSite).replace(/^./, (c) => c.toUpperCase())}`);
    }
    return parts.join("; ");
  }

  #command(method, params) {
    const uuid = Math.random();
    const payload = { method, params, uuid, id: GM_info.script.id };
    const ChromeXt = LockedChromeXt.unlock(key);
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        ChromeXt.removeEventListener("cookie", listener);
        clearTimeout(timer);
      };
      const listener = (e) => {
        const data = e?.detail;
        if (!data || data.id != payload.id || data.uuid != uuid) return;
        e.stopImmediatePropagation?.();
        const responses = Array.isArray(data.response) ? data.response : [];
        const response = responses.find((r) => r && (r.id === 2 || r.id === 1));
        if (!response) {
          cleanup();
          reject(new Error(`No DevTools response for ${method}`));
          return;
        }
        if (response.error) {
          cleanup();
          reject(new Error(response.error.message || `DevTools ${method} failed`));
          return;
        }
        cleanup();
        this.#backend = "cdp";
        resolve(response.result || {});
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`DevTools cookie bridge timed out for ${method}`));
      }, 1500);
      ChromeXt.addEventListener("cookie", listener);
      try {
        ChromeXt.dispatch("cookie", payload);
      } catch (error) {
        cleanup();
        reject(this.#normalizeError(error));
      }
    });
  }

  async #withFallback(primary, fallback) {
    try {
      return await primary();
    } catch (error) {
      const result = await fallback(this.#normalizeError(error));
      this.#backend = "document.cookie";
      return result;
    }
  }

  export(url = location.origin, store, httpOnly = false) {
    const cookies = store || this.store;
    if (!Array.isArray(cookies)) return;
    const target = url instanceof URL ? url : new URL(url, location.href);
    if (cookies == this.store && target.origin != location.origin) return;
    return cookies
      .filter((cookie) => {
        if (httpOnly && cookie.httpOnly !== true) return false;
        if (cookie.path && !target.pathname.startsWith(cookie.path)) return false;
        if (cookie.domain) {
          const domain = String(cookie.domain).replace(/^\./, "");
          if (!(target.hostname == domain || target.hostname.endsWith(`.${domain}`))) return false;
        }
        const expires = cookie.expirationDate ?? cookie.expires;
        return !(Number.isFinite(expires) && expires > 0 && expires * 1000 <= Date.now());
      })
      .map((cookie) => `${cookie.name}=${cookie.value}`);
  }

  async list(details = { url: location.href }, callback) {
    let result;
    let error;
    try {
      if (!details || typeof details != "object") throw new TypeError("Invalid parameters");
      result = await this.#withFallback(
        async () => {
          const response = await this.#command("Network.getCookies", [details.url || location.href]);
          const cookies = Array.isArray(response.cookies) ? response.cookies : [];
          const props = ["domain", "name", "path"].filter((key) => key in details);
          this.#cache = cookies;
          return props.length
            ? cookies.filter((item) => props.every((prop) => item[prop] === details[prop]))
            : cookies;
        },
        async () => this.#fromDocumentCookie(details)
      );
      this.#cache = result;
    } catch (e) {
      error = this.#normalizeError(e);
    }
    if (typeof callback == "function") callback(result, error?.message);
    if (error) throw error;
    return result;
  }

  async set(details, callback) {
    let error;
    try {
      const cookies = Array.isArray(details) ? details : [details];
      await this.#withFallback(
        () => {
          const normalized = cookies.map((cookie) => {
            const item = { ...cookie };
            if (typeof item.expirationDate == "number") {
              item.expires = item.expirationDate;
              delete item.expirationDate;
            }
            if (item.domain == undefined) item.domain = location.hostname;
            return item;
          });
          return this.#command("Network.setCookies", { cookies: normalized });
        },
        async () => {
          for (const cookie of cookies) document.cookie = this.#serializeCookie(cookie);
          return {};
        }
      );
    } catch (e) {
      error = this.#normalizeError(e);
    }
    if (typeof callback == "function") callback(error?.message);
    if (error) throw error;
  }

  async delete(details, callback) {
    let error;
    try {
      await this.#withFallback(
        () => {
          const payload = { ...details };
          if (payload.domain == undefined && payload.url == undefined) payload.domain = location.hostname;
          return this.#command("Network.deleteCookies", payload);
        },
        async () => {
          document.cookie = this.#serializeCookie(details, true);
          return {};
        }
      );
    } catch (e) {
      error = this.#normalizeError(e);
    }
    if (typeof callback == "function") callback(error?.message);
    if (error) throw error;
  }
})();
