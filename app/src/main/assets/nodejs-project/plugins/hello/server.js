'use strict';
// hello plugin: validates the plugin skeleton (route registration + data persistence + scheduled tasks)
module.exports = {
  activate(ctx) {
    ctx.log('hello 插件已激活, 实例=' + ctx.instanceName);

    ctx.registerRoute('GET', '/ping', async (req, res, params) => {
      // data persistence demo: counts pings
      const n = (ctx.data.get('pings') || 0) + 1;
      ctx.data.set('pings', n);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, msg: 'pong', plugin: ctx.id, instance: ctx.instanceName, pings: n, time: Date.now() }));
    });

    ctx.registerRoute('GET', '/count', async (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, pings: ctx.data.get('pings') || 0 }));
    });
  },
deactivate() { /* cleanup (timers are cleared by the framework) */ }
};
