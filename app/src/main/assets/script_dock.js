(() => {
  "use strict";

  // The dock is a top-frame ChromeXt system surface. UserScript frames keep their own
  // runtime, but they must never create duplicate floating controls.
  if (window !== window.top) return;
  if (!document || !document.documentElement) return;
  if (document.querySelector('[data-chromext-script-dock-host="1"]')) return;

  let ChromeXt;
  try {
    ChromeXt = Symbol.ChromeXtDockAccess.unlock(ChromeXtDockKey, false);
  } catch (error) {
    console.warn("ChromeXt Script Dock unavailable", error);
    return;
  }

  const SETTINGS_ORIGIN = "chromext-internal://script-dock";
  const MANAGER_URL = "about:blank#XT";
  const DEFAULT_Y = Number(ChromeXtDockInitialY);
  const state = {
    y: Number.isFinite(DEFAULT_Y) ? Math.min(0.92, Math.max(0.08, DEFAULT_Y)) : 0.5,
    open: false,
    extended: false,
    dragging: false,
    dragStartY: null,
    dragStartRatio: 0.5,
    retractTimer: 0,
    commandScriptId: null,
  };

  const host = document.createElement("div");
  host.dataset.chromextScriptDockHost = "1";
  host.setAttribute("aria-hidden", "false");
  Object.assign(host.style, {
    all: "initial",
    position: "fixed",
    inset: "0",
    width: "0",
    height: "0",
    zIndex: "2147483647",
    pointerEvents: "none",
    fontFamily:
      "system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
  });

  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  const nonceSource = document.querySelector("script[nonce],style[nonce]");
  if (nonceSource && nonceSource.nonce) style.nonce = nonceSource.nonce;
  style.textContent = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    button { font: inherit; }

    .cx-dock-button {
      position: fixed;
      right: 0;
      top: 50%;
      width: 50px;
      height: 40px;
      padding: 0;
      margin: 0;
      border: 0;
      border-radius: 20px 0 0 20px;
      background: rgba(245,247,249,.72);
      box-shadow: -3px 0 20px rgba(42,48,56,.16), inset 0 1px 0 rgba(255,255,255,.82);
      backdrop-filter: blur(16px) saturate(1.15);
      -webkit-backdrop-filter: blur(16px) saturate(1.15);
      transform: translate3d(calc(100% - 10px), -50%, 0);
      transition: transform .22s cubic-bezier(.2,.8,.2,1), opacity .2s ease, box-shadow .2s ease;
      display: flex;
      align-items: center;
      justify-content: flex-start;
      padding-left: 3px;
      cursor: pointer;
      pointer-events: auto;
      touch-action: none;
      user-select: none;
      -webkit-user-select: none;
      -webkit-tap-highlight-color: transparent;
      outline: none;
    }
    .cx-dock-button.cx-extended,
    .cx-dock-button:focus-visible {
      transform: translate3d(0, -50%, 0);
    }
    .cx-dock-button.cx-dragging { transition: none; }
    .cx-dock-button.cx-fullscreen-dim { opacity: .24; }
    .cx-dock-orb {
      width: 34px;
      height: 34px;
      border-radius: 50%;
      display: grid;
      place-items: center;
      flex: 0 0 34px;
      color: #fff;
      background: linear-gradient(145deg,#7769ea,#5f52d3);
      box-shadow: 0 3px 12px rgba(101,87,216,.44), inset 0 1px 0 rgba(255,255,255,.35);
    }
    .cx-dock-orb svg { width: 19px; height: 19px; display: block; }

    .cx-backdrop {
      position: fixed;
      inset: 0;
      z-index: 1;
      background: rgba(18,22,28,.38);
      opacity: 0;
      visibility: hidden;
      transition: opacity .2s ease, visibility .2s ease;
      pointer-events: none;
    }
    .cx-backdrop.cx-open {
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
    }

    .cx-sheet {
      position: fixed;
      left: 10px;
      right: 10px;
      bottom: 10px;
      z-index: 2;
      max-width: 720px;
      margin: 0 auto;
      border-radius: 24px;
      background: #eef1f4;
      box-shadow: 10px 10px 26px rgba(166,174,184,.42), -8px -8px 24px rgba(255,255,255,.92);
      transform: translate3d(0, calc(100% + 32px), 0);
      opacity: 0;
      visibility: hidden;
      transition: transform .24s cubic-bezier(.2,.8,.2,1), opacity .2s ease, visibility .2s ease;
      pointer-events: none;
      overflow: hidden;
      color: #303740;
      padding-bottom: env(safe-area-inset-bottom, 0px);
    }
    .cx-sheet.cx-open {
      transform: translate3d(0, 0, 0);
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
    }

    .cx-grabber {
      width: 36px;
      height: 4px;
      border-radius: 99px;
      background: rgba(111,120,131,.28);
      margin: 9px auto 4px;
    }

    .cx-icon-strip {
      display: flex;
      gap: 12px;
      align-items: center;
      overflow-x: auto;
      overscroll-behavior-x: contain;
      scrollbar-width: none;
      padding: 12px 16px 16px;
      min-height: 76px;
    }
    .cx-icon-strip::-webkit-scrollbar { display: none; }
    .cx-icon-button {
      position: relative;
      width: 52px;
      height: 52px;
      flex: 0 0 52px;
      border: 0;
      border-radius: 17px;
      padding: 8px;
      margin: 0;
      display: grid;
      place-items: center;
      overflow: hidden;
      background: #eef1f4;
      box-shadow: 5px 5px 12px rgba(166,174,184,.42), -5px -5px 12px rgba(255,255,255,.94);
      cursor: pointer;
      outline: none;
      -webkit-tap-highlight-color: transparent;
    }
    .cx-icon-button:active {
      box-shadow: inset 4px 4px 9px rgba(166,174,184,.38), inset -4px -4px 9px rgba(255,255,255,.85);
      transform: scale(.96);
    }
    .cx-icon-button:focus-visible { outline: 2px solid #6557d8; outline-offset: 2px; }
    .cx-script-icon,
    .cx-fallback-icon {
      width: 36px;
      height: 36px;
      border-radius: 11px;
      object-fit: cover;
      display: block;
    }
    .cx-fallback-icon {
      display: grid;
      place-items: center;
      color: #6557d8;
      background: #eef1f4;
    }
    .cx-fallback-icon svg { width: 25px; height: 25px; }
    .cx-manager-icon {
      width: 36px;
      height: 36px;
      border-radius: 12px;
      display: grid;
      place-items: center;
      color: #fff;
      background: linear-gradient(145deg,#7769ea,#5f52d3);
      box-shadow: inset 0 1px 0 rgba(255,255,255,.26);
    }
    .cx-manager-icon svg { width: 22px; height: 22px; }

    .cx-command-view { display: none; }
    .cx-command-view.cx-active { display: block; }
    .cx-strip-view.cx-hidden { display: none; }
    .cx-command-head {
      display: grid;
      grid-template-columns: 40px minmax(0,1fr) 40px;
      align-items: center;
      gap: 8px;
      padding: 7px 12px 8px;
    }
    .cx-command-head button {
      width: 38px;
      height: 38px;
      padding: 0;
      border: 0;
      border-radius: 13px;
      background: #eef1f4;
      color: #535c67;
      box-shadow: 4px 4px 9px rgba(166,174,184,.36), -4px -4px 9px rgba(255,255,255,.9);
      display: grid;
      place-items: center;
      cursor: pointer;
    }
    .cx-command-head button:active { box-shadow: inset 3px 3px 7px rgba(166,174,184,.34), inset -3px -3px 7px rgba(255,255,255,.84); }
    .cx-command-head svg { width: 20px; height: 20px; }
    .cx-command-title {
      min-width: 0;
      text-align: center;
      font-size: 14px;
      line-height: 1.3;
      font-weight: 700;
      color: #303740;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .cx-command-list {
      max-height: min(48vh, 360px);
      overflow-y: auto;
      padding: 2px 14px 16px;
    }
    .cx-command-item {
      width: 100%;
      min-height: 46px;
      border: 0;
      border-radius: 14px;
      padding: 10px 14px;
      margin: 8px 0 0;
      background: #eef1f4;
      color: #303740;
      box-shadow: 4px 4px 10px rgba(166,174,184,.34), -4px -4px 10px rgba(255,255,255,.88);
      text-align: left;
      font-size: 14px;
      line-height: 1.35;
      cursor: pointer;
    }
    .cx-command-item:active { box-shadow: inset 3px 3px 7px rgba(166,174,184,.34), inset -3px -3px 7px rgba(255,255,255,.82); }
    .cx-empty {
      padding: 18px 14px 22px;
      text-align: center;
      color: #77818c;
      font-size: 13px;
    }

    @media (min-width: 640px) {
      .cx-sheet { left: auto; right: 18px; width: min(560px, calc(100vw - 36px)); bottom: 18px; margin: 0; }
      .cx-dock-button { width: 46px; height: 38px; border-radius: 19px 0 0 19px; }
    }

    @media (prefers-reduced-motion: reduce) {
      .cx-dock-button, .cx-backdrop, .cx-sheet { transition: none !important; }
    }
  `;

  const iconTampermonkey = `
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M5.955.002C3-.071.275 2.386.043 5.335c-.069 3.32-.011 6.646-.03 9.969.06 1.87-.276 3.873.715 5.573 1.083 2.076 3.456 3.288 5.77 3.105 4.003-.011 8.008.022 12.011-.017 2.953-.156 5.478-2.815 5.482-5.772-.007-4.235.023-8.473-.015-12.708C23.82 2.533 21.16.007 18.205.003c-4.083-.005-8.167 0-12.25-.002zm.447 12.683c2.333-.046 4.506 1.805 4.83 4.116.412 2.287-1.056 4.716-3.274 5.411-2.187.783-4.825-.268-5.874-2.341-1.137-2.039-.52-4.827 1.37-6.197a4.9 4.9 0 0 1 2.948-.99zm11.245 0c2.333-.046 4.505 1.805 4.829 4.116.413 2.287-1.056 4.716-3.273 5.411-2.188.783-4.825-.268-5.875-2.341-1.136-2.039-.52-4.827 1.37-6.197a4.9 4.9 0 0 1 2.949-.99z"/>
    </svg>`;
  const iconManager = `
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 3l2 2.1 2.8-.4.8 2.7 2.5 1.3-1.1 2.6 1.1 2.6-2.5 1.3-.8 2.7-2.8-.4L12 21l-2-2.1-2.8.4-.8-2.7-2.5-1.3 1.1-2.6-1.1-2.6 2.5-1.3.8-2.7 2.8.4L12 3z"/>
      <circle cx="12" cy="12" r="3.1"/>
    </svg>`;
  const iconScript = `
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
      <path d="M7 3h7l4 4v14H7z"/><path d="M14 3v5h5"/><path d="M9.5 13l-2 2 2 2M14.5 13l2 2-2 2M13 12l-2 6"/>
    </svg>`;
  const iconBack = `
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>`;
  const iconClose = `
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`;

  const dockButton = document.createElement("button");
  dockButton.type = "button";
  dockButton.className = "cx-dock-button";
  dockButton.setAttribute("aria-label", "ChromeXt 脚本");
  dockButton.title = "ChromeXt 脚本";
  dockButton.innerHTML = `<span class="cx-dock-orb">${iconTampermonkey}</span>`;

  const backdrop = document.createElement("div");
  backdrop.className = "cx-backdrop";

  const sheet = document.createElement("section");
  sheet.className = "cx-sheet";
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  sheet.setAttribute("aria-label", "ChromeXt 脚本菜单");
  sheet.innerHTML = `
    <div class="cx-grabber"></div>
    <div class="cx-strip-view">
      <div class="cx-icon-strip" role="list"></div>
    </div>
    <div class="cx-command-view">
      <div class="cx-command-head">
        <button type="button" class="cx-back" aria-label="返回">${iconBack}</button>
        <div class="cx-command-title"></div>
        <button type="button" class="cx-close" aria-label="关闭">${iconClose}</button>
      </div>
      <div class="cx-command-list"></div>
    </div>`;

  shadow.append(style, backdrop, sheet, dockButton);
  document.documentElement.appendChild(host);

  const stripView = shadow.querySelector(".cx-strip-view");
  const iconStrip = shadow.querySelector(".cx-icon-strip");
  const commandView = shadow.querySelector(".cx-command-view");
  const commandTitle = shadow.querySelector(".cx-command-title");
  const commandList = shadow.querySelector(".cx-command-list");
  const backButton = shadow.querySelector(".cx-back");
  const closeButton = shadow.querySelector(".cx-close");

  function stopEvent(event) {
    if (event && typeof event.stopPropagation === "function") event.stopPropagation();
  }

  function viewportMetrics() {
    const vv = window.visualViewport;
    const top = vv && Number.isFinite(vv.offsetTop) ? vv.offsetTop : 0;
    const height = vv && Number.isFinite(vv.height) ? vv.height : window.innerHeight;
    return { top, height: Math.max(120, height) };
  }

  function applyPosition() {
    const viewport = viewportMetrics();
    const minY = viewport.top + 28;
    const maxY = viewport.top + viewport.height - 28;
    const px = Math.min(maxY, Math.max(minY, viewport.top + viewport.height * state.y));
    dockButton.style.top = `${Math.round(px)}px`;
  }

  function setExtended(value) {
    state.extended = value;
    dockButton.classList.toggle("cx-extended", value);
  }

  function clearRetractTimer() {
    if (state.retractTimer) {
      clearTimeout(state.retractTimer);
      state.retractTimer = 0;
    }
  }

  function scheduleRetract(delay = 2200) {
    clearRetractTimer();
    if (state.open || state.dragging) return;
    state.retractTimer = setTimeout(() => setExtended(false), delay);
  }

  function scriptIdOf(info) {
    return info && info.script && typeof info.script.id === "string" ? info.script.id : "";
  }

  function valueOf(value) {
    if (Array.isArray(value)) return value.find((it) => typeof it === "string" && it.trim()) || "";
    return typeof value === "string" ? value : "";
  }

  function scriptName(info) {
    const script = (info && info.script) || {};
    return valueOf(script.name) || valueOf(script["name:zh-CN"]) || valueOf(script["name:zh"]) || scriptIdOf(info).split(":").pop() || "UserScript";
  }

  function safeIcon(info) {
    const script = (info && info.script) || {};
    const source = valueOf(script.icon64) || valueOf(script.icon);
    if (!source) return "";
    const normalized = source.trim();
    if (/^https?:\/\//i.test(normalized) || /^data:image\//i.test(normalized) || /^blob:/i.test(normalized)) return normalized;
    return "";
  }

  function runningScripts() {
    const seen = new Set();
    const result = [];
    try {
      Array.from(ChromeXt.scripts || []).forEach((info) => {
        const id = scriptIdOf(info);
        if (!id || seen.has(id)) return;
        seen.add(id);
        result.push(info);
      });
    } catch (error) {
      console.warn("ChromeXt Script Dock failed to read scripts", error);
    }
    return result;
  }

  function commandsFor(scriptId) {
    try {
      return Array.from(ChromeXt.commands || []).filter(
        (command) => command && command.id === scriptId && command.enabled !== false && typeof command.listener === "function"
      );
    } catch (error) {
      console.warn("ChromeXt Script Dock failed to read commands", error);
      return [];
    }
  }

  function makeFallbackIcon() {
    const fallback = document.createElement("span");
    fallback.className = "cx-fallback-icon";
    fallback.innerHTML = iconScript;
    return fallback;
  }

  function makeScriptIcon(info) {
    const icon = safeIcon(info);
    if (!icon) return makeFallbackIcon();
    const image = document.createElement("img");
    image.className = "cx-script-icon";
    image.alt = "";
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    image.src = icon;
    image.addEventListener(
      "error",
      () => {
        if (image.parentNode) image.replaceWith(makeFallbackIcon());
      },
      { once: true }
    );
    return image;
  }

  function openManager() {
    closePanel();
    let opened = null;
    try {
      opened = window.open(MANAGER_URL, "_blank");
    } catch (_) {}
    if (!opened) {
      try {
        window.location.href = MANAGER_URL;
      } catch (error) {
        console.error("ChromeXt Script Dock failed to open manager", error);
      }
    }
  }

  function renderStrip() {
    iconStrip.replaceChildren();

    const managerButton = document.createElement("button");
    managerButton.type = "button";
    managerButton.className = "cx-icon-button";
    managerButton.title = "脚本管理器";
    managerButton.setAttribute("aria-label", "打开脚本管理器");
    managerButton.innerHTML = `<span class="cx-manager-icon">${iconManager}</span>`;
    managerButton.addEventListener("click", (event) => {
      stopEvent(event);
      openManager();
    });
    iconStrip.append(managerButton);

    runningScripts().forEach((info) => {
      const id = scriptIdOf(info);
      const name = scriptName(info);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "cx-icon-button";
      button.title = name;
      button.setAttribute("aria-label", name);
      button.appendChild(makeScriptIcon(info));
      button.addEventListener("click", (event) => {
        stopEvent(event);
        openCommands(id, name);
      });
      iconStrip.append(button);
    });
  }

  function invokeCommand(scriptId, index, expectedTitle) {
    const commands = commandsFor(scriptId);
    let command = commands[index];
    if (!command || command.title !== expectedTitle) {
      command = commands.find((item) => item.title === expectedTitle);
    }
    if (!command || typeof command.listener !== "function") return;
    try {
      const clickEvent = typeof MouseEvent === "function" ? new MouseEvent("click", { bubbles: false, cancelable: true, view: window }) : undefined;
      Reflect.apply(command.listener, window, clickEvent ? [clickEvent] : []);
    } catch (error) {
      console.error(`ChromeXt menu command failed: ${expectedTitle}`, error);
    }
  }

  function openCommands(scriptId, name) {
    state.commandScriptId = scriptId;
    commandTitle.textContent = name;
    commandList.replaceChildren();
    const commands = commandsFor(scriptId);
    if (commands.length === 0) {
      const empty = document.createElement("div");
      empty.className = "cx-empty";
      empty.textContent = "此脚本没有注册菜单命令";
      commandList.append(empty);
    } else {
      commands.forEach((command, index) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "cx-command-item";
        item.textContent = String(command.title || "未命名命令");
        item.addEventListener("click", (event) => {
          stopEvent(event);
          invokeCommand(scriptId, index, command.title);
        });
        commandList.append(item);
      });
    }
    stripView.classList.add("cx-hidden");
    commandView.classList.add("cx-active");
  }

  function showStrip() {
    state.commandScriptId = null;
    commandView.classList.remove("cx-active");
    stripView.classList.remove("cx-hidden");
    renderStrip();
  }

  function openPanel() {
    clearRetractTimer();
    state.open = true;
    setExtended(true);
    showStrip();
    backdrop.classList.add("cx-open");
    sheet.classList.add("cx-open");
  }

  function closePanel() {
    state.open = false;
    state.commandScriptId = null;
    backdrop.classList.remove("cx-open");
    sheet.classList.remove("cx-open");
    commandView.classList.remove("cx-active");
    stripView.classList.remove("cx-hidden");
    scheduleRetract(900);
  }

  function persistPosition() {
    try {
      ChromeXt.dispatch("syncData", {
        origin: SETTINGS_ORIGIN,
        name: "filters",
        data: String(state.y),
      });
    } catch (error) {
      console.warn("ChromeXt Script Dock failed to save position", error);
    }
  }

  function onPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    stopEvent(event);
    clearRetractTimer();
    state.dragging = false;
    state.dragStartY = event.clientY;
    state.dragStartRatio = state.y;
    setExtended(true);
    dockButton.classList.add("cx-dragging");
    if (dockButton.setPointerCapture && event.pointerId !== undefined) {
      try { dockButton.setPointerCapture(event.pointerId); } catch (_) {}
    }
  }

  function onPointerMove(event) {
    if (state.dragStartY === null || state.dragStartY === undefined) return;
    const delta = event.clientY - state.dragStartY;
    if (!state.dragging && Math.abs(delta) < 6) return;
    state.dragging = true;
    const viewport = viewportMetrics();
    state.y = Math.min(0.92, Math.max(0.08, state.dragStartRatio + delta / viewport.height));
    applyPosition();
    if (event.cancelable && typeof event.preventDefault === "function") event.preventDefault();
    stopEvent(event);
  }

  function finishPointer(event, cancelled = false) {
    if (state.dragStartY === null) return;
    const wasDragging = state.dragging;
    state.dragStartY = null;
    state.dragging = false;
    dockButton.classList.remove("cx-dragging");
    // Android Chromium/WebView can emit pointercancel when the browser takes over a
    // gesture. The button has already reached a valid position, so remember it just
    // like a normal pointerup instead of silently reverting on the next page.
    if (wasDragging) {
      persistPosition();
      scheduleRetract(cancelled ? 900 : 1100);
    } else if (cancelled) {
      scheduleRetract(900);
    } else if (!state.open) {
      openPanel();
    } else {
      closePanel();
    }
    stopEvent(event);
  }

  function touchProxy(event, touch) {
    return {
      clientY: touch ? touch.clientY : 0,
      button: 0,
      cancelable: event.cancelable,
      preventDefault: () => event.preventDefault(),
      stopPropagation: () => event.stopPropagation(),
    };
  }

  // Pointer Events cover modern Chromium/WebView. A touch/mouse fallback keeps older
  // Android WebViews usable without creating duplicate gesture streams.
  if ("PointerEvent" in window) {
    dockButton.addEventListener("pointerdown", onPointerDown);
    dockButton.addEventListener("pointermove", onPointerMove);
    dockButton.addEventListener("pointerup", (event) => finishPointer(event));
    dockButton.addEventListener("pointercancel", (event) => finishPointer(event, true));
    dockButton.addEventListener("lostpointercapture", (event) => finishPointer(event, true));
  } else {
    let mouseDown = false;
    let touchActive = false;
    dockButton.addEventListener("mousedown", (event) => {
      mouseDown = true;
      onPointerDown(event);
    });
    window.addEventListener("mousemove", (event) => mouseDown && onPointerMove(event), true);
    window.addEventListener("mouseup", (event) => {
      if (!mouseDown) return;
      mouseDown = false;
      finishPointer(event);
    }, true);
    dockButton.addEventListener("touchstart", (event) => {
      const touch = event.touches[0];
      if (!touch) return;
      touchActive = true;
      onPointerDown(touchProxy(event, touch));
    }, { passive: false });
    dockButton.addEventListener("touchmove", (event) => {
      if (!touchActive) return;
      const touch = event.touches[0];
      if (touch) onPointerMove(touchProxy(event, touch));
    }, { passive: false });
    dockButton.addEventListener("touchend", (event) => {
      if (!touchActive) return;
      touchActive = false;
      finishPointer(touchProxy(event, event.changedTouches[0]));
    }, { passive: false });
    dockButton.addEventListener("touchcancel", (event) => {
      if (!touchActive) return;
      touchActive = false;
      finishPointer(touchProxy(event, event.changedTouches[0]), true);
    }, { passive: false });
  }

  dockButton.addEventListener("mouseenter", () => {
    clearRetractTimer();
    setExtended(true);
  });
  dockButton.addEventListener("mouseleave", () => scheduleRetract());
  dockButton.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    stopEvent(event);
  });
  backdrop.addEventListener("click", (event) => {
    stopEvent(event);
    closePanel();
  });
  backButton.addEventListener("click", (event) => {
    stopEvent(event);
    showStrip();
  });
  closeButton.addEventListener("click", (event) => {
    stopEvent(event);
    closePanel();
  });
  sheet.addEventListener("click", stopEvent);
  sheet.addEventListener("pointerdown", stopEvent);

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.open) closePanel();
  }, true);

  function updateFullscreenState() {
    const fullscreen = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
    dockButton.classList.toggle("cx-fullscreen-dim", fullscreen && !state.open);
    if (fullscreen && !state.open) setExtended(false);
  }

  document.addEventListener("fullscreenchange", updateFullscreenState, true);
  document.addEventListener("webkitfullscreenchange", updateFullscreenState, true);
  window.addEventListener("orientationchange", () => setTimeout(applyPosition, 80), true);
  window.addEventListener("resize", applyPosition, true);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", applyPosition);
    window.visualViewport.addEventListener("scroll", applyPosition);
  }

  // Some SPAs replace direct children of <html>. Reattach only when our host itself was
  // removed; the observer does not inspect page content and therefore stays cheap.
  const parentObserver = new MutationObserver(() => {
    if (!host.isConnected && document.documentElement) document.documentElement.appendChild(host);
  });
  parentObserver.observe(document.documentElement, { childList: true });

  applyPosition();
  scheduleRetract(1400);
})();
//# sourceURL=local://ChromeXt/script-dock
