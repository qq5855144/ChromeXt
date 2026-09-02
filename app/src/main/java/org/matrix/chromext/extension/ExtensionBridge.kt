package org.matrix.chromext.extension

import org.json.JSONObject
import org.matrix.chromext.Chrome
import org.matrix.chromext.script.Local

object ExtensionBridge {
  private fun managerEvent(name: String, detail: Any): String =
      "ChromeXt.post('$name', ${JSONObject.valueToString(detail)});"

  fun manager(payload: String): String {
    if (payload.isBlank()) return managerEvent("extension_list", LocalFiles.managementList())
    val data = JSONObject(payload)
    return when (data.optString("op")) {
      "list" -> managerEvent("extension_list", LocalFiles.managementList())
      "setEnabled" -> {
        val changed = LocalFiles.setEnabled(data.getString("id"), data.getBoolean("enabled"))
        managerEvent(
            "extension_changed",
            JSONObject().put("ok", changed).put("type", "enabled").put("id", data.getString("id")))
      }
      "delete" -> {
        val changed = LocalFiles.delete(data.getString("id"))
        managerEvent(
            "extension_changed",
            JSONObject().put("ok", changed).put("type", "delete").put("id", data.getString("id")))
      }
      "installStart" ->
          managerEvent(
              "extension_install",
              LocalFiles.beginInstall(data.getString("token"), data.optString("name", "extension.zip")))
      "installChunk" ->
          managerEvent(
              "extension_install_progress",
              LocalFiles.appendInstall(data.getString("token"), data.getString("data")))
      "installFinish" ->
          managerEvent("extension_install", LocalFiles.finishInstall(data.getString("token")))
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
    val isBackground = context?.optString("type") == "background" || context?.optString("type") == "extension_page"
    val url = Chrome.getUrl(currentTab)
    val api = request.optString("api")
    val result =
        if (extensionId.isBlank() || requestId.isBlank()) {
          JSONObject().put("ok", false).put("error", "Invalid extension request")
        } else if (!isBackground && !LocalFiles.allowedOnUrl(extensionId, url)) {
          JSONObject().put("ok", false).put("error", "Extension has no access to this page")
        } else if (api == "runtime.sendMessage" || api == "tabs.sendMessage" || api == "runtime.sendMessageResponse") {
          messageResult(request, currentTab, frameId)
        } else {
          LocalFiles.api(extensionId, request, currentTab, frameId)
        }
    result.put("extensionId", extensionId).put("requestId", requestId)
    return "Symbol.${Local.name}.unlock(${Local.key}).post('cx_extension_response', ${result});"
  }
}
