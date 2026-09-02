"use strict";

(() => {
  const api = Symbol.ChromeXt;
  const extensionDispatch = (payload) => api.dispatch("extension", JSON.stringify(payload));
  const FRAME_MARKER = "__chromextExtensionFrame";
  const FORWARDED_EVENTS = [
    "cx_extension_response",
    "cx_extension_message",
    "cx_extension_message_response",
    "cx_extension_storage",
  ];
  let extensions = [];
  let activePopup = null;

  const showToast = (message, failure = false) => {
    const node = document.getElementById("cx-toast");
    if (!node) return;
    node.textContent = message;
    node.dataset.failure = failure ? "true" : "false";
    node.classList.add("show");
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => node.classList.remove("show"), failure ? 3600 : 2400);
  };

  const actionManifest = (extension) =>
    extension?.action || extension?.browser_action || extension?.page_action || null;

  const popupPath = (extension) => {
    const action = actionManifest(extension);
    return extension?.popupUrl || action?.default_popup || "";
  };

  const largestIcon = (icons) => {
    if (!icons) return "";
    if (typeof icons === "string") return icons;
    if (typeof icons !== "object") return "";
    return Object.keys(icons)
      .sort((a, b) => (Number(b) || 0) - (Number(a) || 0))
      .map((key) => icons[key])
      .find((value) => typeof value === "string" && value) || "";
  };

  const extensionIcon = (extension) => {
    const path = largestIcon(actionManifest(extension)?.default_icon) || largestIcon(extension?.icons);
    if (!path || !extension?.baseUrl) return "";
    return extension.baseUrl + String(path).replace(/^\//, "");
  };

  const setFallbackIcon = (button, extension) => {
    button.replaceChildren();
    const fallback = document.createElement("span");
    fallback.className = "cx-extension-icon-fallback";
    fallback.textContent = String(extension?.name || "E").trim().slice(0, 1).toUpperCase() || "E";
    button.append(fallback);
  };

  const ensurePopupModal = () => {
    if (document.getElementById("cx-extension-popup")) return;
    const modal = document.createElement("div");
    modal.className = "cx-modal cx-extension-popup-modal";
    modal.id = "cx-extension-popup";
    modal.hidden = true;
    modal.innerHTML = `
      <section class="cx-extension-popup-sheet" role="dialog" aria-modal="true" aria-label="扩展菜单">
        <div class="cx-extension-popup-handle" aria-hidden="true"></div>
        <iframe
          id="cx-extension-popup-frame"
          title="扩展菜单"
          sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads"
          referrerpolicy="no-referrer"></iframe>
      </section>`;
    document.body.append(modal);

    const style = document.createElement("style");
    style.textContent = `
      .cx-extension-popup-modal {
        place-items: end center;
        padding: 0;
        background: rgba(18,22,28,.62);
        backdrop-filter: blur(6px);
      }
      .cx-extension-popup-sheet {
        width: min(720px, 100%);
        max-height: 88vh;
        padding: 10px 0 max(0px, env(safe-area-inset-bottom));
        border: 0;
        border-radius: 28px 28px 0 0;
        background: #fff;
        overflow: hidden;
        box-shadow: none;
      }
      .cx-extension-popup-handle {
        width: 58px;
        height: 6px;
        margin: 2px auto 10px;
        border-radius: 999px;
        background: rgba(70,76,84,.18);
      }
      #cx-extension-popup-frame {
        display: block;
        width: 100%;
        height: min(78vh, 720px);
        min-height: 360px;
        border: 0;
        border-radius: 0;
        background: #fff;
        box-shadow: none;
      }
      .cx-extension-toolbar-icon {
        width: 48px;
        height: 48px;
        flex: 0 0 48px;
        display: grid;
        place-items: center;
        padding: 7px;
        border: 0;
        border-radius: 15px;
        color: var(--neo-accent);
        background: var(--neo-surface);
        box-shadow: var(--neo-raised-sm);
        cursor: pointer;
        -webkit-tap-highlight-color: transparent;
      }
      .cx-extension-toolbar-icon:active {
        transform: translateY(1px);
        box-shadow: var(--neo-inset-sm);
      }
      .cx-extension-toolbar-icon:disabled {
        opacity: .45;
        cursor: default;
      }
      .cx-extension-toolbar-icon img {
        display: block;
        width: 34px;
        height: 34px;
        object-fit: contain;
        border-radius: 9px;
      }
      .cx-extension-icon-fallback {
        font-size: 17px;
        font-weight: 850;
        line-height: 1;
      }
      .cx-card[data-kind="extension"] .cx-card-head > .cx-extension-toolbar-icon + div {
        flex: 1;
        min-width: 0;
      }
      @media (min-width: 760px) {
        .cx-extension-popup-sheet {
          margin-bottom: 18px;
          border-radius: 28px;
        }
      }
    `;
    document.head.append(style);

    modal.addEventListener("click", (event) => {
      if (event.target === modal) closePopup();
    });
  };

  const closePopup = () => {
    const modal = document.getElementById("cx-extension-popup");
    const frame = document.getElementById("cx-extension-popup-frame");
    activePopup = null;
    if (frame) {
      frame.removeAttribute("srcdoc");
      frame.src = "about:blank";
      frame.style.height = "min(78vh, 720px)";
    }
    if (modal) modal.hidden = true;
  };

  const activateExtension = (id) => {
    const extension = extensions.find((item) => item.id === id);
    if (!extension?.enabled) return showToast("请先启用该扩展", true);
    extensionDispatch({ op: "activate", id });
  };

  const decorateCards = () => {
    document.querySelectorAll("#cx-extension-list .cx-card[data-kind='extension']").forEach((card) => {
      const extension = extensions.find((item) => item.id === card.dataset.id);
      if (!extension) return;
      const hasPopup = !!popupPath(extension);
      card.dataset.hasPopup = hasPopup ? "true" : "false";

      const head = card.querySelector(".cx-card-head");
      if (head && !head.querySelector(".cx-extension-toolbar-icon")) {
        const button = document.createElement("button");
        button.className = "cx-extension-toolbar-icon";
        button.type = "button";
        button.dataset.action = "extension-action-icon";
        button.disabled = !extension.enabled;
        button.setAttribute(
          "aria-label",
          hasPopup ? `打开 ${extension.name || "扩展"} 菜单` : `触发 ${extension.name || "扩展"}`
        );
        const icon = extensionIcon(extension);
        if (icon) {
          const image = document.createElement("img");
          image.src = icon;
          image.alt = "";
          image.addEventListener("error", () => setFallbackIcon(button, extension), { once: true });
          button.append(image);
        } else {
          setFallbackIcon(button, extension);
        }
        head.prepend(button);
      }

      const popupButton = card.querySelector("[data-action='popup']");
      if (popupButton) popupButton.textContent = "打开菜单";
    });
  };

  const renderPopup = (detail) => {
    if (!detail?.ok) return showToast(`扩展菜单打开失败：${detail?.error || "未知错误"}`, true);
    if (!detail.documentUrl) return showToast("扩展菜单打开失败：缺少本地菜单地址", true);
    ensurePopupModal();
    const modal = document.getElementById("cx-extension-popup");
    const frame = document.getElementById("cx-extension-popup-frame");
    frame.title = detail.name ? `${detail.name} 菜单` : "扩展菜单";
    activePopup = {
      id: detail.id,
      token: detail.token,
      frame,
      ready: false,
    };
    modal.hidden = false;
    frame.removeAttribute("srcdoc");
    frame.src = detail.documentUrl;
  };

  const onFrameMessage = (event) => {
    const popup = activePopup;
    if (!popup || event.source !== popup.frame?.contentWindow) return;
    const data = event.data || {};
    if (data[FRAME_MARKER] !== true || data.extensionId !== popup.id || data.token !== popup.token) return;

    if (data.direction === "ready") {
      popup.ready = true;
      return;
    }
    if (data.direction === "close") {
      closePopup();
      return;
    }
    if (data.direction === "resize") {
      const viewportLimit = Math.max(360, Math.floor(window.innerHeight * 0.82));
      const height = Math.max(360, Math.min(viewportLimit, Number(data.height) || viewportLimit));
      popup.frame.style.height = `${height}px`;
      return;
    }
    if (data.direction !== "dispatch" || data.action !== "extensionApi" || typeof data.payload !== "string") return;

    try {
      const payload = JSON.parse(data.payload);
      if (payload.extensionId !== popup.id) throw new Error("Extension id mismatch");
      api.dispatch("extensionApi", data.payload);
    } catch (error) {
      showToast(`扩展菜单通信失败：${error?.message || error}`, true);
    }
  };

  const forwardEvent = (name, detail) => {
    const popup = activePopup;
    if (!popup?.frame?.contentWindow) return;
    popup.frame.contentWindow.postMessage(
      {
        [FRAME_MARKER]: true,
        direction: "event",
        token: popup.token,
        extensionId: popup.id,
        name,
        detail,
      },
      "*"
    );
  };

  const attachListCapture = () => {
    const list = document.getElementById("cx-extension-list");
    if (!list || list.dataset.popupCapture === "true") return;
    list.dataset.popupCapture = "true";
    list.addEventListener(
      "click",
      (event) => {
        const card = event.target.closest?.(".cx-card[data-kind='extension']");
        if (!card) return;
        const trigger = event.target.closest?.("[data-action='popup'],[data-action='extension-action-icon']");
        if (!trigger) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        activateExtension(card.dataset.id);
      },
      true
    );
  };

  const start = () => {
    ensurePopupModal();
    attachListCapture();
    window.addEventListener("message", onFrameMessage);
    api.addEventListener("extension_list", (event) => {
      extensions = Array.isArray(event.detail) ? event.detail : [];
      setTimeout(decorateCards, 0);
    });
    api.addEventListener("extension_popup", (event) => renderPopup(event.detail || {}));
    api.addEventListener("extension_action", (event) => {
      if (event.detail?.ok === false)
        showToast(`扩展操作失败：${event.detail?.error || "未知错误"}`, true);
    });
    FORWARDED_EVENTS.forEach((name) =>
      api.addEventListener(name, (event) => forwardEvent(name, event.detail))
    );
  };

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", () => setTimeout(start, 0), { once: true });
  else setTimeout(start, 0);
})();
