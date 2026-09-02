package org.matrix.chromext.extension

import java.io.File
import java.io.FileReader
import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject
import org.matrix.chromext.Chrome
import org.matrix.chromext.devtools.DevSessions
import org.matrix.chromext.utils.Log

/** Additional chrome.scripting compatibility operations that require reversible CSS injection. */
object ExtensionScriptingCompat {
  fun insertCss(extensionId: String, details: JSONObject?, currentTab: Any?): JSONObject {
    val css = cssText(extensionId, details) ?: return failure("insertCSS requires css or files")
    val key = cssKey(extensionId, css)
    val expression =
        "(()=>{const old=document.querySelectorAll('style[data-chromext-insert-css=${JSONObject.quote(key)}]');old.forEach(n=>n.remove());const s=document.createElement('style');s.setAttribute('data-chromext-insert-css',${JSONObject.quote(key)});s.textContent=${JSONObject.quote(css)};(document.head||document.documentElement).appendChild(s);})()"
    return evaluate(details, currentTab, expression)
  }

  fun removeCss(extensionId: String, details: JSONObject?, currentTab: Any?): JSONObject {
    val css = cssText(extensionId, details) ?: return failure("removeCSS requires css or files")
    val key = cssKey(extensionId, css)
    val expression =
        "(()=>{document.querySelectorAll('style[data-chromext-insert-css=${JSONObject.quote(key)}]').forEach(n=>n.remove());})()"
    return evaluate(details, currentTab, expression)
  }

  private fun evaluate(details: JSONObject?, currentTab: Any?, expression: String): JSONObject {
    if (details == null) return failure("Missing CSS injection details")
    val target = details.optJSONObject("target")
    val tabId = target?.optString("tabId")?.takeIf { it.isNotBlank() }
    return runCatching {
          if (tabId != null) {
            val remembered = ExtensionActiveTab.resolve(tabId)
            if (remembered != null) {
              Chrome.evaluateJavascript(listOf(expression), remembered)
            } else {
              val client = DevSessions.new(tabId, "extension-css")
              client.evaluateJavascript(expression)
              client.close()
            }
          } else {
            Chrome.evaluateJavascript(listOf(expression), ExtensionActiveTab.preferred(currentTab))
          }
          success(JSONObject.NULL)
        }
        .getOrElse {
          Log.e("Extension CSS injection failed: ${it.message}")
          failure(it.message ?: "CSS injection failed")
        }
  }

  private fun cssText(extensionId: String, details: JSONObject?): String? {
    if (details == null) return null
    val inline = details.optString("css")
    if (inline.isNotBlank()) return inline
    val files = strings(details.optJSONArray("files"))
    if (files.isEmpty()) return null
    val root =
        File(Chrome.getContext().getExternalFilesDir(null), "Extension/$extensionId").canonicalFile
    val parts = mutableListOf<String>()
    for (path in files) {
      val file = File(root, path.trimStart('/')).canonicalFile
      if (!file.path.startsWith(root.path + File.separator) || !file.isFile) return null
      val text = runCatching { FileReader(file).use { it.readText() } }.getOrNull() ?: return null
      parts.add(text)
    }
    return parts.joinToString("\n")
  }

  private fun cssKey(extensionId: String, css: String): String {
    val digest =
        MessageDigest.getInstance("SHA-256")
            .digest((extensionId + "\u0000" + css).toByteArray(Charsets.UTF_8))
    return digest.take(12).joinToString("") { "%02x".format(it.toInt() and 0xff) }
  }

  private fun strings(array: JSONArray?): List<String> {
    if (array == null) return emptyList()
    val result = mutableListOf<String>()
    for (i in 0 until array.length()) {
      val value = array.optString(i)
      if (value.isNotBlank()) result.add(value)
    }
    return result
  }

  private fun success(value: Any?): JSONObject =
      JSONObject().put("ok", true).put("value", value ?: JSONObject.NULL)

  private fun failure(message: String): JSONObject =
      JSONObject().put("ok", false).put("error", message)
}
