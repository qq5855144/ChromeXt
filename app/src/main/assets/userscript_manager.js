"use strict";

(() => {
  const api = Symbol.ChromeXt;
  let pendingDeleteId = null;

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

  const dispatch = (payload) => api.dispatch("userscript", JSON.stringify(payload));

  const closeDeleteConfirm = () => {
    pendingDeleteId = null;
    const modal = document.getElementById("cx-confirm");
    if (modal) modal.hidden = true;
  };

  const openDeleteConfirm = (id, title) => {
    pendingDeleteId = id;
    document.getElementById("cx-confirm-name").textContent = `「${title}」将从 ChromeXt 中删除。`;
    const modal = document.getElementById("cx-confirm");
    modal.hidden = false;
    requestAnimationFrame(() => document.getElementById("cx-confirm-ok")?.focus());
  };

  const buildShell = () => {
    document.title = "UserScript 管理 · ChromeXt";
    document.documentElement.lang = "zh-CN";
    document.body.innerHTML = `
      <main class="cx-manager">
        <header class="cx-header">
          <div>
            <p class="cx-kicker">ChromeXt</p>
            <h1>UserScript 管理</h1>
            <p class="cx-subtitle">管理浏览器中已安装的用户脚本。禁用不会删除脚本或脚本存储。</p>
          </div>
          <button class="cx-refresh" type="button" id="cx-refresh">刷新</button>
        </header>
        <section class="cx-summary" aria-live="polite">
          <span id="cx-total">0 个脚本</span>
          <span id="cx-enabled">0 个已启用</span>
        </section>
        <section id="cx-list" class="cx-list"><div class="cx-empty">正在读取已安装脚本…</div></section>
      </main>
      <div class="cx-modal" id="cx-confirm" hidden>
        <section class="cx-modal-card" role="dialog" aria-modal="true" aria-labelledby="cx-confirm-title">
          <p class="cx-modal-kicker">ChromeXt</p>
          <h2 id="cx-confirm-title">确认卸载脚本？</h2>
          <p class="cx-modal-text" id="cx-confirm-name"></p>
          <div class="cx-modal-actions">
            <button class="cx-action" type="button" id="cx-confirm-cancel">取消</button>
            <button class="cx-action cx-delete cx-confirm-delete" type="button" id="cx-confirm-ok">确认卸载</button>
          </div>
        </section>
      </div>`;

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
      .cx-manager { width: min(920px, 100%); margin: 0 auto; padding: 28px 18px 64px; }
      .cx-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 18px;
        margin-bottom: 22px;
        padding: 22px;
        border-radius: 26px;
        background: var(--neo-surface);
        box-shadow: var(--neo-raised);
      }
      .cx-kicker, .cx-modal-kicker {
        margin: 0 0 5px;
        color: var(--neo-accent);
        font-size: 11px;
        font-weight: 800;
        letter-spacing: .13em;
        text-transform: uppercase;
      }
      h1 { margin: 0; font-size: clamp(28px, 7vw, 42px); line-height: 1.05; letter-spacing: -.025em; }
      .cx-subtitle { margin: 11px 0 0; max-width: 620px; color: var(--neo-muted); line-height: 1.6; }
      .cx-refresh, .cx-action {
        border: 0;
        border-radius: 14px;
        padding: 10px 15px;
        cursor: pointer;
        color: var(--neo-text);
        background: var(--neo-surface);
        box-shadow: var(--neo-raised-sm);
        transition: box-shadow .14s ease, transform .14s ease, color .14s ease, opacity .14s ease;
      }
      .cx-refresh { flex-shrink: 0; color: var(--neo-accent); font-weight: 750; }
      .cx-refresh:active, .cx-action:active, .cx-refresh:focus-visible, .cx-action:focus-visible {
        transform: translateY(1px);
        box-shadow: var(--neo-inset-sm);
      }
      .cx-refresh:disabled, .cx-action:disabled { opacity: .48; cursor: default; box-shadow: var(--neo-inset-sm); }
      .cx-summary { display: flex; gap: 10px; flex-wrap: wrap; margin: 20px 4px; font-size: 13px; color: var(--neo-muted); }
      .cx-summary span {
        padding: 8px 12px;
        border-radius: 999px;
        background: var(--neo-surface);
        box-shadow: var(--neo-inset-sm);
      }
      .cx-list { display: grid; gap: 18px; }
      .cx-card {
        padding: 18px;
        border: 0;
        border-radius: 22px;
        background: var(--neo-surface);
        box-shadow: var(--neo-raised);
        transition: opacity .16s ease, box-shadow .16s ease;
      }
      .cx-card[data-enabled="false"] { opacity: .66; }
      .cx-card-head { display: flex; justify-content: space-between; gap: 14px; align-items: flex-start; }
      .cx-title { margin: 0; font-size: 17px; word-break: break-word; }
      .cx-version { margin-left: 7px; color: var(--neo-accent); font-size: 12px; font-weight: 750; }
      .cx-id { margin-top: 6px; color: var(--neo-muted); font-size: 12px; overflow-wrap: anywhere; }
      .cx-status {
        white-space: nowrap;
        padding: 6px 10px;
        border-radius: 999px;
        color: var(--neo-accent);
        font-size: 12px;
        font-weight: 750;
        background: var(--neo-surface);
        box-shadow: var(--neo-inset-sm);
      }
      .cx-card[data-enabled="false"] .cx-status { color: var(--neo-muted); }
      .cx-meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 13px 18px; margin: 18px 0; }
      .cx-meta-row { min-width: 0; }
      .cx-label { display: block; margin-bottom: 5px; color: #8a929b; font-size: 10px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
      .cx-value { color: #505963; font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
      .cx-wide { grid-column: 1 / -1; }
      .cx-tags { display: flex; flex-wrap: wrap; gap: 7px; }
      .cx-tag {
        padding: 5px 8px;
        border-radius: 9px;
        color: var(--neo-muted);
        font-size: 11px;
        overflow-wrap: anywhere;
        background: var(--neo-surface);
        box-shadow: var(--neo-inset-sm);
      }
      .cx-actions { display: flex; justify-content: flex-end; gap: 10px; padding-top: 5px; }
      .cx-toggle { color: var(--neo-accent); font-weight: 750; }
      .cx-delete { color: var(--neo-danger); font-weight: 750; }
      .cx-empty {
        margin-top: 10px;
        padding: 58px 18px;
        border-radius: 22px;
        color: var(--neo-muted);
        text-align: center;
        background: var(--neo-surface);
        box-shadow: var(--neo-inset);
      }
      .cx-modal[hidden] { display: none !important; }
      .cx-modal {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        display: grid;
        place-items: center;
        padding: 20px;
        background: rgba(226,230,234,.76);
        backdrop-filter: blur(6px);
      }
      .cx-modal-card {
        width: min(390px, 100%);
        padding: 24px;
        border-radius: 24px;
        background: var(--neo-surface);
        box-shadow: 16px 16px 38px rgba(150,160,170,.44), -16px -16px 38px rgba(255,255,255,.94);
      }
      .cx-modal-card h2 { margin: 0; font-size: 20px; }
      .cx-modal-text { margin: 10px 0 0; color: var(--neo-muted); line-height: 1.6; overflow-wrap: anywhere; }
      .cx-modal-actions { display: flex; justify-content: flex-end; gap: 12px; margin-top: 24px; }
      .cx-confirm-delete { color: var(--neo-danger); }
      @media (max-width: 620px) {
        .cx-manager { padding: 18px 14px 48px; }
        .cx-header { align-items: center; padding: 18px; border-radius: 22px; }
        .cx-subtitle { font-size: 13px; }
        .cx-meta { grid-template-columns: 1fr; }
        .cx-wide { grid-column: auto; }
        .cx-actions .cx-action { flex: 1; }
        .cx-modal-actions .cx-action { flex: 1; }
      }`;
    document.head.appendChild(style);

    document.getElementById("cx-refresh").addEventListener("click", requestList);
    document.getElementById("cx-confirm-cancel").addEventListener("click", closeDeleteConfirm);
    document.getElementById("cx-confirm-ok").addEventListener("click", () => {
      if (!pendingDeleteId) return closeDeleteConfirm();
      const id = pendingDeleteId;
      const card = [...document.querySelectorAll(".cx-card")].find((node) => node.dataset.id === id);
      const button = card?.querySelector("[data-action='delete']");
      if (button) button.disabled = true;
      closeDeleteConfirm();
      dispatch({ ids: [id], delete: true });
    });
    document.getElementById("cx-confirm").addEventListener("click", (event) => {
      if (event.target.id === "cx-confirm") closeDeleteConfirm();
    });
  };

  const tags = (values, empty = "无") =>
    values.length
      ? `<div class="cx-tags">${values.map((v) => `<span class="cx-tag">${escapeHtml(v)}</span>`).join("")}</div>`
      : `<span class="cx-value">${empty}</span>`;

  const render = (items) => {
    const list = document.getElementById("cx-list");
    const scripts = Array.isArray(items) ? items : [];
    document.getElementById("cx-total").textContent = `${scripts.length} 个脚本`;
    document.getElementById("cx-enabled").textContent = `${scripts.filter((s) => s.enabled).length} 个已启用`;

    if (!scripts.length) {
      list.innerHTML = '<div class="cx-empty">暂无已安装 UserScript</div>';
      return;
    }

    list.innerHTML = scripts
      .map((script) => {
        const meta = script.meta || "";
        const name = metaValue(meta, "name", script.id);
        const version = metaValue(meta, "version", "");
        const namespace = metaValue(meta, "namespace", "ChromeXt");
        const runAt = metaValue(meta, "run-at", "document-idle");
        const matches = [...metaValues(meta, "match"), ...metaValues(meta, "include")];
        const grants = metaValues(meta, "grant");
        return `
          <article class="cx-card" data-id="${escapeHtml(script.id)}" data-enabled="${script.enabled}">
            <div class="cx-card-head">
              <div>
                <h2 class="cx-title">${escapeHtml(name)}${version ? `<span class="cx-version">v${escapeHtml(version)}</span>` : ""}</h2>
                <div class="cx-id">${escapeHtml(script.id)}</div>
              </div>
              <span class="cx-status">${script.enabled ? "已启用" : "已禁用"}</span>
            </div>
            <div class="cx-meta">
              <div class="cx-meta-row"><span class="cx-label">Namespace</span><span class="cx-value">${escapeHtml(namespace)}</span></div>
              <div class="cx-meta-row"><span class="cx-label">Run at</span><span class="cx-value">${escapeHtml(runAt)}</span></div>
              <div class="cx-meta-row cx-wide"><span class="cx-label">匹配范围</span>${tags(matches)}</div>
              <div class="cx-meta-row cx-wide"><span class="cx-label">Grant</span>${tags(grants, "none")}</div>
            </div>
            <div class="cx-actions">
              <button class="cx-action cx-toggle" type="button" data-action="toggle">${script.enabled ? "禁用" : "启用"}</button>
              <button class="cx-action cx-delete" type="button" data-action="delete">卸载</button>
            </div>
          </article>`;
      })
      .join("");

    list.querySelectorAll("[data-action='toggle']").forEach((button) => {
      button.addEventListener("click", () => {
        const card = button.closest(".cx-card");
        const id = card.dataset.id;
        const enabled = card.dataset.enabled !== "true";
        button.disabled = true;
        dispatch({ ids: [id], enabled });
      });
    });

    list.querySelectorAll("[data-action='delete']").forEach((button) => {
      button.addEventListener("click", () => {
        const card = button.closest(".cx-card");
        const id = card.dataset.id;
        const title = card.querySelector(".cx-title")?.textContent || id;
        openDeleteConfirm(id, title);
      });
    });
  };

  const requestList = () => dispatch({ list: true });

  const start = () => {
    buildShell();
    globalThis.ChromeXt.addEventListener("userscript_list", (event) => render(event.detail));
    globalThis.ChromeXt.addEventListener("userscript_changed", () => requestList());
    requestList();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(start, 0), { once: true });
  } else {
    setTimeout(start, 0);
  }
})();
