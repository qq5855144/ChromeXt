"use strict";

(() => {
  const api = Symbol.ChromeXt;
  const extensionDispatch = (payload) => api.dispatch("extension", JSON.stringify(payload));
  let extensions = [];
  let permissionExtension = null;
  let folderBusy = false;

  const bytesToBase64 = (bytes) => {
    let binary = "";
    const size = 0x8000;
    for (let i = 0; i < bytes.length; i += size)
      binary += String.fromCharCode(...bytes.subarray(i, i + size));
    return btoa(binary);
  };

  const showToast = (message, failure = false) => {
    const node = document.getElementById("cx-toast");
    if (!node) return;
    node.textContent = message;
    node.dataset.failure = failure ? "true" : "false";
    node.classList.add("show");
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => node.classList.remove("show"), failure ? 3600 : 2400);
  };

  const installFolder = async (files) => {
    if (!files?.length || folderBusy) return;
    const total = [...files].reduce((sum, file) => sum + file.size, 0);
    if (total > 32 * 1024 * 1024) return showToast("扩展导入失败：文件夹超过 32 MB", true);
    folderBusy = true;
    const button = document.getElementById("cx-import-extension-folder");
    if (button) {
      button.disabled = true;
      button.textContent = "正在导入…";
    }
    const token = `folder-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      extensionDispatch({ op: "folderStart", token });
      const chunkSize = 96 * 1024;
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const path = file.webkitRelativePath || file.name;
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          extensionDispatch({
            op: "folderChunk",
            token,
            path,
            data: bytesToBase64(bytes.subarray(offset, offset + chunkSize)),
          });
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        if (bytes.length === 0)
          extensionDispatch({ op: "folderChunk", token, path, data: "" });
      }
      const rootName = files[0]?.webkitRelativePath?.split("/")[0] || "unpacked-extension";
      extensionDispatch({ op: "folderFinish", token, name: rootName });
    } catch (error) {
      folderBusy = false;
      if (button) {
        button.disabled = false;
        button.textContent = "导入文件夹";
      }
      showToast(`扩展导入失败：${error?.message || error}`, true);
    }
  };

  const ensureFolderControls = () => {
    const toolbar = document.getElementById("cx-extension-toolbar");
    if (!toolbar || document.getElementById("cx-import-extension-folder")) return;
    const group = document.createElement("div");
    group.style.display = "flex";
    group.style.gap = "10px";
    group.style.flexWrap = "wrap";
    const button = document.createElement("button");
    button.id = "cx-import-extension-folder";
    button.type = "button";
    button.className = "cx-action cx-install";
    button.textContent = "导入文件夹";
    const input = document.createElement("input");
    input.id = "cx-extension-folder";
    input.type = "file";
    input.multiple = true;
    input.hidden = true;
    input.setAttribute("webkitdirectory", "");
    input.setAttribute("directory", "");
    button.addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
      const files = [...(input.files || [])];
      input.value = "";
      installFolder(files);
    });
    group.append(button, input);
    toolbar.append(group);
  };

  const optionalPermissions = (extension) => [
    ...(Array.isArray(extension.optional_permissions) ? extension.optional_permissions : []),
    ...(Array.isArray(extension.optional_host_permissions) ? extension.optional_host_permissions : []),
  ];

  const ensurePermissionModal = () => {
    if (document.getElementById("cx-permissions")) return;
    const modal = document.createElement("div");
    modal.className = "cx-modal";
    modal.id = "cx-permissions";
    modal.hidden = true;
    modal.innerHTML = `
      <section class="cx-modal-card" role="dialog" aria-modal="true" aria-labelledby="cx-permission-title">
        <p class="cx-modal-kicker">ChromeXt</p>
        <h2 id="cx-permission-title">扩展权限</h2>
        <p class="cx-modal-text" id="cx-permission-description"></p>
        <div id="cx-permission-list" style="display:grid;gap:10px;margin-top:18px"></div>
        <div class="cx-modal-actions">
          <button class="cx-action" type="button" id="cx-permission-cancel">取消</button>
          <button class="cx-action cx-toggle" type="button" id="cx-permission-save">保存</button>
        </div>
      </section>`;
    document.body.append(modal);
    modal.addEventListener("click", (event) => {
      if (event.target === modal) modal.hidden = true;
    });
    modal.querySelector("#cx-permission-cancel").addEventListener("click", () => {
      modal.hidden = true;
    });
    modal.querySelector("#cx-permission-save").addEventListener("click", () => savePermissions());
  };

  const openPermissions = (id) => {
    permissionExtension = extensions.find((extension) => extension.id === id) || null;
    if (!permissionExtension) return;
    const optional = optionalPermissions(permissionExtension);
    if (!optional.length) return showToast("该扩展没有可选权限");
    extensionDispatch({ op: "permissions", id });
  };

  const renderPermissionModal = (detail) => {
    if (!permissionExtension || detail?.id !== permissionExtension.id || detail?.ok === false) {
      if (detail?.ok === false) showToast(`读取权限失败：${detail.error || "未知错误"}`, true);
      return;
    }
    const granted = new Set([
      ...(Array.isArray(detail.value?.permissions) ? detail.value.permissions : []),
      ...(Array.isArray(detail.value?.origins) ? detail.value.origins : []),
    ]);
    const optional = optionalPermissions(permissionExtension);
    document.getElementById("cx-permission-description").textContent =
      `仅下列 Manifest 可选权限可以在这里授权。${permissionExtension.name || permissionExtension.id}`;
    const list = document.getElementById("cx-permission-list");
    list.innerHTML = "";
    optional.forEach((permission) => {
      const label = document.createElement("label");
      label.style.display = "flex";
      label.style.alignItems = "center";
      label.style.gap = "12px";
      label.style.padding = "11px 13px";
      label.style.borderRadius = "14px";
      label.style.boxShadow = "var(--neo-inset-sm)";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = permission;
      input.checked = granted.has(permission);
      input.dataset.initial = input.checked ? "true" : "false";
      const text = document.createElement("span");
      text.className = "cx-value";
      text.textContent = permission;
      label.append(input, text);
      list.append(label);
    });
    document.getElementById("cx-permissions").hidden = false;
  };

  const savePermissions = () => {
    if (!permissionExtension) return;
    const inputs = [...document.querySelectorAll("#cx-permission-list input[type='checkbox']")];
    const grant = inputs.filter((input) => input.checked && input.dataset.initial !== "true").map((input) => input.value);
    const remove = inputs.filter((input) => !input.checked && input.dataset.initial === "true").map((input) => input.value);
    const split = (values) => ({
      permissions: values.filter((value) => !value.includes("://") && value !== "<all_urls>"),
      origins: values.filter((value) => value.includes("://") || value === "<all_urls>"),
    });
    if (grant.length)
      extensionDispatch({ op: "grantPermissions", id: permissionExtension.id, permissions: split(grant) });
    if (remove.length)
      extensionDispatch({ op: "removePermissions", id: permissionExtension.id, permissions: split(remove) });
    document.getElementById("cx-permissions").hidden = true;
    showToast("扩展权限已更新");
  };

  const decorateCards = () => {
    document.querySelectorAll("#cx-extension-list .cx-card[data-kind='extension']").forEach((card) => {
      if (card.querySelector("[data-action='permissions']")) return;
      const extension = extensions.find((item) => item.id === card.dataset.id);
      if (!extension || !optionalPermissions(extension).length) return;
      const button = document.createElement("button");
      button.className = "cx-action cx-open";
      button.type = "button";
      button.dataset.action = "permissions";
      button.textContent = "权限";
      button.addEventListener("click", () => openPermissions(card.dataset.id));
      card.querySelector(".cx-actions")?.prepend(button);
    });
  };

  const start = () => {
    ensureFolderControls();
    ensurePermissionModal();
    globalThis.ChromeXt.addEventListener("extension_list", (event) => {
      extensions = Array.isArray(event.detail) ? event.detail : [];
      setTimeout(decorateCards, 0);
    });
    globalThis.ChromeXt.addEventListener("extension_permissions", (event) => renderPermissionModal(event.detail));
    globalThis.ChromeXt.addEventListener("extension_permissions_changed", (event) => {
      if (event.detail?.ok === false)
        showToast(`权限更新失败：${event.detail.error || "未知错误"}`, true);
    });
    globalThis.ChromeXt.addEventListener("extension_install", () => {
      folderBusy = false;
      const button = document.getElementById("cx-import-extension-folder");
      if (button) {
        button.disabled = false;
        button.textContent = "导入文件夹";
      }
    });
  };

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", () => setTimeout(start, 0), { once: true });
  else setTimeout(start, 0);
})();
