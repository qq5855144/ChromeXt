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
 * Browser-owned compatibility host for extension background/service-worker code.
 *
 * ChromeXt does not discover DevTools pages here. Backgrounds are attached only to a browser tab
 * object already supplied by the normal page lifecycle. A navigation invalidates the old host and
 * causes a clean service-worker-style restart on the new document.
 */
object ExtensionBackgroundHost {
  data class PreparedHost(val tab: Any, val bootstrap: String?)

  private data class Host(val tab: WeakReference<Any>, val url: String)

  private val hosts = ConcurrentHashMap<String, Host>()

  /** Prepare every enabled extension background for the already-known top-level browser tab. */
  fun prepareAll(preferredTab: Any? = null): List<String> {
    val target =
        ExtensionActiveTab.preferred(preferredTab) ?: Chrome.getTab(preferredTab) ?: return emptyList()
    val manifests = LocalFiles.managementList()
    val output = mutableListOf<String>()
    for (i in 0 until manifests.length()) {
      val manifest = manifests.optJSONObject(i) ?: continue
      if (!manifest.optBoolean("enabled") || manifest.optJSONObject("background") == null) continue
      prepare(manifest.optString("id"), target)?.bootstrap?.let { output.add(it) }
    }
    return output
  }

  fun prepare(id: String, preferredTab: Any? = null): PreparedHost? {
    val manifest = manifest(id) ?: return null
    val background = manifest.optJSONObject("background") ?: return null
    val directory = File(Chrome.getContext().getExternalFilesDir(null), "Extension/$id")
    val code = backgroundCode(directory, manifest, background)
    if (code.isBlank()) return null

    val preferred =
        ExtensionActiveTab.preferred(preferredTab) ?: Chrome.getTab(preferredTab) ?: return null
    val previous = hosts[id]
    val previousTab = previous?.tab?.get()
    val previousAlive =
        previousTab != null &&
            runCatching { Chrome.checkTab(previousTab) }.getOrDefault(false) &&
            Chrome.getUrl(previousTab) == previous?.url
    val target = if (previousAlive) previousTab!! else preferred
    val targetUrl = Chrome.getUrl(target) ?: ExtensionActiveTab.url(Chrome.getUrl(preferred))
    val needsBootstrap = !previousAlive || previous?.url != targetUrl

    hosts[id] = Host(WeakReference(target), targetUrl)
    return PreparedHost(target, if (needsBootstrap) buildRuntime(manifest, code, targetUrl) else null)
  }

  /** Emulate a browser toolbar action click when an extension has no default_popup. */
  fun dispatchActionClick(id: String, preferredTab: Any? = null): Boolean {
    val prepared = prepare(id, preferredTab) ?: return false
    val activeTab = ExtensionActiveTab.snapshot(prepared.tab)
    val code =
        """
        (()=>{
          const runtime=globalThis.__cxExtensionRuntimes?.get(${JSONObject.quote(id)});
          if(!runtime)return;
          const tab=${activeTab};
          runtime.chrome?.action?.onClicked?.dispatch(tab);
        })();
        //# sourceURL=local://ChromeXt/extension/${id}/action-click
        """.trimIndent()
    val codes = mutableListOf<String>()
    prepared.bootstrap?.let { codes.add(it) }
    codes.add(code)
    Chrome.evaluateJavascript(codes, prepared.tab)
    return true
  }

  fun isAttached(id: String): Boolean {
    val host = hosts[id] ?: return false
    val tab = host.tab.get() ?: return false
    return runCatching { Chrome.checkTab(tab) && Chrome.getUrl(tab) == host.url }.getOrDefault(false)
  }

  fun release(id: String) {
    val host = hosts.remove(id) ?: return
    val tab = host.tab.get() ?: return
    if (!runCatching { Chrome.checkTab(tab) }.getOrDefault(false)) return
    val code =
        """
        (()=>{
          const id=${JSONObject.quote(id)};
          const runtime=globalThis.__cxExtensionRuntimes?.get(id);
          try{ runtime?.destroy?.(); }catch(error){ console.error('[ChromeXt Extension stop]',error); }
          globalThis.__cxExtensionRuntimes?.delete(id);
          globalThis.__cxExtensionBackgrounds?.delete(id);
        })();
        """.trimIndent()
    Chrome.evaluateJavascript(listOf(code), tab)
  }

  fun releaseAll() {
    hosts.keys.toList().forEach { release(it) }
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
    val activeTab = ExtensionActiveTab.snapshot()
    val context =
        JSONObject()
            .put("type", "background")
            .put("url", url)
            .put("activeUrl", activeTab.optString("url", url))
            .put("activeTab", activeTab)
            .put("frameId", JSONObject.NULL)
            .put("extensionId", id)
            .put("contextId", "background:$id")
    return """
      (()=>{
        const __cxRealGlobal=globalThis;
        if(!__cxRealGlobal.__cxExtensionBackgrounds) __cxRealGlobal.__cxExtensionBackgrounds=new Set();
        if(!__cxRealGlobal.__cxExtensionRuntimes) __cxRealGlobal.__cxExtensionRuntimes=new Map();
        if(__cxRealGlobal.__cxExtensionBackgrounds.has(${JSONObject.quote(id)})) return;
        __cxRealGlobal.__cxExtensionBackgrounds.add(${JSONObject.quote(id)});
        const __cxExtension=${manifest};
        const __cxContext=${context};
        const __cxNative=Symbol.${Local.name}.unlock(${Local.key});
        ${LocalFiles.script}
        const chrome=__cxCreateExtensionApi(__cxExtension,__cxContext,__cxNative);
        const browser=chrome;
        const __cxOverlay=Object.create(null);
        __cxOverlay.chrome=chrome;
        __cxOverlay.browser=browser;
        const __cxExtensionGlobal=new Proxy(__cxRealGlobal,{
          get(target,key){
            if(Object.prototype.hasOwnProperty.call(__cxOverlay,key)) return __cxOverlay[key];
            const value=Reflect.get(target,key,target);
            return typeof value==='function'?value.bind(target):value;
          },
          set(target,key,value){ __cxOverlay[key]=value; return true; },
          has(target,key){ return Object.prototype.hasOwnProperty.call(__cxOverlay,key)||key in target; }
        });
        const __cxRuntime={chrome,browser,context:__cxContext,destroy(){
          try{ chrome.__cxDestroy?.(); }catch(_){}
          Object.keys(__cxOverlay).forEach((key)=>{ if(key!=='chrome'&&key!=='browser')delete __cxOverlay[key]; });
        }};
        __cxRealGlobal.__cxExtensionRuntimes.set(${JSONObject.quote(id)},__cxRuntime);
        {
          const globalThis=__cxExtensionGlobal;
          const self=__cxExtensionGlobal;
          const window=__cxExtensionGlobal;
          ${ExtensionCompat.script}
          try {
            (()=>{ ${code} })();
          } catch(error) {
            __cxRealGlobal.__cxExtensionRuntimes.delete(${JSONObject.quote(id)});
            __cxRealGlobal.__cxExtensionBackgrounds.delete(${JSONObject.quote(id)});
            console.error('[ChromeXt Extension background ${id}]', error);
          }
        }
      })();
      //# sourceURL=local://ChromeXt/extension/${id}/background-host
    """.trimIndent()
  }
}
