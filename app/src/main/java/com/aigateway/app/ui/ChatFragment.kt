package com.aigateway.app.ui

import android.os.Bundle
import com.aigateway.app.R
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.ArrayAdapter
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import com.aigateway.app.data.ChatMessage
import com.aigateway.app.databinding.FragmentChatBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class ChatFragment : BaseFragment() {

    private var _b: FragmentChatBinding? = null
    private val b get() = _b!!
    private val adapter = ChatAdapter()
    private var sending = false

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        _b = FragmentChatBinding.inflate(inflater, container, false)
        return b.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        b.chatList.layoutManager = LinearLayoutManager(requireContext()).apply { stackFromEnd = true }
        b.chatList.adapter = adapter

        b.btnSend.setOnClickListener { send() }
        b.btnRefreshModels.setOnClickListener { loadModels() }
        b.editMessage.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_SEND) { send(); true } else false
        }

        updateEmpty()
        loadModels()
    }

    private fun updateEmpty() {
        val empty = adapter.itemCount == 0
        b.emptyHint.visibility = if (empty) View.VISIBLE else View.GONE
        b.chatList.visibility = if (empty) View.GONE else View.VISIBLE
    }

    private fun loadModels() {
        val backend = backendOrNull() ?: return
        run({ snack(getString(R.string.ch_load_models_failed, it)) }, {
            backend.getConfig(app.connectionStore.activeInstance)
        }) { cfg ->
            val models = linkedSetOf<String>()
            cfg.channels.forEach { ch ->
                ch.models?.let { models.addAll(it) }
                ch.modelMap?.keys?.let { models.addAll(it) }
            }
            val list = models.toList()
            b.modelInput.setAdapter(ArrayAdapter(requireContext(), android.R.layout.simple_list_item_1, list))
            if (b.modelInput.text.isNullOrBlank() && list.isNotEmpty()) {
                b.modelInput.setText(list.first(), false)
            }
        }
    }

    private fun send() {
        val text = b.editMessage.text?.toString()?.trim().orEmpty()
        val model = b.modelInput.text?.toString()?.trim().orEmpty()
        if (text.isBlank() || sending) return
        if (model.isBlank()) { snack(getString(R.string.ch_need_model)); return }
        val backend = backendOrNull() ?: run { snack(getString(R.string.ch_no_backend)); return }

        adapter.add(ChatMessage("user", text))
        b.editMessage.setText("")
        updateEmpty()
        scrollToBottom()

        
        val history = adapter.messages.filter { !(it.role == "assistant" && it.content.isBlank()) }
        val instance = app.connectionStore.activeInstance

        adapter.add(ChatMessage("assistant", ""))
        scrollToBottom()
        sending = true
        b.btnSend.isEnabled = false

        viewLifecycleOwner.lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                backend.chat(instance, model, history) { delta ->
                    viewLifecycleOwner.lifecycleScope.launch(Dispatchers.Main) {
                        if (isAdded) {
                            adapter.appendToLast(delta)
                            scrollToBottom()
                        }
                    }
                }
            }
            if (!isAdded) return@launch
            sending = false
            b.btnSend.isEnabled = true
            if (!result.ok) adapter.setLastError(getString(R.string.ch_error, result.error ?: getString(R.string.ch_request_failed)))
        }
    }

    private fun scrollToBottom() {
        if (adapter.itemCount > 0) b.chatList.scrollToPosition(adapter.itemCount - 1)
    }

    
    override fun reload() {
        if (_b != null) loadModels()
    }

    override fun onDestroyView() {
        super.onDestroyView()
        _b = null
    }
}
