package org.matrix.chromext.extension

import java.io.File
import java.io.FileReader
import java.util.concurrent.ConcurrentHashMap
import org.json.JSONObject
import org.matrix.chromext.Chrome
import org.matrix.chromext.devtools.getInspectPages
import org.matrix.chromext.script.Local
import org.matrix.chromext.utils.Log

/**
 * Keeps one background/service-worker compatibility context active for each enabled extension.
 * The context is hosted inside one top-level browser page and migrates when that tab disappears.
 */
object ExtensionBackgroundHost {
  private val hosts = ConcurrentHashMap<String, String>()

  fun bootstrap(url: String): List<String> {
    val currentHost = currentTabId(url)
    cleanupHosts()
    val directory = File(Chrome.getContext().getExternalFilesDir(null), "Extension")
    val result = mutableListOf<String>()
    val manifests = LocalFiles.managementList()
    for (i in 0 until manifests.length()) {
      val manifest = manifests.optJSONObject(i) ?: continue
      if (!manifest.optBoolean("enabled")) continue
      val background = manifest.optJSONObject("background") ?: continue
      val id = manifest.optString("id")
      if (id.isBlank()) continue
      val existing = hosts[id]
      if (existing != null && existing != currentHost) continue
      val code = backgroundCode(File(directory, id), manifest, background)
      if (code.isBlank()) continue
      hosts[id] = currentHost
      result.add(buildRuntime(manifest, code, url))
    }
    return result
  }

  fun release(id: String) {
    hosts.remove(id)
  }

  private fun currentTabId(url: String): String =
      runCatching { Chrome.getTabId(Chrome.getTab(), url) }
          .getOrElse { "fallback:${System.identityHashCode(Chrome.getTab())}:$url" }

  private fun cleanupHosts() {
    val pages = runCatching { getInspectPages() }.getOrNull() ?: return
    val live = mutableSetOf<String>()
    for (i in 0 until pages.length()) {
      val page = pages.optJSONObject(i) ?: continue
      if (page.optString("type") == "page") live.add(page.optString("id"))
    }
    if (live.isEmpty()) return
    val stale =
        hosts.entries
            .filter { !it.value.startsWith("fallback:") && !live.contains(it.value) }
            .map { it.key }
    stale.forEach { hosts.remove(it) }
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
        try { ${code} } catch(error) { console.error('[ChromeXt Extension background ${id}]', error); }
      })();
      //# sourceURL=local://ChromeXt/extension/${id}/background-host
    """.trimIndent()
  }
}
