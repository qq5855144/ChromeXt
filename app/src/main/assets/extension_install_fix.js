"use strict";

(() => {
  const api = Symbol.ChromeXt;
  const extensionDispatch = (payload) => api.dispatch("extension", JSON.stringify(payload));
  const CHUNK_SIZE = 12 * 1024;
  const ACK_TIMEOUT = 15000;
  const INSTALL_TIMEOUT = 90000;

  const toast = (message, failure = false) => {
    const node = document.getElementById("cx-toast");
    if (!node) return;
    node.textContent = message;
    node.dataset.failure = failure ? "true" : "false";
    node.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => node.classList.remove("show"), failure ? 4200 : 2600);
  };

  const bytesToBase64 = (bytes) => {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x4000)
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x4000));
    return btoa(binary);
  };

  const readBytes = (file) => {
    if (typeof file.arrayBuffer === "function") return file.arrayBuffer().then((buffer) => new Uint8Array(buffer));
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(new Uint8Array(reader.result));
      reader.onerror = () => reject(reader.error || new Error("无法读取本地文件"));
      reader.readAsArrayBuffer(file);
    });
  };

  const waitEvent = (eventName, token, seq = null, timeout = ACK_TIMEOUT) =>
    new Promise((resolve, reject) => {
      let timer;
      const handler = (event) => {
        const detail = event.detail || {};
        if (detail.token !== token) return;
        if (seq !== null && Number(detail.seq) !== Number(seq)) return;
        cleanup();
        if (detail.ok === false) reject(new Error(detail.error || "扩展安装失败"));
        else resolve(detail);
      };
      const cleanup = () => {
        clearTimeout(timer);
        globalThis.ChromeXt.removeEventListener(eventName, handler);
      };
      timer = setTimeout(() => {
        cleanup();
        reject(new Error("安装传输超时，请重试"));
      }, timeout);
      globalThis.ChromeXt.addEventListener(eventName, handler);
    });

  const dispatchAndWait = async (eventName, payload, token, seq = null, timeout = ACK_TIMEOUT) => {
    const pending = waitEvent(eventName, token, seq, timeout);
    extensionDispatch(payload);
    return pending;
  };

  const setLocalButtonBusy = (busy) => {
    const button = document.getElementById("cx-install-extension");
    if (!button) return;
    button.disabled = busy;
    button.textContent = busy ? "正在导入…" : "导入本地 ZIP/CRX";
  };

  const reliableInstallFile = async (file) => {
    if (!file) return;
    if (file.size > 32 * 1024 * 1024) return toast("扩展安装失败：文件超过 32 MB", true);
    const token = `file-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setLocalButtonBusy(true);
    try {
      await dispatchAndWait(
        "extension_install_started",
        { op: "installStart", token, name: file.name || "extension.zip", size: file.size },
        token
      );
      const bytes = await readBytes(file);
      let seq = 0;
      for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
        const chunk = bytes.subarray(offset, Math.min(offset + CHUNK_SIZE, bytes.length));
        await dispatchAndWait(
          "extension_install_progress",
          { op: "installChunk", token, seq, data: bytesToBase64(chunk) },
          token,
          seq
        );
        seq += 1;
      }
      await dispatchAndWait("extension_install", { op: "installFinish", token }, token, null, INSTALL_TIMEOUT);
    } catch (error) {
      toast(`扩展安装失败：${error?.message || error}`, true);
    } finally {
      setLocalButtonBusy(false);
    }
  };

  const setFolderButtonBusy = (busy) => {
    const button = document.getElementById("cx-import-extension-folder");
    if (!button) return;
    button.disabled = busy;
    button.textContent = busy ? "正在导入…" : "导入本地文件夹";
  };

  const reliableInstallFolder = async (files) => {
    if (!files?.length) return;
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (total > 32 * 1024 * 1024) return toast("扩展导入失败：文件夹超过 32 MB", true);
    const token = `folder-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setFolderButtonBusy(true);
    try {
      await dispatchAndWait("extension_install_started", { op: "folderStart", token }, token);
      let seq = 0;
      for (const file of files) {
        const bytes = await readBytes(file);
        const path = file.webkitRelativePath || file.name;
        if (!path) throw new Error("无法读取扩展文件路径");
        if (bytes.length === 0) {
          await dispatchAndWait(
            "extension_install_progress",
            { op: "folderChunk", token, seq, path, data: "" },
            token,
            seq
          );
          seq += 1;
          continue;
        }
        for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
          const chunk = bytes.subarray(offset, Math.min(offset + CHUNK_SIZE, bytes.length));
          await dispatchAndWait(
            "extension_install_progress",
            { op: "folderChunk", token, seq, path, data: bytesToBase64(chunk) },
            token,
            seq
          );
          seq += 1;
        }
      }
      const rootName = files[0]?.webkitRelativePath?.split("/")[0] || "unpacked-extension";
      await dispatchAndWait(
        "extension_install",
        { op: "folderFinish", token, name: rootName },
        token,
        null,
        INSTALL_TIMEOUT
      );
    } catch (error) {
      toast(`扩展导入失败：${error?.message || error}`, true);
    } finally {
      setFolderButtonBusy(false);
    }
  };

  const closeUrlModal = () => {
    const modal = document.getElementById("cx-extension-url-modal");
    if (modal) modal.hidden = true;
  };

  const installFromUrl = async () => {
    const input = document.getElementById("cx-extension-url");
    const button = document.getElementById("cx-extension-url-confirm");
    const url = input?.value?.trim() || "";
    if (!/^https?:\/\//i.test(url)) return toast("请输入 HTTP/HTTPS 扩展地址", true);
    const token = `url-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    button.disabled = true;
    button.textContent = "正在下载…";
    try {
      const started = waitEvent("extension_install_started", token, null, ACK_TIMEOUT);
      const finished = waitEvent("extension_install", token, null, INSTALL_TIMEOUT);
      extensionDispatch({ op: "installUrl", token, url });
      await started;
      await finished;
      closeUrlModal();
    } catch (error) {
      toast(`扩展安装失败：${error?.message || error}`, true);
    } finally {
      button.disabled = false;
      button.textContent = "安装";
    }
  };

  const ensureUrlInstaller = () => {
    if (document.getElementById("cx-install-extension-url")) return;
    const toolbar = document.querySelector("#cx-extension-toolbar .cx-toolbar-actions") || document.getElementById("cx-extension-toolbar");
    if (!toolbar) return;
    const button = document.createElement("button");
    button.className = "cx-action cx-install";
    button.type = "button";
    button.id = "cx-install-extension-url";
    button.textContent = "从网址安装";
    toolbar.appendChild(button);

    const modal = document.createElement("div");
    modal.className = "cx-modal";
    modal.id = "cx-extension-url-modal";
    modal.hidden = true;
    modal.innerHTML = `
      <section class="cx-modal-card" role="dialog" aria-modal="true" aria-labelledby="cx-extension-url-title">
        <p class="cx-modal-kicker">ChromeXt</p>
        <h2 id="cx-extension-url-title">直接安装扩展</h2>
        <p class="cx-modal-text">支持直接的 ZIP / CRX 下载地址，也支持 Chrome Web Store 扩展详情页地址。</p>
        <input id="cx-extension-url" type="url" inputmode="url" autocomplete="off" spellcheck="false"
          placeholder="https://.../extension.crx" style="width:100%;margin-top:18px;padding:12px 14px;border:0;border-radius:14px;background:var(--neo-surface);color:var(--neo-text);box-shadow:var(--neo-inset-sm);outline:none">
        <div class="cx-modal-actions">
          <button class="cx-action" type="button" id="cx-extension-url-cancel">取消</button>
          <button class="cx-action cx-toggle" type="button" id="cx-extension-url-confirm">安装</button>
        </div>
      </section>`;
    document.body.appendChild(modal);

    button.addEventListener("click", () => {
      modal.hidden = false;
      requestAnimationFrame(() => document.getElementById("cx-extension-url")?.focus());
    });
    modal.addEventListener("click", (event) => {
      if (event.target === modal) closeUrlModal();
    });
    modal.querySelector("#cx-extension-url-cancel").addEventListener("click", closeUrlModal);
    modal.querySelector("#cx-extension-url-confirm").addEventListener("click", installFromUrl);
    modal.querySelector("#cx-extension-url").addEventListener("keydown", (event) => {
      if (event.key === "Enter") installFromUrl();
    });
  };

  // Capture before the older target listeners. This replaces the previous 96 KB fire-and-forget uploader.
  document.addEventListener(
    "change",
    (event) => {
      const target = event.target;
      if (target?.id === "cx-extension-file") {
        event.stopImmediatePropagation();
        const file = target.files?.[0];
        target.value = "";
        reliableInstallFile(file);
      } else if (target?.id === "cx-extension-folder") {
        event.stopImmediatePropagation();
        const files = [...(target.files || [])];
        target.value = "";
        reliableInstallFolder(files);
      }
    },
    true
  );

  const start = () => ensureUrlInstaller();
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", () => setTimeout(start, 0), { once: true });
  else setTimeout(start, 0);
})();
