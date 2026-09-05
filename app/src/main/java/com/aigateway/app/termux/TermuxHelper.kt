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

/**
 * Termux 集成 —— 检测 / RUN_COMMAND 关联启动 / 部署脚本生成。
 *
 * 前提: Termux 侧 ~/.termux/termux.properties 需 `allow-external-apps=true`。
 * App 已声明权限 com.termux.permission.RUN_COMMAND。
 */
object TermuxHelper {

    const val TERMUX_PACKAGE = "com.termux"
    private const val ACTION_RUN_COMMAND = "com.termux.app.RUN_COMMAND"
    private const val RUN_COMMAND_SERVICE = "com.termux.app.RunCommandService"
    private const val EXTRA_PATH = "com.termux.app.RUN_COMMAND_PATH"
    private const val EXTRA_ARGS = "com.termux.app.RUN_COMMAND_ARGUMENTS"
    private const val EXTRA_WORKDIR = "com.termux.app.RUN_COMMAND_WORKDIR"
    private const val EXTRA_BACKGROUND = "com.termux.app.RUN_COMMAND_BACKGROUND"
    private const val BASH = "/data/data/com.termux/files/usr/bin/bash"

    /** 检测 Termux 是否安装(多重手段, 兼容 Android 11+ 包可见性) */
    fun isTermuxInstalled(context: Context): Boolean {
        val pm = context.packageManager
        // 1) 直接查包信息(需 <queries> 声明)
        try {
            pm.getPackageInfo(TERMUX_PACKAGE, 0)
            return true
        } catch (_: Exception) {}
        // 2) 查启动 Intent
        try {
            if (pm.getLaunchIntentForPackage(TERMUX_PACKAGE) != null) return true
        } catch (_: Exception) {}
        // 3) 查 RUN_COMMAND 服务是否可解析
        try {
            val intent = Intent(ACTION_RUN_COMMAND).setClassName(TERMUX_PACKAGE, RUN_COMMAND_SERVICE)
            if (pm.queryIntentServices(intent, 0).isNotEmpty()) return true
        } catch (_: Exception) {}
        // 4) 兜底: Termux 的 files 目录存在(同机 Termux 通常可见)
        return try { java.io.File("/data/data/com.termux/files/usr/bin/bash").exists() } catch (_: Exception) { false }
    }

    /** RUN_COMMAND 服务是否可用(判断是否授权外部调用) */
    fun isRunCommandAvailable(context: Context): Boolean = try {
        val intent = Intent(ACTION_RUN_COMMAND).setClassName(TERMUX_PACKAGE, RUN_COMMAND_SERVICE)
        context.packageManager.queryIntentServices(intent, 0).isNotEmpty()
    } catch (_: Exception) { false }

    /** 打开 Termux 主界面 */
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

    /** 执行结果 */
    sealed class RunResult {
        object Success : RunResult()
        object NotInstalled : RunResult()
        data class Failed(val reason: String) : RunResult()
    }

    /**
     * 通过 RUN_COMMAND 在 Termux 执行 bash 命令。
     * @param background true=后台执行(不弹出 Termux 界面)
     */
    fun runCommandDetailed(context: Context, command: String, background: Boolean = true): RunResult {
        if (!isTermuxInstalled(context)) return RunResult.NotInstalled
        return try {
            val intent = Intent(ACTION_RUN_COMMAND)
            intent.setClassName(TERMUX_PACKAGE, RUN_COMMAND_SERVICE)
            intent.putExtra(EXTRA_PATH, BASH)
            intent.putExtra(EXTRA_ARGS, arrayOf("-lc", command))
            intent.putExtra(EXTRA_WORKDIR, "/data/data/com.termux/files/home")
            intent.putExtra(EXTRA_BACKGROUND, background)
            intent.putExtra("com.termux.app.RUN_COMMAND_SESSION_ACTION", "0")
            // Android 8+ 后台启动服务受限, Termux 的 RunCommandService 是前台服务
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
            RunResult.Success
        } catch (e: SecurityException) {
            // 未授权外部调用(allow-external-apps 未开)
            RunResult.Failed("permission")
        } catch (e: Exception) {
            RunResult.Failed(e.message ?: "unknown")
        }
    }

    fun runCommand(context: Context, command: String, background: Boolean = true): Boolean =
        runCommandDetailed(context, command, background) is RunResult.Success

    // ---------- 常用命令 ----------

    /** 启动 Termux 里的 gateway 后端 */
    fun startBackend(context: Context): Boolean =
        runCommand(context, START_CMD, background = true)

    const val START_CMD = "bash ~/ai-gateway/agw.sh start"

    /** 启动后端(详细结果, 供 UI 区分提示) */
    fun startBackendDetailed(context: Context): RunResult =
        runCommandDetailed(context, START_CMD, background = true)

    /** 停止后端 */
    fun stopBackend(context: Context): Boolean =
        runCommand(context, "bash ~/ai-gateway/agw.sh stop", background = true)

    /** 重启后端 */
    fun restartBackend(context: Context): Boolean =
        runCommand(context, "bash ~/ai-gateway/agw.sh restart", background = true)

    /** 查看后端状态(后台执行) */
    fun checkBackendStatus(context: Context): Boolean =
        runCommand(context, "bash ~/ai-gateway/agw.sh status", background = true)

    // ---------- 部署 ----------

    private const val DEPLOY_DIR = "ai-gateway-deploy"

    /**
     * 把 assets/gateway/ 的后端文件写到 Download/ai-gateway-deploy/ (供 Termux 读取)。
     * 返回部署到的 Download 相对路径。
     */
    fun deployGatewayFiles(context: Context): Boolean {
        return try {
            val assetFiles = context.assets.list("gateway") ?: return false
            for (name in assetFiles) {
                val bytes = context.assets.open("gateway/$name").readBytes()
                writeToDownload(context, DEPLOY_DIR, name, bytes)
            }
            // 生成安装脚本
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
        val s = "${'$'}" // 字面 $, 供 shell 变量用
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

    /** 执行部署(写文件 + 让 Termux 跑安装脚本, 会弹出 Termux 界面显示进度) */
    fun deployAndInstall(context: Context): Boolean {
        if (!deployGatewayFiles(context)) return false
        return runCommand(context, "bash ~/storage/downloads/$DEPLOY_DIR/install.sh", background = false)
    }
}
