package com.aigateway.app.ui

import android.annotation.SuppressLint
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.webkit.WebViewClient
import com.aigateway.app.R
import com.aigateway.app.databinding.FragmentPanelBinding


class PanelFragment : BaseFragment() {

    private var _b: FragmentPanelBinding? = null
    private val b get() = _b!!

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _b = FragmentPanelBinding.inflate(inflater, container, false)
        return b.root
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        b.panelWeb.settings.javaScriptEnabled = true
        b.panelWeb.settings.domStorageEnabled = true
        b.panelWeb.webViewClient = object : WebViewClient() {
            override fun onPageFinished(v: WebView?, url: String?) {
                b.panelLoading.visibility = View.GONE
            }
        }
        b.panelRefresh.setOnClickListener { load() }
        load()
    }

    private fun load() {
        val backend = backendOrNull()
        val url = backend?.panelUrl()
        if (url == null) {
            b.panelLoading.visibility = View.GONE
            return
        }
        b.panelLoading.visibility = View.VISIBLE
        b.panelWeb.loadUrl(url)
    }

    override fun reload() { if (_b != null) load() }

    fun canGoBack(): Boolean = _b?.panelWeb?.canGoBack() == true
    fun goBack() { _b?.panelWeb?.goBack() }
}
