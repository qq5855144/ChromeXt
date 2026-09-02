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

  const popupPath = (extension) => {
    const action = extension?.action || extension?.browser_action || extension?.page_action || null;
    return extension?.popupUrl || action?.default_popup || "";
  };

  const ensurePopupModal = () => {
    if (document.getElementById("cx-extension-popup")) return;
    const modal = document.createElement("div");
    modal.className = "cx-modal";
    modal.id = "cx-extension-popup";
    modal.hidden = true;
    modal.innerHTML = `
      <section class="cx-modal-card cx-extension-popup-card" role="dialog" aria-modal="true" aria-labelledby="cx-extension-popup-title">
        <header class="cx-extension-popup-head">
          <div>
            <p class="cx-modal-kicker">Extension</p>
            <h2 id="cx-extension-popup-title">扩展菜单</h2>
          </div>
          <button class="cx-action" type="button" id="cx-extension-popup-close" aria-label="关闭扩展菜单">关闭</button>
        </header>
        <iframe id="cx-extension-popup-frame" title="扩展菜单" sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads"></iframe>
      </section>`;
    document.body.append(modal);

    const style = document.createElement("style");
    style.textContent = `
      .cx-extension-popup-card { width: min(480px, calc(100vw - 24px)); padding: 16px; overflow: hidden; }
      .cx-extension-popup-head { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:4px 4px 14px; }
      .cx-extension-popup-head h2 { margin:0; font-size:18px; }
      #cx-extension-popup-frame { display:block; width:100%; height:min(68vh, 580px); min-height:320px; border:0; border-radius:18px; background:#fff; box-shadow:var(--neo-inset-sm); }
      .cx-card[data-has-popup="true"] .cx-card-head { cursor:pointer; }
    `;
    document.head.append(style);

    const close = () => closePopup();
    modal.querySelector("#cx-extension-popup-close").addEventListener("click", close);
    modal.addEventListener("click", (event) => {
      if (event.target === modal) close();
    });
  };

  const closePopup = () => {
    const modal = document.getElementById("cx-extension-popup");
    const frame = document.getElementById("cx-extension-popup-frame");
    activePopup = null;
    if (frame) frame.removeAttribute("srcdoc");
    if (modal) modal.hidden = true;
  };

  const openPopup = (id) => {
    const extension = extensions.find((item) => item.id === id);
    if (!extension || !popupPath(extension)) return showToast("该扩展没有菜单面板", true);
    extensionDispatch({ op: "popup", id });
  };

  const decorateCards = () => {
    document.querySelectorAll("#cx-extension-list .cx-card[data-kind='extension']").forEach((card) => {
      const extension = extensions.find((item) => item.id === card.dataset.id);
      const hasPopup = !!popupPath(extension);
      card.dataset.hasPopup = hasPopup ? "true" : "false";
      if (!hasPopup || card.querySelector("[data-action='popup']")) return;
      const button = document.createElement("button");
      button.className = "cx-action cx-open";
      button.type = "button";
      button.dataset.action = "popup";
      button.textContent = "打开菜单";
      card.querySelector(".cx-actions")?.prepend(button);
    });
  };

  const renderPopup = (detail) => {
    if (!detail?.ok) return showToast(`扩展菜单打开失败：${detail?.error || "未知错误"}`, true);
    ensurePopupModal();
    const modal = document.getElementById("cx-extension-popup");
    const frame = document.getElementById("cx-extension-popup-frame");
    document.getElementById("cx-extension-popup-title").textContent = detail.name || "扩展菜单";
    activePopup = {
      id: detail.id,
      token: detail.token,
      frame,
      ready: false,
    };
    modal.hidden = false;
    frame.srcdoc = detail.document || "";
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
        if (!card || card.dataset.hasPopup !== "true") return;
        const popupButton = event.target.closest?.("[data-action='popup']");
        const clickedHead = !!event.target.closest?.(".cx-card-head") && !event.target.closest?.("button");
        if (!popupButton && !clickedHead) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        openPopup(card.dataset.id);
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
    FORWARDED_EVENTS.forEach((name) =>
      api.addEventListener(name, (event) => forwardEvent(name, event.detail))
    );
  };

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", () => setTimeout(start, 0), { once: true });
  else setTimeout(start, 0);
})();
