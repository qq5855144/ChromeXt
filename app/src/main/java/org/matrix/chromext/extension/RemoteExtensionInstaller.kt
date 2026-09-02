package org.matrix.chromext.extension

import android.util.Base64
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.net.URLEncoder
import java.util.UUID
import org.json.JSONObject
import org.matrix.chromext.utils.Log

/** Downloads extension packages outside the WebView/CORS sandbox and feeds them to the safe package installer. */
object RemoteExtensionInstaller {
  private const val MAX_PACKAGE_BYTES = 32 * 1024 * 1024
  private const val MAX_REDIRECTS = 6
  private const val CONNECT_TIMEOUT_MS = 15_000
  private const val READ_TIMEOUT_MS = 30_000

  fun install(source: String): JSONObject {
    val resolved = resolveSource(source)
        ?: return failure("请输入有效的 HTTPS/HTTP 扩展地址或 Chrome Web Store 地址")
    val sourceId = webStoreId(source)
    val token = "remote-${UUID.randomUUID()}"
    val name = sourceName(source, resolved)
    val started = LocalFiles.beginInstall(token, name)
    if (!started.optBoolean("ok")) return started

    var completed = false
    return try {
      val connection = open(resolved)
      try {
        val length = connection.contentLength
        if (length > MAX_PACKAGE_BYTES) return failure("扩展安装失败：下载文件超过 32 MB")
        val buffer = ByteArray(24 * 1024)
        var total = 0
        connection.inputStream.use { input ->
          while (true) {
            val count = input.read(buffer)
            if (count <= 0) break
            total += count
            if (total > MAX_PACKAGE_BYTES) return failure("扩展安装失败：下载文件超过 32 MB")
            val encoded = Base64.encodeToString(buffer, 0, count, Base64.NO_WRAP)
            val appended = LocalFiles.appendInstall(token, encoded)
            if (!appended.optBoolean("ok")) return appended
          }
        }
        if (total == 0) return failure("扩展安装失败：下载内容为空")
        val result =
            LocalFiles.finishInstall(token)
                .put("sourceUrl", source)
                .put("resolvedUrl", resolved.toString())
        if (result.optBoolean("ok") && sourceId != null) {
          val internalId = result.optJSONObject("extension")?.optString("id")
          ExtensionUrl.registerAlias(sourceId, internalId)
          result.put("webStoreId", sourceId)
        }
        completed = true
        result
      } finally {
        connection.disconnect()
      }
    } catch (error: Throwable) {
      Log.e("Direct extension install failed: ${error.message}")
      failure("扩展下载失败：${error.message ?: error::class.java.simpleName}")
    } finally {
      // finishInstall consumes the upload session. Consume partial sessions too so failed downloads do not leak memory.
      if (!completed) runCatching { LocalFiles.finishInstall(token) }
    }
  }

  private fun open(initial: URL): HttpURLConnection {
    var url = initial
    repeat(MAX_REDIRECTS + 1) { index ->
      val connection = (url.openConnection() as HttpURLConnection).apply {
        instanceFollowRedirects = false
        connectTimeout = CONNECT_TIMEOUT_MS
        readTimeout = READ_TIMEOUT_MS
        requestMethod = "GET"
        setRequestProperty("Accept", "application/x-chrome-extension, application/zip, application/octet-stream, */*")
        setRequestProperty("User-Agent", "ChromeXt Extension Installer")
      }
      val status = connection.responseCode
      if (status in 300..399) {
        val location = connection.getHeaderField("Location")
            ?: throw IllegalArgumentException("扩展下载重定向缺少 Location")
        connection.disconnect()
        if (index >= MAX_REDIRECTS) throw IllegalArgumentException("扩展下载重定向次数过多")
        url = URL(url, location)
        if (url.protocol != "https" && url.protocol != "http")
          throw IllegalArgumentException("不支持的下载协议：${url.protocol}")
      } else {
        if (status !in 200..299) {
          connection.disconnect()
          throw IllegalArgumentException("扩展下载失败：HTTP $status")
        }
        return connection
      }
    }
    throw IllegalArgumentException("扩展下载重定向次数过多")
  }

  private fun resolveSource(input: String): URL? {
    val text = input.trim()
    if (text.isEmpty()) return null
    val uri = runCatching { URI(text) }.getOrNull() ?: return null
    if (uri.scheme != "https" && uri.scheme != "http") return null
    val id = webStoreId(text)
    if (id != null) {
      val x = URLEncoder.encode("id=$id&installsource=ondemand&uc", "UTF-8")
      return URL(
          "https://clients2.google.com/service/update2/crx" +
              "?response=redirect&prodversion=130.0.0.0&acceptformat=crx2,crx3&x=$x")
    }
    return runCatching { uri.toURL() }.getOrNull()
  }

  private fun webStoreId(input: String): String? {
    val uri = runCatching { URI(input.trim()) }.getOrNull() ?: return null
    val host = uri.host?.lowercase() ?: return null
    if (host != "chromewebstore.google.com" && host != "chrome.google.com") return null
    return Regex("[a-p]{32}", RegexOption.IGNORE_CASE)
        .findAll(uri.path ?: "")
        .lastOrNull()
        ?.value
        ?.lowercase()
  }

  private fun sourceName(source: String, resolved: URL): String {
    val original = runCatching { URI(source.trim()).path.substringAfterLast('/') }.getOrDefault("")
    if (original.endsWith(".crx", true) || original.endsWith(".zip", true)) return original
    val resolvedName = resolved.path.substringAfterLast('/')
    if (resolvedName.endsWith(".crx", true) || resolvedName.endsWith(".zip", true)) return resolvedName
    return "extension.crx"
  }

  private fun failure(message: String): JSONObject = JSONObject().put("ok", false).put("error", message)
}
