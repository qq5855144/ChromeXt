const isSandboxed = [
  "raw.githubusercontent.com",
  "gist.githubusercontent.com",
].includes(location.hostname);

let installResultTimer = null;

function showInstallResult(success, message) {
  let result = document.querySelector("#install-result");
  if (result == null) {
    result = document.createElement("div");
    result.id = "install-result";
    result.setAttribute("role", "status");
    result.setAttribute("aria-live", "polite");
    document.body.append(result);
  }

  clearTimeout(installResultTimer);
  result.className = "install-result " + (success ? "success" : "failure");
  result.textContent = message || (success ? "脚本安装成功" : "脚本安装失败");
  requestAnimationFrame(() => result.classList.add("show"));
  installResultTimer = setTimeout(() => {
    result.classList.remove("show");
  }, success ? 2200 : 3200);
}

// 解析脚本元数据，用于在安装界面中展示脚本信息
function parseScriptMeta(metaText) {
  const info = {
    name: "未命名脚本",
    namespace: "",
    version: "",
    author: "",
    matches: [],
    grants: [],
    runAt: "",
  };
  const reg = /\/\/\s+@(\S+)(?:[ \t]+(.+))?/g;
  let match;
  while ((match = reg.exec(metaText)) !== null) {
    const key = match[1];
    const value = (match[2] || "").trim();
    switch (key) {
      case "name":
        info.name = value.replace(":", "");
        break;
      case "namespace":
        info.namespace = value;
        break;
      case "version":
        info.version = value;
        break;
      case "author":
        info.author = value;
        break;
      case "match":
      case "include":
        info.matches.push(value);
        break;
      case "grant":
        info.grants.push(value);
        break;
      case "run-at":
        info.runAt = value;
        break;
    }
  }
  if (info.grants.length == 0) info.grants.push("none");
  return info;
}

function sanitizeDownloadName(name) {
  const clean = String(name || "UserScript")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  const base = clean || "UserScript";
  return base.endsWith(".user.js") ? base : base + ".user.js";
}

function downloadCurrentScript() {
  const meta = document.querySelector("#meta");
  const code = document.querySelector("#code");
  if (!meta || !code) return;

  const script = meta.innerText + code.innerText;
  const info = parseScriptMeta(meta.innerText);
  const blob = new Blob([script], { type: "text/javascript;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = sanitizeDownloadName(info.name);
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function installScript(force = false) {
  const dialog = document.querySelector("dialog#confirm");
  if (!force) {
    dialog.showModal();
  } else {
    dialog.close();
    const meta = document.querySelector("#meta");
    const code = document.querySelector("#code");
    const script = (meta ? meta.innerText : "") + (code ? code.innerText : "");
    const nativeAlert = window.alert;
    let failed = false;
    const installAlert = (message) => {
      if (String(message) == "Invalid UserScript") {
        failed = true;
        showInstallResult(false, "脚本安装失败：脚本格式无效");
      } else {
        nativeAlert.call(window, message);
      }
    };

    window.alert = installAlert;
    try {
      Symbol.ChromeXt.dispatch("installScript", script);
    } catch (error) {
      failed = true;
      showInstallResult(false, "脚本安装失败");
      console.error("ChromeXt UserScript installation failed", error);
    }

    setTimeout(() => {
      if (window.alert === installAlert) window.alert = nativeAlert;
      if (!failed) showInstallResult(true, "脚本安装成功");
    }, 500);
  }
}

// 创建顶部脚本信息卡片
function createInfoCard(info) {
  const card = document.createElement("div");
  card.id = "script-info";
  const head = document.createElement("div");
  head.className = "info-head";
  const download = document.createElement("button");
  download.className = "info-download";
  download.type = "button";
  download.textContent = "下载";
  download.setAttribute("aria-label", "下载当前用户脚本");
  download.addEventListener("click", () => {
    download.blur();
    downloadCurrentScript();
  });
  const title = document.createElement("div");
  title.className = "info-title";
  const name = document.createElement("span");
  name.className = "info-name";
  name.textContent = info.name;
  const version = document.createElement("span");
  version.className = "info-version";
  version.textContent = info.version ? "v" + info.version : "";
  title.append(name, version);
  head.append(download, title);
  const tags = document.createElement("div");
  tags.className = "info-tags";
  const matchTag = document.createElement("span");
  matchTag.className = "tag";
  matchTag.textContent = "🌐 " + info.matches.length + " 个站点";
  const grantTag = document.createElement("span");
  grantTag.className = "tag";
  grantTag.textContent = "🔑 " + info.grants.length + " 项权限";
  tags.append(matchTag, grantTag);
  if (info.runAt) {
    const runTag = document.createElement("span");
    runTag.className = "tag";
    runTag.textContent = "⚡ " + info.runAt;
    tags.append(runTag);
  }
  card.append(head, tags);
  return card;
}

function renderEditor(code, alertEncoding) {
  let scriptMeta = document.querySelector("#meta");
  if (scriptMeta) return;
  const separator = "==/UserScript==\n";
  const script = code.innerHTML.split(separator);
  if (script.length < 2) return;
  let html = (script.shift() + separator).replace(
    "GM.ChromeXt",
    "<em>GM.ChromeXt</em>"
  );
  for (const api of ["GM_notification", "GM_setClipboard", "GM_cookie"]) {
    html = html.replace(api, `<span>${api}</span>`);
  }
  const plainMeta = html.replace(/<[^>]+>/g, "");
  const info = parseScriptMeta(plainMeta);
  scriptMeta = document.createElement("pre");
  scriptMeta.innerHTML = html;
  code.innerHTML = script.join(separator);
  code.id = "code";
  code.removeAttribute("style");
  scriptMeta.id = "meta";
  const infoCard = createInfoCard(info);
  document.body.prepend(scriptMeta);
  document.body.prepend(infoCard);

  if (alertEncoding) {
    const msg =
      "检测到当前脚本可能包含编码异常的内容。\n\n如需修复，可先下载该脚本，再通过本地文件方式安装。";
    createDialog(msg, false);
  } else {
    const msg =
      "当前页面已阻止代码编辑器运行。\n\n请通过浏览器菜单安装此用户脚本，或刷新页面后重试。";
    createDialog(msg);
    setTimeout(fixDialog);
    // setTimeout 在沙箱页面中不可用，可借此检测沙箱页面
  }

  scriptMeta.setAttribute("contenteditable", true);
  code.setAttribute("contenteditable", true);
  scriptMeta.setAttribute("spellcheck", false);
  code.setAttribute("spellcheck", false);
  // 节点过多会拖慢事件循环，后续可优化
  import("https://unpkg.com/@speed-highlight/core/dist/index.js").then(
    (imports) => {
      imports.highlightElement(code, "js", "multiline", {
        hideLineNumbers: true,
      });
    }
  );
}

function createDialog(msg, interactive = true) {
  const dialog = document.createElement("dialog");
  dialog.id = "confirm";
  document.body.prepend(dialog);
  if (!interactive) {
    // 纯提示对话框：不提供安装交互
    const icon = document.createElement("div");
    icon.className = "dialog-icon";
    icon.textContent = "⚠️";
    const text = document.createElement("p");
    text.className = "dialog-msg";
    text.textContent = msg;
    dialog.append(icon, text);
    dialog.show();
  } else {
    dialog.textContent = msg;
    dialog.show();
  }
  return dialog;
}

function fixDialog() {
  const dialog = document.querySelector("dialog#confirm");
  if (dialog.textContent == "") return;
  dialog.close();
  dialog.textContent = "";
  const meta = document.querySelector("#meta");
  const info = meta ? parseScriptMeta(meta.innerText) : parseScriptMeta("");

  const managerHint = document.createElement("p");
  managerHint.className = "manager-hint";
  managerHint.append(document.createTextNode("地址栏输入 "));
  const managerLink = document.createElement("a");
  managerLink.className = "manager-link";
  managerLink.href = "about:blank#XT";
  managerLink.textContent = "about:blank#XT";
  managerLink.setAttribute("aria-label", "打开脚本管理面板");
  managerLink.addEventListener("click", (event) => {
    event.preventDefault();
    managerLink.blur();
    window.location.href = "about:blank#XT";
  });
  managerHint.append(managerLink, document.createTextNode(" 打开脚本管理面板"));
  const title = document.createElement("h2");
  title.textContent = "安装用户脚本";
  const name = document.createElement("p");
  name.className = "script-name";
  name.textContent = info.name || "未命名脚本";
  const metaRow = document.createElement("div");
  metaRow.className = "dialog-meta";
  const chips = [];
  if (info.version) chips.push("v" + info.version);
  chips.push(info.matches.length + " 个匹配站点");
  chips.push(info.grants.length + " 项权限");
  if (info.runAt) chips.push(info.runAt);
  for (const chip of chips) {
    const span = document.createElement("span");
    span.className = "chip";
    span.textContent = chip;
    metaRow.append(span);
  }
  const div = document.createElement("div");
  div.id = "interaction";
  const yes = document.createElement("button");
  yes.className = "btn-primary";
  yes.textContent = "确认安装";
  yes.addEventListener("click", () => installScript(true));
  const no = document.createElement("button");
  no.className = "btn-secondary";
  no.textContent = "稍后再说";
  no.addEventListener("click", () => {
    dialog.close();
    setTimeout(() => dialog.show(), 30000);
  });
  div.append(no, yes);
  dialog.append(managerHint, title, name, metaRow);
  const askChromeXt = document.querySelector("#meta > em") != undefined;
  if (askChromeXt) {
    const alert = document.createElement("p");
    alert.id = "alert";
    alert.textContent = "⚠️ 注意：该脚本声明了 GM.ChromeXt 特殊权限，请谨慎确认";
    dialog.append(alert);
  }
  dialog.append(div);
  installScript();
}

async function prepareDOM() {
  if (Symbol.ChromeXt == undefined) return;
  if (document.querySelector("script,div,p") != null) return;
  const meta = document.createElement("meta");
  const style = document.createElement("style");

  style.setAttribute("type", "text/css");
  meta.setAttribute("name", "viewport");
  meta.setAttribute(
    "content",
    "width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"
  );
  style.textContent = _editor_style;

  const code = document.querySelector("body > pre");
  if (document.readyState == "loading") {
    if (isSandboxed) {
      return prepareDOM();
      // 沙箱页面无法使用事件监听
    } else {
      return document.addEventListener("DOMContentLoaded", prepareDOM);
    }
  }
  Symbol.installScript = installScript;
  document.head.appendChild(meta);
  document.head.appendChild(style);

  const alertEncoding = !(await fixEncoding(true, true, code));
  renderEditor(code, alertEncoding);
}

prepareDOM();