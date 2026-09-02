package org.matrix.chromext.extension

import org.json.JSONArray
import org.json.JSONObject
import org.matrix.chromext.Chrome
import org.matrix.chromext.devtools.DevSessions
import org.matrix.chromext.script.Local
import org.matrix.chromext.utils.Log

object ExtensionBridge {
  private fun managerEvent(name: String, detail: Any): String =
      "ChromeXt.post('$name', ${detail.toString()});"

  private fun managerApi(id: String, api: String, value: JSONObject? = null): JSONObject {
    val args = JSONArray()
    if (value != null) args.put(value)
    return LocalFiles.api(id, JSONObject().put("api", api).put("args", args), Chrome.getTab(), null)
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

  fun manager(payload: String): String {
    if (payload.isBlank()) return managerEvent("extension_list", LocalFiles.managementList())
    val data = JSONObject(payload)
    return when (data.optString("op")) {
      "list" -> managerEvent("extension_list", LocalFiles.managementList())
      "setEnabled" -> {
        val id = data.getString("id")
        val enabled = data.getBoolean("enabled")
        val changed = LocalFiles.setEnabled(id, enabled)
        if (changed && !enabled) ExtensionBackgroundHost.release(id)
        managerEvent(
            "extension_changed",
            JSONObject().put("ok", changed).put("type", "enabled").put("id", id))
      }
      "delete" -> {
        val id = data.getString("id")
        ExtensionBackgroundHost.release(id)
        ExtensionDynamicScripts.clear(id)
        val changed = LocalFiles.delete(id)
        managerEvent(
            "extension_changed",
            JSONObject().put("ok", changed).put("type", "delete").put("id", id))
      }
      "installStart" ->
          managerEvent(
              "extension_install_started",
              LocalFiles.beginInstall(data.getString("token"), data.optString("name", "extension.zip")))
      "installChunk" ->
          managerEvent(
              "extension_install_progress",
              LocalFiles.appendInstall(data.getString("token"), data.getString("data")))
      "installFinish" ->
          managerEvent("extension_install", LocalFiles.finishInstall(data.getString("token")))
      "folderStart" ->
          managerEvent("extension_install_started", UnpackedExtensionInstaller.begin(data.getString("token")))
      "folderChunk" ->
          managerEvent(
              "extension_install_progress",
              UnpackedExtensionInstaller.append(
                  data.getString("token"), data.getString("path"), data.getString("data")))
      "folderFinish" ->
          managerEvent(
              "extension_install",
              UnpackedExtensionInstaller.finish(data.getString("token"), data.optString("name")))
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

  private fun sender(extensionId: String, currentTab: Any?, frameId: String?): JSONObject {
    val url = Chrome.getUrl(currentTab) ?: ""
    val tabId = runCatching { Chrome.getTabId(currentTab, url) }.getOrDefault("")
    return JSONObject()
        .put("id", extensionId)
        .put("url", url)
        .put("frameId", frameId ?: JSONObject.NULL)
        .put(
            "tab",
            JSONObject()
                .put("id", tabId)
                .put("url", url)
                .put("active", currentTab == Chrome.getTab()))
  }

  private fun deliverToTab(tabId: String, event: String, detail: JSONObject): Boolean {
    if (tabId.isBlank()) return false
    return runCatching {
          val code =
              "Symbol.${Local.name}.unlock(${Local.key}).post(${JSONObject.quote(event)},${detail});"
          val client = DevSessions.new(tabId, "extension-message")
          client.evaluateJavascript(code)
          client.close()
          true
        }
        .getOrElse {
          Log.e("Failed to deliver extension message to tab $tabId: ${it.message}")
          false
        }
  }

  private fun messageResult(request: JSONObject, currentTab: Any?, frameId: String?): JSONObject {
    val extensionId = request.getString("extensionId")
    val api = request.optString("api")
    val args = request.optJSONArray("args") ?: JSONArray()
    val messageId = request.optString("messageId", request.optString("requestId"))
    if (api == "runtime.sendMessageResponse") {
      val detail =
          JSONObject()
              .put("extensionId", extensionId)
              .put("messageId", messageId)
              .put("value", args.opt(0) ?: JSONObject.NULL)
      Chrome.broadcast("cx_extension_message_response", detail, false) { true }
      return JSONObject().put("ok", true).put("value", JSONObject.NULL)
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
            .put("sender", sender(extensionId, currentTab, frameId))

    if (isTabMessage) {
      val targetTabId = args.optString(0)
      if (!deliverToTab(targetTabId, "cx_extension_message", detail)) {
        return JSONObject().put("ok", false).put("error", "Target tab is not available")
      }
    } else {
      Chrome.broadcast("cx_extension_message", detail, false) { true }
    }
    return JSONObject().put("ok", true).put("value", JSONObject.NULL)
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
      "scripting.insertCSS" ->
          ExtensionScriptingCompat.insertCss(args.optJSONObject(0), currentTab)
      "scripting.removeCSS" ->
          ExtensionScriptingCompat.removeCss(args.optJSONObject(0), currentTab)
      "notifications.clear" -> ExtensionNativeCompat.clearNotification(args.optString(0))
      "cookies.getAll" -> ExtensionNativeCompat.getAllCookies(args.optJSONObject(0))
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
    val url = Chrome.getUrl(currentTab)
    val api = request.optString("api")
    val permissions = requiredPermissions(api)
    val result =
        if (extensionId.isBlank() || requestId.isBlank()) {
          JSONObject().put("ok", false).put("error", "Invalid extension request")
        } else if (!isPrivilegedContext && !LocalFiles.allowedOnUrl(extensionId, url)) {
          JSONObject().put("ok", false).put("error", "Extension has no access to this page")
        } else if (api == "permissions.request") {
          JSONObject()
              .put("ok", false)
              .put("error", "Optional permissions must be granted from the ChromeXt manager")
        } else if (permissions != null && !hasAnyPermission(extensionId, permissions)) {
          JSONObject()
              .put("ok", false)
              .put(
                  "error",
                  "Missing WebExtension permission: ${permissions.joinToString(" or ")}")
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
