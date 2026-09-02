package org.matrix.chromext.extension

import org.matrix.chromext.Chrome
import org.matrix.chromext.BuildConfig
import org.matrix.chromext.utils.Log

/**
 * Process-level runtime entry for the extension-only branch.
 *
 * The first milestone only owns extension package/resource initialization. Content scripts,
 * background workers and API routing are added behind this boundary instead of reusing the
 * UserScript runtime.
 */
object ExtensionRuntime {
  @Volatile private var started = false

  fun ensureStarted() {
    if (started) return
    synchronized(this) {
      if (started) return
      started = true
      Chrome.IO.submit {
        runCatching { LocalFiles.start() }
            .onFailure {
              started = false
              if (BuildConfig.DEBUG) Log.ex(it)
            }
      }
    }
  }

  fun onNavigation(url: String, tab: Any?) {
    if (url.startsWith("javascript:", ignoreCase = true)) return
    if (tab != null) Chrome.updateTab(tab)
    ensureStarted()
  }
}
