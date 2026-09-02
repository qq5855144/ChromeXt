package org.matrix.chromext.extension

import java.lang.ref.WeakReference
import org.json.JSONObject
import org.matrix.chromext.Chrome

/**
 * Keeps the last normal top-level web page available as an extension action context.
 *
 * This avoids DevTools tab enumeration when a manager-hosted action popup asks for the active tab.
 * The weak reference is used only while the original browser tab still points at the remembered
 * page; otherwise ChromeXt keeps the URL snapshot but will not route page commands to a stale tab.
 */
object ExtensionActiveTab {
  private data class State(val tab: WeakReference<Any>, val url: String, val id: String)

  @Volatile private var state: State? = null

  fun remember(tab: Any?, url: String) {
    val target = Chrome.getTab(tab) ?: return
    if (!url.startsWith("http://") && !url.startsWith("https://")) return
    state = State(WeakReference(target), url, "cx-local-${System.identityHashCode(target)}")
  }

  fun preferred(fallback: Any? = null): Any? = liveTab() ?: Chrome.getTab(fallback)

  fun url(fallback: String? = null): String = state?.url ?: fallback ?: "about:blank"

  fun id(): String = if (liveTab() != null) state?.id.orEmpty() else ""

  fun resolve(id: String): Any? {
    val current = state ?: return null
    if (id != current.id) return null
    return liveTab()
  }

  fun snapshot(fallbackTab: Any? = null): JSONObject {
    val live = liveTab()
    val current = state
    val fallback = Chrome.getTab(fallbackTab)
    val fallbackUrl = Chrome.getUrl(fallback) ?: "about:blank"
    val url = current?.url ?: fallbackUrl
    val id = if (live != null) current?.id.orEmpty() else ""
    return JSONObject()
        .put("id", id)
        .put("url", url)
        .put("active", true)
        .put("highlighted", true)
        .put("selected", true)
        .put("pinned", false)
        .put("incognito", false)
        .put("windowId", 0)
        .put("index", 0)
        .put("status", "complete")
  }

  private fun liveTab(): Any? {
    val current = state ?: return null
    val tab = current.tab.get() ?: return null
    if (!runCatching { Chrome.checkTab(tab) }.getOrDefault(false)) return null
    val actualUrl = Chrome.getUrl(tab) ?: return null
    if (actualUrl != current.url) return null
    return tab
  }
}
