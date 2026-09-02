package org.matrix.chromext.extension

import java.net.URI
import org.json.JSONArray
import org.json.JSONObject

/** Applies Manifest content_script run_at semantics to generated extension runtimes. */
object ExtensionRunAt {
  fun schedule(codes: List<String>, url: String, frameId: String?): List<String> =
      codes.map { code ->
        if (code.contains("/background")) return@map code
        val manifest = extractManifest(code) ?: return@map code
        val block = findBlock(manifest, code, url, frameId) ?: return@map code
        when (block.optString("run_at", "document_idle")) {
          "document_start" -> code
          "document_end" ->
              wrap(
                  code,
                  "if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',__cxRun,{once:true});}else{__cxRun();}")
          else ->
              wrap(
                  code,
                  "if(document.readyState==='complete'){setTimeout(__cxRun,0);}else{window.addEventListener('load',()=>setTimeout(__cxRun,0),{once:true});}")
        }
      }

  private fun wrap(code: String, scheduler: String): String =
      """
      (()=>{
        let __cxDone=false;
        const __cxRun=()=>{if(__cxDone)return;__cxDone=true;${code}};
        ${scheduler}
      })();
      """.trimIndent()

  private fun extractManifest(code: String): JSONObject? {
    val startMarker = "const __cxExtension="
    val endMarker = ";\n        const __cxContext="
    val start = code.indexOf(startMarker)
    if (start < 0) return null
    val jsonStart = start + startMarker.length
    val end = code.indexOf(endMarker, jsonStart)
    if (end < 0) return null
    return runCatching { JSONObject(code.substring(jsonStart, end)) }.getOrNull()
  }

  private fun findBlock(
      manifest: JSONObject,
      code: String,
      url: String,
      frameId: String?,
  ): JSONObject? {
    val scripts = manifest.optJSONArray("content_scripts") ?: return null
    var fallback: JSONObject? = null
    for (i in 0 until scripts.length()) {
      val block = scripts.optJSONObject(i) ?: continue
      if (!contentBlockMatches(block, url, frameId)) continue
      if (fallback == null) fallback = block
      val files = strings(block.optJSONArray("js"))
      if (files.isNotEmpty() && files.any { code.contains("/${it}") }) return block
      if (files.isEmpty() && strings(block.optJSONArray("css")).isNotEmpty()) {
        // CSS-only blocks cannot be identified by sourceURL, so the first matching CSS-only block is safe.
        return block
      }
    }
    return fallback
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

  private fun contentBlockMatches(block: JSONObject, url: String, frameId: String?): Boolean {
    if (frameId != null && !block.optBoolean("all_frames", false)) return false
    val includes = strings(block.optJSONArray("matches"))
    if (includes.isEmpty() || includes.none { matchesPattern(it, url) }) return false
    return strings(block.optJSONArray("exclude_matches")).none { matchesPattern(it, url) }
  }

  private fun matchesPattern(pattern: String, url: String): Boolean {
    if (pattern == "<all_urls>")
        return url.startsWith("http://") || url.startsWith("https://") || url.startsWith("file://")
    return runCatching {
          val uri = URI(url)
          val separator = pattern.indexOf("://")
          if (separator <= 0) return@runCatching glob(pattern).matches(url)
          val schemePattern = pattern.substring(0, separator)
          val rest = pattern.substring(separator + 3)
          val slash = rest.indexOf('/')
          val hostPattern = if (slash < 0) rest else rest.substring(0, slash)
          val pathPattern = if (slash < 0) "/*" else rest.substring(slash)
          val scheme = uri.scheme ?: return@runCatching false
          val host = uri.host ?: ""
          val path = (uri.rawPath ?: "/") + if (uri.rawQuery == null) "" else "?${uri.rawQuery}"
          val schemeOk =
              (schemePattern == "*" && (scheme == "http" || scheme == "https")) ||
                  schemePattern.equals(scheme, true)
          val hostOk =
              hostPattern == "*" ||
                  hostPattern.equals(host, true) ||
                  (hostPattern.startsWith("*.") &&
                      (host.equals(hostPattern.substring(2), true) ||
                          host.endsWith("." + hostPattern.substring(2), true)))
          schemeOk && hostOk && glob(pathPattern).matches(path)
        }
        .getOrDefault(false)
  }

  private fun glob(value: String): Regex {
    val regex = StringBuilder("^")
    value.forEach {
      when (it) {
        '*' -> regex.append(".*")
        '?' -> regex.append('.')
        '.', '(', ')', '[', ']', '{', '}', '+', '^', '$', '|', '\\' -> regex.append('\\').append(it)
        else -> regex.append(it)
      }
    }
    regex.append('$')
    return Regex(regex.toString(), RegexOption.IGNORE_CASE)
  }
}
