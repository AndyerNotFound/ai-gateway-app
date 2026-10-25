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

/**
 * 插件页容器：WebView 加载插件前端页（user.html），通过白名单 JSBridge 提供原生能力。
 * 安全：仅放行本网关域名；JSBridge 只暴露 getToken/callApi/close/toast。
 */
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

        // 插件页 URL：apiRoot(带分支前缀) + /plugins/<id>/<userPage>
        val url = app.userStore.apiRoot() + "/plugins/" + pluginId + "/" + userPage
        val gatewayHost = try { android.net.Uri.parse(app.userStore.serverUrl).host } catch (_: Exception) { null }

        b.pwWeb.settings.javaScriptEnabled = true
        b.pwWeb.settings.domStorageEnabled = true
        b.pwWeb.addJavascriptInterface(Bridge(), "AGW")
        b.pwWeb.webViewClient = object : WebViewClient() {
            // 域白名单：只放行本网关，外链用系统浏览器
            override fun shouldOverrideUrlLoading(view: WebView, request: android.webkit.WebResourceRequest): Boolean {
                val h = request.url.host
                return if (gatewayHost != null && h == gatewayHost) false
                else { try { startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, request.url)) } catch (_: Exception) {} ; true }
            }
        }
        b.pwWeb.loadUrl(url)
    }

    /** 白名单 JSBridge：插件页通过 window.AGW.xxx 调用 */
    inner class Bridge {
        /** 当前登录卡密（插件页调 API 用，如同源 fetch 带 token） */
        @JavascriptInterface fun getToken(): String = app.userStore.token
        /** 当前用户名/昵称 */
        @JavascriptInterface fun getUserName(): String = app.userStore.userName
        /** 插件 API 基址（/plugins/<id>） */
        @JavascriptInterface fun close() { runOnUiThread { finish() } }
        @JavascriptInterface fun toast(msg: String) { runOnUiThread { Toast.makeText(this@PluginWebActivity, msg, Toast.LENGTH_SHORT).show() } }
    }

    override fun onDestroy() { b.pwWeb.destroy(); super.onDestroy() }

    override fun onBackPressed() {
        if (b.pwWeb.canGoBack()) b.pwWeb.goBack() else super.onBackPressed()
    }
}
