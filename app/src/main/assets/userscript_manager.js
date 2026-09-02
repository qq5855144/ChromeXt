"use strict";

(() => {
  const api = Symbol.ChromeXt;
  let pendingDelete = null;
  let activeView = "scripts";
  let scriptsCache = [];
  let extensionsCache = [];

  const escapeHtml = (value) =>
    String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");

  const metaValues = (meta, key) => {
    const values = [];
    const prefix = `@${key}`;
    for (const line of String(meta || "").split(/\r?\n/)) {
      const match = line.match(/^\/\/\s+@([\w-]+)(?:\s+(.+))?$/);
      if (match && `@${match[1]}` === prefix) values.push((match[2] || "").trim());
    }
    return values;
  };

  const metaValue = (meta, key, fallback = "") => metaValues(meta, key)[0] || fallback;
  const scriptDispatch = (payload) => api.dispatch("userscript", JSON.stringify(payload));
  const extensionDispatch = (payload) => api.dispatch("extension", JSON.stringify(payload));

  const toast = (message, failure = false) => {
    const node = document.getElementById("cx-toast");
    node.textContent = message;
    node.dataset.failure = failure ? "true" : "false";
    node.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => node.classList.remove("show"), failure ? 3600 : 2400);
  };

  const closeDeleteConfirm = () => {
    pendingDelete = null;
    const modal = document.getElementById("cx-confirm");
    if (modal) modal.hidden = true;
  };

  const openDeleteConfirm = (type, id, title) => {
    pendingDelete = { type, id };
    document.getElementById("cx-confirm-title").textContent = type === "extension" ? "确认卸载扩展？" : "确认卸载脚本？";
    document.getElementById("cx-confirm-name").textContent = `「${title}」将从 ChromeXt 中删除。`;
    const modal = document.getElementById("cx-confirm");
    modal.hidden = false;
    requestAnimationFrame(() => document.getElementById("cx-confirm-ok")?.focus());
  };

  const buildShell = () => {
    document.title = "ChromeXt 管理中心";
    document.documentElement.lang = "zh-CN";
    document.body.innerHTML = `
      <main class="cx-manager">
        <header class="cx-header">
          <div>
            <p class="cx-kicker">ChromeXt</p>
            <h1>管理中心</h1>
            <p class="cx-subtitle">统一管理 UserScript 与浏览器扩展，并支持直接从设备本地导入脚本、ZIP/CRX 扩展和扩展文件夹。</p>
          </div>
          <button class="cx-refresh" type="button" id="cx-refresh">刷新</button>
        </header>
        <nav class="cx-tabs" aria-label="管理类型">
          <button class="cx-tab active" type="button" data-view="scripts">用户脚本</button>
          <button class="cx-tab" type="button" data-view="extensions">扩展插件</button>
        </nav>
        <section class="cx-toolbar" id="cx-script-toolbar">
          <div class="cx-summary" aria-live="polite">
            <span id="cx-total">0 个脚本</span><span id="cx-enabled">0 个已启用</span>
          </div>
          <div class="cx-toolbar-actions">
            <button class="cx-action cx-install" type="button" id="cx-import-userscript">导入本地脚本</button>
            <input type="file" id="cx-userscript-file" accept=".user.js,.js,.txt,text/javascript,application/javascript,text/plain" multiple hidden>
          </div>
        </section>
        <section class="cx-toolbar" id="cx-extension-toolbar" hidden>
          <div class="cx-summary" aria-live="polite">
            <span id="cx-extension-total">0 个扩展</span><span id="cx-extension-enabled">0 个已启用</span>
          </div>
          <div class="cx-toolbar-actions">
            <button class="cx-action cx-install" type="button" id="cx-install-extension">导入本地 ZIP/CRX</button>
            <input type="file" id="cx-extension-file" accept=".zip,.crx,application/zip" hidden>
          </div>
        </section>
        <section id="cx-script-list" class="cx-list"><div class="cx-empty">正在读取已安装脚本…</div></section>
        <section id="cx-extension-list" class="cx-list" hidden><div class="cx-empty">正在读取扩展…</div></section>
      </main>
      <div class="cx-modal" id="cx-confirm" hidden>
        <section class="cx-modal-card" role="dialog" aria-modal="true" aria-labelledby="cx-confirm-title">
          <p class="cx-modal-kicker">ChromeXt</p>
          <h2 id="cx-confirm-title">确认卸载？</h2>
          <p class="cx-modal-text" id="cx-confirm-name"></p>
          <div class="cx-modal-actions">
            <button class="cx-action" type="button" id="cx-confirm-cancel">取消</button>
            <button class="cx-action cx-delete cx-confirm-delete" type="button" id="cx-confirm-ok">确认卸载</button>
          </div>
        </section>
      </div>
      <div class="cx-toast" id="cx-toast" role="status" aria-live="polite"></div>`;

    const style = document.createElement("style");
    style.textContent = `
      :root {
        color-scheme: light;
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
        --neo-bg: #eef1f4;
        --neo-surface: #eef1f4;
        --neo-text: #303740;
        --neo-muted: #6f7883;
        --neo-accent: #6557d8;
        --neo-danger: #ad4f52;
        --neo-success: #397356;
        --neo-raised: 9px 9px 20px rgba(174,184,194,.52), -9px -9px 20px rgba(255,255,255,.96);
        --neo-raised-sm: 5px 5px 12px rgba(174,184,194,.48), -5px -5px 12px rgba(255,255,255,.92);
        --neo-inset: inset 4px 4px 9px rgba(174,184,194,.46), inset -4px -4px 9px rgba(255,255,255,.88);
        --neo-inset-sm: inset 2px 2px 5px rgba(174,184,194,.42), inset -2px -2px 5px rgba(255,255,255,.84);
      }
      * { box-sizing: border-box; }
      html, body { min-height: 100%; background: var(--neo-bg); }
      body { margin: 0; min-height: 100vh; color: var(--neo-text); }
      button { font: inherit; -webkit-tap-highlight-color: transparent; }
      button:focus, button:focus-visible { outline: none; }
      [hidden] { display: none !important; }
      .cx-manager { width: min(920px, 100%); margin: 0 auto; padding: 28px 18px 64px; }
      .cx-header {
        display: flex; align-items: flex-start; justify-content: space-between; gap: 18px;
        margin-bottom: 20px; padding: 22px; border-radius: 26px;
        background: var(--neo-surface); box-shadow: var(--neo-raised);
      }
      .cx-kicker, .cx-modal-kicker { margin: 0 0 5px; color: var(--neo-accent); font-size: 11px; font-weight: 800; letter-spacing: .13em; text-transform: uppercase; }
      h1 { margin: 0; font-size: clamp(28px, 7vw, 42px); line-height: 1.05; letter-spacing: -.025em; }
      .cx-subtitle { margin: 11px 0 0; max-width: 650px; color: var(--neo-muted); line-height: 1.6; }
      .cx-refresh, .cx-action, .cx-tab {
        border: 0; border-radius: 14px; padding: 10px 15px; cursor: pointer;
        color: var(--neo-text); background: var(--neo-surface); box-shadow: var(--neo-raised-sm);
        transition: box-shadow .14s ease, transform .14s ease, color .14s ease, opacity .14s ease;
      }
      .cx-refresh { flex-shrink: 0; color: var(--neo-accent); font-weight: 750; }
      .cx-refresh:active, .cx-action:active, .cx-tab:active, .cx-refresh:focus-visible, .cx-action:focus-visible, .cx-tab:focus-visible {
        transform: translateY(1px); box-shadow: var(--neo-inset-sm);
      }
      .cx-refresh:disabled, .cx-action:disabled { opacity: .48; cursor: default; box-shadow: var(--neo-inset-sm); }
      .cx-tabs { display: flex; gap: 12px; margin: 4px 4px 20px; }
      .cx-tab { color: var(--neo-muted); font-weight: 750; }
      .cx-tab.active { color: var(--neo-accent); box-shadow: var(--neo-inset-sm); }
      .cx-toolbar { display: flex; justify-content: space-between; gap: 14px; align-items: center; margin: 18px 4px; }
      .cx-toolbar-actions { display: flex; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }
      .cx-summary { display: flex; gap: 10px; flex-wrap: wrap; font-size: 13px; color: var(--neo-muted); }
      .cx-summary span { padding: 8px 12px; border-radius: 999px; background: var(--neo-surface); box-shadow: var(--neo-inset-sm); }
      .cx-install { color: var(--neo-accent); font-weight: 750; }
      .cx-list { display: grid; gap: 18px; }
      .cx-card {
        padding: 18px; border: 0; border-radius: 22px; background: var(--neo-surface);
        box-shadow: var(--neo-raised); transition: opacity .16s ease, box-shadow .16s ease;
      }
      .cx-card[data-enabled="false"] { opacity: .66; }
      .cx-card-head { display: flex; justify-content: space-between; gap: 14px; align-items: flex-start; }
      .cx-title { margin: 0; font-size: 17px; word-break: break-word; }
      .cx-version { margin-left: 7px; color: var(--neo-accent); font-size: 12px; font-weight: 750; }
      .cx-id { margin-top: 6px; color: var(--neo-muted); font-size: 11px; overflow-wrap: anywhere; }
      .cx-status { white-space: nowrap; padding: 6px 10px; border-radius: 999px; color: var(--neo-accent); font-size: 12px; font-weight: 750; background: var(--neo-surface); box-shadow: var(--neo-inset-sm); }
      .cx-card[data-enabled="false"] .cx-status { color: var(--neo-muted); }
      .cx-meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 13px 18px; margin: 18px 0; }
      .cx-meta-row { min-width: 0; }
      .cx-label { display: block; margin-bottom: 5px; color: #8a929b; font-size: 10px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
      .cx-value { color: #505963; font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
      .cx-wide { grid-column: 1 / -1; }
      .cx-tags { display: flex; flex-wrap: wrap; gap: 7px; }
      .cx-tag { padding: 5px 8px; border-radius: 9px; color: var(--neo-muted); font-size: 11px; overflow-wrap: anywhere; background: var(--neo-surface); box-shadow: var(--neo-inset-sm); }
      .cx-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 10px; padding-top: 5px; }
      .cx-toggle, .cx-open { color: var(--neo-accent); font-weight: 750; }
      .cx-delete { color: var(--neo-danger); font-weight: 750; }
      .cx-empty { margin-top: 10px; padding: 58px 18px; border-radius: 22px; color: var(--neo-muted); text-align: center; background: var(--neo-surface); box-shadow: var(--neo-inset); }
      .cx-modal { position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center; padding: 20px; background: rgba(18,22,28,.62); backdrop-filter: blur(6px); }
      .cx-modal-card { width: min(390px, 100%); padding: 24px; border-radius: 24px; background: var(--neo-surface); }
      .cx-modal-card h2 { margin: 0; font-size: 20px; }
      .cx-modal-text { margin: 10px 0 0; color: var(--neo-muted); line-height: 1.6; overflow-wrap: anywhere; }
      .cx-modal-actions { display: flex; justify-content: flex-end; gap: 12px; margin-top: 24px; }
      .cx-confirm-delete { color: var(--neo-danger); }
      .cx-toast { position: fixed; left: 50%; bottom: max(24px, env(safe-area-inset-bottom)); z-index: 2147483647; min-width: 180px; max-width: calc(100vw - 40px); padding: 12px 18px; border-radius: 16px; color: var(--neo-success); font-size: 13px; font-weight: 750; text-align: center; background: var(--neo-surface); box-shadow: var(--neo-raised); opacity: 0; pointer-events: none; transform: translate(-50%, 12px); transition: .18s ease; }
      .cx-toast[data-failure="true"] { color: var(--neo-danger); }
      .cx-toast.show { opacity: 1; transform: translate(-50%, 0); }
      @media (max-width: 620px) {
        .cx-manager { padding: 18px 14px 48px; }
        .cx-header { align-items: center; padding: 18px; border-radius: 22px; }
        .cx-subtitle { font-size: 13px; }
        .cx-toolbar { align-items: flex-start; flex-direction: column; }
        .cx-toolbar-actions { width: 100%; justify-content: stretch; }
        .cx-toolbar-actions .cx-action { flex: 1; }
        .cx-meta { grid-template-columns: 1fr; }
        .cx-wide { grid-column: auto; }
        .cx-actions .cx-action { flex: 1 1 calc(50% - 10px); }
        .cx-modal-actions .cx-action { flex: 1; }
      }`;
    document.head.appendChild(style);

    document.getElementById("cx-refresh").addEventListener("click", requestAll);
    document.querySelectorAll(".cx-tab").forEach((button) => {
      button.addEventListener("click", () => switchView(button.dataset.view));
    });
    document.getElementById("cx-import-userscript").addEventListener("click", () => document.getElementById("cx-userscript-file").click());
    document.getElementById("cx-userscript-file").addEventListener("change", (event) => {
      const files = [...(event.target.files || [])];
      event.target.value = "";
      if (files.length) importUserScripts(files);
    });
    document.getElementById("cx-install-extension").addEventListener("click", () => document.getElementById("cx-extension-file").click());
    document.getElementById("cx-extension-file").addEventListener("change", (event) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (file) installExtension(file);
    });
    document.getElementById("cx-confirm-cancel").addEventListener("click", closeDeleteConfirm);
    document.getElementById("cx-confirm-ok").addEventListener("click", () => {
      if (!pendingDelete) return closeDeleteConfirm();
      const { type, id } = pendingDelete;
      closeDeleteConfirm();
      if (type === "extension") extensionDispatch({ op: "delete", id });
      else scriptDispatch({ ids: [id], delete: true });
    });
    document.getElementById("cx-confirm").addEventListener("click", (event) => {
      if (event.target.id === "cx-confirm") closeDeleteConfirm();
    });
  };

  const switchView = (view) => {
    activeView = view === "extensions" ? "extensions" : "scripts";
    document.querySelectorAll(".cx-tab").forEach((button) => button.classList.toggle("active", button.dataset.view === activeView));
    document.getElementById("cx-script-toolbar").hidden = activeView !== "scripts";
    document.getElementById("cx-extension-toolbar").hidden = activeView !== "extensions";
    document.getElementById("cx-script-list").hidden = activeView !== "scripts";
    document.getElementById("cx-extension-list").hidden = activeView !== "extensions";
  };

  const tags = (values, empty = "无") =>
    values.length
      ? `<div class="cx-tags">${values.map((v) => `<span class="cx-tag">${escapeHtml(v)}</span>`).join("")}</div>`
      : `<span class="cx-value">${empty}</span>`;

  const renderScripts = (items) => {
    scriptsCache = Array.isArray(items) ? items : [];
    const list = document.getElementById("cx-script-list");
    document.getElementById("cx-total").textContent = `${scriptsCache.length} 个脚本`;
    document.getElementById("cx-enabled").textContent = `${scriptsCache.filter((s) => s.enabled).length} 个已启用`;
    if (!scriptsCache.length) {
      list.innerHTML = '<div class="cx-empty">暂无已安装 UserScript。可点击“导入本地脚本”从设备选择 .user.js / .js 文件。</div>';
      return;
    }
    list.innerHTML = scriptsCache.map((script) => {
      const meta = script.meta || "";
      const name = metaValue(meta, "name", script.id);
      const version = metaValue(meta, "version", "");
      const namespace = metaValue(meta, "namespace", "ChromeXt");
      const runAt = metaValue(meta, "run-at", "document-idle");
      const matches = [...metaValues(meta, "match"), ...metaValues(meta, "include")];
      const grants = metaValues(meta, "grant");
      return `<article class="cx-card" data-kind="script" data-id="${escapeHtml(script.id)}" data-enabled="${script.enabled}">
        <div class="cx-card-head"><div><h2 class="cx-title">${escapeHtml(name)}${version ? `<span class="cx-version">v${escapeHtml(version)}</span>` : ""}</h2><div class="cx-id">${escapeHtml(script.id)}</div></div><span class="cx-status">${script.enabled ? "已启用" : "已禁用"}</span></div>
        <div class="cx-meta">
          <div class="cx-meta-row"><span class="cx-label">Namespace</span><span class="cx-value">${escapeHtml(namespace)}</span></div>
          <div class="cx-meta-row"><span class="cx-label">Run at</span><span class="cx-value">${escapeHtml(runAt)}</span></div>
          <div class="cx-meta-row cx-wide"><span class="cx-label">匹配范围</span>${tags(matches)}</div>
          <div class="cx-meta-row cx-wide"><span class="cx-label">Grant</span>${tags(grants, "none")}</div>
        </div>
        <div class="cx-actions"><button class="cx-action cx-toggle" data-action="toggle">${script.enabled ? "禁用" : "启用"}</button><button class="cx-action cx-delete" data-action="delete">卸载</button></div>
      </article>`;
    }).join("");
    list.querySelectorAll("[data-action='toggle']").forEach((button) => button.addEventListener("click", () => {
      const card = button.closest(".cx-card");
      button.disabled = true;
      scriptDispatch({ ids: [card.dataset.id], enabled: card.dataset.enabled !== "true" });
    }));
    list.querySelectorAll("[data-action='delete']").forEach((button) => button.addEventListener("click", () => {
      const card = button.closest(".cx-card");
      openDeleteConfirm("script", card.dataset.id, card.querySelector(".cx-title")?.textContent || card.dataset.id);
    }));
  };

  const extensionPermissions = (extension) => [
    ...(Array.isArray(extension.permissions) ? extension.permissions : []),
    ...(Array.isArray(extension.host_permissions) ? extension.host_permissions : []),
  ];

  const renderExtensions = (items) => {
    extensionsCache = Array.isArray(items) ? items : [];
    const list = document.getElementById("cx-extension-list");
    document.getElementById("cx-extension-total").textContent = `${extensionsCache.length} 个扩展`;
    document.getElementById("cx-extension-enabled").textContent = `${extensionsCache.filter((e) => e.enabled).length} 个已启用`;
    if (!extensionsCache.length) {
      list.innerHTML = '<div class="cx-empty">暂无已安装扩展。可从本地导入 ZIP/CRX，或使用“导入本地文件夹”。</div>';
      return;
    }
    list.innerHTML = extensionsCache.map((extension) => {
      const permissions = extensionPermissions(extension);
      const contentScripts = Array.isArray(extension.content_scripts) ? extension.content_scripts : [];
      const background = extension.background ? "已隔离（不参与普通网页导航）" : "无后台脚本";
      return `<article class="cx-card" data-kind="extension" data-id="${escapeHtml(extension.id)}" data-enabled="${extension.enabled}">
        <div class="cx-card-head"><div><h2 class="cx-title">${escapeHtml(extension.name || extension.id)}<span class="cx-version">v${escapeHtml(extension.version || "0")}</span></h2><div class="cx-id">${escapeHtml(extension.id)}</div></div><span class="cx-status">${extension.enabled ? "已启用" : "已禁用"}</span></div>
        <div class="cx-meta">
          <div class="cx-meta-row"><span class="cx-label">Manifest</span><span class="cx-value">MV${escapeHtml(extension.manifest_version || 2)}</span></div>
          <div class="cx-meta-row"><span class="cx-label">后台运行时</span><span class="cx-value">${escapeHtml(background)}</span></div>
          <div class="cx-meta-row"><span class="cx-label">Content Scripts</span><span class="cx-value">${contentScripts.length} 组</span></div>
          <div class="cx-meta-row"><span class="cx-label">本地资源宿主</span><span class="cx-value">${extension.enabled ? "Loopback :" + escapeHtml(extension.port || "-") : "未启动"}</span></div>
          <div class="cx-meta-row cx-wide"><span class="cx-label">Permissions / Host Permissions</span>${tags(permissions)}</div>
        </div>
        <div class="cx-actions">
          ${extension.popupUrl ? '<button class="cx-action cx-open" data-action="popup">打开 Popup</button>' : ""}
          ${extension.optionsUrl ? '<button class="cx-action cx-open" data-action="options">选项</button>' : ""}
          <button class="cx-action cx-toggle" data-action="toggle">${extension.enabled ? "禁用" : "启用"}</button>
          <button class="cx-action cx-delete" data-action="delete">卸载</button>
        </div>
      </article>`;
    }).join("");
    list.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => {
      const card = button.closest(".cx-card");
      const extension = extensionsCache.find((item) => item.id === card.dataset.id);
      const action = button.dataset.action;
      if (action === "toggle") {
        button.disabled = true;
        extensionDispatch({ op: "setEnabled", id: card.dataset.id, enabled: card.dataset.enabled !== "true" });
      } else if (action === "delete") {
        openDeleteConfirm("extension", card.dataset.id, extension?.name || card.dataset.id);
      } else if (action === "popup" && extension?.popupUrl) {
        window.open(extension.popupUrl, "_blank");
      } else if (action === "options" && extension?.optionsUrl) {
        window.open(extension.optionsUrl, "_blank");
      }
    }));
  };

  const importUserScripts = async (files) => {
    const button = document.getElementById("cx-import-userscript");
    button.disabled = true;
    button.textContent = "正在导入…";
    let accepted = 0;
    try {
      for (const file of files) {
        if (file.size > 2 * 1024 * 1024) {
          toast(`${file.name} 导入失败：脚本超过 2 MB`, true);
          continue;
        }
        const code = await file.text();
        scriptDispatch({ import: true, name: file.name, code });
        accepted += 1;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (!accepted) button.disabled = false;
    } catch (error) {
      toast(`脚本导入失败：${error?.message || error}`, true);
    } finally {
      button.disabled = false;
      button.textContent = "导入本地脚本";
    }
  };

  const bytesToBase64 = (bytes) => {
    let binary = "";
    const size = 0x8000;
    for (let i = 0; i < bytes.length; i += size) binary += String.fromCharCode(...bytes.subarray(i, i + size));
    return btoa(binary);
  };

  const installExtension = async (file) => {
    if (file.size > 32 * 1024 * 1024) return toast("扩展安装失败：文件超过 32 MB", true);
    const button = document.getElementById("cx-install-extension");
    button.disabled = true;
    button.textContent = "正在导入…";
    const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      extensionDispatch({ op: "installStart", token, name: file.name, size: file.size });
      const buffer = new Uint8Array(await file.arrayBuffer());
      const chunkSize = 96 * 1024;
      for (let offset = 0; offset < buffer.length; offset += chunkSize) {
        extensionDispatch({ op: "installChunk", token, data: bytesToBase64(buffer.subarray(offset, offset + chunkSize)) });
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      extensionDispatch({ op: "installFinish", token });
    } catch (error) {
      toast(`扩展安装失败：${error?.message || error}`, true);
      button.disabled = false;
      button.textContent = "导入本地 ZIP/CRX";
    }
  };

  const requestScripts = () => scriptDispatch({ list: true });
  const requestExtensions = () => extensionDispatch({ op: "list" });
  const requestAll = () => { requestScripts(); requestExtensions(); };

  const start = () => {
    buildShell();
    globalThis.ChromeXt.addEventListener("userscript_list", (event) => renderScripts(event.detail));
    globalThis.ChromeXt.addEventListener("userscript_changed", () => requestScripts());
    globalThis.ChromeXt.addEventListener("userscript_import", (event) => {
      const detail = event.detail || {};
      if (detail.ok) {
        toast(`脚本导入成功：${detail.name || detail.id}`);
        switchView("scripts");
        requestScripts();
      } else {
        toast(`脚本导入失败：${detail.error || "未知错误"}`, true);
      }
    });
    globalThis.ChromeXt.addEventListener("extension_list", (event) => renderExtensions(event.detail));
    globalThis.ChromeXt.addEventListener("extension_changed", (event) => {
      toast(event.detail?.ok ? "扩展状态已更新" : "扩展操作失败", !event.detail?.ok);
      requestExtensions();
    });
    globalThis.ChromeXt.addEventListener("extension_install", (event) => {
      const button = document.getElementById("cx-install-extension");
      button.disabled = false;
      button.textContent = "导入本地 ZIP/CRX";
      const detail = event.detail || {};
      if (detail.extension) {
        toast(`扩展安装成功：${detail.extension.name || detail.extension.id}`);
        switchView("extensions");
        requestExtensions();
      } else if (detail.ok === false) {
        toast(`扩展安装失败：${detail.error || "未知错误"}`, true);
      }
    });
    requestAll();
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => setTimeout(start, 0), { once: true });
  else setTimeout(start, 0);
})();
