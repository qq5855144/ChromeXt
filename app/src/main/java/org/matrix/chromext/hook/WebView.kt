package org.matrix.chromext.hook

import android.os.Handler
import java.lang.ref.WeakReference
import org.matrix.chromext.Chrome
import org.matrix.chromext.extension.ExtensionRuntime
import org.matrix.chromext.utils.Log
import org.matrix.chromext.utils.findMethod
import org.matrix.chromext.utils.hookAfter
import org.matrix.chromext.utils.invokeMethod

/** WebView lifecycle used by the extension-only product line. */
object WebViewHook : BaseHook() {

  var ViewClient: Class<*>? = null
  var ChromeClient: Class<*>? = null
  var WebView: Class<*>? = null
  val records = mutableListOf<WeakReference<Any>>()

  fun evaluateJavascript(code: String?, view: Any?) {
    val webView = (view ?: Chrome.getTab())
    if (!code.isNullOrEmpty() && webView != null) {
      val webSettings = webView.invokeMethod { name == "getSettings" }
      if (webSettings?.invokeMethod { name == "getJavaScriptEnabled" } == true) {
        Handler(Chrome.getContext().mainLooper).post {
          webView.invokeMethod(code, null) { name == "evaluateJavascript" }
        }
      }
    }
  }

  override fun init() {
    findMethod(ChromeClient!!, true) { name == "onConsoleMessage" && parameterCount == 1 }
        .hookAfter {
          val consoleMessage = it.args[0]
          val messageLevel = consoleMessage.invokeMethod { name == "messageLevel" }
          val sourceId = consoleMessage.invokeMethod { name == "sourceId" } as String
          val lineNumber = consoleMessage.invokeMethod { name == "lineNumber" }
          val message = consoleMessage.invokeMethod { name == "message" } as String
          Log.d(messageLevel.toString() + ": [${sourceId}@${lineNumber}] ${message}")
        }

    fun onUpdateUrl(url: String, view: Any?) {
      if (url.startsWith("javascript", ignoreCase = true) || view == null) return
      ExtensionRuntime.onNavigation(url, view)
    }

    findMethod(WebView!!) { name == "setWebChromeClient" }
        .hookAfter {
          val webView = it.thisObject
          records.removeAll(records.filter { it.get() == null || it.get() == webView })
          if (it.args[0] != null) records.add(WeakReference(webView))
        }

    findMethod(WebView!!) { name == "onAttachedToWindow" }
        .hookAfter { Chrome.updateTab(it.thisObject) }

    findMethod(ViewClient!!, true) { name == "onPageStarted" }
        .hookAfter {
          if (Chrome.isQihoo && it.thisObject::class.java.declaredMethods.size > 1) return@hookAfter
          onUpdateUrl(it.args[1] as String, it.args[0])
        }

    isInit = true
  }
}
