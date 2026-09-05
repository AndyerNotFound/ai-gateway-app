package com.aigateway.app.ui

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import androidx.activity.result.contract.ActivityResultContracts
import com.aigateway.app.R
import com.aigateway.app.data.ConfigCrypto
import com.aigateway.app.data.ConfigTransfer
import com.aigateway.app.data.QrCodec
import com.aigateway.app.databinding.DialogQrShowBinding
import com.aigateway.app.data.GatewayConfig
import com.aigateway.app.data.RunMode
import com.aigateway.app.databinding.DialogImportPassBinding
import com.aigateway.app.databinding.FragmentConfigBinding
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** 配置与备份 —— 配置加密 + 导入/导出 */
class ConfigFragment : BaseFragment() {

    private var _b: FragmentConfigBinding? = null
    private val b get() = _b!!
    private lateinit var transfer: ConfigTransfer
    private val gson = Gson()

    /** 导出: 创建文件 */
    private val exportLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            result.data?.data?.let { doExport(it) }
        }
    }

    /** 导入: 选择文件 */
    private val importLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            result.data?.data?.let { doImportRead(it) }
        }
    }

    /** 选图片(相册)解码二维码 */
    private val qrImageLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            result.data?.data?.let { decodeQrFromUri(it) }
        }
    }

    /** 相机拍照解码二维码 */
    private val qrCameraLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            @Suppress("DEPRECATION")
            val bmp = result.data?.extras?.get("data") as? android.graphics.Bitmap
            if (bmp != null) decodeQrBitmap(bmp) else snack(getString(R.string.cfg_qr_no_image))
        }
    }

    /** 相机权限 */
    private val cameraPermLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) launchCamera() else snack(getString(R.string.cfg_qr_need_camera))
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _b = FragmentConfigBinding.inflate(inflater, container, false)
        return b.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        transfer = ConfigTransfer(requireContext())
        val s = app.settings

        b.switchCrypt.isChecked = s.cryptEnabled
        b.cryptPassSection.visibility = if (s.cryptEnabled) View.VISIBLE else View.GONE
        if (s.cryptEnabled) {
            b.editCryptPass.setText(s.cryptPassword)
            b.editCryptPass2.setText(s.cryptPassword)
        }
        b.switchCrypt.setOnCheckedChangeListener { _, on ->
            b.cryptPassSection.visibility = if (on) View.VISIBLE else View.GONE
        }
        b.btnSaveCrypt.setOnClickListener { saveCrypt() }

        b.switchExportEncrypt.setOnCheckedChangeListener { _, on ->
            b.exportPassLayout.visibility = if (on) View.VISIBLE else View.GONE
            if (on && b.editExportPass.text.isNullOrEmpty() && s.cryptPassword.isNotEmpty()) {
                b.editExportPass.setText(s.cryptPassword)
            }
        }
        // 请求内容收集
        b.switchRecord.setOnCheckedChangeListener { _, on ->
            b.recordSection.visibility = if (on) View.VISIBLE else View.GONE
        }
        b.btnSaveRecord.setOnClickListener { saveRecord() }
        loadRecord()

        // 思考链精简
        b.switchTs.setOnCheckedChangeListener { _, on ->
            b.tsSection.visibility = if (on) View.VISIBLE else View.GONE
        }
        b.dropTsMode.setAdapter(ArrayAdapter(requireContext(), android.R.layout.simple_list_item_1, listOf("truncate", "summarize")))
        b.btnSaveTs.setOnClickListener { saveThinkingSummary() }
        loadThinkingSummary()

        b.btnExport.setOnClickListener { pickExportFile() }
        b.btnImport.setOnClickListener { pickImportFile() }
        b.btnExportQr.setOnClickListener { exportQr() }
        b.btnImportQrImage.setOnClickListener { pickQrImage() }
        b.btnImportQrCamera.setOnClickListener { requestCameraThenScan() }
    }

    // ---------- 请求内容收集 ----------

    private fun loadRecord() {
        val backend = backendOrNull() ?: return
        run({ snack(getString(R.string.load_failed, it)) }, {
            backend.getConfig(app.connectionStore.activeInstance)
        }) { cfg ->
            b.switchRecord.isChecked = cfg.record.enable
            b.recordSection.visibility = if (cfg.record.enable) View.VISIBLE else View.GONE
            b.editRecordServer.setText(cfg.record.server)
            b.editRecordMax.setText(cfg.record.maxChars.toString())
        }
    }

    private fun saveRecord() {
        val backend = backendOrNull() ?: return
        val server = b.editRecordServer.text?.toString()?.trim().orEmpty()
        // 填了服务器地址就校验一下格式
        if (server.isNotEmpty() && !(server.startsWith("http://") || server.startsWith("https://"))) {
            snack(getString(R.string.rec_bad_server)); return
        }
        val maxChars = b.editRecordMax.text?.toString()?.toIntOrNull()?.coerceAtLeast(1000) ?: 200000
        val patch = JsonObject().apply {
            add("record", JsonObject().apply {
                addProperty("enable", b.switchRecord.isChecked)
                addProperty("server", server)
                addProperty("maxChars", maxChars)
            })
        }
        run({ snack(getString(R.string.pv_save_failed, it)) }, {
            backend.saveConfig(app.connectionStore.activeInstance, patch)
        }) { r ->
            if (r.ok) toast(getString(R.string.rec_saved))
            else snack(getString(R.string.pv_save_failed, r.error ?: ""))
        }
    }

    // ---------- 思考链精简 ----------

    private fun loadThinkingSummary() {
        val backend = backendOrNull() ?: return
        run({ snack(getString(R.string.load_failed, it)) }, {
            backend.getConfig(app.connectionStore.activeInstance)
        }) { cfg ->
            b.switchTs.isChecked = cfg.thinkingSummary.enable
            b.tsSection.visibility = if (cfg.thinkingSummary.enable) View.VISIBLE else View.GONE
            b.dropTsMode.setText(cfg.thinkingSummary.mode, false)
            b.editTsMaxChars.setText(cfg.thinkingSummary.maxCharsPerSegment.toString())
            b.editTsSumUrl.setText(cfg.thinkingSummary.summarizeBaseUrl)
            b.editTsSumKey.setText(cfg.thinkingSummary.summarizeApiKey)
            b.editTsSumModel.setText(cfg.thinkingSummary.summarizeModel)
            b.editTsSumPrompt.setText(cfg.thinkingSummary.summarizePrompt)
        }
    }

    private fun saveThinkingSummary() {
        val backend = backendOrNull() ?: return
        val mode = if (b.dropTsMode.text?.toString()?.trim() == "summarize") "summarize" else "truncate"
        val maxChars = b.editTsMaxChars.text?.toString()?.toIntOrNull()?.coerceIn(10, 500) ?: 80
        val prompt = b.editTsSumPrompt.text?.toString()?.trim()?.ifEmpty { "用一句话中文概括以下思考片段:" } ?: "用一句话中文概括以下思考片段:"
        val patch = JsonObject().apply {
            add("thinkingSummary", JsonObject().apply {
                addProperty("enable", b.switchTs.isChecked)
                addProperty("mode", mode)
                addProperty("maxCharsPerSegment", maxChars)
                addProperty("summarizeBaseUrl", b.editTsSumUrl.text?.toString()?.trim().orEmpty())
                addProperty("summarizeApiKey", b.editTsSumKey.text?.toString()?.trim().orEmpty())
                addProperty("summarizeModel", b.editTsSumModel.text?.toString()?.trim().orEmpty())
                addProperty("summarizePrompt", prompt)
                addProperty("maxSegments", 12)
            })
        }
        run({ snack(getString(R.string.pv_save_failed, it)) }, {
            backend.saveConfig(app.connectionStore.activeInstance, patch)
        }) { r ->
            if (r.ok) toast(getString(R.string.rec_saved))
            else snack(getString(R.string.pv_save_failed, r.error ?: ""))
        }
    }

    override fun reload() {
        if (_b != null) { loadRecord(); loadThinkingSummary() }
    }

    // ---------- 配置加密 ----------

    private fun saveCrypt() {
        val s = app.settings
        val on = b.switchCrypt.isChecked
        if (!on) {
            // 关闭加密: 把内嵌配置转回明文
            s.cryptEnabled = false
            s.cryptPassword = ""
            app.embeddedEngineOrNull()?.changeCryptPassword("")
            toast(getString(R.string.cfg_crypt_disabled))
            return
        }
        val p1 = b.editCryptPass.text?.toString().orEmpty()
        val p2 = b.editCryptPass2.text?.toString().orEmpty()
        if (p1.isEmpty()) { snack(getString(R.string.cfg_crypt_need_pass)); return }
        if (p1 != p2) { snack(getString(R.string.cfg_crypt_mismatch)); return }
        s.cryptEnabled = true
        s.cryptPassword = p1
        // 立即用新口令重写内嵌配置
        app.embeddedEngineOrNull()?.changeCryptPassword(p1)
        toast(getString(R.string.cfg_crypt_enabled))
    }

    // ---------- 导出 ----------

    private fun pickExportFile() {
        val encrypt = b.switchExportEncrypt.isChecked
        val name = if (encrypt) ConfigTransfer.DEFAULT_EXPORT_NAME_ENC else ConfigTransfer.DEFAULT_EXPORT_NAME
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "application/json"
            putExtra(Intent.EXTRA_TITLE, name)
        }
        exportLauncher.launch(intent)
    }

    private fun doExport(uri: Uri) {
        val backend = backendOrNull() ?: run { snack(getString(R.string.no_backend_hint)); return }
        val pass = if (b.switchExportEncrypt.isChecked) b.editExportPass.text?.toString().orEmpty() else ""
        if (b.switchExportEncrypt.isChecked && pass.isEmpty()) {
            snack(getString(R.string.cfg_crypt_need_pass)); return
        }
        run({ snack(getString(R.string.cfg_export_failed, it)) }, {
            val cfg = backend.getConfig(app.connectionStore.activeInstance)
            val text = transfer.buildExport(cfg, pass.ifEmpty { null })
            withContext(Dispatchers.IO) { transfer.writeUri(uri, text) }
            true
        }) { toast(getString(R.string.cfg_exported)) }
    }

    // ---------- 导入 ----------

    private fun pickImportFile() {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
        }
        importLauncher.launch(intent)
    }

    private fun doImportRead(uri: Uri) {
        run({ snack(getString(R.string.cfg_import_failed, it)) }, {
            withContext(Dispatchers.IO) { transfer.readUri(uri) }
        }) { raw ->
            if (ConfigCrypto.isEncrypted(raw)) askPasswordThenImport(raw)
            else parseAndConfirm(raw, null)
        }
    }

    /** 加密文件: 弹窗要源口令 */
    private fun askPasswordThenImport(raw: String) {
        val db = DialogImportPassBinding.inflate(layoutInflater)
        db.textHint.text = getString(R.string.cfg_import_encrypted_hint)
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.cfg_import_pass_title)
            .setView(db.root)
            .setPositiveButton(R.string.ok) { _, _ ->
                parseAndConfirm(raw, db.editPass.text?.toString().orEmpty())
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun parseAndConfirm(raw: String, srcPass: String?) {
        when (val r = transfer.parseImport(raw, srcPass)) {
            is ConfigTransfer.ImportResult.NeedPassword -> askPasswordThenImport(raw)
            is ConfigTransfer.ImportResult.WrongPassword ->
                snack(getString(R.string.cfg_import_wrong_pass, r.message))
            is ConfigTransfer.ImportResult.Invalid ->
                snack(getString(R.string.cfg_import_invalid, r.message))
            is ConfigTransfer.ImportResult.Success -> confirmImport(r.config, r.wasEncrypted)
        }
    }

    private fun confirmImport(cfg: GatewayConfig, wasEncrypted: Boolean) {
        val srcDesc = getString(
            if (wasEncrypted) R.string.cfg_import_src_enc else R.string.cfg_import_src_plain
        )
        MaterialAlertDialogBuilder(requireContext())
            .setTitle(R.string.cfg_import_confirm_title)
            .setMessage(getString(R.string.cfg_import_confirm_msg, cfg.channels.size, srcDesc))
            .setPositiveButton(R.string.ok) { _, _ -> applyImport(cfg) }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    /** 应用导入: 写入当前后端(内嵌模式会用本 App 口令重新加密) */
    private fun applyImport(cfg: GatewayConfig) {
        val backend = backendOrNull() ?: run { snack(getString(R.string.no_backend_hint)); return }
        // 组 patch: 端口/密钥/渠道/代理/替换/过滤/同步 全量覆盖
        val patch = JsonParser.parseString(gson.toJson(cfg)).asJsonObject
        patch.remove("name")
        run({ snack(getString(R.string.cfg_import_failed, it)) }, {
            backend.saveConfig(app.connectionStore.activeInstance, patch)
        }) { r ->
            if (r.ok) {
                toast(getString(R.string.cfg_imported, cfg.channels.size))
                // 内嵌模式 + 已启用加密 → 配置已按本 App 口令加密存储
                if (app.connectionStore.runMode == RunMode.EMBEDDED && app.settings.cryptEnabled) {
                    app.embeddedEngineOrNull()?.changeCryptPassword(app.settings.cryptPassword)
                    snack(getString(R.string.cfg_reencrypted))
                }
            } else snack(getString(R.string.cfg_import_failed, r.error ?: ""))
        }
    }

    // ---------- 二维码导出 ----------

    private fun exportQr() {
        val backend = backendOrNull() ?: run { snack(getString(R.string.no_backend_hint)); return }
        val pass = if (b.switchExportEncrypt.isChecked) b.editExportPass.text?.toString().orEmpty() else ""
        if (b.switchExportEncrypt.isChecked && pass.isEmpty()) {
            snack(getString(R.string.cfg_crypt_need_pass)); return
        }
        run({ snack(getString(R.string.cfg_export_failed, it)) }, {
            val cfg = backend.getConfig(app.connectionStore.activeInstance)
            val text = transfer.buildExport(cfg, pass.ifEmpty { null })
            val payload = QrCodec.buildPayload(text)
            Pair(QrCodec.encodeBitmap(payload), Triple(text.length, payload.length, cfg.channels.size))
        }) { (bmp, info) ->
            val (rawLen, payLen, chCount) = info
            val db = DialogQrShowBinding.inflate(layoutInflater)
            db.qrImage.setImageBitmap(bmp)
            db.qrInfo.text = getString(R.string.cfg_qr_info, chCount, rawLen, payLen)
            MaterialAlertDialogBuilder(requireContext())
                .setTitle(R.string.cfg_export_qr)
                .setView(db.root)
                .setPositiveButton(R.string.close, null)
                .show()
        }
    }

    // ---------- 二维码导入 ----------

    private fun pickQrImage() {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "image/*"
        }
        qrImageLauncher.launch(intent)
    }

    private fun requestCameraThenScan() {
        val granted = androidx.core.content.ContextCompat.checkSelfPermission(
            requireContext(), android.Manifest.permission.CAMERA
        ) == android.content.pm.PackageManager.PERMISSION_GRANTED
        if (granted) launchCamera() else cameraPermLauncher.launch(android.Manifest.permission.CAMERA)
    }

    private fun launchCamera() {
        val intent = Intent(android.provider.MediaStore.ACTION_IMAGE_CAPTURE)
        if (intent.resolveActivity(requireContext().packageManager) != null) {
            qrCameraLauncher.launch(intent)
        } else {
            snack(getString(R.string.cfg_qr_no_camera_app))
        }
    }

    private fun decodeQrFromUri(uri: Uri) {
        run({ snack(getString(R.string.cfg_qr_decode_failed, it)) }, {
            withContext(Dispatchers.IO) {
                requireContext().contentResolver.openInputStream(uri)?.use { ins ->
                    android.graphics.BitmapFactory.decodeStream(ins)
                }
            }
        }) { bmp ->
            if (bmp == null) snack(getString(R.string.cfg_qr_no_image)) else decodeQrBitmap(bmp)
        }
    }

    private fun decodeQrBitmap(bmp: android.graphics.Bitmap) {
        run({ snack(getString(R.string.cfg_qr_decode_failed, it)) }, {
            withContext(Dispatchers.IO) { QrCodec.decodeBitmap(bmp) }
        }) { payload ->
            if (payload.isNullOrBlank()) { snack(getString(R.string.cfg_qr_not_found)); return@run }
            val text = runCatching { QrCodec.parsePayload(payload) }.getOrNull()
            if (text.isNullOrBlank()) { snack(getString(R.string.cfg_qr_bad_payload)); return@run }
            if (ConfigCrypto.isEncrypted(text)) askPasswordThenImport(text)
            else parseAndConfirm(text, null)
        }
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _b = null
    }
}
