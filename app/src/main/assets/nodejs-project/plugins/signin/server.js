'use strict';
//// daily check-in plugin: users check in with a key card to earn quota (grantQuota); tracks streaks and cumulative rewards
const crypto = require('crypto');

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function today() { return new Date().toISOString().slice(0, 10); }
function yesterday() { return new Date(Date.now() - 86400000).toISOString().slice(0, 10); }
// Key cards are never stored in plaintext; the hash is the key
function uk(token) { return 'u_' + crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 16); }

module.exports = {
  activate(ctx) {
    const reward = () => Math.max(0, Number(ctx.config.rewardTokens) || 1000);

// POST /plugins/signin/checkin  {token} or ?token=
    ctx.registerRoute('POST', '/checkin', async (req, res, params) => {
      const token = (params.body && params.body.token) || params.query.token || params.token || '';
      if (!token) return json(res, 400, { error: '缺少卡密 token' });
      const key = ctx.gateway.findKey(token);
      if (!key) return json(res, 401, { error: '卡密无效' });
      if (key.enable === false) return json(res, 403, { error: '卡密已被禁用' });
      const rec = ctx.data.get(uk(token)) || { lastDay: '', streak: 0, total: 0 };
      if (rec.lastDay === today()) {
        return json(res, 200, { ok: false, already: true, msg: '今日已签到，明天再来吧', streak: rec.streak, total: rec.total });
      }
      rec.streak = (rec.lastDay === yesterday()) ? rec.streak + 1 : 1;
      rec.lastDay = today();
      const rw = reward();
      rec.total += rw;
      ctx.data.set(uk(token), rec);
      const granted = ctx.gateway.grantQuota(token, rw);
      ctx.log(`签到: ${(key.name || 'card')}(…${String(token).slice(-4)}) +${rw} tokens, 连续${rec.streak}天, 累计${rec.total}, 发放${granted ? 'OK' : 'FAIL'}`);
      json(res, 200, { ok: true, reward: rw, streak: rec.streak, total: rec.total, granted });
    });

// GET /plugins/signin/summary?token=  (formerly /status, renamed to avoid clashing with the gateway-level status)
    ctx.registerRoute('GET', '/summary', async (req, res, params) => {
      const token = params.query.token || params.token || '';
      if (!token) return json(res, 400, { error: '缺少卡密 token' });
      const key = ctx.gateway.findKey(token);
      if (!key) return json(res, 401, { error: '卡密无效' });
      const rec = ctx.data.get(uk(token)) || { lastDay: '', streak: 0, total: 0 };
      json(res, 200, { ok: true, checkedToday: rec.lastDay === today(), streak: rec.streak, total: rec.total, reward: reward() });
    });

    ctx.log('每日签到插件已激活, 单次奖励=' + reward() + ' tokens');
  },
  deactivate() {}
};
