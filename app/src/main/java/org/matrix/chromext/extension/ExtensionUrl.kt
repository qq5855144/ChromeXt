package org.matrix.chromext.extension

import android.content.Context
import android.util.Base64
import java.net.URI
import java.security.MessageDigest
import org.json.JSONObject
import org.matrix.chromext.Chrome
import org.matrix.chromext.utils.Log

/** Resolves standard chrome-extension:// URLs onto ChromeXt's loopback extension resource host. */
object ExtensionUrl {
  private const val PREFIX = "chrome-extension://"
  private val extensionId = Regex("^[a-p]{32}$", RegexOption.IGNORE_CASE)
  private val aliases by lazy {
    Chrome.getContext().getSharedPreferences("ChromeXtExtensionAliases", Context.MODE_PRIVATE)
  }

  fun registerAlias(alias: String?, internalId: String?) {
    val normalizedAlias = alias?.trim()?.lowercase().orEmpty()
    val normalizedInternal = internalId?.trim()?.lowercase().orEmpty()
    if (!extensionId.matches(normalizedAlias) || !extensionId.matches(normalizedInternal)) return
    aliases.edit().putString("alias:$normalizedAlias", normalizedInternal).apply()
  }

  fun resolve(url: String): String? {
    if (!url.startsWith(PREFIX, ignoreCase = true)) return null
    val uri = runCatching { URI(url) }.getOrNull() ?: return null
    val requestedId = uri.host?.lowercase()?.takeIf { extensionId.matches(it) } ?: return null
    val path = (uri.rawPath ?: "/").trimStart('/')
    val savedAlias = aliases.getString("alias:$requestedId", null)?.lowercase()
    val manifests = LocalFiles.managementList()

    var target: JSONObject? = null
    for (i in 0 until manifests.length()) {
      val candidate = manifests.optJSONObject(i) ?: continue
      if (!candidate.optBoolean("enabled")) continue
      val internalId = candidate.optString("id").lowercase()
      if (
          requestedId == internalId ||
              savedAlias == internalId ||
              manifestDerivedId(candidate) == requestedId) {
        target = candidate
        if (requestedId != internalId) registerAlias(requestedId, internalId)
        break
      }
    }

    // Older ChromeXt builds generated a package-content id instead of preserving the CRX id. If an
    // existing install opens its own declared popup/options URL, use that unique declaration to
    // recover the original id once and remember the alias for all later extension resources.
    if (target == null) {
      val declaredMatches = mutableListOf<JSONObject>()
      for (i in 0 until manifests.length()) {
        val candidate = manifests.optJSONObject(i) ?: continue
        if (!candidate.optBoolean("enabled")) continue
        if (declaresPage(candidate, path)) declaredMatches.add(candidate)
      }
      if (declaredMatches.size == 1) {
        target = declaredMatches.first()
        registerAlias(requestedId, target.optString("id"))
        Log.i("Recovered extension id alias $requestedId -> ${target.optString("id")}")
      }
    }

    val extension = target ?: return null
    val baseUrl = extension.optString("baseUrl")
    if (baseUrl.isBlank()) return null
    return buildString {
      append(baseUrl)
      append(path)
      uri.rawQuery?.let { append('?').append(it) }
      uri.rawFragment?.let { append('#').append(it) }
    }
  }

  private fun manifestDerivedId(manifest: JSONObject): String? {
    val key = manifest.optString("key").trim()
    if (key.isBlank()) return null
    val bytes = runCatching { Base64.decode(key, Base64.DEFAULT) }.getOrNull() ?: return null
    if (bytes.isEmpty()) return null
    return digestToExtensionId(MessageDigest.getInstance("SHA-256").digest(bytes))
  }

  private fun digestToExtensionId(hash: ByteArray): String {
    if (hash.size < 16) return ""
    val out = StringBuilder(32)
    for (i in 0 until 16) {
      val value = hash[i].toInt() and 0xff
      out.append(('a'.code + (value shr 4)).toChar())
      out.append(('a'.code + (value and 0x0f)).toChar())
    }
    return out.toString()
  }

  private fun declaresPage(manifest: JSONObject, requestedPath: String): Boolean {
    val path = requestedPath.trimStart('/')
    if (path.isBlank()) return false
    val declared = mutableSetOf<String>()
    manifest.optString("options_page").takeIf { it.isNotBlank() }?.let { declared.add(it) }
    manifest.optJSONObject("options_ui")?.optString("page")?.takeIf { it.isNotBlank() }?.let {
      declared.add(it)
    }
    listOf("action", "browser_action", "page_action").forEach { key ->
      manifest.optJSONObject(key)?.optString("default_popup")?.takeIf { it.isNotBlank() }?.let {
        declared.add(it)
      }
    }
    manifest.optString("devtools_page").takeIf { it.isNotBlank() }?.let { declared.add(it) }
    manifest.optJSONObject("side_panel")?.optString("default_path")?.takeIf { it.isNotBlank() }?.let {
      declared.add(it)
    }
    return declared.any { it.substringBefore('?').substringBefore('#').trimStart('/') == path }
  }
}
