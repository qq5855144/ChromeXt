package org.matrix.chromext.extension

import android.util.Base64
import java.io.ByteArrayOutputStream
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import org.json.JSONObject

/** Builds a safe ZIP stream from a browser directory-picker upload and reuses LocalFiles installer. */
object UnpackedExtensionInstaller {
  private const val MAX_FILES = 6000
  private const val MAX_TOTAL_BYTES = 32 * 1024 * 1024

  private data class Session(
      val files: MutableMap<String, ByteArrayOutputStream> = linkedMapOf(),
      var total: Int = 0,
  )

  private val sessions = ConcurrentHashMap<String, Session>()

  fun begin(token: String): JSONObject {
    if (token.isBlank()) return failure("Invalid folder upload token")
    sessions[token] = Session()
    return success().put("token", token)
  }

  fun append(token: String, path: String, base64: String): JSONObject {
    val session = sessions[token] ?: return failure("Folder upload session expired")
    val normalized = normalizePath(path) ?: return failure("Unsafe extension path")
    if (!session.files.containsKey(normalized) && session.files.size >= MAX_FILES) {
      sessions.remove(token)
      return failure("Extension contains too many files")
    }
    val bytes = runCatching { Base64.decode(base64, Base64.DEFAULT) }.getOrNull()
        ?: return failure("Invalid folder data")
    if (session.total + bytes.size > MAX_TOTAL_BYTES) {
      sessions.remove(token)
      return failure("Unpacked extension is larger than 32 MB")
    }
    session.files.getOrPut(normalized) { ByteArrayOutputStream() }.write(bytes)
    session.total += bytes.size
    return success().put("received", session.total).put("files", session.files.size)
  }

  fun finish(token: String, name: String): JSONObject {
    val session = sessions.remove(token) ?: return failure("Folder upload session expired")
    if (session.files.keys.none { it.endsWith("manifest.json") }) return failure("manifest.json not found")
    return runCatching {
          val zipBytes = ByteArrayOutputStream()
          ZipOutputStream(zipBytes).use { zip ->
            session.files.forEach { (path, data) ->
              zip.putNextEntry(ZipEntry(path))
              data.writeTo(zip)
              zip.closeEntry()
            }
          }
          if (zipBytes.size() > MAX_TOTAL_BYTES) return failure("Packed extension is larger than 32 MB")
          val packageToken = "folder-${UUID.randomUUID()}"
          LocalFiles.beginInstall(packageToken, if (name.isBlank()) "unpacked-extension.zip" else "$name.zip")
          val bytes = zipBytes.toByteArray()
          var offset = 0
          val chunkSize = 96 * 1024
          while (offset < bytes.size) {
            val end = minOf(offset + chunkSize, bytes.size)
            val chunk = Base64.encodeToString(bytes.copyOfRange(offset, end), Base64.NO_WRAP)
            val result = LocalFiles.appendInstall(packageToken, chunk)
            if (!result.optBoolean("ok")) return result
            offset = end
          }
          LocalFiles.finishInstall(packageToken)
        }
        .getOrElse { failure(it.message ?: "Failed to import unpacked extension") }
  }

  private fun normalizePath(path: String): String? {
    val normalized = path.replace('\\', '/').trimStart('/')
    if (normalized.isBlank() || normalized.startsWith("../") || normalized.contains("/../") || normalized == "..") return null
    return normalized.split('/').filter { it.isNotBlank() && it != "." }.joinToString("/")
  }

  private fun success(): JSONObject = JSONObject().put("ok", true)
  private fun failure(message: String): JSONObject = JSONObject().put("ok", false).put("error", message)
}
