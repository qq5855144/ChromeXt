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
 * Position is stored as normalized coordinates and restored after restart,
 * rotation and different screen sizes.
 */
object FloatingButtonManager {
  private const val PREF = "chromext_floating_button"
  private const val KEY_POSITION = "position"

  private var view: ImageView? = null

  fun show(context: Context, icon: Int? = null, onClick: (() -> Unit)? = null) {
    if (view != null) return

    val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    val button = ImageView(context).apply {
      isClickable = true
      isFocusable = true
      icon?.let { setImageResource(it) }
    }

    val saved = loadPosition(context)
    val lp = WindowManager.LayoutParams().apply {
      width = 56
      height = 56
      gravity = Gravity.TOP or Gravity.START
      format = PixelFormat.TRANSLUCENT
      type = WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
      x = (saved.first * 1000).toInt()
      y = (saved.second * 2000).toInt()
    }

    var downX = 0f
    var downY = 0f
    var startX = 0
    var startY = 0
    var moved = false

    button.setOnTouchListener { _, event ->
      when (event.action) {
        MotionEvent.ACTION_DOWN -> {
          downX = event.rawX
          downY = event.rawY
          startX = lp.x
          startY = lp.y
          moved = false
          true
        }
        MotionEvent.ACTION_MOVE -> {
          val dx = event.rawX - downX
          val dy = event.rawY - downY
          if (kotlin.math.abs(dx) > 8 || kotlin.math.abs(dy) > 8) moved = true
          lp.x = (startX + dx).toInt()
          lp.y = (startY + dy).toInt()
          wm.updateViewLayout(button, lp)
          true
        }
        MotionEvent.ACTION_UP -> {
          if (!moved) onClick?.invoke()
          savePosition(context, lp)
          true
        }
        else -> false
      }
    }

    wm.addView(button, lp)
    view = button
  }

  fun hide(context: Context) {
    view?.let {
      runCatching {
        (context.getSystemService(Context.WINDOW_SERVICE) as WindowManager).removeView(it)
      }
    }
    view = null
  }

  fun restorePosition(view: View, context: Context) {
    val pos = loadPosition(context)
    view.post {
      view.x = pos.first * view.resources.displayMetrics.widthPixels
      view.y = pos.second * view.resources.displayMetrics.heightPixels
    }
  }

  private fun savePosition(context: Context, lp: WindowManager.LayoutParams) {
    val metrics = context.resources.displayMetrics
    val json = JSONObject()
      .put("x", (lp.x.toFloat() / metrics.widthPixels).coerceIn(0f, 1f))
      .put("y", (lp.y.toFloat() / metrics.heightPixels).coerceIn(0f, 1f))

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
      Pair(
        json.optDouble("x", 0.92).toFloat(),
        json.optDouble("y", 0.55).toFloat()
      )
    }.getOrDefault(Pair(0.92f, 0.55f))
  }
}
