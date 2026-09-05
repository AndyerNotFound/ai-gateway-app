#!/usr/bin/env node
/* crypt.js - ai-gateway 配置文件加密工具 (零依赖, Node 内置 crypto)
 * 加密方案: AES-256-GCM, 密钥由口令经 scrypt(N=16384,r=8,p=1) 派生, 每文件独立随机 salt+iv
 * 文件格式: "AGWENC1:" + base64(salt[16] | iv[12] | authTag[16] | ciphertext)
 * 口令来源: 环境变量 AGW_CRYPT_PASS 或密钥文件 <ai-gateway>/.agwkey (enable 写入, 权限600)
 * 用法: status / enable [--pass 口令|--genkey] / disable [--keep-key] / changepass [--old 旧 --pass 新] / test
 * 注意: 忘记口令 = 加密配置无法恢复; enable/disable 后需重启各实例
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const MAGIC = 'AGWENC1:';
const DIR = __dirname;
const KEY_FILE = () => process.env.AGW_KEY_FILE || path.join(DIR, '.agwkey');

function deriveKey(pass, salt) {
  return crypto.scryptSync(String(pass), salt, 32, { N: 16384, r: 8, p: 1 });
}
function isEncText(t) { return typeof t === 'string' && t.startsWith(MAGIC); }
function encryptText(plain, pass) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', deriveKey(pass, salt), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return MAGIC + Buffer.concat([salt, iv, c.getAuthTag(), ct]).toString('base64');
}
function decryptText(enc, pass) {
  const b = Buffer.from(String(enc).slice(MAGIC.length), 'base64');
  if (b.length < 45) throw new Error('密文格式无效');
  const salt = b.subarray(0, 16), iv = b.subarray(16, 28), tag = b.subarray(28, 44), ct = b.subarray(44);
  const d = crypto.createDecipheriv('aes-256-gcm', deriveKey(pass, salt), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}
function loadPass() {
  if (process.env.AGW_CRYPT_PASS) return process.env.AGW_CRYPT_PASS;
  const kf = KEY_FILE();
  if (fs.existsSync(kf)) { const t = fs.readFileSync(kf, 'utf8').trim(); return t || null; }
  return null;
}
function configFileList() {
  try { return fs.readdirSync(DIR).filter(f => /^config(\..+)?\.json$/.test(f)).sort(); }
  catch (e) { return []; }
}
function writeIfChanged(file, newText, pass) {
  const old = fs.readFileSync(file, 'utf8');
  if (old === newText) return 'unchanged';
  if (isEncText(newText) && decryptText(newText, pass) !== old) throw new Error(file + ' 回读验证失败, 已中止写入');
  fs.writeFileSync(file, newText);
  return isEncText(newText) ? 'encrypted' : 'decrypted';
}
let _rl = null, _pending = [], _lines = [];
function _mmFlush() {
  while (_pending.length && _lines.length) {
    const cb = _pending.shift();
    muted = false;
    cb(_lines.shift());
  }
}
let muted = true;
function getRl() {
  if (_rl) return _rl;
  _rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: !!process.stdin.isTTY   // 终端模式: 退格可用; 管道模式: 逐行读取
  });
  _rl._writeToOutput = s => { if (!muted) process.stdout.write(s); };  // 静音, 不回显口令
  _rl.on('line', l => { _lines.push(String(l).trim()); _mmFlush(); });
  _rl.on('close', () => { while (_pending.length) { const cb = _pending.shift(); muted = false; cb(''); } });
  _rl.on('SIGINT', () => { process.stdout.write('\n(已取消)\n'); process.exit(130); });
  return _rl;
}
function askHidden(question) {
  return new Promise(resolve => {
    process.stdout.write(question);
    getRl();
    _pending.push(resolve);
    _mmFlush();
  });
}
function cmdStatus() {
  const files = configFileList();
  const pass = loadPass();
  console.log('密钥文件: ' + KEY_FILE() + (fs.existsSync(KEY_FILE()) ? '  [存在]' : '  [不存在]'));
  console.log('AGW_CRYPT_PASS: ' + (process.env.AGW_CRYPT_PASS ? '[已设置]' : '[未设置]'));
  console.log('可用口令: ' + (pass ? '[有] 加密配置可读' : '[无] 加密配置不可读'));
  for (const f of files) {
    const raw = fs.readFileSync(path.join(DIR, f), 'utf8');
    if (isEncText(raw)) {
      let ok = '?';
      try { decryptText(raw, pass); ok = '可用当前口令解开'; } catch (e) { ok = '! 当前口令解不开: ' + e.message; }
      console.log('  ' + f.padEnd(28) + '[已加密] ' + ok);
    } else {
      console.log('  ' + f.padEnd(28) + '[明文]');
    }
  }
}
async function cmdEnable(argv) {
  let pass = null;
  const pi = argv.indexOf('--pass');
  if (pi >= 0 && argv[pi + 1]) pass = argv[pi + 1];
  else if (argv.includes('--genkey')) {
    pass = crypto.randomBytes(24).toString('base64url');
    console.log('已生成随机口令(请立即抄写保存, 只显示这一次):\n  ' + pass + '\n');
  } else {
    const a = await askHidden('设置配置加密口令(输入不回显): ');
    const b = await askHidden('再输一遍确认: ');
    if (!a) { console.log('口令不能为空'); process.exit(1); }
    if (a !== b) { console.log('两次输入不一致'); process.exit(1); }
    pass = a;
  }
  if (!pass) { console.log('口令不能为空'); process.exit(1); }
  const files = configFileList();
  if (!files.length) { console.log('未找到任何 config*.json'); process.exit(1); }
  const jobs = [];
  for (const f of files) {
    const raw = fs.readFileSync(path.join(DIR, f), 'utf8');
    if (isEncText(raw)) {
      let plain;
      try { plain = decryptText(raw, loadPass()); } catch (e) { console.log('x ' + f + ' 已加密但当前口令解不开, 中止: ' + e.message); process.exit(1); }
      jobs.push([f, plain]);
    } else {
      JSON.parse(raw);
      jobs.push([f, raw]);
    }
  }
  for (const [f, plain] of jobs) {
    writeIfChanged(path.join(DIR, f), encryptText(plain, pass), pass);
    console.log('OK ' + f + ' -> 已加密');
  }
  fs.writeFileSync(KEY_FILE(), pass + '\n', { mode: 0o600 });
  try { fs.chmodSync(KEY_FILE(), 0o600); } catch (e) {}
  console.log('OK 密钥已写入 ' + KEY_FILE() + ' (权限600)');
  console.log('完成。请重启各实例: agw.sh restart <名字>');
  console.log('注意: 口令务必自行备份; 忘记口令 = 配置无法恢复。');
}
function cmdDisable(argv) {
  const pass = loadPass();
  if (!pass) { console.log('找不到口令(keyfile/env), 无法解密加密配置'); process.exit(1); }
  for (const f of configFileList()) {
    const p = path.join(DIR, f);
    const raw = fs.readFileSync(p, 'utf8');
    if (!isEncText(raw)) { console.log('- ' + f + ' 本来就是明文'); continue; }
    let plain;
    try { plain = decryptText(raw, pass); } catch (e) { console.log('x ' + f + ' 解密失败: ' + e.message); process.exit(1); }
    JSON.parse(plain);
    fs.writeFileSync(p, plain);
    console.log('OK ' + f + ' -> 已解密');
  }
  if (!argv.includes('--keep-key')) {
    if (fs.existsSync(KEY_FILE())) { fs.unlinkSync(KEY_FILE()); console.log('OK 已删除密钥文件 ' + KEY_FILE() + ' (--keep-key 可保留)'); }
  } else {
    console.log('- 密钥文件已保留 (注意: 保留期间新写入的配置会再次被加密)');
  }
  console.log('完成。请重启各实例。');
}
async function cmdChangepass(argv) {
  let oldPass = loadPass();
  const oi = argv.indexOf('--old');
  if (oi >= 0 && argv[oi + 1]) oldPass = argv[oi + 1];
  if (!oldPass) oldPass = await askHidden('输入旧口令: ');
  let newPass = null;
  const ni = argv.indexOf('--pass');
  if (ni >= 0 && argv[ni + 1]) newPass = argv[ni + 1];
  else {
    const a = await askHidden('输入新口令(不回显): ');
    const b = await askHidden('再输一遍确认: ');
    if (!a || a !== b) { console.log('新口令为空或两次不一致'); process.exit(1); }
    newPass = a;
  }
  for (const f of configFileList()) {
    const p = path.join(DIR, f);
    const raw = fs.readFileSync(p, 'utf8');
    if (!isEncText(raw)) continue;
    let plain;
    try { plain = decryptText(raw, oldPass); } catch (e) { console.log('x ' + f + ' 旧口令解不开: ' + e.message); process.exit(1); }
    fs.writeFileSync(p, encryptText(plain, newPass));
    console.log('OK ' + f + ' 已用新口令重加密');
  }
  fs.writeFileSync(KEY_FILE(), newPass + '\n', { mode: 0o600 });
  try { fs.chmodSync(KEY_FILE(), 0o600); } catch (e) {}
  console.log('OK 密钥文件已更新');
  console.log('完成。请重启各实例。');
}
function cmdTest() {
  const pass = loadPass();
  if (!pass) { console.log('x 找不到口令'); process.exit(1); }
  let bad = 0, enc = 0;
  for (const f of configFileList()) {
    const raw = fs.readFileSync(path.join(DIR, f), 'utf8');
    if (!isEncText(raw)) continue;
    enc++;
    try { JSON.parse(decryptText(raw, pass)); console.log('OK ' + f); }
    catch (e) { bad++; console.log('x ' + f + ': ' + e.message); }
  }
  if (!enc) console.log('(没有加密的配置文件)');
  process.exit(bad ? 1 : 0);
}
if (require.main === module) (async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'status' || !cmd) return cmdStatus();
    if (cmd === 'enable') return await cmdEnable(rest);
    if (cmd === 'disable') return cmdDisable(rest);
    if (cmd === 'changepass') return await cmdChangepass(rest);
    if (cmd === 'test') return cmdTest();
    console.log('未知命令: ' + cmd + ' (可用: status/enable/disable/changepass/test)');
    process.exit(1);
  } catch (e) {
    console.log('x ' + ((e && e.message) || e));
    process.exit(1);
  }
})();
module.exports = { MAGIC, isEncText, encryptText, decryptText, loadPass, KEY_FILE, configFileList, askHidden };
