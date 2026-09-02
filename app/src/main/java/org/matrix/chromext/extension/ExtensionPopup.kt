package org.matrix.chromext.extension

import java.io.File
import java.io.FileReader
import java.util.UUID
import org.json.JSONObject
import org.matrix.chromext.Chrome

/** Builds an isolated popup document that has the WebExtension runtime before extension scripts run. */
object ExtensionPopup {
  private const val MAX_POPUP_BYTES = 2 * 1024 * 1024L

  fun document(id: String): JSONObject {
    val manifest = manifest(id) ?: return failure("Unknown or disabled extension")
    val action =
        manifest.optJSONObject("action")
            ?: manifest.optJSONObject("browser_action")
            ?: manifest.optJSONObject("page_action")
    val popup = action?.optString("default_popup")?.trim().orEmpty()
    if (popup.isBlank()) return failure("Extension does not declare a popup")

    val root = File(Chrome.getContext().getExternalFilesDir(null), "Extension/$id").canonicalFile
    val file = File(root, popup.trimStart('/')).canonicalFile
    if (!file.path.startsWith(root.path + File.separator) || !file.isFile)
        return failure("Popup file is missing or unsafe")
    if (file.length() > MAX_POPUP_BYTES) return failure("Extension popup is larger than 2 MB")

    return runCatching {
          val html = FileReader(file).use { it.readText() }
          val baseUrl = manifest.optString("baseUrl")
          val popupUrl = baseUrl + popup.trimStart('/')
          val directoryUrl = popupUrl.substringBeforeLast('/', baseUrl.removeSuffix("/") + "/") + "/"
          val token = UUID.randomUUID().toString()
          val context =
              JSONObject()
                  .put("type", "extension_page")
                  .put("url", popupUrl)
                  .put("frameId", JSONObject.NULL)
                  .put("extensionId", id)
                  .put("contextId", "popup:$token")
          val prelude = buildPrelude(manifest, context, token)
          val document = injectHead(html, directoryUrl, prelude)
          JSONObject()
              .put("ok", true)
              .put("id", id)
              .put("name", manifest.optString("name", id))
              .put("popupUrl", popupUrl)
              .put("token", token)
              .put("document", document)
        }
        .getOrElse { failure(it.message ?: "Unable to open extension popup") }
  }

  private fun manifest(id: String): JSONObject? {
    val manifests = LocalFiles.managementList()
    for (i in 0 until manifests.length()) {
      val candidate = manifests.optJSONObject(i) ?: continue
      if (candidate.optString("id") == id && candidate.optBoolean("enabled")) return candidate
    }
    return null
  }

  private fun buildPrelude(manifest: JSONObject, context: JSONObject, token: String): String {
    val id = manifest.optString("id")
    return """
      <script>
      (()=>{
        const __cxTarget=window.parent!==window?window.parent:window.opener;
        if(!__cxTarget)return;
        const __cxToken=${JSONObject.quote(token)};
        const __cxExtension=${manifest};
        const __cxContext=${context};
        const __cxListeners=new Map();
        const __cxNative={
          dispatch(action,payload){
            __cxTarget.postMessage({__chromextExtensionFrame:true,direction:'dispatch',token:__cxToken,extensionId:${JSONObject.quote(id)},action,payload},'*');
          },
          addEventListener(name,listener){
            if(typeof listener!=='function')return;
            if(!__cxListeners.has(name))__cxListeners.set(name,new Set());
            __cxListeners.get(name).add(listener);
          },
          removeEventListener(name,listener){
            const listeners=__cxListeners.get(name);
            if(listeners)listeners.delete(listener);
          }
        };
        window.addEventListener('message',(event)=>{
          if(event.source!==__cxTarget)return;
          const data=event.data||{};
          if(data.__chromextExtensionFrame!==true||data.direction!=='event'||data.token!==__cxToken)return;
          const listeners=__cxListeners.get(data.name);
          if(!listeners)return;
          [...listeners].forEach((listener)=>{
            try{listener({detail:data.detail});}catch(error){console.error('[ChromeXt popup bridge]',error);}
          });
        });
        ${LocalFiles.script}
        globalThis.chrome=__cxCreateExtensionApi(__cxExtension,__cxContext,__cxNative);
        globalThis.browser=globalThis.chrome;
        __cxTarget.postMessage({__chromextExtensionFrame:true,direction:'ready',token:__cxToken,extensionId:${JSONObject.quote(id)}},'*');
      })();
      </script>
    """.trimIndent()
  }

  private fun injectHead(html: String, baseUrl: String, prelude: String): String {
    val head = Regex("(?is)<head(?:\\s[^>]*)?>").find(html)
    val insertion = "<base href=\"${escapeAttribute(baseUrl)}\">\n$prelude"
    if (head != null) {
      val index = head.range.last + 1
      return html.substring(0, index) + "\n" + insertion + html.substring(index)
    }

    val htmlTag = Regex("(?is)<html(?:\\s[^>]*)?>").find(html)
    if (htmlTag != null) {
      val index = htmlTag.range.last + 1
      return html.substring(0, index) + "<head>$insertion</head>" + html.substring(index)
    }
    return "<!doctype html><html><head>$insertion</head><body>$html</body></html>"
  }

  private fun escapeAttribute(value: String): String =
      value.replace("&", "&amp;").replace("\"", "&quot;").replace("<", "&lt;").replace(">", "&gt;")

  private fun failure(message: String): JSONObject =
      JSONObject().put("ok", false).put("error", message)
}
