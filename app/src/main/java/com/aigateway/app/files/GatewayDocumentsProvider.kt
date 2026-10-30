package com.aigateway.app.files

import android.database.Cursor
import android.database.MatrixCursor
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.provider.DocumentsContract.Root
import android.provider.DocumentsProvider
import com.aigateway.app.R
import java.io.File
import java.io.FileNotFoundException

/**
 * 把内置网关的请求记录与运行日志暴露给系统文件选择器（DocumentsUI 侧边栏）。
 *
 * 只读，且只暴露 logs/embedded.log 两类文件；config.json 等含密钥的文件不在此列。
 */
class GatewayDocumentsProvider : DocumentsProvider() {

    companion object {
        private const val ROOT_ID = "agw"
        private const val DIR_LOGS = "logs"
        private const val DIR_RUNTIME = "runtime"

        private val ROOT_PROJECTION = arrayOf(
            Root.COLUMN_ROOT_ID, Root.COLUMN_DOCUMENT_ID, Root.COLUMN_TITLE,
            Root.COLUMN_SUMMARY, Root.COLUMN_FLAGS, Root.COLUMN_ICON
        )
        private val DOC_PROJECTION = arrayOf(
            Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE,
            Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED, Document.COLUMN_FLAGS
        )
    }

    private val dataDir: File get() = File(requireNotNull(context).filesDir, "nodejs-project/data")
    private val logsDir: File get() = File(dataDir, "log")

    override fun onCreate(): Boolean = true

    override fun queryRoots(projection: Array<String>?): Cursor {
        val cols = projection ?: ROOT_PROJECTION
        val cursor = MatrixCursor(cols)
        val row = cursor.newRow()
        for (col in cols) when (col) {
            Root.COLUMN_ROOT_ID -> row.add(ROOT_ID)
            Root.COLUMN_DOCUMENT_ID -> row.add(ROOT_ID)
            Root.COLUMN_TITLE -> row.add(context!!.getString(R.string.docs_root_title))
            Root.COLUMN_SUMMARY -> row.add(context!!.getString(R.string.docs_root_summary))
            Root.COLUMN_FLAGS -> row.add(Root.FLAG_LOCAL_ONLY or Root.FLAG_SUPPORTS_IS_CHILD)
            Root.COLUMN_ICON -> row.add(R.drawable.ic_cloud)
            else -> row.add(null)
        }
        return cursor
    }

    override fun queryDocument(documentId: String, projection: Array<String>?): Cursor {
        val cols = projection ?: DOC_PROJECTION
        val cursor = MatrixCursor(cols)
        addDocument(cursor, cols, documentId)
        return cursor
    }

    override fun queryChildDocuments(
        parentDocumentId: String,
        projection: Array<String>?,
        sortOrder: String?
    ): Cursor {
        val cols = projection ?: DOC_PROJECTION
        val cursor = MatrixCursor(cols)
        when (parentDocumentId) {
            ROOT_ID -> {
                addDocument(cursor, cols, DIR_LOGS)
                addDocument(cursor, cols, DIR_RUNTIME)
            }
            DIR_LOGS -> listFiles(logsDir).forEach { addDocument(cursor, cols, "$DIR_LOGS/${it.name}") }
            DIR_RUNTIME -> listFiles(dataDir)
                .filter { it.isFile && it.name.endsWith(".log") }
                .forEach { addDocument(cursor, cols, "$DIR_RUNTIME/${it.name}") }
        }
        return cursor
    }

    override fun openDocument(
        documentId: String,
        mode: String,
        signal: CancellationSignal?
    ): ParcelFileDescriptor {
        val file = fileFor(documentId) ?: throw FileNotFoundException(documentId)
        if (file.isDirectory) throw FileNotFoundException(documentId)
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    }

    override fun getDocumentType(documentId: String): String {
        if (documentId == ROOT_ID || documentId == DIR_LOGS || documentId == DIR_RUNTIME) {
            return Document.MIME_TYPE_DIR
        }
        return when (fileFor(documentId)?.extension?.lowercase()) {
            "jsonl", "ndjson" -> "application/x-ndjson"
            "json" -> "application/json"
            "log", "txt" -> "text/plain"
            else -> "application/octet-stream"
        }
    }

    override fun isChildDocument(parentDocumentId: String, documentId: String): Boolean = when {
        parentDocumentId == ROOT_ID -> documentId == DIR_LOGS || documentId == DIR_RUNTIME
        parentDocumentId == DIR_LOGS -> documentId.startsWith("$DIR_LOGS/")
        parentDocumentId == DIR_RUNTIME -> documentId.startsWith("$DIR_RUNTIME/")
        else -> false
    }

    private fun addDocument(cursor: MatrixCursor, cols: Array<String>, documentId: String) {
        val dir = documentId == ROOT_ID || documentId == DIR_LOGS || documentId == DIR_RUNTIME
        val file = if (dir) null else fileFor(documentId)
        if (!dir && file == null) return
        val name = when (documentId) {
            ROOT_ID -> context!!.getString(R.string.docs_root_title)
            DIR_LOGS -> context!!.getString(R.string.docs_logs)
            DIR_RUNTIME -> context!!.getString(R.string.docs_runtime)
            else -> file!!.name
        }
        val row = cursor.newRow()
        for (col in cols) when (col) {
            Document.COLUMN_DOCUMENT_ID -> row.add(documentId)
            Document.COLUMN_DISPLAY_NAME -> row.add(name)
            Document.COLUMN_MIME_TYPE -> row.add(getDocumentType(documentId))
            Document.COLUMN_SIZE -> row.add(if (dir) 0 else file?.length() ?: 0)
            Document.COLUMN_LAST_MODIFIED -> row.add(if (dir) 0 else file?.lastModified() ?: 0)
            Document.COLUMN_FLAGS -> row.add(0)
            else -> row.add(null)
        }
    }

    private fun listFiles(dir: File): List<File> =
        dir.listFiles()?.filter { it.isFile }?.sortedByDescending { it.lastModified() } ?: emptyList()

    /** 只允许 root 下两个虚拟目录和它们里面的真实文件，杜绝路径穿越。 */
    private fun fileFor(documentId: String): File? {
        val slash = documentId.indexOf('/')
        if (slash <= 0) return null
        val dir = documentId.substring(0, slash)
        val name = documentId.substring(slash + 1)
        if (name.isEmpty() || name.contains('/') || name.contains("..")) return null
        val base = when (dir) {
            DIR_LOGS -> logsDir
            DIR_RUNTIME -> dataDir
            else -> return null
        }
        val f = File(base, name)
        return if (f.isFile) f else null
    }
}
