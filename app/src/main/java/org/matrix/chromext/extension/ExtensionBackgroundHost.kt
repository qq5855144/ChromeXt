package org.matrix.chromext.extension

import java.io.File
import java.io.FileReader
import java.util.concurrent.ConcurrentHashMap
import org.json.JSONObject
import org.matrix.chromext.Chrome
import org.matrix.chromext.script.Local
import org.matrix.chromext.utils.Log

/**
 * Compatibility host for extension background code.
 *
 * Background code must never be started as part of a normal website navigation. In particular, do
 * not synchronously discover DevTools pages or resolve Chromium tab ids here: those operations can
 * block the browser UI on WebView-based hosts. A compatibility background may only be hosted from
 * one of ChromeXt's local loopback extension pages.
 */
object ExtensionBackgroundHost {
  private val hosts = ConcurrentHashMap<String, String>()

  fun bootstrap(url: String, hostTab: Any? = null): List<String> {
    if (!isLocalExtensionResource(url)) return emptyList()

    val currentHost = "local:${System.identityHashCode(Chrome.getTab(hostTab))}"
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

  private fun isLocalExtensionResource(url: String): Boolean {
    if (!url.startsWith("http://127.0.0.1:")) return false
    val portStart = "http://127.0.0.1:".length
    val slash = url.indexOf('/', portStart)
    if (slash <= portStart) return false
    return url.substring(portStart, slash).toIntOrNull() != null
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
