package com.youcoded.app.ui

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Rect
import android.view.MotionEvent
import android.view.View
import android.webkit.WebView

/**
 * WebView that can forward touches to a sibling native view (the Termux
 * TerminalView) when the user taps in the middle "terminal zone" during
 * terminal mode.
 *
 * Background: on Android the terminal is a native view sitting behind a
 * transparent WebView (see ChatScreen.kt layering). The WebView normally eats
 * every touch event before it can reach the terminal, so scroll and text-selection
 * gestures never work. CSS `pointer-events: none` only affects DOM hit-testing
 * inside the WebView — Android's touch dispatch ignores it, so the WebView still
 * consumes the event.
 *
 * Fix: override `dispatchTouchEvent` to route gestures that start in the middle
 * zone (outside header/bottom chrome and outside any React-reported hotspot)
 * directly to the TerminalView via `terminalView.dispatchTouchEvent(ev)`. The
 * routing decision is made on ACTION_DOWN and held for the whole gesture so we
 * don't split a drag halfway through.
 *
 * - When [passThroughActive] is false (chat mode, or setup): the WebView behaves
 *   as a normal WebView — every touch is handled by web content.
 * - When [blocked] is true (a modal scrim is covering the terminal): pass-through
 *   is disabled so the modal stays tappable.
 * - [hotspots]: React-reported rects (viewport pixels) of floating overlays that
 *   must keep receiving touches in terminal mode (e.g. TerminalScrollButtons).
 */
@SuppressLint("ViewConstructor")
class PassThroughWebView(context: Context) : WebView(context) {

    var passThroughActive: Boolean = false
    var headerPx: Int = 0
    var bottomPx: Int = 0
    var hotspots: List<Rect> = emptyList()
    var blocked: Boolean = false
    var terminalView: View? = null

    // Sticky per-gesture decision: set on ACTION_DOWN, held through UP/CANCEL.
    // Without this, a finger drag that started in the middle but moved into the
    // chrome strip would start landing on the WebView mid-gesture, confusing
    // scroll/selection.
    private var currentGestureGoesToTerminal = false

    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        if (ev.actionMasked == MotionEvent.ACTION_DOWN) {
            currentGestureGoesToTerminal = shouldPassThrough(ev)
        }
        if (currentGestureGoesToTerminal) {
            // Forward to TerminalView. If the reference is stale/null, fall back
            // to normal WebView dispatch so we never silently drop the gesture.
            return terminalView?.dispatchTouchEvent(ev) ?: super.dispatchTouchEvent(ev)
        }
        return super.dispatchTouchEvent(ev)
    }

    private fun shouldPassThrough(ev: MotionEvent): Boolean {
        if (!passThroughActive) return false
        if (blocked) return false
        if (terminalView == null) return false
        val x = ev.x.toInt()
        val y = ev.y.toInt()
        // Outside the middle band (i.e. inside header/bottom chrome) → WebView handles it
        if (y < headerPx) return false
        if (y > (height - bottomPx)) return false
        // Inside any hotspot (e.g. floating scroll buttons) → WebView handles it
        for (rect in hotspots) {
            if (rect.contains(x, y)) return false
        }
        return true
    }
}
