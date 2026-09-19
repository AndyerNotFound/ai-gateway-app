package com.aigateway.app.termux

import android.content.ActivityNotFoundException
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.File







object TermuxHelper {

    const val TERMUX_PACKAGE = "com.termux"
    private const val RUN_COMMAND_SERVICE = "com.termux.app.RunCommandService"
    private const val BASH = "/data/data/com.termux/files/usr/bin/bash"

    





    private data class Proto(
        val action: String,
        val path: String,
        val args: String,
        val workdir: String,
        val background: String,
        val sessionAction: String
    )

    private fun proto(variant: String): Proto =
        if (variant == "official") {
            Proto(
                "com.termux.app.RUN_COMMAND",
                "com.termux.app.RUN_COMMAND_PATH",
                "com.termux.app.RUN_COMMAND_ARGUMENTS",
                "com.termux.app.RUN_COMMAND_WORKDIR",
                "com.termux.app.RUN_COMMAND_BACKGROUND",
                "com.termux.app.RUN_COMMAND_SESSION_ACTION"
            )
        } else {
            Proto(
                "com.termux.RUN_COMMAND",
                "com.termux.RUN_COMMAND_PATH",
                "com.termux.RUN_COMMAND_ARGUMENTS",
                "com.termux.RUN_COMMAND_WORKDIR",
                "com.termux.RUN_COMMAND_BACKGROUND",
                "com.termux.RUN_COMMAND_SESSION_ACTION"
            )
        }

    
    private fun variant(context: Context): String =
        context.getSharedPreferences("ai_gateway_settings", Context.MODE_PRIVATE)
            .getString("termux_variant", "zero") ?: "zero"

    
    fun isTermuxInstalled(context: Context): Boolean {
        val pm = context.packageManager
        
        try {
            pm.getPackageInfo(TERMUX_PACKAGE, 0)
            return true
        } catch (_: Exception) {}
        
        try {
            if (pm.getLaunchIntentForPackage(TERMUX_PACKAGE) != null) return true
        } catch (_: Exception) {}
        
        try {
            val ok = listOf("zero", "official").any { v ->
                val intent = Intent(proto(v).action).setClassName(TERMUX_PACKAGE, RUN_COMMAND_SERVICE)
                pm.queryIntentServices(intent, 0).isNotEmpty()
            }
            if (ok) return true
        } catch (_: Exception) {}
        
        return try { java.io.File("/data/data/com.termux/files/usr/bin/bash").exists() } catch (_: Exception) { false }
    }

    
    fun isRunCommandAvailable(context: Context): Boolean = try {
        listOf("zero", "official").any { v ->
            val intent = Intent(proto(v).action).setClassName(TERMUX_PACKAGE, RUN_COMMAND_SERVICE)
            context.packageManager.queryIntentServices(intent, 0).isNotEmpty()
        }
    } catch (_: Exception) { false }

    
    fun openTermux(context: Context): Boolean {
        val intent = context.packageManager.getLaunchIntentForPackage(TERMUX_PACKAGE) ?: return false
        return try {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            true
        } catch (e: ActivityNotFoundException) {
            false
        }
    }

    
    sealed class RunResult {
        object Success : RunResult()
        object NotInstalled : RunResult()
        data class Failed(val reason: String) : RunResult()
    }

    



    fun runCommandDetailed(context: Context, command: String, background: Boolean = true): RunResult {
        if (!isTermuxInstalled(context)) return RunResult.NotInstalled
        val p = proto(variant(context))
        return try {
            val intent = Intent(p.action)
            intent.setClassName(TERMUX_PACKAGE, RUN_COMMAND_SERVICE)
            intent.putExtra(p.path, BASH)
            intent.putExtra(p.args, arrayOf("-lc", command))
            intent.putExtra(p.workdir, "/data/data/com.termux/files/home")
            intent.putExtra(p.background, background)
            intent.putExtra(p.sessionAction, "0")
            
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
            RunResult.Success
        } catch (e: SecurityException) {
            
            RunResult.Failed("permission")
        } catch (e: Exception) {
            RunResult.Failed(e.message ?: "unknown")
        }
    }

    fun runCommand(context: Context, command: String, background: Boolean = true): Boolean =
        runCommandDetailed(context, command, background) is RunResult.Success

    

    
    fun startBackend(context: Context): Boolean =
        runCommand(context, START_CMD, background = true)

    const val START_CMD = "bash ~/ai-gateway/agw.sh start"

    
    fun startBackendDetailed(context: Context): RunResult =
        runCommandDetailed(context, START_CMD, background = true)

    
    fun stopBackend(context: Context): Boolean =
        runCommand(context, "bash ~/ai-gateway/agw.sh stop", background = true)

    
    fun restartBackend(context: Context): Boolean =
        runCommand(context, "bash ~/ai-gateway/agw.sh restart", background = true)

    
    fun checkBackendStatus(context: Context): Boolean =
        runCommand(context, "bash ~/ai-gateway/agw.sh status", background = true)

    

    private const val DEPLOY_DIR = "ai-gateway-deploy"

    



    fun deployGatewayFiles(context: Context): Boolean {
        return try {
            val assetFiles = context.assets.list("gateway") ?: return false
            for (name in assetFiles) {
                val bytes = context.assets.open("gateway/$name").readBytes()
                writeToDownload(context, DEPLOY_DIR, name, bytes)
            }
            
            val installScript = buildInstallScript()
            writeToDownload(context, DEPLOY_DIR, "install.sh", installScript.toByteArray(Charsets.UTF_8))
            true
        } catch (e: Exception) {
            false
        }
    }

    private fun writeToDownload(context: Context, dir: String, fileName: String, content: ByteArray): Uri? {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, fileName)
                put(MediaStore.Downloads.MIME_TYPE, "application/octet-stream")
                put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + File.separator + dir)
            }
            val uri = context.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
            uri?.also { context.contentResolver.openOutputStream(it, "wt")?.use { os -> os.write(content) } }
        } else {
            @Suppress("DEPRECATION")
            val dirFile = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), dir)
            dirFile.mkdirs()
            val f = File(dirFile, fileName)
            f.writeBytes(content)
            Uri.fromFile(f)
        }
    }

    private fun buildInstallScript(): String {
        val s = "${'$'}" 
        return """#!/data/data/com.termux/files/usr/bin/bash
# ai-gateway 一键部署脚本 (由 AI Gateway App 生成)
set -e
echo "=== ai-gateway 部署 ==="
DEPLOY=~/storage/downloads/$DEPLOY_DIR
TARGET=~/ai-gateway

echo "[1/4] 安装 Node.js ..."
pkg install -y nodejs 2>&1 | tail -1 || true

echo "[2/4] 部署文件到 ${s}TARGET ..."
mkdir -p "${s}TARGET"
cp "${s}DEPLOY"/gateway.js "${s}DEPLOY"/admin.js "${s}DEPLOY"/crypt.js "${s}DEPLOY"/agw.sh "${s}TARGET"/ 2>/dev/null || cp "${s}DEPLOY"/*.js "${s}DEPLOY"/agw.sh "${s}TARGET"/
[ -f "${s}TARGET/config.json" ] || cp "${s}DEPLOY"/config.default.json "${s}TARGET"/config.json 2>/dev/null || true
chmod +x "${s}TARGET"/agw.sh 2>/dev/null || true

echo "[3/4] 配置允许外部 App 调用 ..."
mkdir -p ~/.termux
grep -q "allow-external-apps" ~/.termux/termux.properties 2>/dev/null || echo "allow-external-apps=true" >> ~/.termux/termux.properties

echo "[4/4] 启动网关 ..."
bash "${s}TARGET"/agw.sh start || node "${s}TARGET"/gateway.js &

echo "=== 完成! 网关默认端口 16384 ==="
"""
    }

    
    fun deployAndInstall(context: Context): Boolean {
        if (!deployGatewayFiles(context)) return false
        return runCommand(context, "bash ~/storage/downloads/$DEPLOY_DIR/install.sh", background = false)
    }
}
