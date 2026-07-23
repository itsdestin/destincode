package com.youcoded.app.util

import org.json.JSONObject

/** Iterate a JSONObject's keys without the manual keys()/hasNext()/next() dance. */
inline fun JSONObject.forEachKey(action: (String) -> Unit) {
    val it = keys()
    while (it.hasNext()) action(it.next())
}
