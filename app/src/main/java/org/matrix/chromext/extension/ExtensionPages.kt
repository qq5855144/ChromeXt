package org.matrix.chromext.extension

import org.json.JSONObject
import org.matrix.chromext.script.Local

object ExtensionPages {
  fun bootstrap(url: String): String? {
    val manifests = LocalFiles.managementList()
    var manifest: JSONObject? = null
    for (i in 0 until manifests.length()) {
      val candidate = manifests.optJSONObject(i) ?: continue
      if (!candidate.optBoolean("enabled")) continue
      val base = candidate.optString("baseUrl")
      if (base.isNotBlank() && url.startsWith(base)) {
        manifest = candidate
        break
      }
    }
    val extension = manifest ?: return null
    val context =
        JSONObject()
            .put("type", "extension_page")
            .put("url", url)
            .put("frameId", JSONObject.NULL)
            .put("extensionId", extension.getString("id"))
    return """
      (()=>{
        const __cxExtension=${extension};
        const __cxContext=${context};
        const __cxNative=Symbol.${Local.name}.unlock(${Local.key});
        ${LocalFiles.script}
        globalThis.chrome=__cxCreateExtensionApi(__cxExtension,__cxContext,__cxNative);
        globalThis.browser=globalThis.chrome;
      })();
      //# sourceURL=local://ChromeXt/extension-page/${extension.getString("id")}
    """.trimIndent()
  }
}
