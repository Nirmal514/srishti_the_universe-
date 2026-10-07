/*
  SHRISHTI browser adapter.
  The page was written against a small runtime: claude.use('sample' | 'user' | 'db').
  This file provides the same three pieces on top of this project's own server:
    sample -> POST /api/sample   (server calls Gemini; the key never reaches the browser)
    user   -> /api/me, /api/profiles
    db     -> /api/db/*, /api/dbc/*
  It also provides window.shrishtiAuth() (Google sign-in) and window.shrishtiLogout().
*/
(function () {
  'use strict';
  var HEAD = { 'content-type': 'application/json', 'x-requested-with': 'shrishti' };
  var state = { me: null, cfg: null, cfgP: null };
  window.SHRISHTI_BASE = location.origin + location.pathname;

  function api(method, url, body, signal) {
    return fetch(url, { method: method, headers: HEAD, body: body == null ? undefined : JSON.stringify(body), credentials: 'same-origin', signal: signal })
      .then(function (r) {
        return r.json().catch(function () { return null; }).then(function (j) {
          if (!r.ok) {
            var e = new Error((j && j.error && j.error.message) || ('HTTP ' + r.status));
            e.status = r.status; e.code = j && j.error && j.error.code;
            throw e;
          }
          return j;
        });
      });
  }
  function cfg() {
    if (!state.cfgP) state.cfgP = api('GET', '/api/config').then(function (c) { state.cfg = c; return c; }).catch(function () { state.cfg = {}; return state.cfg; });
    return state.cfgP;
  }
  function loadMe() {
    return api('GET', '/api/me').then(function (m) { state.me = m; return m; }).catch(function () { state.me = null; return null; });
  }

  /* ----- tolerant JSON reader (whole reply, then a code fence, then first { or [ to last } or ]) ----- */
  function parseJson(t) {
    try { return JSON.parse(t); } catch (e) { /* fall through */ }
    var f = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
    if (f) { try { return JSON.parse(f[1]); } catch (e) { /* fall through */ } }
    var a = t.search(/[\[{]/), b = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { /* fall through */ } }
    return undefined;
  }

  /* ----- sample ----- */
  function call(input, opts, asJson) {
    opts = opts || {};
    var turns = typeof input === 'string' ? [{ role: 'user', content: input }] : input;
    if (opts.signal && opts.signal.aborted) return Promise.reject({ code: 'cancelled', message: 'cancelled' });
    return api('POST', '/api/sample', { turns: turns, json: !!asJson }, opts.signal).then(function (out) {
      if (opts.onText) { try { opts.onText({ text: out.text, delta: out.text }); } catch (e) { /* ignore */ } }
      return { text: out.text, truncated: !!out.truncated, modelTierApplied: 'default' };
    }, function (e) {
      if (e && e.name === 'AbortError') throw { code: 'cancelled', message: 'cancelled' };
      var code = e.code || (e.status === 429 ? 'rate_limited' : e.status === 401 ? 'session_expired' : 'upstream_error');
      throw { code: code, message: e.message };
    });
  }
  var sample = function (input, opts) { return call(input, opts, false); };
  sample.json = function (input, opts) {
    return call(input, opts, true).then(function (r) {
      var v = parseJson(r.text);
      if (v === undefined) throw { code: 'invalid_json', message: 'The reply was not valid JSON.', text: r.text };
      return v;
    });
  };
  sample.limits = function () { return Promise.resolve({ maxPromptBytes: 262144 }); };

  /* ----- user ----- */
  var user = {
    isOwner: function () { return Promise.resolve(false); },
    canEdit: function () { return Promise.resolve(false); },
    can: function () { return Promise.resolve(null); },
    id: function () { return Promise.resolve(state.me ? state.me.id : null); },
    me: function () {
      var m = state.me;
      return Promise.resolve({ id: m ? m.id : null, name: m ? m.name : '', avatarUrl: m && m.avatar ? m.avatar : '', color: '#8fc7b0', email: null, isOwner: false, canEdit: false });
    },
    profiles: function (ids) {
      ids = Array.isArray(ids) ? ids : [ids];
      return api('POST', '/api/profiles', { ids: ids }).then(function (map) {
        var out = {};
        ids.forEach(function (id) { out[id] = { id: id, name: (map[id] && map[id].name) || '', avatarUrl: '', color: '#8fc7b0', email: null, isMe: !!(state.me && state.me.id === id), guest: false }; });
        return out;
      }).catch(function () {
        var out = {}; ids.forEach(function (id) { out[id] = { id: id, name: '', avatarUrl: '', color: '#8fc7b0', email: null, isMe: false, guest: false }; }); return out;
      });
    }
  };

  /* ----- db ----- */
  function enc(p) { return p.split('/').map(encodeURIComponent).join('/'); }
  function docRef(p) {
    return {
      id: p.split('/').pop(), path: p,
      get: function () {
        return api('GET', '/api/db/' + enc(p)).then(
          function (r) { return { id: p.split('/').pop(), exists: true, data: function () { return r.data; } }; },
          function (e) { if (e.status === 404) return { id: p.split('/').pop(), exists: false, data: function () { return undefined; } }; throw e; }
        );
      },
      set: function (d) { return api('PUT', '/api/db/' + enc(p), { data: d }).then(function () {}); },
      delete: function () { return api('DELETE', '/api/db/' + enc(p)).then(function () {}); }
    };
  }
  function colRef(p) {
    return {
      path: p,
      get: function () {
        return api('GET', '/api/dbc/' + enc(p)).then(function (r) {
          return { docs: r.docs.map(function (x) { return { id: x.id, exists: true, data: function () { return x.data; } }; }) };
        });
      },
      doc: function (id) { return docRef(p + '/' + id); }
    };
  }
  var db = { doc: docRef, collection: colRef };

  window.claude = {
    use: function (name) {
      return cfg().then(function (c) {
        if (name === 'sample') return c.gemini ? sample : null;
        return (state.me ? Promise.resolve(state.me) : loadMe()).then(function () {
          if (name === 'user') return user;
          if (name === 'db') return state.me ? db : null;
          return null;
        });
      });
    }
  };

  /* ----- sign-in ----- */
  function modal(build) {
    return new Promise(function (resolve) {
      var back = document.createElement('div');
      back.style.cssText = 'position:fixed;inset:0;z-index:99;background:rgba(4,6,8,.72);display:grid;place-items:center;padding:16px';
      var box = document.createElement('div');
      box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', 'Sign in');
      box.style.cssText = 'width:min(380px,100%);background:#0e1417;border:1px solid #33424a;border-radius:10px;padding:22px;display:flex;flex-direction:column;gap:14px;color:#e8e4d9;font:14px/1.5 "Hanken Grotesk","Segoe UI",system-ui,sans-serif';
      var x = document.createElement('button');
      x.textContent = 'Cancel'; x.type = 'button';
      x.style.cssText = 'align-self:flex-end;background:none;border:1px solid #33424a;color:#8e999d;border-radius:14px;padding:3px 12px;cursor:pointer;font:inherit;font-size:12px';
      var done = function (v) { document.removeEventListener('keydown', onKey); back.remove(); resolve(v); };
      var onKey = function (e) { if (e.key === 'Escape') done(false); };
      x.onclick = function () { done(false); };
      document.addEventListener('keydown', onKey);
      box.appendChild(x); back.appendChild(box); document.body.appendChild(back);
      back.addEventListener('click', function (e) { if (e.target === back) done(false); });
      build(box, done);
    });
  }
  function note(box, text, color) {
    var p = document.createElement('p');
    p.style.cssText = 'margin:0;color:' + (color || '#8e999d');
    p.textContent = text; box.appendChild(p); return p;
  }
  function loadGsi() {
    return new Promise(function (resolve, reject) {
      if (window.google && window.google.accounts && window.google.accounts.id) return resolve();
      var s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
      s.onload = function () { resolve(); }; s.onerror = function () { reject(new Error('Could not load Google sign-in')); };
      document.head.appendChild(s);
    });
  }
  function devLoginModal(done) {
    return modal(function (box, done) {
      note(box, 'Development sign-in. Google is unavailable or not authorized for this origin.', '#e6c78f');
      var inp = document.createElement('input');
      inp.type = 'text'; inp.placeholder = 'Your name'; inp.maxLength = 60; inp.setAttribute('aria-label', 'Your name');
      inp.style.cssText = 'height:38px;border:1px solid #33424a;background:#0b1114;color:#e8e4d9;border-radius:6px;padding:0 12px;font:inherit';
      var go = document.createElement('button'); go.type = 'button'; go.textContent = 'Continue';
      go.style.cssText = 'height:38px;border:1px solid #8fc7b0;background:rgba(143,199,176,.1);color:#8fc7b0;border-radius:6px;cursor:pointer;font:inherit';
      var msg = note(box, '', '#e3a79f');
      var submit = function () {
        api('POST', '/api/auth/dev', { name: inp.value || 'Explorer' }).then(function () { return loadMe(); }).then(function (m) { if (m) done(true); else msg.textContent = 'Sign-in failed.'; }, function (e) { msg.textContent = e.message; });
      };
      go.onclick = submit; inp.onkeydown = function (e) { if (e.key === 'Enter') submit(); };
      box.appendChild(inp); box.appendChild(go); inp.focus();
    });
  }

  window.shrishtiAuth = function () {
    return cfg().then(function (c) {
      return loadMe().then(function (me) {
        if (me) return true;
        if (c.devLogin) {
          return devLoginModal(function () {});
        }
        if (c.googleClientId) {
          return modal(function (box, done) {
            note(box, 'Sign in with Google to continue.', '#e8e4d9');
            var holder = document.createElement('div'); box.appendChild(holder);
            var msg = note(box, '', '#e3a79f');
            var fallback = function () {
              if (c.devLogin) {
                done(false);
                return devLoginModal(done);
              }
              msg.textContent = 'Google sign-in is not configured correctly for this origin.';
            };
            loadGsi().then(function () {
              window.google.accounts.id.initialize({
                client_id: c.googleClientId,
                callback: function (resp) {
                  api('POST', '/api/auth/google', { credential: resp.credential }).then(function () { return loadMe(); }).then(function (m) {
                    if (m) done(true); else msg.textContent = 'Sign-in failed. Try again.';
                  }, function (e) {
                    if (c.devLogin) {
                      msg.textContent = 'Google sign-in is unavailable for this origin. Falling back to local sign-in.';
                      setTimeout(function () { done(false); devLoginModal(done); }, 500);
                    } else {
                      msg.textContent = e.message || 'Sign-in failed. Try again.';
                    }
                  });
                }
              });
              window.google.accounts.id.renderButton(holder, { theme: 'filled_black', size: 'large', text: 'continue_with', shape: 'rectangular' });
            }, function () {
              fallback();
            });
          });
        }
        return modal(function (box) {
          note(box, 'This server is not set up for sign-in yet. Set GOOGLE_CLIENT_ID in the .env file and restart the server.', '#e3a79f');
        });
      });
    });
  };
  window.shrishtiLogout = function () {
    api('POST', '/api/auth/logout').catch(function () {});
    state.me = null;
  };
  cfg(); loadMe();
})();
