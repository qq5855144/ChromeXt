package org.matrix.chromext.extension

import org.matrix.chromext.Chrome

/** Additional soft API namespaces used by complex MV2/MV3 extensions. */
object ExtensionCompat {
  val script: String by lazy {
    Chrome.getContext().assets.open("extension_compat.js").bufferedReader().use { it.readText() }
  }
}
