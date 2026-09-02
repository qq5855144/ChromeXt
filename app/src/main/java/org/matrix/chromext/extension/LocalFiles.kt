package org.matrix.chromext.extension

import android.app.DownloadManager
import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.Base64
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.FileReader
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URI
import java.net.URLConnection
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.zip.ZipInputStream
import org.json.JSONArray
import org.json.JSONObject
import org.matrix.chromext.Chrome
import org.matrix.chromext.devtools.DevSessions
import org.matrix.chromext.devtools.getInspectPages
import org.matrix.chromext.script.Local
import org.matrix.chromext.utils.Log

/**
 * Browser-independent WebExtension runtime owned by ChromeXt.
 *
 * The host browser does not need Chromium's ExtensionService. Extension resources live inside the
 * browser application's private external-files directory, while ChromeXt provides the WebExtension
 * APIs and content-script injection itself.
 */
object LocalFiles {
  private const val MAX_PACKAGE_BYTES = 32 * 1024 * 1024
  private const val MIN_UNPACKED_BYTES = 256 * 1024 * 1024L
  private const val MAX_UNPACKED_BYTES = 512 * 1024 * 1024L
  private const val MAX_UNPACK_RATIO = 20L
  private const val MAX_SINGLE_FILE_BYTES = 256 * 1024 * 1024L
  private const val MAX_FILES = 6000

  private data class Extension(
      val id: String,
      val directory: File,
      val manifest: JSONObject,
      var enabled: Boolean,
      var port: Int = 0,
      var server: ServerSocket? = null,
  )

  private val directory: File
  private val extensions = ConcurrentHashMap<String, Extension>()
  private val uploads = ConcurrentHashMap<String, ByteArrayOutputStream>()
  private val uploadNames = ConcurrentHashMap<String, String>()
  private val state by lazy {
    Chrome.getContext().getSharedPreferences("ChromeXtExtensions", Context.MODE_PRIVATE)
  }
  private val storageCache = ConcurrentHashMap<String, JSONObject>()
  val script: String

  init {
    val ctx = Chrome.getContext()
    directory = File(ctx.getExternalFilesDir(null), "Extension")
    script = ctx.assets.open("extension.js").bufferedReader().use { it.readText() }
    if (!directory.exists()) directory.mkdirs()
    reload()
  }

  private fun reload() {
    extensions.values.forEach { runCatching { it.server?.close() } }
    extensions.clear()
    directory.listFiles()?.forEach { folder ->
      if (!folder.isDirectory || folder.name.startsWith(".")) return@forEach
      val manifestFile = File(folder, "manifest.json")
      if (!manifestFile.exists()) return@forEach
      runCatching {
            val manifest = JSONObject(FileReader(manifestFile).use { it.readText() })
            normalizeManifest(manifest)
            val id = folder.name
            extensions[id] =
                Extension(id, folder, manifest, state.getBoolean("enabled:$id", true))
          }
          .onFailure { Log.e("Invalid extension ${folder.name}: ${it.message}") }
    }
  }

  private fun normalizeManifest(manifest: JSONObject) {
    if (!manifest.has("manifest_version")) manifest.put("manifest_version", 2)
    if (!manifest.has("name")) manifest.put("name", "Unnamed extension")
    if (!manifest.has("version")) manifest.put("version", "0")
  }

  private fun JSONObject.optStringOrNull(name: String): String? {
    if (!has(name) || isNull(name)) return null
    val value = optString(name).trim()
    return if (value.isEmpty()) null else value
  }

  private fun extensionInfo(extension: Extension): JSONObject {
    val manifest = JSONObject(extension.manifest.toString())
    manifest.put("id", extension.id)
    manifest.put("enabled", extension.enabled)
    manifest.put("port", extension.port)
    manifest.put("baseUrl", if (extension.port == 0) "" else "http://127.0.0.1:${extension.port}/")
    val action = manifest.optJSONObject("action") ?: manifest.optJSONObject("browser_action")
    val popup = action?.optStringOrNull("default_popup")
    val options =
        manifest.optStringOrNull("options_page")
            ?: manifest.optJSONObject("options_ui")?.optStringOrNull("page")
    if (popup != null) manifest.put("popupUrl", resourceUrl(extension, popup))
    if (options != null) manifest.put("optionsUrl", resourceUrl(extension, options))
    return manifest
  }

  fun start(): JSONObject {
    extensions.values.filter { it.enabled }.forEach { startServer(it) }
    return JSONObject().put("type", "init").put("manifests", managementList())
  }

  fun managementList(): JSONArray {
    val result = JSONArray()
    extensions.values.sortedBy { it.manifest.optString("name").lowercase() }.forEach {
      if (it.enabled) startServer(it)
      result.put(extensionInfo(it))
    }
    return result
  }

  fun setEnabled(id: String, enabled: Boolean): Boolean {
    val extension = extensions[id] ?: return false
    extension.enabled = enabled
    state.edit().putBoolean("enabled:$id", enabled).apply()
    if (enabled) startServer(extension) else stopServer(extension)
    return true
  }

  fun delete(id: String): Boolean {
    val extension = extensions.remove(id) ?: return false
    stopServer(extension)
    storageCache.remove(id)
    state.edit().remove("enabled:$id").remove("permissions:$id").apply()
    Chrome.getContext().getSharedPreferences("ChromeXtExtensionStorage:$id", Context.MODE_PRIVATE).edit().clear().apply()
    return extension.directory.deleteRecursively()
  }

  fun beginInstall(token: String, name: String): JSONObject {
    if (token.isBlank()) return failure("Invalid upload token")
    uploads[token] = ByteArrayOutputStream()
    uploadNames[token] = name
    return success().put("token", token)
  }

  fun appendInstall(token: String, base64: String): JSONObject {
    val output = uploads[token] ?: return failure("Upload session expired")
    val bytes = runCatching { Base64.decode(base64, Base64.DEFAULT) }.getOrNull()
        ?: return failure("Invalid package chunk")
    if (output.size() + bytes.size > MAX_PACKAGE_BYTES) {
      uploads.remove(token)
      uploadNames.remove(token)
      return failure("Extension package is larger than 32 MB")
    }
    output.write(bytes)
    return success().put("received", output.size())
  }

  fun finishInstall(token: String): JSONObject {
    val bytes = uploads.remove(token)?.toByteArray() ?: return failure("Upload session expired")
    val name = uploadNames.remove(token) ?: "extension.zip"
    return installPackage(bytes, name)
  }

  private fun installPackage(packageBytes: ByteArray, sourceName: String): JSONObject {
    if (packageBytes.isEmpty()) return failure("Empty extension package")
    val zipBytes = extractZip(packageBytes) ?: return failure("Only ZIP/CRX extension packages are supported")
    val temp = File(directory, ".install-${UUID.randomUUID()}")
    temp.mkdirs()
    return runCatching {
          unpack(zipBytes, temp)
          val root = findManifestRoot(temp) ?: throw IllegalArgumentException("manifest.json not found")
          val manifestFile = File(root, "manifest.json")
          val manifest = JSONObject(FileReader(manifestFile).use { it.readText() })
          normalizeManifest(manifest)
          val version = manifest.optInt("manifest_version", 2)
          if (version !in 2..3) throw IllegalArgumentException("Unsupported manifest_version: $version")
          val id = extensionId(manifest, zipBytes)
          val target = File(directory, id)
          val previousEnabled = extensions[id]?.enabled ?: state.getBoolean("enabled:$id", true)
          extensions[id]?.let { stopServer(it) }
          if (target.exists()) target.deleteRecursively()
          target.mkdirs()
          root.copyRecursively(target, overwrite = true)
          temp.deleteRecursively()
          val installed = Extension(id, target, manifest, previousEnabled)
          extensions[id] = installed
          state.edit().putBoolean("enabled:$id", previousEnabled).apply()
          if (previousEnabled) startServer(installed)
          success()
              .put("message", "Extension installed")
              .put("source", sourceName)
              .put("extension", extensionInfo(installed))
        }
        .getOrElse {
          temp.deleteRecursively()
          Log.ex(it)
          failure(it.message ?: "Failed to install extension")
        }
  }

  private fun extractZip(data: ByteArray): ByteArray? {
    fun isZip(offset: Int): Boolean =
        data.size >= offset + 4 &&
            data[offset] == 0x50.toByte() && data[offset + 1] == 0x4b.toByte() &&
            data[offset + 2] == 0x03.toByte() && data[offset + 3] == 0x04.toByte()
    if (isZip(0)) return data
    if (data.size < 16 || String(data, 0, 4, Charsets.US_ASCII) != "Cr24") return null
    fun le32(offset: Int): Int =
        (data[offset].toInt() and 0xff) or
            ((data[offset + 1].toInt() and 0xff) shl 8) or
            ((data[offset + 2].toInt() and 0xff) shl 16) or
            ((data[offset + 3].toInt() and 0xff) shl 24)
    val version = le32(4)
    val offset =
        when (version) {
          2 -> 16 + le32(8) + le32(12)
          3 -> 12 + le32(8)
          else -> return null
        }
    return if (offset in 0 until data.size && isZip(offset)) data.copyOfRange(offset, data.size) else null
  }

  private fun unpack(bytes: ByteArray, target: File) {
    val unpackLimit =
        (bytes.size.toLong() * MAX_UNPACK_RATIO)
            .coerceAtLeast(MIN_UNPACKED_BYTES)
            .coerceAtMost(MAX_UNPACKED_BYTES)
    var total = 0L
    var count = 0
    val canonicalRoot = target.canonicalFile
    ZipInputStream(ByteArrayInputStream(bytes)).use { zip ->
      while (true) {
        val entry = zip.nextEntry ?: break
        count += 1
        if (count > MAX_FILES) throw IllegalArgumentException("Extension contains too many files")
        val output = File(target, entry.name).canonicalFile
        if (!output.path.startsWith(canonicalRoot.path + File.separator))
            throw SecurityException("Unsafe path in extension package")
        if (entry.isDirectory) {
          output.mkdirs()
        } else {
          output.parentFile?.mkdirs()
          var entryTotal = 0L
          FileOutputStream(output).use { stream ->
            val buffer = ByteArray(16 * 1024)
            while (true) {
              val read = zip.read(buffer)
              if (read <= 0) break
              entryTotal += read
              total += read
              if (entryTotal > MAX_SINGLE_FILE_BYTES)
                  throw IllegalArgumentException("Extension contains a file larger than 256 MB")
              if (total > unpackLimit) {
                val limitMb = unpackLimit / (1024 * 1024)
                throw IllegalArgumentException("Extension expands beyond ${limitMb} MB safety limit")
              }
              stream.write(buffer, 0, read)
            }
          }
        }
        zip.closeEntry()
      }
    }
  }

  private fun findManifestRoot(root: File): File? {
    if (File(root, "manifest.json").isFile) return root
    val candidates = root.walkTopDown().maxDepth(3).filter { it.isFile && it.name == "manifest.json" }.toList()
    return candidates.firstOrNull()?.parentFile
  }

  private fun extensionId(manifest: JSONObject, bytes: ByteArray): String {
    val digest = MessageDigest.getInstance("SHA-256")
    val key = manifest.optStringOrNull("key")
    val hash = digest.digest(if (key == null) bytes else key.toByteArray(Charsets.UTF_8))
    val out = StringBuilder(32)
    for (i in 0 until 16) {
      val value = hash[i].toInt() and 0xff
      out.append(('a'.code + (value shr 4)).toChar())
      out.append(('a'.code + (value and 0x0f)).toChar())
    }
    return out.toString()
  }

  private fun stopServer(extension: Extension) {
    runCatching { extension.server?.close() }
    extension.server = null
    extension.port = 0
  }

  private fun startServer(extension: Extension) {
    if (!extension.enabled || extension.server?.isClosed == false) return
    runCatching {
          val server = ServerSocket(0, 16, InetAddress.getLoopbackAddress())
          extension.server = server
          extension.port = server.localPort
          Chrome.IO.submit {
            while (!server.isClosed) {
              runCatching { server.accept() }
                  .onSuccess { socket -> Chrome.IO.submit { serveFiles(extension, socket) } }
                  .onFailure { if (!server.isClosed) Log.ex(it) }
            }
          }
        }
        .onFailure { Log.e("Unable to start extension host for ${extension.id}: ${it.message}") }
  }

  private fun resourceUrl(extension: Extension, path: String): String {
    if (extension.port == 0) startServer(extension)
    return "http://127.0.0.1:${extension.port}/" + path.trimStart('/')
  }

  private fun serveFiles(extension: Extension, connection: Socket) {
    runCatching {
          connection.use { socket ->
            val reader = socket.getInputStream().bufferedReader()
            val requestLine = reader.readLine() ?: return
            val request = requestLine.split(" ")
            if (request.size < 3 || request[0] != "GET") return
            val requestPath = Uri.decode(request[1].substringBefore('?')).trimStart('/')
            if (requestPath.contains("..")) {
              writeResponse(socket, 403, "text/plain", "Forbidden".toByteArray())
              return
            }
            if (requestPath == "__chromext_manifest__.json") {
              writeResponse(socket, 200, "application/json", extensionInfo(extension).toString().toByteArray())
              return
            }
            val file = File(extension.directory, requestPath).canonicalFile
            if (!file.path.startsWith(extension.directory.canonicalPath + File.separator) || !file.isFile) {
              writeResponse(socket, 404, "text/plain", "Not Found".toByteArray())
              return
            }
            val type = URLConnection.guessContentTypeFromName(file.name) ?: "application/octet-stream"
            writeResponse(socket, 200, type, FileInputStream(file).use { it.readBytes() })
          }
        }
        .onFailure { Log.ex(it) }
  }

  private fun writeResponse(socket: Socket, status: Int, type: String, bytes: ByteArray) {
    val reason = if (status == 200) "OK" else if (status == 403) "Forbidden" else "Not Found"
    val headers =
        "HTTP/1.1 $status $reason\r\n" +
            "Content-Length: ${bytes.size}\r\n" +
            "Content-Type: $type\r\n" +
            "Cache-Control: no-cache\r\n" +
            "Access-Control-Allow-Origin: *\r\n" +
            "Connection: close\r\n\r\n"
    socket.getOutputStream().write(headers.toByteArray(Charsets.US_ASCII))
    socket.getOutputStream().write(bytes)
  }

  private fun jsonArrayStrings(array: JSONArray?): List<String> {
    if (array == null) return emptyList()
    val result = mutableListOf<String>()
    for (i in 0 until array.length()) result.add(array.optString(i))
    return result.filter { it.isNotBlank() }
  }

  private fun globRegex(value: String): Regex {
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

  private fun matchesPattern(pattern: String, url: String): Boolean {
    if (pattern == "<all_urls>") return url.startsWith("http://") || url.startsWith("https://") || url.startsWith("file://")
    return runCatching {
          val uri = URI(url)
          val separator = pattern.indexOf("://")
          if (separator <= 0) return@runCatching globRegex(pattern).matches(url)
          val schemePattern = pattern.substring(0, separator)
          val rest = pattern.substring(separator + 3)
          val slash = rest.indexOf('/')
          val hostPattern = if (slash < 0) rest else rest.substring(0, slash)
          val pathPattern = if (slash < 0) "/*" else rest.substring(slash)
          val scheme = uri.scheme ?: return@runCatching false
          val host = uri.host ?: ""
          val path = (uri.rawPath ?: "/") + if (uri.rawQuery == null) "" else "?${uri.rawQuery}"
          val schemeOk = schemePattern == "*" && (scheme == "http" || scheme == "https") || schemePattern.equals(scheme, true)
          val hostOk =
              hostPattern == "*" ||
                  hostPattern.equals(host, true) ||
                  (hostPattern.startsWith("*.") &&
                      (host.equals(hostPattern.substring(2), true) || host.endsWith("." + hostPattern.substring(2), true)))
          schemeOk && hostOk && globRegex(pathPattern).matches(path)
        }
        .getOrDefault(false)
  }

  private fun contentBlockMatches(block: JSONObject, url: String, frameId: String?): Boolean {
    if (frameId != null && !block.optBoolean("all_frames", false)) return false
    val matches = jsonArrayStrings(block.optJSONArray("matches"))
    if (matches.isEmpty() || matches.none { matchesPattern(it, url) }) return false
    val excludes = jsonArrayStrings(block.optJSONArray("exclude_matches"))
    return excludes.none { matchesPattern(it, url) }
  }

  fun hasAllFrames(url: String): Boolean {
    return extensions.values.any { extension ->
      extension.enabled &&
          extension.manifest.optJSONArray("content_scripts")?.let { scripts ->
            (0 until scripts.length()).any {
              val block = scripts.optJSONObject(it)
              block != null && block.optBoolean("all_frames", false) && contentBlockMatches(block, url, null)
            }
          } == true
    }
  }

  fun bootstrap(url: String, frameId: String?): List<String> {
    val output = mutableListOf<String>()
    extensions.values.filter { it.enabled }.forEach { extension ->
      val contentScripts = extension.manifest.optJSONArray("content_scripts") ?: return@forEach
      for (i in 0 until contentScripts.length()) {
        val block = contentScripts.optJSONObject(i) ?: continue
        if (!contentBlockMatches(block, url, frameId)) continue
        val css = jsonArrayStrings(block.optJSONArray("css"))
            .mapNotNull { path -> runCatching { File(extension.directory, path).readText() }.getOrNull() }
            .joinToString("\n")
        val js = jsonArrayStrings(block.optJSONArray("js"))
            .mapNotNull { path ->
              runCatching { File(extension.directory, path).readText() + "\n//# sourceURL=chromext-extension://${extension.id}/$path" }
                  .getOrNull()
            }
            .joinToString("\n")
        if (css.isEmpty() && js.isEmpty()) continue
        output.add(buildRuntime(extension, "content", css, js, url, frameId))
      }
      if (frameId == null) {
        val backgroundCode = backgroundCode(extension)
        if (backgroundCode.isNotEmpty()) {
          output.add(buildRuntime(extension, "background", "", backgroundCode, url, null))
        }
      }
    }
    return output
  }

  private fun backgroundCode(extension: Extension): String {
    val manifest = extension.manifest
    val background = manifest.optJSONObject("background") ?: return ""
    val scripts = mutableListOf<String>()
    jsonArrayStrings(background.optJSONArray("scripts")).forEach { path ->
      runCatching { scripts.add(File(extension.directory, path).readText() + "\n//# sourceURL=chromext-extension://${extension.id}/$path") }
    }
    val worker = background.optStringOrNull("service_worker")
    if (worker != null) {
      runCatching { scripts.add(File(extension.directory, worker).readText() + "\n//# sourceURL=chromext-extension://${extension.id}/$worker") }
    }
    return scripts.joinToString("\n")
  }

  private fun buildRuntime(
      extension: Extension,
      context: String,
      css: String,
      code: String,
      url: String,
      frameId: String?,
  ): String {
    val manifest = extensionInfo(extension)
    val contextJson =
        JSONObject()
            .put("type", context)
            .put("url", url)
            .put("frameId", frameId ?: JSONObject.NULL)
            .put("extensionId", extension.id)
    val styleCode =
        if (css.isEmpty()) ""
        else """
          (()=>{const style=document.createElement('style');style.dataset.chromextExtension=${JSONObject.quote(extension.id)};style.textContent=${JSONObject.quote(css)};(document.head||document.documentElement).appendChild(style);})();
        """.trimIndent()
    return """
      (()=>{
        const __cxExtension=${manifest};
        const __cxContext=${contextJson};
        const __cxNative=Symbol.${Local.name}.unlock(${Local.key});
        ${script}
        const chrome=__cxCreateExtensionApi(__cxExtension,__cxContext,__cxNative);
        const browser=chrome;
        ${styleCode}
        try { ${code} } catch(error) { console.error('[ChromeXt Extension ${extension.id}]', error); }
      })();
      //# sourceURL=local://ChromeXt/extension/${extension.id}/${context}
    """.trimIndent()
  }

  fun allowedOnUrl(id: String, url: String?): Boolean {
    val extension = extensions[id] ?: return false
    if (!extension.enabled || url == null) return false
    val manifest = extension.manifest
    val permissions = jsonArrayStrings(manifest.optJSONArray("host_permissions")) + jsonArrayStrings(manifest.optJSONArray("permissions"))
    if (permissions.any { it == "<all_urls>" || it.contains("://") && matchesPattern(it, url) }) return true
    val scripts = manifest.optJSONArray("content_scripts")
    if (scripts != null) {
      for (i in 0 until scripts.length()) {
        val block = scripts.optJSONObject(i) ?: continue
        if (contentBlockMatches(block, url, null)) return true
      }
    }
    return url.startsWith("http://127.0.0.1:${extension.port}/")
  }

  fun api(id: String, request: JSONObject, currentTab: Any?, frameId: String?): JSONObject {
    val extension = extensions[id] ?: return failure("Unknown extension")
    if (!extension.enabled) return failure("Extension is disabled")
    val api = request.optString("api")
    val args = request.optJSONArray("args") ?: JSONArray()
    return runCatching {
          when (api) {
            "runtime.getManifest" -> success(extensionInfo(extension))
            "runtime.getURL" -> success(resourceUrl(extension, args.optString(0)))
            "runtime.getPlatformInfo" -> success(JSONObject().put("os", "android").put("arch", System.getProperty("os.arch") ?: "unknown").put("nacl_arch", ""))
            "runtime.sendMessage", "tabs.sendMessage" -> {
              val message = if (api == "tabs.sendMessage") args.opt(1) else args.opt(0)
              val detail =
                  JSONObject()
                      .put("extensionId", id)
                      .put("message", message ?: JSONObject.NULL)
                      .put("sender", sender(currentTab, frameId, id))
              Chrome.broadcast("cx_extension_message", detail, false) { true }
              success(JSONObject.NULL)
            }
            "storage.local.get", "storage.sync.get", "storage.session.get" -> success(storageGet(id, args.opt(0)))
            "storage.local.set", "storage.sync.set", "storage.session.set" -> {
              storageSet(id, args.optJSONObject(0) ?: JSONObject())
              success(JSONObject.NULL)
            }
            "storage.local.remove", "storage.sync.remove", "storage.session.remove" -> {
              storageRemove(id, args.opt(0))
              success(JSONObject.NULL)
            }
            "storage.local.clear", "storage.sync.clear", "storage.session.clear" -> {
              storageClear(id)
              success(JSONObject.NULL)
            }
            "tabs.query" -> success(tabList(args.optJSONObject(0)))
            "tabs.getCurrent" -> success(sender(currentTab, frameId, id).optJSONObject("tab") ?: JSONObject.NULL)
            "tabs.reload" -> {
              Chrome.evaluateJavascript(listOf("location.reload()"), currentTab, frameId)
              success(JSONObject.NULL)
            }
            "tabs.create" -> {
              val props = args.optJSONObject(0) ?: JSONObject()
              val target = props.optString("url", "about:blank")
              Chrome.evaluateJavascript(listOf("window.open(${JSONObject.quote(target)},'_blank')"), currentTab, frameId)
              success(JSONObject().put("url", target))
            }
            "tabs.update" -> {
              val props = if (args.optJSONObject(0) != null) args.optJSONObject(0)!! else args.optJSONObject(1) ?: JSONObject()
              if (props.has("url")) Chrome.evaluateJavascript(listOf("location.href=${JSONObject.quote(props.getString("url"))}"), currentTab, frameId)
              success(JSONObject.NULL)
            }
            "tabs.remove" -> {
              Chrome.evaluateJavascript(listOf("window.close()"), currentTab, frameId)
              success(JSONObject.NULL)
            }
            "scripting.executeScript" -> executeScript(args.optJSONObject(0), currentTab)
            "scripting.insertCSS" -> insertCss(args.optJSONObject(0), currentTab)
            "permissions.getAll" -> success(permissionSnapshot(extension))
            "permissions.contains" -> success(permissionContains(extension, args.optJSONObject(0)))
            "permissions.request" -> success(permissionRequest(extension, args.optJSONObject(0)))
            "permissions.remove" -> success(permissionRemove(extension, args.optJSONObject(0)))
            "downloads.download" -> download(args.optJSONObject(0))
            "notifications.create" -> notification(extension, args)
            "cookies.get" -> cookieGet(args.optJSONObject(0))
            "cookies.set" -> cookieSet(args.optJSONObject(0))
            "cookies.remove" -> cookieRemove(args.optJSONObject(0))
            else -> failure("Unsupported WebExtension API: $api")
          }
        }
        .getOrElse {
          Log.ex(it)
          failure(it.message ?: "WebExtension API failed")
        }
  }

  private fun sender(tab: Any?, frameId: String?, id: String): JSONObject {
    val url = Chrome.getUrl(tab) ?: ""
    val tabId = runCatching { Chrome.getTabId(tab, url) }.getOrDefault("")
    return JSONObject()
        .put("id", id)
        .put("url", url)
        .put("frameId", frameId ?: JSONObject.NULL)
        .put("tab", JSONObject().put("id", tabId).put("url", url).put("active", tab == Chrome.getTab()))
  }

  private fun storageObject(id: String): JSONObject {
    return storageCache.getOrPut(id) {
      val text = Chrome.getContext().getSharedPreferences("ChromeXtExtensionStorage:$id", Context.MODE_PRIVATE).getString("json", "{}") ?: "{}"
      runCatching { JSONObject(text) }.getOrDefault(JSONObject())
    }
  }

  private fun persistStorage(id: String, value: JSONObject) {
    Chrome.getContext().getSharedPreferences("ChromeXtExtensionStorage:$id", Context.MODE_PRIVATE).edit().putString("json", value.toString()).apply()
  }

  private fun storageGet(id: String, keys: Any?): JSONObject {
    val source = storageObject(id)
    if (keys == null || keys == JSONObject.NULL) return JSONObject(source.toString())
    val result = JSONObject()
    when (keys) {
      is String -> if (source.has(keys)) result.put(keys, source.get(keys))
      is JSONArray -> for (i in 0 until keys.length()) {
        val key = keys.optString(i)
        if (source.has(key)) result.put(key, source.get(key))
      }
      is JSONObject -> {
        val iterator = keys.keys()
        while (iterator.hasNext()) {
          val key = iterator.next()
          result.put(key, if (source.has(key)) source.get(key) else keys.get(key))
        }
      }
    }
    return result
  }

  private fun storageSet(id: String, data: JSONObject) {
    val source = storageObject(id)
    val changes = JSONObject()
    val iterator = data.keys()
    while (iterator.hasNext()) {
      val key = iterator.next()
      val old = if (source.has(key)) source.get(key) else JSONObject.NULL
      val value = data.get(key)
      source.put(key, value)
      changes.put(key, JSONObject().put("oldValue", old).put("newValue", value))
    }
    persistStorage(id, source)
    Chrome.broadcast("cx_extension_storage", JSONObject().put("extensionId", id).put("changes", changes).put("areaName", "local"), false) { true }
  }

  private fun storageRemove(id: String, keys: Any?) {
    val source = storageObject(id)
    val list = when (keys) {
      is JSONArray -> jsonArrayStrings(keys)
      is String -> listOf(keys)
      else -> emptyList()
    }
    list.forEach { source.remove(it) }
    persistStorage(id, source)
  }

  private fun storageClear(id: String) {
    storageCache[id] = JSONObject()
    persistStorage(id, JSONObject())
  }

  private fun tabList(query: JSONObject?): JSONArray {
    val pages = getInspectPages() ?: JSONArray()
    val result = JSONArray()
    for (i in 0 until pages.length()) {
      val page = pages.optJSONObject(i) ?: continue
      if (page.optString("type") != "page") continue
      val tab = JSONObject().put("id", page.optString("id")).put("url", page.optString("url")).put("title", page.optString("title")).put("active", page.optString("url") == Chrome.getUrl())
      if (query?.has("active") == true && query.optBoolean("active") != tab.optBoolean("active")) continue
      result.put(tab)
    }
    return result
  }

  private fun executeScript(details: JSONObject?, currentTab: Any?): JSONObject {
    if (details == null) return failure("Missing script injection details")
    val target = details.optJSONObject("target")
    val tabId = target?.optString("tabId")?.takeIf { it.isNotBlank() }
    val code = details.optString("code")
    val func = details.optString("func")
    val args = details.optJSONArray("args") ?: JSONArray()
    val expression =
        if (code.isNotBlank()) code
        else if (func.isNotBlank()) "(${func}).apply(null,${args})"
        else return failure("executeScript requires func or code")
    if (tabId != null) {
      val client = DevSessions.new(tabId, "extension")
      client.evaluateJavascript(expression)
      client.close()
    } else {
      Chrome.evaluateJavascript(listOf(expression), currentTab)
    }
    return success(JSONArray().put(JSONObject().put("result", JSONObject.NULL)))
  }

  private fun insertCss(details: JSONObject?, currentTab: Any?): JSONObject {
    if (details == null) return failure("Missing CSS injection details")
    val css = details.optString("css")
    if (css.isBlank()) return failure("insertCSS requires css")
    val expression = "(()=>{const s=document.createElement('style');s.textContent=${JSONObject.quote(css)};(document.head||document.documentElement).appendChild(s)})()"
    val target = details.optJSONObject("target")
    val tabId = target?.optString("tabId")?.takeIf { it.isNotBlank() }
    if (tabId != null) {
      val client = DevSessions.new(tabId, "extension")
      client.evaluateJavascript(expression)
      client.close()
    } else Chrome.evaluateJavascript(listOf(expression), currentTab)
    return success(JSONObject.NULL)
  }

  private fun declaredPermissions(extension: Extension): MutableSet<String> {
    val result = mutableSetOf<String>()
    result.addAll(jsonArrayStrings(extension.manifest.optJSONArray("permissions")))
    result.addAll(jsonArrayStrings(extension.manifest.optJSONArray("host_permissions")))
    return result
  }

  private fun optionalPermissions(extension: Extension): Set<String> =
      (jsonArrayStrings(extension.manifest.optJSONArray("optional_permissions")) +
              jsonArrayStrings(extension.manifest.optJSONArray("optional_host_permissions")))
          .toSet()

  private fun grantedOptional(extension: Extension): MutableSet<String> {
    val json = state.getString("permissions:${extension.id}", "[]") ?: "[]"
    return runCatching { jsonArrayStrings(JSONArray(json)).toMutableSet() }.getOrDefault(mutableSetOf())
  }

  private fun saveGranted(extension: Extension, values: Set<String>) {
    state.edit().putString("permissions:${extension.id}", JSONArray(values.toList()).toString()).apply()
  }

  private fun permissionSnapshot(extension: Extension): JSONObject {
    val all = declaredPermissions(extension) + grantedOptional(extension)
    val origins = all.filter { it.contains("://") || it == "<all_urls>" }
    val permissions = all - origins.toSet()
    return JSONObject().put("permissions", JSONArray(permissions.toList())).put("origins", JSONArray(origins))
  }

  private fun requestedPermissionSet(request: JSONObject?): Set<String> {
    if (request == null) return emptySet()
    return (jsonArrayStrings(request.optJSONArray("permissions")) + jsonArrayStrings(request.optJSONArray("origins"))).toSet()
  }

  private fun permissionContains(extension: Extension, request: JSONObject?): Boolean {
    val available = declaredPermissions(extension) + grantedOptional(extension)
    return available.containsAll(requestedPermissionSet(request))
  }

  private fun permissionRequest(extension: Extension, request: JSONObject?): Boolean {
    val requested = requestedPermissionSet(request)
    if (!optionalPermissions(extension).containsAll(requested)) return false
    val granted = grantedOptional(extension)
    granted.addAll(requested)
    saveGranted(extension, granted)
    return true
  }

  private fun permissionRemove(extension: Extension, request: JSONObject?): Boolean {
    val granted = grantedOptional(extension)
    val changed = granted.removeAll(requestedPermissionSet(request))
    if (changed) saveGranted(extension, granted)
    return changed
  }

  private fun download(options: JSONObject?): JSONObject {
    if (options == null) return failure("Missing download options")
    val url = options.optString("url")
    if (url.isBlank()) return failure("downloads.download requires url")
    val request = DownloadManager.Request(Uri.parse(url))
    val filename = options.optString("filename")
    if (filename.isNotBlank()) request.setDestinationInExternalPublicDir(android.os.Environment.DIRECTORY_DOWNLOADS, filename)
    request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
    val manager = Chrome.getContext().getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
    return success(manager.enqueue(request))
  }

  private fun notification(extension: Extension, args: JSONArray): JSONObject {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return failure("Notifications require Android 8+")
    val id = args.optString(0).ifBlank { UUID.randomUUID().toString() }
    val options = if (args.optJSONObject(0) != null) args.optJSONObject(0)!! else args.optJSONObject(1) ?: JSONObject()
    val builder = Notification.Builder(Chrome.getContext(), "xposed_notification")
        .setSmallIcon(org.matrix.chromext.R.drawable.ic_extension)
        .setContentTitle(options.optString("title", extension.manifest.optString("name")))
        .setContentText(options.optString("message"))
        .setAutoCancel(true)
    val manager = Chrome.getContext().getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    manager.notify(id, id.hashCode(), builder.build())
    return success(id)
  }

  private fun cookieGet(details: JSONObject?): JSONObject {
    if (details == null) return success(JSONObject.NULL)
    val url = details.optString("url")
    val name = details.optString("name")
    if (url.isBlank() || name.isBlank()) return success(JSONObject.NULL)
    val cookies = android.webkit.CookieManager.getInstance().getCookie(url) ?: return success(JSONObject.NULL)
    cookies.split(';').map { it.trim() }.forEach {
      val index = it.indexOf('=')
      if (index > 0 && it.substring(0, index) == name)
        return success(JSONObject().put("name", name).put("value", it.substring(index + 1)).put("url", url))
    }
    return success(JSONObject.NULL)
  }

  private fun cookieSet(details: JSONObject?): JSONObject {
    if (details == null) return failure("Missing cookie details")
    val url = details.optString("url")
    val name = details.optString("name")
    if (url.isBlank() || name.isBlank()) return failure("cookies.set requires url and name")
    val value = details.optString("value")
    val attributes = StringBuilder("$name=$value")
    if (details.has("path")) attributes.append("; Path=${details.optString("path")}")
    if (details.optBoolean("secure")) attributes.append("; Secure")
    if (details.optBoolean("httpOnly")) attributes.append("; HttpOnly")
    android.webkit.CookieManager.getInstance().setCookie(url, attributes.toString())
    return success(JSONObject().put("name", name).put("value", value).put("url", url))
  }

  private fun cookieRemove(details: JSONObject?): JSONObject {
    if (details == null) return failure("Missing cookie details")
    val copy = JSONObject(details.toString()).put("value", "").put("expirationDate", 0)
    val result = cookieSet(copy)
    return if (result.optBoolean("ok")) success(JSONObject().put("url", details.optString("url")).put("name", details.optString("name"))) else result
  }

  private fun success(value: Any? = JSONObject.NULL): JSONObject = JSONObject().put("ok", true).put("value", value ?: JSONObject.NULL)
  private fun failure(message: String): JSONObject = JSONObject().put("ok", false).put("error", message)
}
