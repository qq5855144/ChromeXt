package org.matrix.chromext.extension

import android.content.Context
import java.io.File
import java.io.FileReader
import java.net.URI
import java.util.concurrent.ConcurrentHashMap
import org.json.JSONArray
import org.json.JSONObject
import org.matrix.chromext.Chrome
import org.matrix.chromext.script.Local
import org.matrix.chromext.utils.Log

/** MV3 dynamic content-script registry used by chrome.scripting.registerContentScripts. */
object ExtensionDynamicScripts {
  private val registries = ConcurrentHashMap<String, MutableMap<String, JSONObject>>()
  private val state by lazy {
    Chrome.getContext().getSharedPreferences("ChromeXtExtensions", Context.MODE_PRIVATE)
  }

  fun register(extensionId: String, scripts: JSONArray): JSONObject {
    val manifest = manifest(extensionId) ?: return failure("Unknown extension")
    val registry = registry(extensionId)
    val additions = mutableListOf<JSONObject>()
    for (i in 0 until scripts.length()) {
      val raw = scripts.optJSONObject(i) ?: return failure("Invalid content script at index $i")
      val normalized = normalize(extensionId, raw) ?: return failure("Invalid dynamic content script at index $i")
      val id = normalized.getString("id")
      if (registry.containsKey(id) || additions.any { it.optString("id") == id }) {
        return failure("A content script with id '$id' is already registered")
      }
      if (!patternsArePermitted(extensionId, manifest, normalized.optJSONArray("matches"))) {
        return failure("Dynamic content script '$id' requests an origin that is not permitted")
      }
      additions.add(normalized)
    }
    additions.forEach { registry[it.getString("id")] = it }
    persist(extensionId, registry)
    return success(JSONObject.NULL)
  }

  fun unregister(extensionId: String, filter: JSONObject?): JSONObject {
    val registry = registry(extensionId)
    val ids = strings(filter?.optJSONArray("ids"))
    if (ids.isEmpty()) registry.clear() else ids.forEach { registry.remove(it) }
    persist(extensionId, registry)
    return success(JSONObject.NULL)
  }

  fun get(extensionId: String, filter: JSONObject?): JSONObject {
    val ids = strings(filter?.optJSONArray("ids")).toSet()
    val result = JSONArray()
    registry(extensionId).values.forEach {
      if (ids.isEmpty() || ids.contains(it.optString("id"))) result.put(toPublic(it))
    }
    return success(result)
  }

  fun clear(extensionId: String) {
    registries.remove(extensionId)
    state.edit().remove("dynamicScripts:$extensionId").apply()
  }

  fun hasAllFrames(url: String): Boolean {
    val manifests = LocalFiles.managementList()
    for (i in 0 until manifests.length()) {
      val manifest = manifests.optJSONObject(i) ?: continue
      if (!manifest.optBoolean("enabled")) continue
      val id = manifest.optString("id")
      if (!hasHostAccess(id, manifest, url)) continue
      if (registry(id).values.any { it.optBoolean("all_frames") && matches(it, url, null) }) return true
    }
    return false
  }

  fun bootstrap(url: String, frameId: String?): List<String> {
    val output = mutableListOf<String>()
    val manifests = LocalFiles.managementList()
    for (i in 0 until manifests.length()) {
      val manifest = manifests.optJSONObject(i) ?: continue
      if (!manifest.optBoolean("enabled")) continue
      val extensionId = manifest.optString("id")
      if (extensionId.isBlank() || !hasHostAccess(extensionId, manifest, url)) continue
      registry(extensionId).values.forEach { block ->
        if (!matches(block, url, frameId)) return@forEach
        val css = readResources(extensionId, strings(block.optJSONArray("css"))).joinToString("\n")
        val js =
            strings(block.optJSONArray("js"))
                .mapNotNull { path ->
                  safeFile(extensionId, path)?.let {
                    runCatching {
                          FileReader(it).use { reader -> reader.readText() } +
                              "\n//# sourceURL=chromext-extension://$extensionId/$path"
                        }
                        .getOrNull()
                  }
                }
                .joinToString("\n")
        if (css.isBlank() && js.isBlank()) return@forEach
        output.add(schedule(buildRuntime(manifest, block, css, js, url, frameId), block))
      }
    }
    return output
  }

  private fun registry(extensionId: String): MutableMap<String, JSONObject> =
      registries.getOrPut(extensionId) {
        val map = linkedMapOf<String, JSONObject>()
        val stored = state.getString("dynamicScripts:$extensionId", "[]") ?: "[]"
        runCatching {
              val array = JSONArray(stored)
              for (i in 0 until array.length()) {
                val item = array.optJSONObject(i) ?: continue
                val id = item.optString("id")
                if (id.isNotBlank()) map[id] = item
              }
            }
            .onFailure { Log.e("Failed to restore dynamic scripts for $extensionId: ${it.message}") }
        map
      }

  private fun persist(extensionId: String, registry: Map<String, JSONObject>) {
    val persistent = JSONArray()
    registry.values.forEach {
      if (it.optBoolean("persist_across_sessions", true)) persistent.put(it)
    }
    state.edit().putString("dynamicScripts:$extensionId", persistent.toString()).apply()
  }

  private fun manifest(extensionId: String): JSONObject? {
    val manifests = LocalFiles.managementList()
    for (i in 0 until manifests.length()) {
      val manifest = manifests.optJSONObject(i) ?: continue
      if (manifest.optString("id") == extensionId && manifest.optBoolean("enabled")) return manifest
    }
    return null
  }

  private fun normalize(extensionId: String, raw: JSONObject): JSONObject? {
    val id = raw.optString("id").trim()
    val matches = raw.optJSONArray("matches")
    if (id.isBlank() || matches == null || matches.length() == 0) return null
    val js = raw.optJSONArray("js") ?: JSONArray()
    val css = raw.optJSONArray("css") ?: JSONArray()
    if (js.length() == 0 && css.length() == 0) return null
    for (path in strings(js) + strings(css)) {
      if (safeFile(extensionId, path) == null) return null
    }
    return JSONObject()
        .put("id", id)
        .put("matches", JSONArray(strings(matches)))
        .put("exclude_matches", JSONArray(strings(raw.optJSONArray("excludeMatches"))))
        .put("js", JSONArray(strings(js)))
        .put("css", JSONArray(strings(css)))
        .put("all_frames", raw.optBoolean("allFrames", false))
        .put("run_at", raw.optString("runAt", "document_idle"))
        .put("persist_across_sessions", raw.optBoolean("persistAcrossSessions", true))
        .put("world", raw.optString("world", "ISOLATED"))
  }

  private fun toPublic(block: JSONObject): JSONObject =
      JSONObject()
          .put("id", block.optString("id"))
          .put("matches", block.optJSONArray("matches") ?: JSONArray())
          .put("excludeMatches", block.optJSONArray("exclude_matches") ?: JSONArray())
          .put("js", block.optJSONArray("js") ?: JSONArray())
          .put("css", block.optJSONArray("css") ?: JSONArray())
          .put("allFrames", block.optBoolean("all_frames"))
          .put("runAt", block.optString("run_at", "document_idle"))
          .put("persistAcrossSessions", block.optBoolean("persist_across_sessions", true))
          .put("world", block.optString("world", "ISOLATED"))

  private fun buildRuntime(
      manifest: JSONObject,
      block: JSONObject,
      css: String,
      code: String,
      url: String,
      frameId: String?,
  ): String {
    val extensionId = manifest.optString("id")
    val context =
        JSONObject()
            .put("type", "content")
            .put("url", url)
            .put("frameId", frameId ?: JSONObject.NULL)
            .put("extensionId", extensionId)
    val styleCode =
        if (css.isBlank()) ""
        else """
          (()=>{const s=document.createElement('style');s.dataset.chromextDynamic=${JSONObject.quote(block.optString("id"))};s.textContent=${JSONObject.quote(css)};(document.head||document.documentElement).appendChild(s);})();
        """.trimIndent()
    return """
      (()=>{
        const __cxExtension=${manifest};
        const __cxContext=${context};
        const __cxNative=Symbol.${Local.name}.unlock(${Local.key});
        ${LocalFiles.script}
        const chrome=__cxCreateExtensionApi(__cxExtension,__cxContext,__cxNative);
        const browser=chrome;
        ${styleCode}
        try { ${code} } catch(error) { console.error('[ChromeXt dynamic content script $extensionId]',error); }
      })();
      //# sourceURL=local://ChromeXt/extension/$extensionId/dynamic/${block.optString("id")}
    """.trimIndent()
  }

  private fun schedule(code: String, block: JSONObject): String =
      when (block.optString("run_at", "document_idle")) {
        "document_start" -> code
        "document_end" ->
            "(()=>{let d=false;const r=()=>{if(d)return;d=true;$code};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',r,{once:true});else r();})();"
        else ->
            "(()=>{let d=false;const r=()=>{if(d)return;d=true;$code};if(document.readyState==='complete')setTimeout(r,0);else window.addEventListener('load',()=>setTimeout(r,0),{once:true});})();"
      }

  private fun safeFile(extensionId: String, path: String): File? {
    if (path.isBlank()) return null
    val root =
        File(Chrome.getContext().getExternalFilesDir(null), "Extension/$extensionId").canonicalFile
    val file = File(root, path.trimStart('/')).canonicalFile
    if (!file.path.startsWith(root.path + File.separator) || !file.isFile) return null
    return file
  }

  private fun readResources(extensionId: String, paths: List<String>): List<String> =
      paths.mapNotNull { path ->
        safeFile(extensionId, path)?.let { runCatching { FileReader(it).use { r -> r.readText() } }.getOrNull() }
      }

  private fun matches(block: JSONObject, url: String, frameId: String?): Boolean {
    if (frameId != null && !block.optBoolean("all_frames", false)) return false
    val includes = strings(block.optJSONArray("matches"))
    if (includes.none { matchesPattern(it, url) }) return false
    return strings(block.optJSONArray("exclude_matches")).none { matchesPattern(it, url) }
  }

  private fun patternsArePermitted(extensionId: String, manifest: JSONObject, matches: JSONArray?): Boolean {
    val requested = strings(matches)
    if (requested.isEmpty()) return false
    val allowed = hostPermissions(extensionId, manifest)
    return requested.all { requestedPattern ->
      allowed.any { permissionPattern -> patternCovers(permissionPattern, requestedPattern) }
    }
  }

  private fun hasHostAccess(extensionId: String, manifest: JSONObject, url: String): Boolean =
      hostPermissions(extensionId, manifest).any { matchesPattern(it, url) }

  private fun hostPermissions(extensionId: String, manifest: JSONObject): Set<String> {
    val result = mutableSetOf<String>()
    result.addAll(strings(manifest.optJSONArray("host_permissions")))
    strings(manifest.optJSONArray("permissions"))
        .filterTo(result) { it == "<all_urls>" || it.contains("://") }
    val optional = state.getString("permissions:$extensionId", "[]") ?: "[]"
    runCatching { strings(JSONArray(optional)) }
        .getOrDefault(emptyList())
        .filterTo(result) { it == "<all_urls>" || it.contains("://") }
    return result
  }

  private fun patternCovers(permission: String, requested: String): Boolean {
    if (permission == "<all_urls>" || permission == requested) return true
    val sample = requested.replace("*", "chromext-test").replace("?", "x")
    return matchesPattern(permission, sample)
  }

  private fun matchesPattern(pattern: String, url: String): Boolean {
    if (pattern == "<all_urls>")
        return url.startsWith("http://") ||
            url.startsWith("https://") ||
            url.startsWith("file://") ||
            url.startsWith("ftp://")
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
        '.', '(', ')', '[', ']', '{', '}', '+', '^', '$', '|', '\\' ->
            regex.append('\\').append(it)
        else -> regex.append(it)
      }
    }
    regex.append('$')
    return Regex(regex.toString(), RegexOption.IGNORE_CASE)
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
