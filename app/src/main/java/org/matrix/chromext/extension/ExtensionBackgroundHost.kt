package org.matrix.chromext.extension

import java.io.File
import java.io.FileReader
import java.lang.ref.WeakReference
import java.util.concurrent.ConcurrentHashMap
import org.json.JSONObject
import org.matrix.chromext.Chrome
import org.matrix.chromext.script.Local
import org.matrix.chromext.utils.Log

/**
 * Event-driven compatibility host for extension background code.
 *
 * Background/service-worker code is never started from normal navigation and never discovers
 * DevTools pages. It is lazily attached to an already available browser tab only when an extension
 * event actually needs a background context. The host can migrate when the previous tab disappears.
 */
object ExtensionBackgroundHost {
  data class PreparedHost(val tab: Any, val bootstrap: String?)

  private data class Host(val tab: WeakReference<Any>, val url: String)

  private val hosts = ConcurrentHashMap<String, Host>()

  fun prepare(id: String, preferredTab: Any? = null): PreparedHost? {
    val manifest = manifest(id) ?: return null
    val background = manifest.optJSONObject("background") ?: return null
    val directory = File(Chrome.getContext().getExternalFilesDir(null), "Extension/$id")
    val code = backgroundCode(directory, manifest, background)
    if (code.isBlank()) return null

    val preferred = Chrome.getTab(preferredTab) ?: return null
    val previous = hosts[id]
    val previousTab = previous?.tab?.get()
    val previousAlive =
        previousTab != null && runCatching { Chrome.checkTab(previousTab) }.getOrDefault(false)
    val target = if (previousAlive) previousTab!! else preferred
    val targetUrl = Chrome.getUrl(target) ?: Chrome.getUrl(preferred) ?: "about:blank"
    val needsBootstrap = !previousAlive || previous?.url != targetUrl

    hosts[id] = Host(WeakReference(target), targetUrl)
    return PreparedHost(target, if (needsBootstrap) buildRuntime(manifest, code, targetUrl) else null)
  }

  fun release(id: String) {
    hosts.remove(id)
  }

  private fun manifest(id: String): JSONObject? {
    val manifests = LocalFiles.managementList()
    for (i in 0 until manifests.length()) {
      val candidate = manifests.optJSONObject(i) ?: continue
      if (candidate.optString("id") == id && candidate.optBoolean("enabled")) return candidate
    }
    return null
  }

  private fun backgroundCode(directory: File, manifest: JSONObject, background: JSONObject): String {
    val scripts = mutableListOf<String>()
    val array = background.optJSONArray("scripts")
    if (array != null) {
      for (i in 0 until array.length()) addFile(directory, manifest, array.optString(i), scripts)
    }
    val worker = background.optString("service_worker")
    if (worker.isNotBlank()) addFile(directory, manifest, worker, scripts)
    val page = background.optString("page")
    if (page.isNotBlank()) {
      val html = safeFile(directory, page)?.let { FileReader(it).use { reader -> reader.readText() } }
      if (html != null) {
        Regex("<script[^>]+src=[\\\"']([^\\\"']+)[\\\"'][^>]*></script>", RegexOption.IGNORE_CASE)
            .findAll(html)
            .forEach { addFile(directory, manifest, it.groupValues[1], scripts) }
        Regex("<script(?![^>]+src=)[^>]*>([\\s\\S]*?)</script>", RegexOption.IGNORE_CASE)
            .findAll(html)
            .forEach { match ->
              if (match.groupValues[1].isNotBlank()) scripts.add(match.groupValues[1])
            }
      }
    }
    return scripts.joinToString("\n")
  }

  private fun addFile(
      directory: File,
      manifest: JSONObject,
      path: String,
      scripts: MutableList<String>,
  ) {
    if (path.isBlank()) return
    val file = safeFile(directory, path) ?: return
    runCatching {
          scripts.add(
              FileReader(file).use { it.readText() } +
                  "\n//# sourceURL=chromext-extension://${manifest.optString("id")}/${path}")
        }
        .onFailure { Log.e("Failed to load extension background resource $path: ${it.message}") }
  }

  private fun safeFile(directory: File, path: String): File? {
    val root = directory.canonicalFile
    val file = File(root, path.trimStart('/')).canonicalFile
    if (!file.path.startsWith(root.path + File.separator) || !file.isFile) return null
    return file
  }

  private fun buildRuntime(manifest: JSONObject, code: String, url: String): String {
    val id = manifest.optString("id")
    val context =
        JSONObject()
            .put("type", "background")
            .put("url", url)
            .put("frameId", JSONObject.NULL)
            .put("extensionId", id)
            .put("contextId", "background:$id")
    return """
      (()=>{
        if(!globalThis.__cxExtensionBackgrounds) globalThis.__cxExtensionBackgrounds=new Set();
        if(globalThis.__cxExtensionBackgrounds.has(${JSONObject.quote(id)})) return;
        globalThis.__cxExtensionBackgrounds.add(${JSONObject.quote(id)});
        const __cxExtension=${manifest};
        const __cxContext=${context};
        const __cxNative=Symbol.${Local.name}.unlock(${Local.key});
        ${LocalFiles.script}
        const chrome=__cxCreateExtensionApi(__cxExtension,__cxContext,__cxNative);
        const browser=chrome;
        ${ExtensionCompat.script}
        try { ${code} } catch(error) { console.error('[ChromeXt Extension background ${id}]', error); }
      })();
      //# sourceURL=local://ChromeXt/extension/${id}/background-host
    """.trimIndent()
  }
}
