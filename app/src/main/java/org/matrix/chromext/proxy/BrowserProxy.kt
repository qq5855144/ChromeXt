package org.matrix.chromext.proxy

import java.lang.reflect.Modifier
import org.matrix.chromext.Chrome
import org.matrix.chromext.utils.Log
import org.matrix.chromext.utils.findField
import org.matrix.chromext.utils.findMethodOrNull

/**
 * Browser navigation/tab reflection used by the extension-only product line.
 *
 * This proxy deliberately contains no UserScript storage, metadata or GM runtime dependencies.
 */
object BrowserProxy {
  val gURL = Chrome.load("org.chromium.url.GURL")

  val tabWebContentsDelegateAndroidImpl =
      if (Chrome.isSamsung) {
        Chrome.load("com.sec.android.app.sbrowser.tab.Tab")
      } else {
        Chrome.load("org.chromium.chrome.browser.tab.TabWebContentsDelegateAndroidImpl")
      }

  val chromeTabbedActivity =
      if (Chrome.isSamsung) {
        Chrome.load("com.sec.terrace.TerraceActivity")
      } else {
        Chrome.load("org.chromium.chrome.browser.ChromeTabbedActivity")
      }

  val tabImpl =
      if (Chrome.isSamsung) {
        Chrome.load("com.sec.terrace.Terrace")
      } else {
        Chrome.load("org.chromium.chrome.browser.tab.TabImpl")
      }

  private val getId = findMethodOrNull(tabImpl) { name == "getId" }

  private val mId =
      (if (Chrome.isSamsung) tabWebContentsDelegateAndroidImpl else tabImpl)
          .declaredFields
          .run {
            val named = find { it.name == "mId" }
            if (named != null) return@run named

            val profile = Chrome.load("org.chromium.chrome.browser.profiles.Profile")
            val windowAndroid = Chrome.load("org.chromium.ui.base.WindowAndroid")
            var startIndex = indexOfFirst { it.type == gURL }
            val endIndex = indexOfFirst { it.type == profile || it.type == windowAndroid }
            if (startIndex == -1 || endIndex == -1 || startIndex > endIndex) startIndex = 0
            slice(startIndex until maxOf(startIndex + 1, endIndex))
                .findLast { it.type == Int::class.java && !Modifier.isStatic(it.modifiers) }
                ?: findLast { it.type == Int::class.java && !Modifier.isStatic(it.modifiers) }
                ?: error("Unable to locate browser tab id")
          }
          .also { it.isAccessible = true }

  val mTab = findField(tabWebContentsDelegateAndroidImpl) { type == tabImpl }
  val getUrl = findMethodOrNull(tabImpl) { returnType == gURL }

  fun getTab(delegate: Any): Any? = if (Chrome.isSamsung) delegate else mTab.get(delegate)

  fun getTabId(tab: Any): String {
    val id = if (getId != null) getId.invoke(tab) else mId.get(tab)
    return id.toString()
  }

  fun parseUrl(packed: Any?): String? {
    if (packed == null) return null
    if (packed is String) return packed
    if (packed::class.java == gURL) {
      val mSpec = gURL.getDeclaredField("a").also { it.isAccessible = true }
      return mSpec.get(packed) as? String
    }
    Log.w("BrowserProxy.parseUrl: unsupported ${packed::class.java.name}")
    return null
  }
}
