package com.aigateway.app.ui.user

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.aigateway.app.App
import com.aigateway.app.R
import com.aigateway.app.databinding.ActivityPluginWebBinding





class PluginWebActivity : AppCompatActivity() {

    private lateinit var b: ActivityPluginWebBinding
    private val app get() = application as App

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        b = ActivityPluginWebBinding.inflate(layoutInflater)
        setContentView(b.root)

        val pluginId = intent.getStringExtra("pluginId") ?: run { finish(); return }
        val userPage = intent.getStringExtra("userPage") ?: "pages/user.html"
        val name = intent.getStringExtra("name") ?: getString(R.string.uh_plugins)
        setSupportActionBar(b.pwToolbar)
        supportActionBar?.setDisplayHomeAsUpEnabled(true)
        supportActionBar?.title = name
        b.pwToolbar.setNavigationOnClickListener { finish() }

        
        val url = app.userStore.apiRoot() + "/plugins/" + pluginId + "/" + userPage
        val gatewayHost = try { android.net.Uri.parse(app.userStore.serverUrl).host } catch (_: Exception) { null }

        b.pwWeb.settings.javaScriptEnabled = true
        b.pwWeb.settings.domStorageEnabled = true
        b.pwWeb.addJavascriptInterface(Bridge(), "AGW")
        b.pwWeb.webViewClient = object : WebViewClient() {
            
            override fun shouldOverrideUrlLoading(view: WebView, request: android.webkit.WebResourceRequest): Boolean {
                val h = request.url.host
                return if (gatewayHost != null && h == gatewayHost) false
                else { try { startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, request.url)) } catch (_: Exception) {} ; true }
            }
        }
        b.pwWeb.loadUrl(url)
    }

    
    inner class Bridge {
        
        @JavascriptInterface fun getToken(): String = app.userStore.token
        
        @JavascriptInterface fun getUserName(): String = app.userStore.userName
        
        @JavascriptInterface fun close() { runOnUiThread { finish() } }
        @JavascriptInterface fun toast(msg: String) { runOnUiThread { Toast.makeText(this@PluginWebActivity, msg, Toast.LENGTH_SHORT).show() } }
    }

    override fun onDestroy() { b.pwWeb.destroy(); super.onDestroy() }

    override fun onBackPressed() {
        if (b.pwWeb.canGoBack()) b.pwWeb.goBack() else super.onBackPressed()
    }
}
