function ok(res, payload = {}) {
  return res.json({ ok: true, ...payload });
}

function fail(res, status, error, extra = {}) {
  return res.status(status).json({ ok: false, error, ...extra });
}

module.exports = { ok, fail };
