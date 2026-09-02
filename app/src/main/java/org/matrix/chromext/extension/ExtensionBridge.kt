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

  fun api(payload: String, currentTab: Any?, frameId: String?): String {
    val request = JSONObject(payload)
    val extensionId = request.optString("extensionId")
    val requestId = request.optString("requestId")
    val context = request.optJSONObject("context")
    val isBackground = context?.optString("type") == "background"
    val url = Chrome.getUrl(currentTab)
    val result =
        if (extensionId.isBlank() || requestId.isBlank()) {
          JSONObject().put("ok", false).put("error", "Invalid extension request")
        } else if (!isBackground && !LocalFiles.allowedOnUrl(extensionId, url)) {
          JSONObject().put("ok", false).put("error", "Extension has no access to this page")
        } else {
          LocalFiles.api(extensionId, request, currentTab, frameId)
        }
    result.put("extensionId", extensionId).put("requestId", requestId)
    return "Symbol.${Local.name}.unlock(${Local.key}).post('cx_extension_response', ${result});"
  }
}
