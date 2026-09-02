package org.matrix.chromext.utils

import android.content.Context
import android.graphics.PixelFormat
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.ImageView
import org.json.JSONObject

/**
 * ChromeXt floating entry controller.
 *
 * Stores the floating entry position as normalized coordinates so it survives
 * resolution, rotation and navigation bar changes.
 */
object FloatingButtonManager {
  private const val PREF = "chromext_floating_button"
  private const val KEY_POSITION = "position"

  private var view: ImageView? = null
  private var params: WindowManager.LayoutParams? = null

  fun show(context: Context, icon: Int? = null, onClick: (() -> Unit)? = null) {
    if (view != null) return

    val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    val button = ImageView(context)
    icon?.let { button.setImageResource(it) }

    val saved = loadPosition(context)
    val lp = WindowManager.LayoutParams().apply {
      width = 56
      height = 56
      gravity = Gravity.TOP or Gravity.START
      format = PixelFormat.TRANSLUCENT
      type = WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
      x = ((saved.first * 1000).toInt())
      y = ((saved.second * 2000).toInt())
    }

    var downX = 0f
    var downY = 0f
    var startX = 0
    var startY = 0

    button.setOnTouchListener { _, event ->
      when (event.action) {
        MotionEvent.ACTION_DOWN -> {
          downX = event.rawX
          downY = event.rawY
          startX = lp.x
          startY = lp.y
          true
        }
        MotionEvent.ACTION_MOVE -> {
          lp.x = startX + (event.rawX - downX).toInt()
          lp.y = startY + (event.rawY - downY).toInt()
          wm.updateViewLayout(button, lp)
          true
        }
        MotionEvent.ACTION_UP -> {
          if (kotlin.math.abs(event.rawX - downX) < 10 &&
              kotlin.math.abs(event.rawY - downY) < 10) {
            onClick?.invoke()
          }
          savePosition(context, lp)
          true
        }
        else -> false
      }
    }

    wm.addView(button, lp)
    view = button
    params = lp
  }

  fun hide(context: Context) {
    val v = view ?: return
    val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    runCatching { wm.removeView(v) }
    view = null
    params = null
  }

  private fun savePosition(context: Context, lp: WindowManager.LayoutParams) {
    val json = JSONObject()
      .put("x", lp.x / 1000f)
      .put("y", lp.y / 2000f)
    context.getSharedPreferences(PREF, Context.MODE_PRIVATE)
      .edit()
      .putString(KEY_POSITION, json.toString())
      .apply()
  }

  private fun loadPosition(context: Context): Pair<Float, Float> {
    return runCatching {
      val json = JSONObject(
        context.getSharedPreferences(PREF, Context.MODE_PRIVATE)
          .getString(KEY_POSITION, "{}") ?: "{}"
      )
      Pair(json.optDouble("x", 0.9).toFloat(), json.optDouble("y", 0.5).toFloat())
    }.getOrDefault(Pair(0.9f, 0.5f))
  }
}
