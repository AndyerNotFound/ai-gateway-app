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
const { loadConfig, normalizeProxy } = require('./config');
const { logErr, VERSION } = require('./util');
const { saveKeyUsage, pickChannel, pickChannels, collectModels, globMatch, estimatePromptTokens, estimatePromptDist, analyzePrompt, calibRatio, calibUpdate, scaleDist, checkAuth, loadKeyUsage, keyUsageFile, keyCreditsJSON, genApiKey } = require('./router');
const { flushStats, createInstancePool, poolLoadAll, poolLoadInstance, poolRemoveInstance, poolRenameInstance, poolRoute, RESERVED_PATHS, INST_NAME_RE } = require('./pool');
const { startServer } = require('./server');
const { joinUrl, balanceTarget, presetForChannel, fetchChannelBalance, fetchBalanceCached, pickBalanceChannel, BALANCE_PRESETS, balanceChannelList, balanceAggregate, balanceFxRate, probeRound, probeOnce, setupProbe } = require('./upstream');
const { RETRYABLE, chUsesResponses, buildRequestForChannel } = require('./sync');
const { openaiToCanonical, claudeToCanonical, geminiToCanonical, canonicalToOpenAIBody, canonicalToClaudeBody, canonicalToGeminiBody, openaiRespToCanonical, claudeRespToCanonical, geminiRespToCanonical, canonicalToOpenAIResp, canonicalToClaudeResp, canonicalToGeminiResp, responsesToCanonical, canonicalToResponsesBody, responsesRespToCanonical, canonicalToResponsesResp, ResponsesStreamParser, makeResponsesWriter, SSEDecoder, UpstreamStreamParser, makeWriter, claudeFinish, geminiFinish } = require('./convert');
const { socks5Connect, httpConnect, dialViaProxy, makeReader } = require('./proxy');
const state = require('./state');
const rt = require('./runtime');
const hot = require('./hot');

// Persist everything a restart would otherwise lose (key usage, stats, plugin buffers)
function flushAll(cfg) {
  const cs = state.CUR_POOL ? [...state.CUR_POOL.instances.values()] : [cfg];
  for (const c of cs) {
    try { saveKeyUsage(c); } catch (_) {}
    try { flushStats(c); } catch (_) {}
  }
  try { rt.PLUGINS && rt.PLUGINS.flushAll(); } catch (_) {}
}

function argPaths() {
  const args = process.argv.slice(2);
  let configPath = path.join(__dirname, 'data', 'config.json');
  let portOverride;
  for (const a of args) {
    if (/^\d+$/.test(a)) portOverride = Number(a);
    else configPath = a;
  }
  return { configPath, portOverride };
}

function main() {
  const { configPath, portOverride } = argPaths();
  let cfg;
  try {
    cfg = loadConfig(configPath);
  } catch (e) {
    logErr('Config load failed:', e.message);
    process.exit(1);
  }
  if (!cfg.channels.length) logErr('⚠ No valid channels in config; requests will return 503');
  process.on('unhandledRejection', e => logErr('unhandledRejection:', (e && e.message) || e));
  process.on('uncaughtException', e => logErr('uncaughtException:', (e && e.message) || e));
  process.on('SIGTERM', () => { flushAll(cfg); process.exit(0); });
  process.on('SIGINT', () => process.exit(0));
  // multi-instance by default (hosts every config*.json); AGW_SINGLE=1 or a port arg falls back to one instance
  const multi = portOverride == null && process.env.AGW_SINGLE !== '1';
  let started = null;
  hot.worker(() => {
    const pool = state.CUR_POOL;
    if (pool) return [...pool.servers.values()].map(v => v.server);
    if (!started) return [];
    return started.servers || (started.server ? [started.server] : []);
  }, () => flushAll(cfg));
  startServer(cfg, { port: portOverride, multi })
    .then(r => { started = r; hot.ready(); })
    .catch(e => { logErr('Start failed:', e.message); process.exit(1); });
}

if (require.main === module) {
  // hot mode: master holds the listen handles and forks a worker; otherwise run directly
  if (hot.ENABLED && hot.cluster.isPrimary) hot.primary(path.join(path.dirname(argPaths().configPath), '.run'));
  else main();
}

module.exports = {
  main,
  VERSION, loadConfig, normalizeProxy, joinUrl, pickChannel, pickChannels, collectModels, RETRYABLE,
  globMatch, estimatePromptTokens, estimatePromptDist, analyzePrompt,
  calibRatio, calibUpdate, scaleDist,
  openaiToCanonical, claudeToCanonical, geminiToCanonical,
  canonicalToOpenAIBody, canonicalToClaudeBody, canonicalToGeminiBody,
  openaiRespToCanonical, claudeRespToCanonical, geminiRespToCanonical,
  canonicalToOpenAIResp, canonicalToClaudeResp, canonicalToGeminiResp,
  responsesToCanonical, canonicalToResponsesBody, responsesRespToCanonical, canonicalToResponsesResp,
  ResponsesStreamParser, makeResponsesWriter, chUsesResponses, buildRequestForChannel,
  SSEDecoder, UpstreamStreamParser, makeWriter, claudeFinish, geminiFinish,
  socks5Connect, httpConnect, dialViaProxy, makeReader,
  startServer, checkAuth,
  balanceTarget, presetForChannel, fetchChannelBalance, fetchBalanceCached, pickBalanceChannel, BALANCE_PRESETS,
  balanceChannelList, balanceAggregate, balanceFxRate,
  createInstancePool, poolLoadAll, poolLoadInstance, poolRemoveInstance, poolRenameInstance, poolRoute,
  RESERVED_PATHS, INST_NAME_RE,
  loadKeyUsage, saveKeyUsage, keyUsageFile,
  keyCreditsJSON, genApiKey,
  probeRound, probeOnce, setupProbe,
};
