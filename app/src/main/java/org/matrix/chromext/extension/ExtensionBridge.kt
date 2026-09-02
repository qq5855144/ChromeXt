package org.matrix.chromext.extension

import org.json.JSONArray
import org.json.JSONObject
import org.matrix.chromext.Chrome
import org.matrix.chromext.script.Local

object ExtensionBridge {
  private fun managerEvent(name: String, detail: Any): String =
      "ChromeXt.post('$name', ${detail.toString()});"

  private fun managerApi(id: String, api: String, value: JSONObject? = null): JSONObject {
    val args = JSONArray()
    if (value != null) args.put(value)
    return LocalFiles.api(id, JSONObject().put("api", api).put("args", args), Chrome.getTab(), null)
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
      else -> managerEvent("extension_install", JSONObject().put("ok", false).put("error", "Unknown extension manager operation"))
    }
  }

  private fun messageResult(request: JSONObject, currentTab: Any?, frameId: String?): JSONObject {
    val extensionId = request.getString("extensionId")
    val api = request.optString("api")
    val args = request.optJSONArray("args")
    val messageId = request.optString("messageId", request.optString("requestId"))
    if (api == "runtime.sendMessageResponse") {
      val detail =
          JSONObject()
              .put("extensionId", extensionId)
              .put("messageId", messageId)
              .put("value", args?.opt(0) ?: JSONObject.NULL)
      Chrome.broadcast("cx_extension_message_response", detail, false) { true }
      return JSONObject().put("ok", true).put("value", JSONObject.NULL)
    }
    val message = if (api == "tabs.sendMessage") args?.opt(1) else args?.opt(0)
    val senderUrl = Chrome.getUrl(currentTab) ?: ""
    val detail =
        JSONObject()
            .put("extensionId", extensionId)
            .put("messageId", messageId)
            .put("target", if (api == "tabs.sendMessage") "content" else "extension")
            .put("senderContext", request.optJSONObject("context") ?: JSONObject())
            .put("message", message ?: JSONObject.NULL)
            .put(
                "sender",
                JSONObject()
                    .put("id", extensionId)
                    .put("url", senderUrl)
                    .put("frameId", frameId ?: JSONObject.NULL))
    Chrome.broadcast("cx_extension_message", detail, false) { true }
    return JSONObject().put("ok", true).put("value", JSONObject.NULL)
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
    val result =
        if (extensionId.isBlank() || requestId.isBlank()) {
          JSONObject().put("ok", false).put("error", "Invalid extension request")
        } else if (!isPrivilegedContext && !LocalFiles.allowedOnUrl(extensionId, url)) {
          JSONObject().put("ok", false).put("error", "Extension has no access to this page")
        } else if (api == "permissions.request") {
          JSONObject()
              .put("ok", false)
              .put("error", "Optional permissions must be granted from the ChromeXt manager")
        } else if (api == "runtime.sendMessage" || api == "tabs.sendMessage" || api == "runtime.sendMessageResponse") {
          messageResult(request, currentTab, frameId)
        } else {
          LocalFiles.api(extensionId, request, currentTab, frameId)
        }
    result.put("extensionId", extensionId).put("requestId", requestId)
    return "Symbol.${Local.name}.unlock(${Local.key}).post('cx_extension_response', ${result});"
  }
}
