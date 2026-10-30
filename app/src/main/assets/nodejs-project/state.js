'use strict';
// ================= Process-level shared state (formerly top-level lets in gateway.js) =================
//// must be accessed as state.CUR_POOL / state.CUR_CFG (keeps references live); never destructure
module.exports = {
  get CUR_POOL() { return this._pool; }, set CUR_POOL(v) { this._pool = v; },
  get CUR_CFG() { return this._cfg; }, set CUR_CFG(v) { this._cfg = v; },
  _pool: null, _cfg: null,
};
