package com.destins.claudemobile

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.material3.Text
import com.destins.claudemobile.ui.theme.ClaudeMobileTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            ClaudeMobileTheme {
                Text("Claude Mobile — bootstrapping...")
            }
        }
    }
}
