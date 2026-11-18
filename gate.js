/* Password step for the published copy. The data files are stored encrypted (AES-256-GCM, key stretched
   from the password with PBKDF2-SHA256). This script asks for the password, decrypts the files in the
   browser and then starts the app. The password is never sent anywhere. The local copy does not use this file. */
(function () {
  'use strict';
  var KEY_SLOT = 'screening-key';
  var box = document.createElement('div');
  box.id = 'gate';
  box.style.cssText = 'position:fixed;inset:0;z-index:1000;background:#fff;display:flex;align-items:center;justify-content:center;padding:16px';
  box.innerHTML = '<form id="gateform" style="width:100%;max-width:340px">' +
    '<h1 style="font-size:18px;margin:0 0 6px">Site screening: Cork</h1>' +
    '<p id="gatemsg" style="margin:0 0 14px;color:#555">Enter the password you were sent.</p>' +
    '<input id="gatepw" type="password" autocomplete="current-password" aria-label="Password" ' +
    'style="box-sizing:border-box;width:100%;padding:9px 10px;font:inherit;border:1px solid #bbb;border-radius:6px;margin-bottom:10px">' +
    '<button class="btn" id="gatego" type="submit">Open</button></form>';
  document.body.appendChild(box);
  var msg = document.getElementById('gatemsg'), pw = document.getElementById('gatepw'), go = document.getElementById('gatego');
  var man = null;

  function b64(s) { var b = atob(s), a = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; }
  function toB64(a) { var s = ''; a = new Uint8Array(a); for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); }
  function say(t, bad) { msg.textContent = t; msg.style.color = bad ? 'rgb(200,16,46)' : '#555'; }
  function busy(on) { pw.disabled = on; go.disabled = on; }

  function derive(password) {
    return crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']).then(function (k) {
      return crypto.subtle.deriveBits({ name: 'PBKDF2', salt: b64(man.salt), iterations: man.iterations, hash: 'SHA-256' }, k, 256);
    });
  }
  function decrypt(key, buf) {
    var a = new Uint8Array(buf);
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: a.subarray(0, 12) }, key, a.subarray(12));
  }
  function gunzip(buf) {
    return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).blob();
  }
  function start(raw, remembered) {
    return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']).then(function (key) {
      return decrypt(key, b64(man.check)).then(function () {
        try { sessionStorage.setItem(KEY_SLOT, toB64(raw)); } catch (e) { /* private window: ask again next time */ }
        var done = 0, urls = {};
        say('Loading data: 0 of ' + man.files.length + ' files');
        return Promise.all(man.files.map(function (name) {
          return fetch('data/enc/' + name + '.enc').then(function (r) {
            if (!r.ok) throw new Error('load');
            return r.arrayBuffer();
          }).then(function (buf) { return decrypt(key, buf); }).then(gunzip).then(function (blob) {
            urls[name] = URL.createObjectURL(new Blob([blob], { type: 'application/json' }));
            say('Loading data: ' + (++done) + ' of ' + man.files.length + ' files');
          });
        })).then(function () {
          window.DATA_URLS = urls;
          var s = document.createElement('script');
          s.src = 'app.js';
          s.onload = function () { box.remove(); };
          document.body.appendChild(s);
        });
      });
    }).catch(function (e) {
      try { sessionStorage.removeItem(KEY_SLOT); } catch (x) { /* nothing stored */ }
      busy(false);
      if (e && e.message === 'load') say('The data could not be downloaded. Check your connection and try again.', true);
      else if (remembered) say('Enter the password you were sent.');
      else { say('That password is not right. Check it and try again.', true); pw.select(); }
    });
  }

  document.getElementById('gateform').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!man || !pw.value) return;
    busy(true); say('Checking the password');
    derive(pw.value.trim()).then(function (raw) { return start(raw, false); });
  });

  if (!window.crypto || !crypto.subtle || !window.DecompressionStream) {
    busy(true); say('This browser is too old to open the page. Use a current version of Edge, Chrome, Safari or Firefox.', true);
    return;
  }
  busy(true);
  fetch('data/enc/manifest.json').then(function (r) { return r.json(); }).then(function (m) {
    man = m;
    var kept = null;
    try { kept = sessionStorage.getItem(KEY_SLOT); } catch (e) { /* no storage */ }
    if (kept) { say('Loading data'); return start(b64(kept).buffer, true); }
    busy(false); pw.focus();
  }).catch(function () { say('The page could not load. Check your connection and refresh.', true); });
})();
