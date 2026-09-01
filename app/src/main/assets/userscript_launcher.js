"use strict";

(() => {
  if (window.top !== window || document.getElementById("__chromext_manager_launcher__")) return;

  const MANAGER_URL = "https://jingmatrix.github.io/ChromeXt/#userscripts";
  const host = document.createElement("div");
  host.id = "__chromext_manager_launcher__";
  host.setAttribute("data-chromext", "userscript-manager-launcher");

  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    :host {
      all: initial !important;
      position: fixed !important;
      right: 0 !important;
      bottom: max(92px, calc(env(safe-area-inset-bottom, 0px) + 72px)) !important;
      z-index: 2147483647 !important;
      width: 27px !important;
      height: 42px !important;
      pointer-events: none !important;
      contain: layout style paint !important;
    }
    button {
      all: initial !important;
      box-sizing: border-box !important;
      width: 27px !important;
      height: 42px !important;
      display: flex !important;
      align-items: center !important;
      justify-content: center !important;
      border: 1px solid rgba(127,127,127,.24) !important;
      border-right: 0 !important;
      border-radius: 13px 0 0 13px !important;
      background: rgba(32,34,38,.72) !important;
      color: rgba(255,255,255,.92) !important;
      font-family: system-ui, sans-serif !important;
      font-size: 10px !important;
      font-weight: 700 !important;
      letter-spacing: -.02em !important;
      box-shadow: 0 3px 14px rgba(0,0,0,.16) !important;
      opacity: .32 !important;
      cursor: pointer !important;
      user-select: none !important;
      -webkit-user-select: none !important;
      -webkit-tap-highlight-color: transparent !important;
      pointer-events: auto !important;
      transition: opacity .18s ease, width .18s ease !important;
    }
    button:hover, button:focus-visible, button:active {
      opacity: .96 !important;
      width: 32px !important;
      outline: none !important;
    }
    @media print {
      :host { display: none !important; }
    }
  `;

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "XT";
  button.title = "ChromeXt UserScript 管理";
  button.setAttribute("aria-label", "打开 ChromeXt UserScript 管理");

  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const opened = window.open(MANAGER_URL, "_blank", "noopener,noreferrer");
    if (!opened) location.href = MANAGER_URL;
  });

  const updateFullscreen = () => {
    host.style.display = document.fullscreenElement ? "none" : "";
  };
  document.addEventListener("fullscreenchange", updateFullscreen, true);

  root.append(style, button);
  const mount = () => {
    if (!document.documentElement || host.isConnected) return;
    document.documentElement.appendChild(host);
    updateFullscreen();
  };

  if (document.documentElement) mount();
  else document.addEventListener("DOMContentLoaded", mount, { once: true });
})();
