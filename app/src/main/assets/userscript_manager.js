"use strict";

(() => {
  const api = Symbol.ChromeXt;
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
      </main>`;

    const style = document.createElement("style");
    style.textContent = `
      :root { color-scheme: light dark; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; background: #f5f6f8; color: #17191c; }
      .cx-manager { width: min(920px, 100%); margin: 0 auto; padding: 28px 18px 56px; }
      .cx-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; margin-bottom: 18px; }
      .cx-kicker { margin: 0 0 4px; font-size: 12px; font-weight: 700; letter-spacing: .12em; opacity: .55; text-transform: uppercase; }
      h1 { margin: 0; font-size: clamp(28px, 7vw, 42px); line-height: 1.05; }
      .cx-subtitle { margin: 10px 0 0; max-width: 620px; opacity: .68; line-height: 1.55; }
      button { font: inherit; }
      .cx-refresh, .cx-action { border: 0; border-radius: 12px; padding: 10px 14px; cursor: pointer; background: #fff; color: inherit; box-shadow: 0 1px 2px rgba(0,0,0,.08), 0 8px 24px rgba(0,0,0,.06); }
      .cx-summary { display: flex; gap: 10px; flex-wrap: wrap; margin: 18px 0; font-size: 13px; opacity: .72; }
      .cx-summary span { background: rgba(255,255,255,.72); border-radius: 999px; padding: 7px 10px; }
      .cx-list { display: grid; gap: 12px; }
      .cx-card { background: #fff; border: 1px solid rgba(0,0,0,.06); border-radius: 18px; padding: 16px; box-shadow: 0 8px 28px rgba(0,0,0,.05); }
      .cx-card[data-enabled="false"] { opacity: .68; }
      .cx-card-head { display: flex; justify-content: space-between; gap: 14px; align-items: flex-start; }
      .cx-title { margin: 0; font-size: 17px; word-break: break-word; }
      .cx-version { font-size: 12px; opacity: .55; margin-left: 6px; }
      .cx-id { margin-top: 5px; font-size: 12px; opacity: .52; overflow-wrap: anywhere; }
      .cx-status { white-space: nowrap; font-size: 12px; font-weight: 700; border-radius: 999px; padding: 6px 9px; background: #eef0f3; }
      .cx-meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 16px; margin: 16px 0; }
      .cx-meta-row { min-width: 0; }
      .cx-label { display: block; font-size: 11px; font-weight: 700; opacity: .48; letter-spacing: .04em; text-transform: uppercase; margin-bottom: 4px; }
      .cx-value { font-size: 13px; line-height: 1.45; overflow-wrap: anywhere; }
      .cx-wide { grid-column: 1 / -1; }
      .cx-tags { display: flex; flex-wrap: wrap; gap: 5px; }
      .cx-tag { padding: 4px 7px; border-radius: 8px; background: #f2f3f5; font-size: 11px; overflow-wrap: anywhere; }
      .cx-actions { display: flex; justify-content: flex-end; gap: 8px; padding-top: 4px; }
      .cx-toggle { font-weight: 650; }
      .cx-delete { color: #b42318; }
      .cx-empty { text-align: center; padding: 54px 16px; opacity: .58; }
      @media (max-width: 620px) { .cx-manager { padding-top: 20px; } .cx-header { align-items: center; } .cx-meta { grid-template-columns: 1fr; } .cx-wide { grid-column: auto; } .cx-actions .cx-action { flex: 1; } }
      @media (prefers-color-scheme: dark) {
        body { background: #101114; color: #f2f3f5; }
        .cx-card, .cx-refresh, .cx-action { background: #1b1d21; box-shadow: none; }
        .cx-card { border-color: rgba(255,255,255,.07); }
        .cx-summary span, .cx-tag, .cx-status { background: #24272d; }
        .cx-delete { color: #ff8a80; }
      }`;
    document.head.appendChild(style);
    document.getElementById("cx-refresh").addEventListener("click", requestList);
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
        if (!confirm(`确定卸载「${title}」？\n\n脚本将从 ChromeXt 中删除。`)) return;
        button.disabled = true;
        dispatch({ ids: [id], delete: true });
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
