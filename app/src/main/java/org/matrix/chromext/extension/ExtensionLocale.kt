package org.matrix.chromext.extension

import java.io.File
import java.io.FileReader
import org.json.JSONObject
import org.matrix.chromext.Chrome

/** Resolves simple __MSG_key__ manifest strings for ChromeXt-owned extension UI. */
object ExtensionLocale {
  private val messageToken = Regex("^__MSG_([A-Za-z0-9_@-]+)__$")
  private val safeLocale = Regex("^[A-Za-z0-9_-]+$")

  fun resolve(id: String, manifest: JSONObject, value: String): String {
    val key = messageToken.matchEntire(value.trim())?.groupValues?.getOrNull(1) ?: return value
    val locale = manifest.optString("default_locale").trim()
    if (!safeLocale.matches(locale)) return value
    val root = File(Chrome.getContext().getExternalFilesDir(null), "Extension/$id").canonicalFile
    val messages = File(root, "_locales/$locale/messages.json").canonicalFile
    if (!messages.path.startsWith(root.path + File.separator) || !messages.isFile) return value
    return runCatching {
          val json = JSONObject(FileReader(messages).use { it.readText() })
          val entry = json.optJSONObject(key) ?: return@runCatching value
          entry.optString("message").takeIf { it.isNotBlank() } ?: value
        }
        .getOrDefault(value)
  }
}
