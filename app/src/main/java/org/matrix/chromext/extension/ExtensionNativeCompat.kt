package org.matrix.chromext.extension

import android.app.NotificationManager
import android.content.Context
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import org.json.JSONArray
import org.json.JSONObject
import org.matrix.chromext.Chrome

/** Native compatibility helpers for WebExtension APIs not fully covered by the legacy backend. */
object ExtensionNativeCompat {
  fun clearNotification(id: String): JSONObject {
    if (id.isBlank()) return success(false)
    val manager =
        Chrome.getContext().getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    manager.cancel(id, id.hashCode())
    return success(true)
  }

  fun getAllCookies(details: JSONObject?): JSONObject {
    val url = cookieUrl(details)
    if (url.isBlank()) return success(JSONArray())
    val raw = android.webkit.CookieManager.getInstance().getCookie(url) ?: return success(JSONArray())
    val result = JSONArray()
    raw.split(';').forEach { part ->
      val token = part.trim()
      val index = token.indexOf('=')
      if (index <= 0) return@forEach
      val name = token.substring(0, index)
      val value = token.substring(index + 1)
      if (details?.has("name") == true && details.optString("name") != name) return@forEach
      result.put(cookieObject(name, value, url))
    }
    return success(result)
  }

  fun setCookie(details: JSONObject?): JSONObject {
    if (details == null) return failure("Missing cookie details")
    val url = cookieUrl(details)
    val name = details.optString("name")
    if (url.isBlank() || name.isBlank()) return failure("cookies.set requires url and name")
    val value = details.optString("value")
    val attributes = StringBuilder("$name=$value")
    val path = details.optString("path", "/")
    if (path.isNotBlank()) attributes.append("; Path=$path")
    val domain = details.optString("domain")
    if (domain.isNotBlank()) attributes.append("; Domain=$domain")
    if (details.optBoolean("secure")) attributes.append("; Secure")
    if (details.optBoolean("httpOnly")) attributes.append("; HttpOnly")
    if (details.has("expirationDate")) {
      val seconds = details.optDouble("expirationDate", 0.0)
      if (seconds > 0) attributes.append("; Expires=${httpDate((seconds * 1000).toLong())}")
    }
    when (details.optString("sameSite").lowercase(Locale.US)) {
      "no_restriction", "none" -> attributes.append("; SameSite=None")
      "lax" -> attributes.append("; SameSite=Lax")
      "strict" -> attributes.append("; SameSite=Strict")
    }
    android.webkit.CookieManager.getInstance().setCookie(url, attributes.toString())
    android.webkit.CookieManager.getInstance().flush()
    return success(cookieObject(name, value, url))
  }

  fun removeCookie(details: JSONObject?): JSONObject {
    if (details == null) return failure("Missing cookie details")
    val url = cookieUrl(details)
    val name = details.optString("name")
    if (url.isBlank() || name.isBlank()) return failure("cookies.remove requires url and name")
    val path = details.optString("path", "/")
    val domain = details.optString("domain")
    val attributes = StringBuilder("$name=; Path=$path; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT")
    if (domain.isNotBlank()) attributes.append("; Domain=$domain")
    android.webkit.CookieManager.getInstance().setCookie(url, attributes.toString())
    android.webkit.CookieManager.getInstance().flush()
    return success(JSONObject().put("url", url).put("name", name))
  }

  private fun cookieUrl(details: JSONObject?): String {
    if (details == null) return ""
    val url = details.optString("url")
    if (url.isNotBlank()) return url
    val domain = details.optString("domain").trim().trimStart('.')
    return if (domain.isBlank()) "" else "https://$domain/"
  }

  private fun cookieObject(name: String, value: String, url: String): JSONObject {
    val host = runCatching { java.net.URI(url).host ?: "" }.getOrDefault("")
    return JSONObject()
        .put("name", name)
        .put("value", value)
        .put("domain", host)
        .put("path", "/")
        .put("secure", url.startsWith("https://"))
        .put("httpOnly", false)
        .put("session", true)
        .put("storeId", "0")
  }

  private fun httpDate(milliseconds: Long): String {
    val format = SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss 'GMT'", Locale.US)
    format.timeZone = TimeZone.getTimeZone("GMT")
    return format.format(Date(milliseconds))
  }

  private fun success(value: Any?): JSONObject =
      JSONObject().put("ok", true).put("value", value ?: JSONObject.NULL)

  private fun failure(message: String): JSONObject =
      JSONObject().put("ok", false).put("error", message)
}
