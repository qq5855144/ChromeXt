package org.matrix.chromext.extension

import java.lang.ref.WeakReference
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import org.json.JSONArray
import org.json.JSONObject
import org.matrix.chromext.Chrome
import org.matrix.chromext.devtools.DevSessions
import org.matrix.chromext.script.Local
import org.matrix.chromext.utils.Log

object ExtensionBridge {
  private data class MessageRoute(val tab: WeakReference<Any>, val frameId: String?)
  private data class ContextRoute(val tab: WeakReference<Any>, val frameId: String?)

  private val messageRoutes = ConcurrentHashMap<String, MessageRoute>()
  private val popupRoutes = ConcurrentHashMap<String, WeakReference<Any>>()
  private val extensionPageRoutes = ConcurrentHashMap<String, MutableList<ContextRoute>>()

  private fun success(value: Any? = JSONObject.NULL): JSONObject =
      JSONObject().put("ok", true).put("value", value ?: JSONObject.NULL)

  private fun failure(message: String): JSONObject =
      JSONObject().put("ok", false).put("error", message)

  private fun managerEvent(name: String, detail: Any): String =
      "ChromeXt.post('$name', ${detail.toString()});"

  private fun managerApi(id: String, api: String, value: JSONObject? = null): JSONObject {
    val args = JSONArray()
    if (value != null) args.put(value)
    return LocalFiles.api(id, JSONObject().put("api", api).put("args", args), Chrome.getTab(), null)
  }

  private fun extensionInfo(id: String): JSONObject? {
    val list = LocalFiles.managementList()
    for (i in 0 until list.length()) {
      val item = list.optJSONObject(i) ?: continue
      if (item.optString("id") == id) return item
    }
    return null
  }

  private fun popupPath(extension: JSONObject?): String {
    if (extension == null) return ""
    val action =
        extension.optJSONObject("action")
            ?: extension.optJSONObject("browser_action")
            ?: extension.optJSONObject("page_action")
    return action?.optString("default_popup")?.trim().orEmpty()
  }

  private fun preparePopup(id: String): String {
    val active = ExtensionActiveTab.preferred(Chrome.getTab()) ?: Chrome.getTab()
    val prepared = ExtensionBackgroundHost.prepare(id, active)
    if (prepared?.bootstrap != null) Chrome.evaluateJavascript(listOf(prepared.bootstrap), prepared.tab)
    Chrome.getTab()?.let { popupRoutes[id] = WeakReference(it) }
    return managerEvent("extension_popup", ExtensionPopup.document(id))
  }

  private fun startInstalledBackground(result: JSONObject) {
    val extension = result.optJSONObject("extension") ?: return
    if (!extension.optBoolean("enabled", true)) return
    val id = extension.optString("id")
    if (id.isBlank()) return
    val prepared = ExtensionBackgroundHost.prepare(id, ExtensionActiveTab.preferred()) ?: return
    prepared.bootstrap?.let { Chrome.evaluateJavascript(listOf(it), prepared.tab) }
  }

  private fun permissionSnapshot(id: String): JSONObject? {
    val response = managerApi(id, "permissions.getAll")
    if (!response.optBoolean("ok")) return null
    return response.optJSONObject("value")
  }

  private fun hasPermission(id: String, permission: String): Boolean {
    val permissions = permissionSnapshot(id)?.optJSONArray("permissions") ?: return false
    for (i in 0 until permissions.length()) {
      if (permissions.optString(i) == permission) return true
    }
    return false
  }

  private fun hasAnyPermission(id: String, permissions: Set<String>): Boolean =
      permissions.any { hasPermission(id, it) }

  private fun requiredPermissions(api: String): Set<String>? =
      when {
        api.startsWith("cookies.") -> setOf("cookies")
        api.startsWith("downloads.") -> setOf("downloads")
        api.startsWith("notifications.") -> setOf("notifications")
        api.startsWith("scripting.") -> setOf("scripting", "tabs")
        else -> null
      }

  private fun taggedUploadResult(data: JSONObject, result: JSONObject): JSONObject {
    val detail = JSONObject(result.toString())
    if (data.has("token")) detail.put("token", data.optString("token"))
    if (data.has("seq")) detail.put("seq", data.optInt("seq"))
    if (data.has("path")) detail.put("path", data.optString("path"))
    return detail
  }

  fun manager(payload: String): String {
    if (payload.isBlank()) return managerEvent("extension_list", LocalFiles.managementList())
    val data = JSONObject(payload)
    return when (data.optString("op")) {
      "list" -> managerEvent("extension_list", LocalFiles.managementList())
      "popup" -> preparePopup(data.getString("id"))
      "activate" -> {
        val id = data.getString("id")
        val extension = extensionInfo(id)
        if (extension == null || !extension.optBoolean("enabled")) {
          managerEvent("extension_action", failure("Extension is disabled").put("id", id))
        } else if (popupPath(extension).isNotBlank()) {
          preparePopup(id)
        } else {
          val ok = ExtensionBackgroundHost.dispatchActionClick(id, ExtensionActiveTab.preferred())
          managerEvent(
              "extension_action",
              JSONObject().put("ok", ok).put("id", id).put("type", "clicked"))
        }
      }
      "runtimeStatus" -> {
        val id = data.getString("id")
        managerEvent(
            "extension_runtime_status",
            JSONObject()
                .put("ok", true)
                .put("id", id)
                .put("backgroundAttached", ExtensionBackgroundHost.isAttached(id))
                .put("activeTab", ExtensionActiveTab.snapshot()))
      }
      "setEnabled" -> {
        val id = data.getString("id")
        val enabled = data.getBoolean("enabled")
        val changed = LocalFiles.setEnabled(id, enabled)
        if (changed && !enabled) {
          ExtensionBackgroundHost.release(id)
          popupRoutes.remove(id)
          extensionPageRoutes.remove(id)
        } else if (changed) {
          val prepared = ExtensionBackgroundHost.prepare(id, ExtensionActiveTab.preferred())
          if (prepared?.bootstrap != null)
              Chrome.evaluateJavascript(listOf(prepared.bootstrap), prepared.tab)
        }
        managerEvent(
            "extension_changed",
            JSONObject().put("ok", changed).put("type", "enabled").put("id", id))
      }
      "delete" -> {
        val id = data.getString("id")
        ExtensionBackgroundHost.release(id)
        ExtensionDynamicScripts.clear(id)
        popupRoutes.remove(id)
        extensionPageRoutes.remove(id)
        val changed = LocalFiles.delete(id)
        managerEvent(
            "extension_changed",
            JSONObject().put("ok", changed).put("type", "delete").put("id", id))
      }
      "installStart" -> {
        val result =
            LocalFiles.beginInstall(data.getString("token"), data.optString("name", "extension.zip"))
        managerEvent("extension_install_started", taggedUploadResult(data, result))
      }
      "installChunk" -> {
        val result = LocalFiles.appendInstall(data.getString("token"), data.getString("data"))
        managerEvent("extension_install_progress", taggedUploadResult(data, result))
      }
      "installFinish" -> {
        val result = LocalFiles.finishInstall(data.getString("token"))
        startInstalledBackground(result)
        managerEvent("extension_install", taggedUploadResult(data, result))
      }
      "installUrl" -> {
        val source = data.optString("url").trim()
        val requestToken = data.optString("token").ifBlank { "remote-${UUID.randomUUID()}" }
        if (source.isBlank()) {
          managerEvent(
              "extension_install",
              JSONObject().put("ok", false).put("error", "请输入扩展地址").put("token", requestToken))
        } else {
          val targetTab = Chrome.getTab()
          Chrome.IO.submit {
            val result = RemoteExtensionInstaller.install(source).put("token", requestToken)
            startInstalledBackground(result)
            Chrome.evaluateJavascript(listOf(managerEvent("extension_install", result)), targetTab)
          }
          managerEvent(
              "extension_install_started",
              JSONObject().put("ok", true).put("token", requestToken).put("remote", true))
        }
      }
      "folderStart" -> {
        val result = UnpackedExtensionInstaller.begin(data.getString("token"))
        managerEvent("extension_install_started", taggedUploadResult(data, result))
      }
      "folderChunk" -> {
        val result =
            UnpackedExtensionInstaller.append(
                data.getString("token"), data.getString("path"), data.getString("data"))
        managerEvent("extension_install_progress", taggedUploadResult(data, result))
      }
      "folderFinish" -> {
        val result =
            UnpackedExtensionInstaller.finish(data.getString("token"), data.optString("name"))
        startInstalledBackground(result)
        managerEvent("extension_install", taggedUploadResult(data, result))
      }
      "permissions" ->
          managerEvent(
              "extension_permissions",
              managerApi(data.getString("id"), "permissions.getAll")
                  .put("id", data.getString("id")))
      "grantPermissions" -> {
        val request = data.optJSONObject("permissions") ?: JSONObject()
        managerEvent(
            "extension_permissions_changed",
            managerApi(data.getString("id"), "permissions.request", request)
                .put("id", data.getString("id")))
      }
      "removePermissions" -> {
        val request = data.optJSONObject("permissions") ?: JSONObject()
        managerEvent(
            "extension_permissions_changed",
            managerApi(data.getString("id"), "permissions.remove", request)
                .put("id", data.getString("id")))
      }
      else ->
          managerEvent(
              "extension_install",
              JSONObject().put("ok", false).put("error", "Unknown extension manager operation"))
    }
  }

  private fun syntheticTabId(tab: Any?): String = ExtensionActiveTab.idFor(tab)

  private fun sender(
      extensionId: String,
      currentTab: Any?,
      frameId: String?,
      context: JSONObject?,
  ): JSONObject {
    val type = context?.optString("type").orEmpty()
    val url = context?.optString("url")?.takeIf { it.isNotBlank() } ?: Chrome.getUrl(currentTab) ?: ""
    val result =
        JSONObject()
            .put("id", extensionId)
            .put("url", url)
            .put("frameId", frameId ?: JSONObject.NULL)
    if (type == "content") {
      val tab = Chrome.getTab(currentTab)
      result.put(
          "tab",
          JSONObject()
              .put("id", syntheticTabId(tab))
              .put("url", Chrome.getUrl(tab) ?: url)
              .put("active", true)
              .put("windowId", 0))
    }
    return result
  }

  private fun eventCode(event: String, detail: JSONObject): String =
      "Symbol.${Local.name}.unlock(${Local.key}).post(${JSONObject.quote(event)},${detail});"

  private fun deliverDirect(
      tab: Any?,
      event: String,
      detail: JSONObject,
      frameId: String? = null,
      bootstrap: String? = null,
  ): Boolean {
    val target = Chrome.getTab(tab) ?: return false
    if (!runCatching { Chrome.checkTab(target) }.getOrDefault(false)) return false
    val codes = mutableListOf<String>()
    if (!bootstrap.isNullOrBlank()) codes.add(bootstrap)
    codes.add(eventCode(event, detail))
    Chrome.evaluateJavascript(codes, target, frameId)
    return true
  }

  private fun deliverToTab(tabId: String, event: String, detail: JSONObject): Boolean {
    if (tabId.isBlank()) return false
    val remembered = ExtensionActiveTab.resolve(tabId)
    if (remembered != null) return deliverDirect(remembered, event, detail)
    if (tabId.startsWith("cx-local-")) return false
    return runCatching {
          val client = DevSessions.new(tabId, "extension-message")
          client.evaluateJavascript(eventCode(event, detail))
          client.close()
          true
        }
        .getOrElse {
          Log.e("Failed to deliver extension message to tab $tabId: ${it.message}")
          false
        }
  }

  private fun rememberRoute(messageId: String, currentTab: Any?, frameId: String?) {
    val tab = Chrome.getTab(currentTab) ?: return
    if (messageId.isNotBlank()) messageRoutes[messageId] = MessageRoute(WeakReference(tab), frameId)
  }

  private fun rememberExtensionPage(extensionId: String, currentTab: Any?, frameId: String?) {
    val tab = Chrome.getTab(currentTab) ?: return
    val routes = extensionPageRoutes.getOrPut(extensionId) { mutableListOf() }
    synchronized(routes) {
      routes.removeAll { it.tab.get() == null || !runCatching { Chrome.checkTab(it.tab.get()) }.getOrDefault(false) }
      if (routes.none { it.tab.get() === tab && it.frameId == frameId }) {
        routes.add(ContextRoute(WeakReference(tab), frameId))
      }
    }
  }

  private fun deliverToExtensionPages(extensionId: String, detail: JSONObject): Boolean {
    var delivered = false
    popupRoutes[extensionId]?.get()?.let { tab ->
      delivered = deliverDirect(tab, "cx_extension_message", detail) || delivered
    }
    val routes = extensionPageRoutes[extensionId]
    if (routes != null) {
      synchronized(routes) {
        val iterator = routes.iterator()
        while (iterator.hasNext()) {
          val route = iterator.next()
          val tab = route.tab.get()
          if (tab == null || !runCatching { Chrome.checkTab(tab) }.getOrDefault(false)) {
            iterator.remove()
            continue
          }
          delivered = deliverDirect(tab, "cx_extension_message", detail, route.frameId) || delivered
        }
      }
    }
    return delivered
  }

  private fun deliverMessageResponse(extensionId: String, messageId: String, value: Any?): Boolean {
    val route = messageRoutes.remove(messageId) ?: return false
    val tab = route.tab.get() ?: return false
    val detail =
        JSONObject()
            .put("extensionId", extensionId)
            .put("messageId", messageId)
            .put("value", value ?: JSONObject.NULL)
    return deliverDirect(tab, "cx_extension_message_response", detail, route.frameId)
  }

  private fun messageResult(request: JSONObject, currentTab: Any?, frameId: String?): JSONObject {
    val extensionId = request.getString("extensionId")
    val api = request.optString("api")
    val args = request.optJSONArray("args") ?: JSONArray()
    val messageId = request.optString("messageId", request.optString("requestId"))
    if (api == "runtime.sendMessageResponse") {
      deliverMessageResponse(extensionId, messageId, args.opt(0))
      return success()
    }

    val isTabMessage = api == "tabs.sendMessage"
    val message = if (isTabMessage) args.opt(1) else args.opt(0)
    val senderContext = request.optJSONObject("context") ?: JSONObject()
    val detail =
        JSONObject()
            .put("extensionId", extensionId)
            .put("messageId", messageId)
            .put("target", if (isTabMessage) "content" else "extension")
            .put("senderContext", senderContext)
            .put("message", message ?: JSONObject.NULL)
            .put("sender", sender(extensionId, currentTab, frameId, senderContext))

    rememberRoute(messageId, currentTab, frameId)
    val delivered =
        if (isTabMessage) {
          deliverToTab(args.optString(0), "cx_extension_message", detail)
        } else if (senderContext.optString("type") == "background") {
          deliverToExtensionPages(extensionId, detail)
        } else {
          val prepared = ExtensionBackgroundHost.prepare(extensionId, ExtensionActiveTab.preferred(currentTab))
          if (prepared != null) {
            deliverDirect(
                prepared.tab,
                "cx_extension_message",
                detail,
                bootstrap = prepared.bootstrap)
          } else {
            false
          }
        }

    if (!delivered) {
      messageRoutes.remove(messageId)
      return failure("Extension message target is not available")
    }
    return success()
  }

  private fun activeTabMatches(query: JSONObject?): Boolean {
    if (query == null) return true
    if (query.has("active") && !query.optBoolean("active")) return false
    if (query.has("highlighted") && !query.optBoolean("highlighted")) return false
    if (query.optBoolean("pinned", false) || query.optBoolean("incognito", false)) return false
    return true
  }

  private fun openUrl(url: String, currentTab: Any?, newTab: Boolean): JSONObject {
    val resolved = ExtensionUrl.resolve(url) ?: url
    val target = ExtensionActiveTab.preferred(currentTab) ?: Chrome.getTab(currentTab)
        ?: return failure("No browser tab is available")
    val expression =
        if (newTab) "window.open(${JSONObject.quote(resolved)},'_blank')"
        else "location.href=${JSONObject.quote(resolved)}"
    Chrome.evaluateJavascript(listOf(expression), target)
    return success(JSONObject().put("id", ExtensionActiveTab.idFor(target)).put("url", resolved).put("active", true).put("windowId", 0))
  }

  private fun compatibilityApi(
      extensionId: String,
      api: String,
      request: JSONObject,
      currentTab: Any?,
      frameId: String?,
  ): JSONObject? {
    val args = request.optJSONArray("args") ?: JSONArray()
    return when (api) {
      "scripting.registerContentScripts" ->
          ExtensionDynamicScripts.register(extensionId, args.optJSONArray(0) ?: JSONArray())
      "scripting.unregisterContentScripts" ->
          ExtensionDynamicScripts.unregister(extensionId, args.optJSONObject(0))
      "scripting.getRegisteredContentScripts" ->
          ExtensionDynamicScripts.get(extensionId, args.optJSONObject(0))
      "scripting.executeScript" ->
          ExtensionScriptingCompat.executeScript(extensionId, args.optJSONObject(0), currentTab)
      "scripting.insertCSS" ->
          ExtensionScriptingCompat.insertCss(extensionId, args.optJSONObject(0), currentTab)
      "scripting.removeCSS" ->
          ExtensionScriptingCompat.removeCss(extensionId, args.optJSONObject(0), currentTab)
      "tabs.query" -> {
        val array = JSONArray()
        if (activeTabMatches(args.optJSONObject(0))) array.put(ExtensionActiveTab.snapshot(currentTab))
        success(array)
      }
      "tabs.getCurrent" -> success(ExtensionActiveTab.snapshot(currentTab))
      "tabs.get" -> {
        val id = args.optString(0)
        val tab = ExtensionActiveTab.snapshot(currentTab)
        if (id == tab.optString("id")) success(tab) else success(JSONObject.NULL)
      }
      "tabs.create" -> openUrl(args.optJSONObject(0)?.optString("url", "about:blank") ?: "about:blank", currentTab, true)
      "tabs.update" -> {
        val firstObject = args.optJSONObject(0)
        val props = firstObject ?: args.optJSONObject(1) ?: JSONObject()
        val id = if (firstObject == null) args.optString(0) else ""
        val target = if (id.isBlank()) ExtensionActiveTab.preferred(currentTab) else ExtensionActiveTab.resolve(id)
        if (target == null) failure("Target tab is not available")
        else if (props.has("url")) openUrl(props.optString("url"), target, false)
        else success(ExtensionActiveTab.snapshot(target))
      }
      "tabs.reload" -> {
        val id = args.optString(0)
        val target = if (id.isBlank()) ExtensionActiveTab.preferred(currentTab) else ExtensionActiveTab.resolve(id)
        if (target == null) failure("Target tab is not available")
        else {
          Chrome.evaluateJavascript(listOf("location.reload()"), target)
          success()
        }
      }
      "tabs.remove" -> {
        val id = args.optString(0)
        val target = if (id.isBlank()) ExtensionActiveTab.preferred(currentTab) else ExtensionActiveTab.resolve(id)
        if (target == null) failure("Target tab is not available")
        else {
          Chrome.evaluateJavascript(listOf("window.close()"), target)
          success()
        }
      }
      "runtime.openOptionsPage" -> {
        val options = extensionInfo(extensionId)?.optString("optionsUrl").orEmpty()
        if (options.isBlank()) failure("Extension does not declare an options page")
        else openUrl(options, currentTab, true)
      }
      "notifications.clear" -> ExtensionNativeCompat.clearNotification(args.optString(0))
      "cookies.getAll" -> ExtensionNativeCompat.getAllCookies(args.optJSONObject(0))
      "cookies.set" -> ExtensionNativeCompat.setCookie(args.optJSONObject(0))
      "cookies.remove" -> ExtensionNativeCompat.removeCookie(args.optJSONObject(0))
      else -> null
    }
  }

  fun api(payload: String, currentTab: Any?, frameId: String?): String {
    val request = JSONObject(payload)
    val extensionId = request.optString("extensionId")
    val requestId = request.optString("requestId")
    val context = request.optJSONObject("context")
    val contextType = context?.optString("type")
    val isPrivilegedContext = contextType == "background" || contextType == "extension_page"
    if (contextType == "extension_page" && extensionId.isNotBlank()) {
      rememberExtensionPage(extensionId, currentTab, frameId)
    }
    val url = context?.optString("url")?.takeIf { it.isNotBlank() } ?: Chrome.getUrl(currentTab)
    val api = request.optString("api")
    val permissions = requiredPermissions(api)
    val result =
        if (extensionId.isBlank() || requestId.isBlank()) {
          failure("Invalid extension request")
        } else if (!isPrivilegedContext && !LocalFiles.allowedOnUrl(extensionId, url)) {
          failure("Extension has no access to this page")
        } else if (api == "permissions.request") {
          failure("Optional permissions must be granted from the ChromeXt manager")
        } else if (permissions != null && !hasAnyPermission(extensionId, permissions)) {
          failure("Missing WebExtension permission: ${permissions.joinToString(" or ")}")
        } else if (
            api == "runtime.sendMessage" ||
                api == "tabs.sendMessage" ||
                api == "runtime.sendMessageResponse") {
          messageResult(request, currentTab, frameId)
        } else {
          compatibilityApi(extensionId, api, request, currentTab, frameId)
              ?: LocalFiles.api(extensionId, request, currentTab, frameId)
        }
    result.put("extensionId", extensionId).put("requestId", requestId)
    return "Symbol.${Local.name}.unlock(${Local.key}).post('cx_extension_response', ${result});"
  }
}
