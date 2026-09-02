package org.matrix.chromext.hook

import android.content.Context
import org.matrix.chromext.Chrome
import org.matrix.chromext.extension.ExtensionRuntime
import org.matrix.chromext.proxy.BrowserProxy
import org.matrix.chromext.utils.findMethod
import org.matrix.chromext.utils.hookAfter
import org.matrix.chromext.utils.hookBefore

/** Chromium/Samsung navigation lifecycle for the extension-only product line. */
object ExtensionHook : BaseHook() {
  override fun init() {
    val proxy = BrowserProxy

    findMethod(if (Chrome.isSamsung) proxy.tabImpl else proxy.tabWebContentsDelegateAndroidImpl) {
          name == "onUpdateUrl" || name == "onUpdateTargetUrl"
        }
        .hookAfter {
          val tab = proxy.getTab(it.thisObject) ?: return@hookAfter
          var url = proxy.parseUrl(it.args[0]).orEmpty()
          if (url.isEmpty() && proxy.getUrl != null) {
            url = proxy.parseUrl(proxy.getUrl.invoke(tab)).orEmpty()
          }
          ExtensionRuntime.onNavigation(url, tab)
        }

    findMethod(proxy.chromeTabbedActivity, true) { name == "onResume" }
        .hookBefore {
          Chrome.init(it.thisObject as Context)
          ExtensionRuntime.ensureStarted()
        }

    isInit = true
  }
}
