'use strict';
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const zlib = require('zlib');
const { toText, normStop, randId, safeParse, nowSec } = require('./util');
const { SSEDecoder } = require('./sse');

// ================= Format conversion: entry parsing / exit building / responses / SSE =================
/* ================= Entry parsing: client format -> canonical =================
 * canonical request: {
 *   model, stream,
 *   messages: [{ role:'system'|'user'|'assistant'|'tool',
 *                content: string | [{type:'text',text}|{type:'image_url',image_url:{url}}],
 *                name?, tool_call_id?, tool_calls?: [{id,type:'function',function:{name,arguments:string}}] }],
 *   temperature?, top_p?, max_tokens?, stop?, tools? (OpenAI form), tool_choice? (OpenAI form) }
 * canonical resp: { text, reasoning?, tool_calls?, finish_reason:'stop'|'length'|'tool_calls'|'content_filter', usage:{input,output} }
 * canonical events: {type:'start',usage?} {type:'text',t} {type:'reasoning',t}
 *                {type:'tool_start',i,id,name} {type:'tool_delta',i,s} {type:'end',finish_reason,usage}
 * ================================================================ */
function openaiToCanonical(body, urlModel) {
  const messages = [];
  for (const m of (body.messages || [])) {
    if (!m || typeof m !== 'object') continue;
    let role = m.role;
    if (role === 'developer') role = 'system';
    if (role === 'function') {
      messages.push({ role: 'tool', name: m.name, tool_call_id: 'call_fn_' + (m.name || ''), content: toText(m.content) });
      continue;
    }
    const out = { role, content: m.content == null ? '' : m.content };
    if (m.name != null) out.name = m.name;
    if (m.tool_call_id != null) out.tool_call_id = m.tool_call_id;
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
      out.tool_calls = m.tool_calls.map(tc => ({
        id: tc.id, type: 'function',
        function: { name: (tc.function && tc.function.name) || '', arguments: (tc.function && tc.function.arguments) != null ? String(tc.function.arguments) : '{}' },
      }));
    }
    messages.push(out);
  }
  return {
    model: body.model || urlModel,
    stream: !!body.stream,
    messages,
    temperature: body.temperature,
    top_p: body.top_p,
    max_tokens: body.max_tokens != null ? body.max_tokens : body.max_completion_tokens,
    stop: normStop(body.stop),
    tools: (Array.isArray(body.tools) && body.tools.length) ? body.tools : undefined,
    tool_choice: body.tool_choice,
  };
}

function claudeToolsToOpenAI(tools) {
  if (!Array.isArray(tools)) return undefined;
  const out = tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description || '', parameters: (t.input_schema && typeof t.input_schema === 'object') ? t.input_schema : { type: 'object' } },
  }));
  return out.length ? out : undefined;
}
function claudeChoiceToOpenAI(tc) {
  if (!tc || typeof tc !== 'object') return undefined;
  if (tc.type === 'auto') return 'auto';
  if (tc.type === 'any') return 'required';
  if (tc.type === 'tool' && tc.name) return { type: 'function', function: { name: tc.name } };
  return undefined;
}
function claudeToCanonical(body, urlModel) {
  const messages = [];
  if (body.system) {
    const s = typeof body.system === 'string'
      ? body.system
      : (Array.isArray(body.system) ? body.system.filter(b => b && b.type === 'text').map(b => b.text || '').join('\n') : '');
    if (s) messages.push({ role: 'system', content: s });
  }
  for (const m of (body.messages || [])) {
    if (!m || typeof m !== 'object') continue;
    const blocks = Array.isArray(m.content) ? m.content : (m.content == null ? [] : [{ type: 'text', text: String(m.content) }]);
    const textParts = [];
    const toolCalls = [];
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text') textParts.push({ type: 'text', text: b.text || '' });
      else if (b.type === 'image' && b.source) {
        const s = b.source;
        if (s.type === 'base64') textParts.push({ type: 'image_url', image_url: { url: `data:${s.media_type || 'image/png'};base64,${s.data || ''}` } });
        else if (s.type === 'url') textParts.push({ type: 'image_url', image_url: { url: s.url } });
      } else if (b.type === 'tool_use') {
        toolCalls.push({ id: b.id || randId('call_'), type: 'function', function: { name: b.name || '', arguments: JSON.stringify(b.input == null ? {} : b.input) } });
      } else if (b.type === 'tool_result') {
        const c = typeof b.content === 'string'
          ? b.content
          : (Array.isArray(b.content) ? b.content.filter(x => x && x.type === 'text').map(x => x.text || '').join('\n') : '');
        messages.push({ role: 'tool', tool_call_id: b.tool_use_id || '', content: c });
      }
// other block types (thinking / document / server_tool_use) ignored
    }
    if (m.role === 'assistant') {
      if (textParts.length || toolCalls.length) {
        const out = { role: 'assistant', content: textParts.length ? textParts : '' };
        if (toolCalls.length) out.tool_calls = toolCalls;
        messages.push(out);
      }
    } else if (textParts.length) {
      messages.push({ role: 'user', content: textParts });
    }
  }
  return {
    model: body.model || urlModel,
    stream: !!body.stream,
    messages,
    temperature: body.temperature,
    top_p: body.top_p,
    max_tokens: body.max_tokens,
    stop: normStop(body.stop_sequences),
    tools: claudeToolsToOpenAI(body.tools),
    tool_choice: claudeChoiceToOpenAI(body.tool_choice),
  };
}

function geminiToCanonical(body, urlModel) {
  const messages = [];
  const sys = body.systemInstruction || body.system_instruction;
  if (sys && Array.isArray(sys.parts)) {
    const t = sys.parts.map(p => (p && typeof p.text === 'string') ? p.text : '').join('');
    if (t) messages.push({ role: 'system', content: t });
  }
  let callSeq = 0;
  const lastName = {};
  for (const c of (body.contents || [])) {
    if (!c || !Array.isArray(c.parts)) continue;
    const role = c.role === 'model' ? 'assistant' : 'user';
    const textParts = [];
    const toolCalls = [];
    const toolMsgs = [];
    for (const p of c.parts) {
      if (!p || typeof p !== 'object') continue;
      if (typeof p.text === 'string') {
        if (!p.thought) textParts.push({ type: 'text', text: p.text });
      } else if (p.inlineData || p.inline_data) {
        const d = p.inlineData || p.inline_data;
        textParts.push({ type: 'image_url', image_url: { url: `data:${d.mimeType || d.mime_type || 'image/png'};base64,${d.data || ''}` } });
      } else if (p.fileData || p.file_data) {
        const d = p.fileData || p.file_data;
        if (d.fileUri || d.file_uri) textParts.push({ type: 'image_url', image_url: { url: d.fileUri || d.file_uri } });
      } else if (p.functionCall || p.function_call) {
        const f = p.functionCall || p.function_call;
        const id = 'call_gm_' + (f.name || 'fn') + '_' + (callSeq++);
        toolCalls.push({ id, type: 'function', function: { name: f.name || '', arguments: JSON.stringify(f.args == null ? {} : f.args) } });
        lastName[f.name || ''] = id;
      } else if (p.functionResponse || p.function_response) {
        const f = p.functionResponse || p.function_response;
        toolMsgs.push({ role: 'tool', name: f.name || '', tool_call_id: lastName[f.name || ''] || ('call_gm_' + (f.name || '')), content: JSON.stringify(f.response == null ? {} : f.response) });
      }
    }
    if (role === 'assistant' && (textParts.length || toolCalls.length)) {
      const out = { role: 'assistant', content: textParts.length ? textParts : '' };
      if (toolCalls.length) out.tool_calls = toolCalls;
      messages.push(out);
    } else if (textParts.length) {
      messages.push({ role, content: textParts });
    }
    messages.push(...toolMsgs);
  }
  const g = body.generationConfig || body.generation_config || {};
  const tools = [];
  for (const t of (body.tools || [])) {
    if (!t || typeof t !== 'object') continue;
    const fds = t.functionDeclarations || t.function_declarations || [];
    for (const fd of fds) {
      tools.push({ type: 'function', function: { name: fd.name, description: fd.description || '', parameters: fd.parameters || fd.parametersJsonSchema || fd.parameters_json_schema || { type: 'object' } } });
    }
  }
  let tool_choice;
  const tcfg = (body.toolConfig && body.toolConfig.functionCallingConfig) || (body.tool_config && body.tool_config.function_calling_config);
  if (tcfg) {
    const mode = String(tcfg.mode || 'AUTO').toUpperCase();
    if (mode === 'ANY') tool_choice = (Array.isArray(tcfg.allowedFunctionNames) && tcfg.allowedFunctionNames.length === 1) ? { type: 'function', function: { name: tcfg.allowedFunctionNames[0] } } : 'required';
    else if (mode === 'NONE') tool_choice = 'none';
    else tool_choice = 'auto';
  }
  return {
    model: urlModel || body.model,
    stream: !!body.stream,
    messages,
    temperature: g.temperature,
    top_p: g.topP != null ? g.topP : g.top_p,
    max_tokens: g.maxOutputTokens != null ? g.maxOutputTokens : g.max_output_tokens,
    stop: normStop(g.stopSequences != null ? g.stopSequences : g.stop_sequences),
    tools: tools.length ? tools : undefined,
    tool_choice,
  };
}

/* ================= OpenAI Responses API conversion ================= */
// Upstream Responses streaming event parsing (response output -> canonical events)
class ResponsesStreamParser {
  constructor(emit) { this.emit = emit; this.finished = false; this.finishReason = undefined; this.usage = null; this.toolIdx = 0; }
  handle(j) {
    const evs = [];
    switch (j.type) {
      case 'response.output_text.delta':
        if (typeof j.delta === 'string' && j.delta) evs.push({ type: 'text', t: j.delta });
        break;
      case 'response.output_item.added': {
        const item = j.item || {};
        if (item.type === 'function_call') {
          const i = this.toolIdx++;
          evs.push({ type: 'tool_start', i, id: item.id || item.call_id || ('call_' + (item.name || '')), name: item.name || '' });
        }
        break;
      }
      case 'response.function_call_arguments.delta':
        if (typeof j.delta === 'string' && j.delta) evs.push({ type: 'tool_delta', i: Math.max(0, this.toolIdx - 1), s: j.delta });
        break;
      case 'response.completed':
      case 'response.incomplete':
      case 'response.failed': {
        const r = j.response || {};
        const st = String(r.status || j.type.replace('response.', ''));
        if (st === 'incomplete') this.finishReason = 'length';
        else if (st === 'failed') this.finishReason = 'content_filter';
        else this.finishReason = 'stop';
        const u = r.usage || j.usage;
        if (u) this.usage = { input: u.input_tokens || 0, output: u.output_tokens || 0 };
        break;
      }
      default: break;
    }
    for (const e of evs) this.emit(e);
  }
  finish() {
    if (this.finished) return;
    this.finished = true;
    this.emit({ type: 'end', finish_reason: this.finishReason || 'stop', usage: this.usage || { input: 0, output: 0, cached: 0, reasoning: 0 } });
  }
}

// Responses content array -> generic content (multi-modal array; plain text collapses to a string)
function responsesContentToContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out = [];
  for (const p of content) {
    if (!p || typeof p !== 'object') continue;
    if (p.type === 'input_text' || p.type === 'output_text' || p.type === 'text') {
      if (typeof p.text === 'string') out.push({ type: 'text', text: p.text });
    } else if (p.type === 'input_image' && p.image_url) {
      out.push({ type: 'image_url', image_url: typeof p.image_url === 'string' ? { url: p.image_url } : p.image_url });
    } else if (p.type === 'input_file' && (p.file_url || p.filename)) {
      const u = typeof p.file_url === 'string' ? p.file_url : '';
      if (u) out.push({ type: 'image_url', image_url: { url: u } });
    }
  }
  if (!out.length) return '';
  return (out.length === 1 && out[0].type === 'text') ? out[0].text : out;
}

// Client Responses request -> canonical (input/instructions -> messages)
function responsesToCanonical(body, urlModel) {
  const messages = [];
  const instructions = body.instructions;
  if (typeof instructions === 'string' && instructions) messages.push({ role: 'system', content: instructions });
  else if (Array.isArray(instructions)) {
    const txt = instructions.filter(p => p && typeof p.text === 'string').map(p => p.text).join('');
    if (txt) messages.push({ role: 'system', content: txt });
  }
  const rawInput = typeof body.input === 'string' ? [body.input] : (Array.isArray(body.input) ? body.input : []);
  for (const item of rawInput) {
    if (typeof item === 'string') { messages.push({ role: 'user', content: item }); continue; }
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'function_call') {
      messages.push({
        role: 'assistant', content: '',
        tool_calls: [{ id: item.call_id || item.id || randId('call_'), type: 'function',
          function: { name: item.name || '', arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments == null ? {} : item.arguments) } }],
      });
    } else if (item.type === 'function_call_output') {
      messages.push({ role: 'tool', tool_call_id: item.call_id || '', content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output == null ? {} : item.output) });
    } else if (item.type === 'message' || item.role) {
      let role = item.role || 'user';
      if (role === 'developer') role = 'system';
      if (role === 'system' && messages.length && messages[0].role === 'system') {
        messages[0].content = toText(messages[0].content) + '\n' + toText(responsesContentToContent(item.content));
        continue;
      }
      messages.push({ role, content: responsesContentToContent(item.content) });
    }
// reasoning / other types ignored
  }
  let tools;
  if (Array.isArray(body.tools) && body.tools.length) {
    tools = body.tools.map(t => (t && t.type === 'function') ? {
      type: 'function', function: { name: t.name, description: t.description || '', parameters: (t.parameters && typeof t.parameters === 'object') ? t.parameters : { type: 'object' } },
    } : t);
  }
  let tool_choice;
  if (typeof body.tool_choice === 'string') tool_choice = body.tool_choice;
  else if (body.tool_choice && body.tool_choice.type === 'function' && body.tool_choice.name) tool_choice = { type: 'function', function: { name: body.tool_choice.name } };
  return {
    model: body.model || urlModel,
    stream: !!body.stream,
    messages,
    temperature: body.temperature,
    top_p: body.top_p,
    max_tokens: body.max_output_tokens != null ? body.max_output_tokens : body.max_tokens,
    stop: normStop(body.stop),
    tools,
    tool_choice,
  };
}

// canonical -> upstream Responses body (system -> instructions, messages -> input items)
function canonicalToResponsesBody(c) {
  const instructions = [];
  const input = [];
  for (const m of (c.messages || [])) {
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'system' || m.role === 'developer') {
      const t = toText(m.content);
      if (t) instructions.push(t);
    } else if (m.role === 'assistant') {
      const parts = [];
      if (typeof m.content === 'string') { if (m.content) parts.push({ type: 'output_text', text: m.content }); }
      else if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (!p) continue;
          if (p.type === 'text' && typeof p.text === 'string') parts.push({ type: 'output_text', text: p.text });
          else if (p.type === 'image_url' && p.image_url && p.image_url.url) parts.push({ type: 'input_image', image_url: p.image_url.url });
        }
      }
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        for (const tc of m.tool_calls) {
          input.push({ type: 'function_call', call_id: tc.id || randId('call_'), name: (tc.function && tc.function.name) || '', arguments: (tc.function && tc.function.arguments) != null ? String(tc.function.arguments) : '{}' });
        }
      }
      if (parts.length) input.push({ type: 'message', role: 'assistant', content: parts });
    } else if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.tool_call_id || '', output: toText(m.content) });
    } else {
      const content = (typeof m.content === 'string') ? m.content : (Array.isArray(m.content) ? m.content.map(p => {
        if (!p) return null;
        if (p.type === 'text' && typeof p.text === 'string') return { type: 'input_text', text: p.text };
        if (p.type === 'image_url' && p.image_url && p.image_url.url) return { type: 'input_image', image_url: p.image_url.url };
        return null;
      }).filter(Boolean) : '');
      input.push({ type: 'message', role: 'user', content: content === '' ? ' ' : content });
    }
  }
  const body = { model: c.model, input: input.length ? input : [' '], stream: !!c.stream };
  if (instructions.length) body.instructions = instructions.join('\n');
  if (c.temperature !== undefined) body.temperature = c.temperature;
  if (c.top_p !== undefined) body.top_p = c.top_p;
  if (c.max_tokens !== undefined) body.max_output_tokens = c.max_tokens;
  if (c.stop && c.stop.length) body.stop = c.stop;
  if (c.tools && c.tools.length) {
    body.tools = c.tools.map(t => (t && t.type === 'function') ? {
      type: 'function', name: t.function.name, description: t.function.description || '',
      parameters: (t.function.parameters && typeof t.function.parameters === 'object') ? t.function.parameters : { type: 'object' },
    } : t);
    if (c.tool_choice) {
      if (c.tool_choice === 'required' || c.tool_choice === 'none' || c.tool_choice === 'auto') body.tool_choice = c.tool_choice;
      else if (c.tool_choice.type === 'function' && c.tool_choice.function) body.tool_choice = { type: 'function', name: c.tool_choice.function.name };
      else body.tool_choice = 'auto';
    }
  }
  return body;
}

/* ================= Exit building: canonical -> upstream format ================= */
function canonicalToOpenAIBody(c, opts = {}) {
  const messages = [];
  for (const m of (c.messages || [])) {
    if (m.role === 'assistant') {
      const content = typeof m.content === 'string' ? m.content : toText(m.content);
      const hasTools = Array.isArray(m.tool_calls) && m.tool_calls.length;
      const out = { role: 'assistant', content: content === '' && hasTools ? null : content };
      if (hasTools) out.tool_calls = m.tool_calls;
      if (m.name != null) out.name = m.name;
      messages.push(out);
    } else if (m.role === 'tool') {
      messages.push({ role: 'tool', tool_call_id: m.tool_call_id || '', content: toText(m.content), ...(m.name ? { name: m.name } : {}) });
    } else if (m.role === 'system') {
      messages.push({ role: 'system', content: toText(m.content) });
    } else {
      let content = m.content;
      // plain-text arrays flatten to a string (max compatibility with OpenAI-compatible sites); arrays with images stay arrays
      if (Array.isArray(content) && content.every(x => x && x.type === 'text')) {
        content = content.map(x => x.text || '').join('');
      }
      messages.push({ role: 'user', content: content == null ? '' : content });
    }
  }
  if (!messages.length) messages.push({ role: 'user', content: ' ' });
  const body = { model: c.model, messages, stream: !!c.stream };
  if (c.temperature !== undefined) body.temperature = c.temperature;
  if (c.top_p !== undefined) body.top_p = c.top_p;
  if (c.max_tokens !== undefined) {
    if (/^o[0-9]/.test(String(c.model || ''))) body.max_completion_tokens = c.max_tokens;
    else body.max_tokens = c.max_tokens;
  }
  if (c.stop && c.stop.length) body.stop = c.stop;
  if (c.tools && c.tools.length) {
    body.tools = c.tools;
    if (c.tool_choice) body.tool_choice = c.tool_choice;
  }
  if (c.stream && opts.addUsage !== false) body.stream_options = { include_usage: true };
  return body;
}

function claudeFinish(reason) {
  return ({ stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', content_filter: 'refusal' })[reason] || 'end_turn';
}
function blocksToClaude(content) {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }];
  const out = [];
  for (const p of (content || [])) {
    if (!p) continue;
    if (p.type === 'text' && typeof p.text === 'string') out.push({ type: 'text', text: p.text });
    else if (p.type === 'image_url' && p.image_url && p.image_url.url) {
      const m = /^data:([^;,]+);base64,([\s\S]*)$/.exec(p.image_url.url);
      if (m) out.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
      else out.push({ type: 'image', source: { type: 'url', url: p.image_url.url } });
    }
  }
  return out;
}
function canonicalToClaudeBody(c) {
  const turns = [];
  const pushTurn = (role, blocks) => {
    if (!blocks.length) return;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else turns.push({ role, content: blocks });
  };
  for (const m of (c.messages || [])) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      pushTurn('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id || '', content: toText(m.content) }]);
    } else if (m.role === 'assistant') {
      const blocks = blocksToClaude(m.content);
      for (const tc of (m.tool_calls || [])) {
        let input = {};
        if (tc.function && typeof tc.function.arguments === 'string') {
          const p = safeParse(tc.function.arguments);
          if (p !== undefined && p !== null) input = (typeof p === 'object' && !Array.isArray(p)) ? p : { value: p };
        }
        blocks.push({ type: 'tool_use', id: tc.id || randId('toolu_'), name: (tc.function && tc.function.name) || '', input });
      }
      if (!blocks.length) blocks.push({ type: 'text', text: '' });
      pushTurn('assistant', blocks);
    } else {
      pushTurn('user', blocksToClaude(m.content));
    }
  }
  if (!turns.length) turns.push({ role: 'user', content: [{ type: 'text', text: ' ' }] });
  const sysParts = (c.messages || []).filter(m => m.role === 'system').map(m => toText(m.content)).filter(Boolean);
  const body = {
    model: c.model,
    messages: turns,
    max_tokens: c.max_tokens != null ? Number(c.max_tokens) : 4096,
    stream: !!c.stream,
  };
  if (sysParts.length) body.system = sysParts.join('\n');
  if (c.temperature !== undefined) body.temperature = c.temperature;
  if (c.top_p !== undefined) body.top_p = c.top_p;
  if (c.stop && c.stop.length) body.stop_sequences = c.stop;
  if (c.tools && c.tools.length) {
    body.tools = c.tools.map(t => ({
      name: t.function && t.function.name,
      description: (t.function && t.function.description) || '',
      input_schema: (t.function && t.function.parameters && typeof t.function.parameters === 'object') ? t.function.parameters : { type: 'object' },
    }));
    if (c.tool_choice === 'auto') body.tool_choice = { type: 'auto' };
    else if (c.tool_choice === 'required') body.tool_choice = { type: 'any' };
    else if (c.tool_choice === 'none') { /* Claude 无 none 语义, 保留 tools 默认 auto */ }
    else if (c.tool_choice && typeof c.tool_choice === 'object' && c.tool_choice.function) body.tool_choice = { type: 'tool', name: c.tool_choice.function.name };
  }
  return body;
}

function geminiFinish(reason) {
  return ({ stop: 'STOP', length: 'MAX_TOKENS', tool_calls: 'STOP', content_filter: 'SAFETY' })[reason] || 'STOP';
}
function blocksToGeminiParts(content) {
  if (typeof content === 'string') return content === '' ? [] : [{ text: content }];
  const out = [];
  for (const p of (content || [])) {
    if (!p) continue;
    if (p.type === 'text' && typeof p.text === 'string') out.push({ text: p.text });
    else if (p.type === 'image_url' && p.image_url && p.image_url.url) {
      const m = /^data:([^;,]+);base64,([\s\S]*)$/.exec(p.image_url.url);
      if (m) out.push({ inlineData: { mimeType: m[1], data: m[2] } });
      else out.push({ fileData: { fileUri: p.image_url.url } });
    }
  }
  return out;
}
function canonicalToGeminiBody(c) {
  const contents = [];
  const push = (role, parts) => {
    if (!parts.length) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  const nameById = {};
  const sysParts = [];
  for (const m of (c.messages || [])) {
    if (m.role === 'system') { const s = toText(m.content); if (s) sysParts.push(s); continue; }
    if (m.role === 'tool') {
      const nm = m.name || nameById[m.tool_call_id] || 'function';
      let resp = safeParse(toText(m.content));
      if (resp === undefined || resp === null) resp = { result: '' };
      if (typeof resp !== 'object' || Array.isArray(resp)) resp = { result: resp };
      push('user', [{ functionResponse: { name: nm, response: resp } }]);
    } else if (m.role === 'assistant') {
      const parts = blocksToGeminiParts(m.content);
      for (const tc of (m.tool_calls || [])) {
        const nm = (tc.function && tc.function.name) || '';
        nameById[tc.id] = nm;
        let args = safeParse((tc.function && tc.function.arguments) || '{}');
        if (args === undefined || args === null) args = {};
        parts.push({ functionCall: { name: nm, args: (typeof args === 'object' && !Array.isArray(args)) ? args : { value: args } } });
      }
      push('model', parts);
    } else {
      push('user', blocksToGeminiParts(m.content));
    }
  }
  if (!contents.length) contents.push({ role: 'user', parts: [{ text: ' ' }] });
  const body = { contents };
  if (sysParts.length) body.systemInstruction = { parts: [{ text: sysParts.join('\n') }] };
  const gc = {};
  if (c.temperature !== undefined) gc.temperature = c.temperature;
  if (c.top_p !== undefined) gc.topP = c.top_p;
  if (c.max_tokens !== undefined) gc.maxOutputTokens = c.max_tokens;
  if (c.stop && c.stop.length) gc.stopSequences = c.stop;
  if (Object.keys(gc).length) body.generationConfig = gc;
  if (c.tools && c.tools.length) {
    body.tools = [{
      functionDeclarations: c.tools.map(t => ({
        name: t.function && t.function.name,
        description: (t.function && t.function.description) || '',
        parameters: (t.function && t.function.parameters) || { type: 'object' },
      })),
    }];
    let mode, allowed;
    if (c.tool_choice === 'auto') mode = 'AUTO';
    else if (c.tool_choice === 'required') mode = 'ANY';
    else if (c.tool_choice === 'none') mode = 'NONE';
    else if (c.tool_choice && typeof c.tool_choice === 'object' && c.tool_choice.function) { mode = 'ANY'; allowed = [c.tool_choice.function.name]; }
    if (mode) body.toolConfig = { functionCallingConfig: { mode, ...(allowed ? { allowedFunctionNames: allowed } : {}) } };
  }
  return body;
}

/* ================= Upstream response (JSON) -> canonical ================= */
function openaiRespToCanonical(j) {
  const choice = (j.choices && j.choices[0]) || {};
  const msg = choice.message || {};
  let text = '';
  if (typeof msg.content === 'string') text = msg.content;
  else if (Array.isArray(msg.content)) text = msg.content.filter(p => p && p.type === 'text').map(p => p.text || '').join('');
  const usage = j.usage || {};
  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls.map(tc => ({
    id: tc.id, type: 'function',
    function: { name: (tc.function && tc.function.name) || '', arguments: (tc.function && tc.function.arguments) != null ? String(tc.function.arguments) : '{}' },
  })) : undefined;
  return {
    text,
    reasoning: typeof msg.reasoning_content === 'string' ? msg.reasoning_content : (typeof msg.reasoning === 'string' ? msg.reasoning : undefined),
    tool_calls: toolCalls,
    finish_reason: ({ stop: 'stop', length: 'length', tool_calls: 'tool_calls', content_filter: 'content_filter', function_call: 'tool_calls' })[choice.finish_reason] || 'stop',
    usage: {
      input: usage.prompt_tokens != null ? usage.prompt_tokens : 0,
      output: usage.completion_tokens != null ? usage.completion_tokens : 0,
      cached: (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0,
      reasoning: (usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens) || 0,
    },
  };
}
function claudeRespToCanonical(j) {
  let text = '';
  const reasoningParts = [];
  const toolCalls = [];
  for (const b of (j.content || [])) {
    if (!b) continue;
    if (b.type === 'text') text += b.text || '';
    else if (b.type === 'thinking') reasoningParts.push(b.thinking || '');
    else if (b.type === 'tool_use') toolCalls.push({ id: b.id, type: 'function', function: { name: b.name || '', arguments: JSON.stringify(b.input == null ? {} : b.input) } });
  }
  const usage = j.usage || {};
  return {
    text,
    reasoning: reasoningParts.length ? reasoningParts.join('\n') : undefined,
    tool_calls: toolCalls.length ? toolCalls : undefined,
    finish_reason: ({ end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', tool_use: 'tool_calls', refusal: 'content_filter' })[j.stop_reason] || 'stop',
    usage: {
      input: usage.input_tokens != null ? usage.input_tokens : 0,
      output: usage.output_tokens != null ? usage.output_tokens : 0,
      cached: (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0),
      reasoning: 0,
    },
  };
}
function geminiRespToCanonical(j) {
  const cand = (j.candidates && j.candidates[0]) || {};
  let text = '';
  const reasoningParts = [];
  const toolCalls = [];
  for (const p of ((cand.content && cand.content.parts) || [])) {
    if (!p) continue;
    if (typeof p.text === 'string') {
      if (p.thought) reasoningParts.push(p.text);
      else text += p.text;
    } else if (p.functionCall || p.function_call) {
      const f = p.functionCall || p.function_call;
      toolCalls.push({ id: randId('call_'), type: 'function', function: { name: f.name || '', arguments: JSON.stringify(f.args == null ? {} : f.args) } });
    }
  }
  const u = j.usageMetadata || j.usage_metadata || {};
  const fr = String(cand.finishReason || cand.finish_reason || 'STOP').toUpperCase();
  let finish = ({ STOP: 'stop', MAX_TOKENS: 'length', SAFETY: 'content_filter', RECITATION: 'content_filter', PROHIBITED_CONTENT: 'content_filter', BLOCKLIST: 'content_filter', SPII: 'content_filter' })[fr] || 'stop';
  if (toolCalls.length) finish = 'tool_calls';
  return {
    text,
    reasoning: reasoningParts.length ? reasoningParts.join('\n') : undefined,
    tool_calls: toolCalls.length ? toolCalls : undefined,
    finish_reason: finish,
    usage: {
      input: u.promptTokenCount != null ? u.promptTokenCount : (u.prompt_token_count || 0),
      output: u.candidatesTokenCount != null ? u.candidatesTokenCount : (u.candidates_token_count || 0),
      cached: u.cachedContentTokenCount || u.cached_content_token_count || 0,
      reasoning: u.thoughtsTokenCount || u.thoughts_token_count || 0,
    },
  };
}

/* ================= canonical -> client-format response (JSON) ================= */
function canonicalToOpenAIResp(cresp, model) {
  const message = { role: 'assistant', content: cresp.text === '' ? null : cresp.text };
  if (cresp.reasoning) message.reasoning_content = cresp.reasoning;
  if (cresp.tool_calls && cresp.tool_calls.length) message.tool_calls = cresp.tool_calls;
  if (cresp.text === '' && !(message.tool_calls || []).length) message.content = '';
  return {
    id: randId('chatcmpl-'), object: 'chat.completion', created: nowSec(), model,
    choices: [{ index: 0, message, finish_reason: cresp.finish_reason }],
    usage: { prompt_tokens: cresp.usage.input, completion_tokens: cresp.usage.output, total_tokens: cresp.usage.input + cresp.usage.output },
  };
}
function canonicalToClaudeResp(cresp, model) {
  const content = [];
  if (cresp.reasoning) content.push({ type: 'thinking', thinking: cresp.reasoning });
  if (cresp.text !== '') content.push({ type: 'text', text: cresp.text });
  for (const tc of (cresp.tool_calls || [])) {
    let input = safeParse(tc.function.arguments);
    if (input === undefined || input === null) input = {};
    content.push({ type: 'tool_use', id: tc.id || randId('toolu_'), name: tc.function.name, input: (typeof input === 'object' && !Array.isArray(input)) ? input : { value: input } });
  }
  if (!content.length) content.push({ type: 'text', text: '' });
  return {
    id: randId('msg_'), type: 'message', role: 'assistant', model,
    content,
    stop_reason: claudeFinish(cresp.finish_reason), stop_sequence: null,
    usage: { input_tokens: cresp.usage.input, output_tokens: cresp.usage.output },
  };
}
function canonicalToGeminiResp(cresp, model) {
  const parts = [];
  if (cresp.reasoning) parts.push({ text: cresp.reasoning, thought: true });
  if (cresp.text !== '') parts.push({ text: cresp.text });
  for (const tc of (cresp.tool_calls || [])) {
    let args = safeParse(tc.function.arguments);
    if (args === undefined || args === null) args = {};
    parts.push({ functionCall: { name: tc.function.name, args: (typeof args === 'object' && !Array.isArray(args)) ? args : { value: args } } });
  }
  if (!parts.length) parts.push({ text: '' });
  return {
    candidates: [{ content: { role: 'model', parts }, finishReason: geminiFinish(cresp.finish_reason), index: 0 }],
    usageMetadata: { promptTokenCount: cresp.usage.input, candidatesTokenCount: cresp.usage.output, totalTokenCount: cresp.usage.input + cresp.usage.output },
    modelVersion: model,
  };
}

// Upstream Responses non-streaming response -> canonical response (parses the output array)
function responsesRespToCanonical(j) {
  let text = '';
  const reasoningParts = [];
  const toolCalls = [];
  for (const item of (j.output || [])) {
    if (!item) continue;
    if (item.type === 'message') {
      for (const p of (item.content || [])) {
        if (p && p.type === 'output_text' && typeof p.text === 'string') text += p.text;
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({ id: item.id || item.call_id || randId('call_'), type: 'function', function: { name: item.name || '', arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments == null ? {} : item.arguments) } });
    } else if (item.type === 'reasoning') {
      const sums = (item.summary || []).filter(s => s && s.type === 'summary_text' && typeof s.text === 'string').map(s => s.text);
      if (sums.length) reasoningParts.push(sums.join('\n'));
    }
  }
  const usage = j.usage || {};
  const st = String(j.status || 'completed');
  let finish = 'stop';
  if (st === 'incomplete') finish = 'length';
  else if (st === 'failed') finish = 'content_filter';
  if (toolCalls.length) finish = 'tool_calls';
  return {
    text,
    reasoning: reasoningParts.length ? reasoningParts.join('\n') : undefined,
    tool_calls: toolCalls.length ? toolCalls : undefined,
    finish_reason: finish,
    usage: {
      input: usage.input_tokens != null ? usage.input_tokens : 0,
      output: usage.output_tokens != null ? usage.output_tokens : 0,
      cached: (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0),
      reasoning: 0,
    },
  };
}

// canonical response -> client Responses non-streaming response
function canonicalToResponsesResp(cresp, model) {
  const output = [];
  if (cresp.reasoning) {
    output.push({ type: 'reasoning', id: randId('rs_'), summary: [{ type: 'summary_text', text: cresp.reasoning }] });
  }
  if (cresp.tool_calls && cresp.tool_calls.length) {
    for (const tc of cresp.tool_calls) {
      output.push({ type: 'function_call', id: randId('fc_'), call_id: tc.id || randId('call_'), name: (tc.function && tc.function.name) || '', arguments: (tc.function && tc.function.arguments) != null ? String(tc.function.arguments) : '{}', status: 'completed' });
    }
  }
  const content = cresp.text !== '' ? [{ type: 'output_text', text: cresp.text, annotations: [] }] : [];
  output.push({ type: 'message', id: randId('msg_'), status: 'completed', role: 'assistant', content });
  const finStatus = (cresp.finish_reason === 'length' || cresp.finish_reason === 'content_filter') ? 'incomplete' : 'completed';
  return {
    id: randId('resp_'), object: 'response', created_at: nowSec(), status: finStatus, model, output,
    incomplete_details: cresp.finish_reason === 'length' ? { reason: 'max_output_tokens' } : null,
    instructions: null, metadata: {}, parallel_tool_calls: true,
    usage: { input_tokens: cresp.usage.input, output_tokens: cresp.usage.output, total_tokens: cresp.usage.input + cresp.usage.output },
    error: null,
  };
}

/* ================= SSE decode + upstream stream -> canonical events ================= */
class UpstreamStreamParser {
  constructor(format, emit) {
    this.format = format;
    this.emit = emit;
    this.finished = false;
    this.finishReason = undefined;
    this.usage = null;
    this.toolIdx = 0;
  }
  handle(j) {
    const evs = [];
    if (this.format === 'openai') {
      const ch = (j.choices && j.choices[0]) || {};
      const d = ch.delta || {};
      if (typeof d.content === 'string' && d.content) evs.push({ type: 'text', t: d.content });
      if (typeof d.reasoning_content === 'string' && d.reasoning_content) evs.push({ type: 'reasoning', t: d.reasoning_content });
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const i = tc.index != null ? tc.index : this.toolIdx;
          const fname = (tc.function && tc.function.name) || '';
          if (tc.id || fname) evs.push({ type: 'tool_start', i, id: tc.id || ('call_' + fname), name: fname });
          if (tc.function && typeof tc.function.arguments === 'string' && tc.function.arguments) evs.push({ type: 'tool_delta', i, s: tc.function.arguments });
          if (tc.index != null && tc.index >= this.toolIdx) this.toolIdx = tc.index + 1;
        }
      }
      if (j.usage) this.usage = {
        input: j.usage.prompt_tokens || 0,
        output: j.usage.completion_tokens || 0,
        cached: (j.usage.prompt_tokens_details && j.usage.prompt_tokens_details.cached_tokens) || 0,
        reasoning: (j.usage.completion_tokens_details && j.usage.completion_tokens_details.reasoning_tokens) || 0,
      };
      if (ch.finish_reason) this.finishReason = ({ stop: 'stop', length: 'length', tool_calls: 'tool_calls', content_filter: 'content_filter', function_call: 'tool_calls' })[ch.finish_reason] || 'stop';
    } else if (this.format === 'claude') {
      const t = j.type;
      if (t === 'message_start') {
        const u = (j.message && j.message.usage) || {};
        this.usage = {
          input: u.input_tokens || 0,
          output: (this.usage && this.usage.output) || 0,
          cached: (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
          reasoning: 0,
        };
        evs.push({ type: 'start', usage: { input: this.usage.input } });
      } else if (t === 'content_block_start') {
        const b = j.content_block || {};
        if (b.type === 'tool_use') evs.push({ type: 'tool_start', i: this.toolIdx++, id: b.id || randId('toolu_'), name: b.name || '' });
      } else if (t === 'content_block_delta') {
        const d = j.delta || {};
        if (d.type === 'text_delta' && d.text) evs.push({ type: 'text', t: d.text });
        else if (d.type === 'thinking_delta' && d.thinking) evs.push({ type: 'reasoning', t: d.thinking });
        else if (d.type === 'input_json_delta' && d.partial_json) evs.push({ type: 'tool_delta', i: Math.max(0, this.toolIdx - 1), s: d.partial_json });
      } else if (t === 'message_delta') {
        const d = j.delta || {};
        if (d.stop_reason) this.finishReason = ({ end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', tool_use: 'tool_calls', refusal: 'content_filter' })[d.stop_reason] || 'stop';
        if (j.usage && j.usage.output_tokens != null) this.usage = {
          input: (this.usage && this.usage.input) || 0,
          output: j.usage.output_tokens,
          cached: (this.usage && this.usage.cached) || (j.usage.cache_read_input_tokens || 0) + (j.usage.cache_creation_input_tokens || 0),
          reasoning: (j.usage && (j.usage.reasoning_tokens != null ? j.usage.reasoning_tokens : 0)) || (this.usage && this.usage.reasoning) || 0,
        };
      }
// message_stop / ping / error: end is always sent from finish()
    } else { // gemini
      const cand = (j.candidates && j.candidates[0]) || {};
      for (const p of ((cand.content && cand.content.parts) || [])) {
        if (!p) continue;
        if (typeof p.text === 'string') {
          evs.push(p.thought ? { type: 'reasoning', t: p.text } : { type: 'text', t: p.text });
        } else if (p.functionCall || p.function_call) {
          const f = p.functionCall || p.function_call;
          const i = this.toolIdx++;
          evs.push({ type: 'tool_start', i, id: 'call_gm_' + i, name: f.name || '' });
          evs.push({ type: 'tool_delta', i, s: JSON.stringify(f.args == null ? {} : f.args) });
        }
      }
      const u = j.usageMetadata || j.usage_metadata;
      if (u) this.usage = {
        input: u.promptTokenCount || 0,
        output: u.candidatesTokenCount || 0,
        cached: u.cachedContentTokenCount || u.cached_content_token_count || 0,
        reasoning: u.thoughtsTokenCount || u.thoughts_token_count || 0,
      };
      const fr = cand.finishReason || cand.finish_reason;
      if (fr) this.finishReason = ({ STOP: 'stop', MAX_TOKENS: 'length', SAFETY: 'content_filter', RECITATION: 'content_filter' })[String(fr).toUpperCase()] || 'stop';
    }
    for (const e of evs) this.emit(e);
  }
  finish() {
    if (this.finished) return;
    this.finished = true;
    this.emit({ type: 'end', finish_reason: this.finishReason || 'stop', usage: this.usage || { input: 0, output: 0, cached: 0, reasoning: 0 } });
  }
}

/* ================= canonical events -> client streaming output ================= */
function sseData(res, obj) { res.write('data: ' + JSON.stringify(obj) + '\n\n'); }
function sseEvent(res, ev, obj) { res.write('event: ' + ev + '\ndata: ' + JSON.stringify(obj) + '\n\n'); }

function makeWriter(format, res, model, opts = {}) {
  if (format === 'openai') {
    const id = randId('chatcmpl-');
    const created = nowSec();
    let firstChunk = true;
    const chunk = (delta, finish_reason) => {
      sseData(res, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish_reason || null }] });
    };
    let ended = false;
    return {
      onEvent(ev) {
        if (!ev || ended) return;
        if (ev.type === 'text') {
          if (firstChunk) { chunk({ role: 'assistant', content: '' }); firstChunk = false; }
          chunk({ content: ev.t });
        } else if (ev.type === 'reasoning') {
          if (firstChunk) { chunk({ role: 'assistant', content: '' }); firstChunk = false; }
          chunk({ reasoning_content: ev.t });
        } else if (ev.type === 'tool_start') {
          chunk({ tool_calls: [{ index: ev.i, id: ev.id, type: 'function', function: { name: ev.name, arguments: '' } }] });
        } else if (ev.type === 'tool_delta') {
          chunk({ tool_calls: [{ index: ev.i, function: { arguments: ev.s } }] });
        } else if (ev.type === 'end') {
          ended = true;
          chunk({}, ev.finish_reason);
          const u = ev.usage || { input: 0, output: 0 };
          sseData(res, { id, object: 'chat.completion.chunk', created, model, choices: [], usage: { prompt_tokens: u.input, completion_tokens: u.output, total_tokens: u.input + u.output } });
          res.write('data: [DONE]\n\n');
          res.end();
        }
      },
    };
  }

  if (format === 'claude') {
    const id = randId('msg_');
    let started = false, sawAny = false, nextBlock = 0, open = null;
    const usage = { input: 0, output: 0 };
    const ensureStart = () => {
      if (started) return;
      started = true;
      sseEvent(res, 'message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: usage.input, output_tokens: 1 } } });
      sseEvent(res, 'ping', { type: 'ping' });
    };
    const closeOpen = () => { if (open) { sseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: open.idx }); open = null; } };
    const ensure = (kind, tool) => {
      if (open && open.kind === kind && (kind !== 'tool' || open.i === tool.i)) return open;
      closeOpen();
      const idx = nextBlock++;
      if (kind === 'text') sseEvent(res, 'content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } });
      else if (kind === 'thinking') sseEvent(res, 'content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'thinking', thinking: '' } });
      else sseEvent(res, 'content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } });
      open = { kind, idx, i: tool ? tool.i : undefined };
      return open;
    };
    let ended = false;
    return {
      onEvent(ev) {
        if (!ev || ended) return;
        if (ev.type === 'start') {
          if (ev.usage && ev.usage.input) usage.input = ev.usage.input;
          ensureStart();
        } else if (ev.type === 'text') {
          sawAny = true; ensureStart();
          const b = ensure('text');
          sseEvent(res, 'content_block_delta', { type: 'content_block_delta', index: b.idx, delta: { type: 'text_delta', text: ev.t } });
        } else if (ev.type === 'reasoning') {
          sawAny = true; ensureStart();
          const b = ensure('thinking');
          sseEvent(res, 'content_block_delta', { type: 'content_block_delta', index: b.idx, delta: { type: 'thinking_delta', thinking: ev.t } });
        } else if (ev.type === 'tool_start') {
          sawAny = true; ensureStart();
          ensure('tool', { id: ev.id, name: ev.name, i: ev.i });
        } else if (ev.type === 'tool_delta') {
          ensureStart();
          const b = ensure('tool', { id: '', name: '', i: ev.i });
          sseEvent(res, 'content_block_delta', { type: 'content_block_delta', index: b.idx, delta: { type: 'input_json_delta', partial_json: ev.s } });
        } else if (ev.type === 'end') {
          ended = true;
          ensureStart();
          closeOpen();
          if (!sawAny) {
            const idx = nextBlock++;
            sseEvent(res, 'content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } });
            sseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: idx });
          }
          const u = ev.usage || { input: 0, output: 0 };
          if (u.input) usage.input = u.input;
          usage.output = u.output;
          sseEvent(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: claudeFinish(ev.finish_reason), stop_sequence: null }, usage: { output_tokens: u.output } });
          sseEvent(res, 'message_stop', { type: 'message_stop' });
          res.end();
        }
      },
    };
  }

// gemini: SSE format when alt=sse, otherwise a chunked JSON-array stream
  const isArray = !!opts.geminiArray;
  let firstArray = true;
  let toolBuf = null;
  const writeChunk = (obj) => {
    if (isArray) {
      if (firstArray) { res.write('[' + JSON.stringify(obj)); firstArray = false; }
      else res.write(',' + JSON.stringify(obj));
    } else sseData(res, obj);
  };
  const flushTool = () => {
    if (!toolBuf) return;
    let args = safeParse(toolBuf.s || '{}');
    if (args === undefined || args === null) args = {};
    writeChunk({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: toolBuf.name, args: (typeof args === 'object' && !Array.isArray(args)) ? args : { value: args } } }] }, index: 0 }] });
    toolBuf = null;
  };
  let ended = false;
  return {
    onEvent(ev) {
      if (!ev || ended) return;
      if (ev.type === 'text') {
        flushTool();
        writeChunk({ candidates: [{ content: { role: 'model', parts: [{ text: ev.t }] }, index: 0 }] });
      } else if (ev.type === 'reasoning') {
        flushTool();
        writeChunk({ candidates: [{ content: { role: 'model', parts: [{ text: ev.t, thought: true }] }, index: 0 }] });
      } else if (ev.type === 'tool_start') {
        flushTool();
        toolBuf = { i: ev.i, id: ev.id, name: ev.name, s: '' };
      } else if (ev.type === 'tool_delta') {
        if (toolBuf && toolBuf.i === ev.i) toolBuf.s += ev.s;
      } else if (ev.type === 'end') {
        ended = true;
        flushTool();
        const u = ev.usage || { input: 0, output: 0 };
        writeChunk({ candidates: [{ content: { role: 'model', parts: [] }, finishReason: geminiFinish(ev.finish_reason), index: 0 }], usageMetadata: { promptTokenCount: u.input, candidatesTokenCount: u.output, totalTokenCount: u.input + u.output } });
        if (isArray) { if (firstArray) res.write('[]'); else res.write(']'); }
        res.end();
      }
    },
  };
}

/* ================= canonical events -> client Responses streaming SSE ================= */
function makeResponsesWriter(res, model) {
  const respId = randId('resp_');
  const msgId = randId('msg_');
  const created = nowSec();
  let started = false, nextOutIdx = 0, msgOutIdx = null, msgText = '';
  let curReasoning = null, curTool = null;
  const outputArr = [];
  const usage = { input: 0, output: 0 };
  const baseResp = (status) => ({ id: respId, object: 'response', created_at: created, status: status || 'in_progress', model, output: [], incomplete_details: null, instructions: null, metadata: {}, parallel_tool_calls: true, temperature: null, top_p: null, max_output_tokens: null, tools: [], tool_choice: 'auto', usage: null, error: null });
  const ensureStart = () => {
    if (started) return;
    started = true;
    sseData(res, { type: 'response.created', response: baseResp('in_progress') });
    sseData(res, { type: 'response.in_progress', response: baseResp('in_progress') });
  };
  const ensureMsg = () => {
    if (msgOutIdx != null) return;
    msgOutIdx = nextOutIdx++;
    sseData(res, { type: 'response.output_item.added', output_index: msgOutIdx, item: { id: msgId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
    sseData(res, { type: 'response.content_part.added', item_id: msgId, output_index: msgOutIdx, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
  };
  const finishItems = () => {
    if (msgOutIdx != null) {
      const part = { type: 'output_text', text: msgText, annotations: [] };
      sseData(res, { type: 'response.output_text.done', item_id: msgId, output_index: msgOutIdx, content_index: 0, part });
      sseData(res, { type: 'response.content_part.done', item_id: msgId, output_index: msgOutIdx, content_index: 0, part });
      sseData(res, { type: 'response.output_item.done', output_index: msgOutIdx, item: { id: msgId, type: 'message', status: 'completed', role: 'assistant', content: msgText !== '' ? [part] : [] } });
      outputArr.push({ id: msgId, type: 'message', status: 'completed', role: 'assistant', content: msgText !== '' ? [part] : [] });
      msgOutIdx = null;
    }
    if (curReasoning) {
      const part = { type: 'summary_text', text: curReasoning.text };
      sseData(res, { type: 'response.reasoning_summary_text.done', item_id: curReasoning.id, output_index: curReasoning.outIdx, part });
      sseData(res, { type: 'response.output_item.done', output_index: curReasoning.outIdx, item: { id: curReasoning.id, type: 'reasoning', status: 'completed', summary: curReasoning.text ? [part] : [] } });
      outputArr.push({ id: curReasoning.id, type: 'reasoning', status: 'completed', summary: curReasoning.text ? [part] : [] });
      curReasoning = null;
    }
    if (curTool) {
      sseData(res, { type: 'response.output_item.done', output_index: curTool.outIdx, item: { id: curTool.id, type: 'function_call', status: 'completed', call_id: curTool.callId, name: curTool.name, arguments: curTool.args } });
      outputArr.push({ id: curTool.id, type: 'function_call', status: 'completed', call_id: curTool.callId, name: curTool.name, arguments: curTool.args });
      curTool = null;
    }
  };
  let ended = false;
  return {
    onEvent(ev) {
      if (!ev || ended) return;
      if (ev.type === 'text') {
        ensureStart(); ensureMsg(); msgText += ev.t;
        sseData(res, { type: 'response.output_text.delta', item_id: msgId, output_index: msgOutIdx, content_index: 0, delta: ev.t });
      } else if (ev.type === 'reasoning') {
        ensureStart();
        if (!curReasoning) {
          curReasoning = { id: randId('rs_'), outIdx: nextOutIdx++, text: '' };
          sseData(res, { type: 'response.output_item.added', output_index: curReasoning.outIdx, item: { id: curReasoning.id, type: 'reasoning', status: 'in_progress', summary: [] } });
        }
        curReasoning.text += ev.t;
        sseData(res, { type: 'response.reasoning_summary_text.delta', item_id: curReasoning.id, output_index: curReasoning.outIdx, delta: ev.t });
      } else if (ev.type === 'tool_start') {
        ensureStart();
        curTool = { id: randId('fc_'), callId: ev.id || randId('call_'), name: ev.name || '', outIdx: nextOutIdx++, args: '' };
        sseData(res, { type: 'response.output_item.added', output_index: curTool.outIdx, item: { id: curTool.id, type: 'function_call', status: 'in_progress', call_id: curTool.callId, name: curTool.name, arguments: '' } });
      } else if (ev.type === 'tool_delta') {
        if (curTool && curTool.outIdx != null) {
          curTool.args += ev.s;
          sseData(res, { type: 'response.function_call_arguments.delta', item_id: curTool.id, output_index: curTool.outIdx, delta: ev.s });
        }
      } else if (ev.type === 'end') {
        ended = true;
        ensureStart();
        finishItems();
        const u = ev.usage || { input: 0, output: 0 };
        usage.input = u.input || 0; usage.output = u.output || 0;
        const finStatus = ev.finish_reason === 'length' ? 'incomplete' : (ev.finish_reason === 'content_filter' ? 'failed' : 'completed');
        const full = baseResp(finStatus);
        full.output = outputArr;
        full.incomplete_details = finStatus === 'incomplete' ? { reason: 'max_output_tokens' } : null;
        full.usage = { input_tokens: usage.input, output_tokens: usage.output, total_tokens: usage.input + usage.output };
        if (finStatus === 'failed') full.error = { code: 'server_error', message: 'upstream finished with content_filter' };
        sseData(res, { type: 'response.' + finStatus, response: full });
        res.write('data: [DONE]\n\n');
        res.end();
      }
    },
  };
}

module.exports = { http, https, net, tls, fs, path, crypto, os, zlib, openaiToCanonical, claudeToolsToOpenAI, claudeChoiceToOpenAI, claudeToCanonical, geminiToCanonical, ResponsesStreamParser, responsesContentToContent, responsesToCanonical, canonicalToResponsesBody, canonicalToOpenAIBody, claudeFinish, blocksToClaude, canonicalToClaudeBody, geminiFinish, blocksToGeminiParts, canonicalToGeminiBody, openaiRespToCanonical, claudeRespToCanonical, geminiRespToCanonical, canonicalToOpenAIResp, canonicalToClaudeResp, canonicalToGeminiResp, responsesRespToCanonical, canonicalToResponsesResp, SSEDecoder, UpstreamStreamParser, sseData, sseEvent, makeWriter, makeResponsesWriter };
