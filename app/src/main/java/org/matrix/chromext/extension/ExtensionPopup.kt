package org.matrix.chromext.extension

import android.net.Uri
import java.io.File
import java.io.FileInputStream
import java.io.FileReader
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLConnection
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import org.json.JSONObject
import org.matrix.chromext.Chrome
import org.matrix.chromext.utils.Log

/**
 * Hosts extension action popups on an isolated loopback origin.
 *
 * Popup HTML is never transported through the console/debug bridge. Each installed extension gets
 * a dedicated loopback origin so its localStorage/IndexedDB and relative resources behave like an
 * extension page while remaining cross-origin from the ChromeXt manager.
 */
object ExtensionPopup {
  private const val MAX_POPUP_BYTES = 2 * 1024 * 1024L
  private const val DOCUMENT_TTL_MS = 10 * 60 * 1000L
  private const val POPUP_TOKEN = "__chromext_popup"

  private data class PreparedDocument(
      val path: String,
      val bytes: ByteArray,
      val createdAt: Long,
  )

  private data class PopupServer(
      val id: String,
      val directory: File,
      val socket: ServerSocket,
      val documents: ConcurrentHashMap<String, PreparedDocument> = ConcurrentHashMap(),
  ) {
    val baseUrl: String = "http://127.0.0.1:${socket.localPort}/"
  }

  private val servers = ConcurrentHashMap<String, PopupServer>()

  fun document(id: String): JSONObject {
    val sourceManifest = manifest(id) ?: return failure("Unknown or disabled extension")
    val action =
        sourceManifest.optJSONObject("action")
            ?: sourceManifest.optJSONObject("browser_action")
            ?: sourceManifest.optJSONObject("page_action")
    val popup = action?.optString("default_popup")?.trim().orEmpty()
    if (popup.isBlank()) return failure("Extension does not declare a popup")

    val root = File(Chrome.getContext().getExternalFilesDir(null), "Extension/$id").canonicalFile
    val file = File(root, popup.trimStart('/')).canonicalFile
    if (!file.path.startsWith(root.path + File.separator) || !file.isFile)
        return failure("Popup file is missing or unsafe")
    if (file.length() > MAX_POPUP_BYTES) return failure("Extension popup is larger than 2 MB")

    return runCatching {
          val server = server(id, root)
          val manifest = popupManifest(sourceManifest, server.baseUrl)
          val html = FileReader(file).use { it.readText() }
          val popupPath = popup.trimStart('/')
          val popupUrl = server.baseUrl + popupPath
          val directoryUrl = popupUrl.substringBeforeLast('/', server.baseUrl) + "/"
          val token = UUID.randomUUID().toString()
          val activeTab = ExtensionActiveTab.snapshot()
          val context =
              JSONObject()
                  .put("type", "extension_page")
                  .put("url", popupUrl)
                  .put("activeUrl", activeTab.optString("url", "about:blank"))
                  .put("activeTab", activeTab)
                  .put("frameId", JSONObject.NULL)
                  .put("extensionId", id)
                  .put("contextId", "popup:$token")
          val prelude = buildPrelude(manifest, context, token)
          val prepared = injectHead(html, directoryUrl, prelude).toByteArray(Charsets.UTF_8)
          cleanupDocuments(server)
          server.documents[token] =
              PreparedDocument(popupPath, prepared, System.currentTimeMillis())
          val documentUrl =
              popupUrl + (if (popupUrl.contains('?')) "&" else "?") + "$POPUP_TOKEN=$token"
          val displayName =
              ExtensionLocale.resolve(id, sourceManifest, sourceManifest.optString("name", id))
          JSONObject()
              .put("ok", true)
              .put("id", id)
              .put("name", displayName)
              .put("popupUrl", popupUrl)
              .put("documentUrl", documentUrl)
              .put("token", token)
        }
        .getOrElse {
          Log.e("Unable to prepare extension popup $id: ${it.message}")
          failure(it.message ?: "Unable to open extension popup")
        }
  }

  /** Returns a popup-origin manifest so top-level options/pages on this origin get chrome.* too. */
  fun manifestForUrl(url: String): JSONObject? {
    val server = servers.values.firstOrNull { url.startsWith(it.baseUrl) } ?: return null
    val source = manifest(server.id) ?: return null
    return popupManifest(source, server.baseUrl)
  }

  private fun server(id: String, root: File): PopupServer {
    servers[id]?.let {
      if (!it.socket.isClosed) return it
      servers.remove(id, it)
    }
    synchronized(this) {
      servers[id]?.let {
        if (!it.socket.isClosed) return it
        servers.remove(id, it)
      }
      val socket = ServerSocket(0, 16, InetAddress.getLoopbackAddress())
      val created = PopupServer(id, root, socket)
      servers[id] = created
      Chrome.IO.submit {
        while (!socket.isClosed) {
          runCatching { socket.accept() }
              .onSuccess { connection -> Chrome.IO.submit { serve(created, connection) } }
              .onFailure { if (!socket.isClosed) Log.e("Extension popup host failed: ${it.message}") }
        }
      }
      return created
    }
  }

  private fun serve(server: PopupServer, connection: Socket) {
    runCatching {
          connection.use { socket ->
            val requestLine = socket.getInputStream().bufferedReader().readLine() ?: return
            val request = requestLine.split(" ")
            if (request.size < 3 || request[0] != "GET") return
            if (manifest(server.id) == null) {
              writeResponse(socket, 404, "text/plain", "Not Found".toByteArray())
              return
            }

            val target = request[1]
            val rawPath = target.substringBefore('?').substringBefore('#')
            val requestPath = Uri.decode(rawPath).trimStart('/')
            if (requestPath.contains("..")) {
              writeResponse(socket, 403, "text/plain", "Forbidden".toByteArray())
              return
            }

            val token = queryParameter(target, POPUP_TOKEN)
            val prepared = token?.let { server.documents[it] }
            if (prepared != null && prepared.path == requestPath) {
              if (System.currentTimeMillis() - prepared.createdAt <= DOCUMENT_TTL_MS) {
                writeResponse(socket, 200, "text/html; charset=utf-8", prepared.bytes)
                return
              }
              server.documents.remove(token)
            }

            val file = File(server.directory, requestPath).canonicalFile
            if (
                !file.path.startsWith(server.directory.canonicalPath + File.separator) ||
                    !file.isFile) {
              writeResponse(socket, 404, "text/plain", "Not Found".toByteArray())
              return
            }
            val type = URLConnection.guessContentTypeFromName(file.name) ?: "application/octet-stream"
            writeResponse(socket, 200, type, FileInputStream(file).use { it.readBytes() })
          }
        }
        .onFailure { Log.e("Failed to serve extension popup resource: ${it.message}") }
  }

  private fun queryParameter(target: String, name: String): String? {
    val query = target.substringAfter('?', "").substringBefore('#')
    if (query.isBlank()) return null
    return query
        .split('&')
        .firstOrNull { it.substringBefore('=') == name }
        ?.substringAfter('=', "")
        ?.takeIf { it.isNotBlank() }
  }

  private fun cleanupDocuments(server: PopupServer) {
    val cutoff = System.currentTimeMillis() - DOCUMENT_TTL_MS
    server.documents.entries.removeAll { it.value.createdAt < cutoff }
  }

  private fun popupManifest(source: JSONObject, baseUrl: String): JSONObject {
    val manifest = JSONObject(source.toString())
    manifest.put("baseUrl", baseUrl)
    val action =
        manifest.optJSONObject("action")
            ?: manifest.optJSONObject("browser_action")
            ?: manifest.optJSONObject("page_action")
    action?.optString("default_popup")?.takeIf { it.isNotBlank() }?.let {
      manifest.put("popupUrl", baseUrl + it.trimStart('/'))
    }
    val options =
        manifest.optString("options_page").takeIf { it.isNotBlank() }
            ?: manifest.optJSONObject("options_ui")?.optString("page")?.takeIf { it.isNotBlank() }
    if (options != null) manifest.put("optionsUrl", baseUrl + options.trimStart('/'))
    return manifest
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
        const __cxResolveExtensionUrl=(value)=>{
          const text=String(value==null?'':value);
          const match=/^chrome-extension:\/\/[a-p]{32}\/(.*)$/i.exec(text);
          return match&&__cxExtension.baseUrl?__cxExtension.baseUrl+match[1]:text;
        };
        const __cxOpen=window.open.bind(window);
        window.open=(url,...args)=>__cxOpen(__cxResolveExtensionUrl(url),...args);
        window.close=()=>{
          __cxTarget.postMessage({__chromextExtensionFrame:true,direction:'close',token:__cxToken,extensionId:${JSONObject.quote(id)}},'*');
        };
        document.addEventListener('click',(event)=>{
          const anchor=event.target&&event.target.closest?event.target.closest('a[href]'):null;
          if(!anchor)return;
          const resolved=__cxResolveExtensionUrl(anchor.getAttribute('href'));
          if(resolved!==anchor.getAttribute('href'))anchor.setAttribute('href',resolved);
        },true);
        const __cxReportSize=()=>{
          try{
            const root=document.documentElement;
            const body=document.body;
            const height=Math.max(
              root?root.scrollHeight:0,
              root?root.offsetHeight:0,
              body?body.scrollHeight:0,
              body?body.offsetHeight:0,
              360
            );
            __cxTarget.postMessage({__chromextExtensionFrame:true,direction:'resize',token:__cxToken,extensionId:${JSONObject.quote(id)},height},'*');
          }catch(_){}
        };
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
        ${ExtensionCompat.script}
        __cxTarget.postMessage({__chromextExtensionFrame:true,direction:'ready',token:__cxToken,extensionId:${JSONObject.quote(id)}},'*');
        if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',__cxReportSize,{once:true});
        else setTimeout(__cxReportSize,0);
        window.addEventListener('load',__cxReportSize,{once:true});
        if(typeof ResizeObserver==='function'){
          const observer=new ResizeObserver(__cxReportSize);
          const observe=()=>{ if(document.documentElement)observer.observe(document.documentElement); };
          if(document.documentElement)observe(); else document.addEventListener('DOMContentLoaded',observe,{once:true});
        }
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

  private fun writeResponse(socket: Socket, status: Int, type: String, bytes: ByteArray) {
    val reason =
        when (status) {
          200 -> "OK"
          403 -> "Forbidden"
          else -> "Not Found"
        }
    val headers =
        "HTTP/1.1 $status $reason\r\n" +
            "Content-Length: ${bytes.size}\r\n" +
            "Content-Type: $type\r\n" +
            "Cache-Control: no-cache\r\n" +
            "Access-Control-Allow-Origin: *\r\n" +
            "Cross-Origin-Resource-Policy: cross-origin\r\n" +
            "Connection: close\r\n\r\n"
    socket.getOutputStream().write(headers.toByteArray(Charsets.US_ASCII))
    socket.getOutputStream().write(bytes)
  }

  private fun escapeAttribute(value: String): String =
      value.replace("&", "&amp;").replace("\"", "&quot;").replace("<", "&lt;").replace(">", "&gt;")

  private fun failure(message: String): JSONObject =
      JSONObject().put("ok", false).put("error", message)
}
