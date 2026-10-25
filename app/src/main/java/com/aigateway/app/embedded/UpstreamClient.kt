package com.aigateway.app.embedded

import com.aigateway.app.data.Proxy
import okhttp3.Credentials
import okhttp3.OkHttpClient
import java.net.Authenticator
import java.net.InetSocketAddress
import java.net.PasswordAuthentication
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/**
 * 上游 HTTP 客户端工厂 —— 按 (代理 + insecure) 缓存 OkHttpClient。
 * 支持 直连 / HTTP 代理(带认证) / SOCKS5 代理(认证经全局 Authenticator, 简化)。
 * insecure=true 跳过证书校验(自签名中转站, 对应 Node 版 channels[].insecure)。
 */
object UpstreamClient {

    private val cache = ConcurrentHashMap<String, OkHttpClient>()

    fun clientFor(proxy: Proxy?, insecure: Boolean = false): OkHttpClient {
        val key = (if (proxy == null) "__direct__"
        else "${proxy.type}|${proxy.host}|${proxy.port}|${proxy.username ?: ""}") + "|ins=$insecure"
        return cache.getOrPut(key) { build(proxy, insecure) }
    }

    private fun build(proxy: Proxy?, insecure: Boolean): OkHttpClient {
        val b = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(300, TimeUnit.SECONDS)
            .writeTimeout(120, TimeUnit.SECONDS)
            .followRedirects(true)
            .followSslRedirects(true)

        if (insecure) applyInsecure(b)

        if (proxy != null && proxy.host.isNotBlank() && proxy.port > 0) {
            val addr = InetSocketAddress.createUnresolved(proxy.host, proxy.port)
            when (proxy.type.lowercase()) {
                "http", "https" -> {
                    b.proxy(java.net.Proxy(java.net.Proxy.Type.HTTP, addr))
                    if (!proxy.username.isNullOrEmpty()) {
                        val user = proxy.username
                        val pass = proxy.password ?: ""
                        b.proxyAuthenticator { _, response ->
                            val cred = Credentials.basic(user, pass)
                            response.request.newBuilder().header("Proxy-Authorization", cred).build()
                        }
                    }
                }
                else -> { // socks5
                    b.proxy(java.net.Proxy(java.net.Proxy.Type.SOCKS, addr))
                    if (!proxy.username.isNullOrEmpty()) {
                        val user = proxy.username
                        val pass = proxy.password ?: ""
                        Authenticator.setDefault(object : Authenticator() {
                            override fun getPasswordAuthentication(): PasswordAuthentication =
                                PasswordAuthentication(user, pass.toCharArray())
                        })
                    }
                }
            }
        }
        return b.build()
    }

    @Suppress("CustomX509TrustManager", "TrustAllX509TrustManager")
    private fun applyInsecure(b: OkHttpClient.Builder) {
        val trustAll = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {}
            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {}
            override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
        }
        val ctx = SSLContext.getInstance("TLS")
        ctx.init(null, arrayOf(trustAll), SecureRandom())
        b.sslSocketFactory(ctx.socketFactory, trustAll)
        b.hostnameVerifier { _, _ -> true }
    }

    fun clear() = cache.clear()
}
