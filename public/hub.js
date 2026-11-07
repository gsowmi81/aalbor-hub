// Small conveniences only. Every screen works without this file.
(function () {
  // Keep your place: after a tick, save or delete, the page comes back where you were,
  // not at the top. (Without this file, the form's #anchor still lands near the item.)
  var KEY = 'hub-scroll';
  // A field named action, method or enctype shadows the form's own property (New job has buttons named action), so read the attributes.
  function attr(f, name, dflt) { var v = f.getAttribute(name); return (v === null || v === '') ? dflt : v; }
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f || attr(f, 'method', 'get').toLowerCase() !== 'post') return;
    try { sessionStorage.setItem(KEY, JSON.stringify({ path: location.pathname, y: window.scrollY, t: Date.now() })); } catch (err) {}
  }, true);
  function restore() {
    var saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(KEY) || 'null'); sessionStorage.removeItem(KEY); } catch (err) {}
    if (saved && saved.path === location.pathname && Date.now() - saved.t < 20000) {
      requestAnimationFrame(function () { window.scrollTo(0, saved.y); });
    }
  }
  if (document.readyState === 'complete') restore(); else window.addEventListener('load', restore);

  // A tick, a move or a flag changes the page in place (George, 7 Nov 2026): the form posts by
  // fetch, the hub answers with the usual redirect, and the new page's content replaces this
  // one's without a reload, so the scroll position and the phone's keyboard state stay put.
  // A redirect somewhere else is followed; a page that isn't a redirect (a form with a
  // mistake) is shown whole. Without this file every form still works the ordinary way.
  var busy = false;
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f || attr(f, 'method', 'get').toLowerCase() !== 'post' || f.hasAttribute('data-plain') || busy) return;
    if (!window.fetch || !window.DOMParser || !window.FormData) return;
    if (f.querySelector('input[type=file]') && !f.hasAttribute('data-photos')) return;
    e.preventDefault();
    busy = true;
    var submitter = e.submitter;
    if (submitter) submitter.disabled = true;
    var ready = f.hasAttribute('data-photos') ? withShrunkPhotos(f) : Promise.resolve(new FormData(f));
    ready.then(function (data) {
      if (submitter && submitter.name) data.append(submitter.name, submitter.value);
      var body = attr(f, 'enctype', '') === 'multipart/form-data' ? data : new URLSearchParams(data);
      var action = new URL(attr(f, 'action', location.href), location.href).href;
      return fetch(action, { method: 'POST', body: body, credentials: 'same-origin', headers: { 'X-Hub-Live': '1' } });
    }).then(function (r) {
      var url = new URL(r.url, location.href);
      if (r.redirected && url.pathname !== location.pathname) { location.href = r.url; return; }
      return r.text().then(function (html) {
        if (!r.redirected) { document.open(); document.write(html); document.close(); return; }
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var fresh = doc.querySelector('.wrap'), mine = document.querySelector('.wrap');
        if (!fresh || !mine) { location.reload(); return; }
        var y = window.scrollY;
        mine.replaceWith(fresh);
        if (url.hash && url.hash !== location.hash) history.replaceState(null, '', url.pathname + url.search + url.hash);
        init();
        window.scrollTo(0, y);
        var target = url.hash && document.querySelector(url.hash);
        if (target && (target.getBoundingClientRect().top < 0 || target.getBoundingClientRect().bottom > window.innerHeight)) target.scrollIntoView({ block: 'center' });
      });
    }).catch(function () { f.setAttribute('data-plain', ''); busy = false; if (submitter) submitter.disabled = false; f.requestSubmit ? f.requestSubmit(submitter || undefined) : f.submit(); })
      .then(function () { busy = false; if (submitter) submitter.disabled = false; });
  });

  // Photos on a flag: shrunk on the phone to 1600px JPEG before they go up (a 5 MB photo becomes ~300 KB).
  function withShrunkPhotos(f) {
    var data = new FormData(f);
    var input = f.querySelector('input[type=file]');
    if (!input || !input.files || !input.files.length || !window.createImageBitmap) return Promise.resolve(data);
    data.delete(input.name);
    var files = Array.prototype.slice.call(input.files, 0, 4);
    return Promise.all(files.map(function (file) {
      if (!/^image\//.test(file.type)) return file;
      return createImageBitmap(file).then(function (bmp) {
        var scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
        var c = document.createElement('canvas');
        c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
        c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
        return new Promise(function (res) { c.toBlob(function (b) { res(b ? new File([b], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' }) : file); }, 'image/jpeg', 0.82); });
      }).catch(function () { return file; });
    })).then(function (list) { list.forEach(function (file) { data.append(input.name, file, file.name); }); return data; });
  }

  // Everything below binds to elements on the page, so it runs again after an in-place update.
  function init() {
  // "Flag" on a step opens the job's flag form for that step.
  document.querySelectorAll('a[data-flag-step]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      var panel = document.getElementById('flags');
      var box = panel && panel.querySelector('details.flag');
      if (!box) return;
      e.preventDefault();
      var form = box.querySelector('form');
      var hidden = form.querySelector('input[name=step_id]');
      if (!hidden) { hidden = document.createElement('input'); hidden.type = 'hidden'; hidden.name = 'step_id'; form.appendChild(hidden); }
      hidden.value = a.getAttribute('data-flag-step');
      box.open = true;
      box.scrollIntoView({ block: 'center' });
      var note = form.querySelector('input[name=note]'); if (note) note.focus();
    });
  });

  // After a drag (George, 6 Nov 2026): a small box asks what happens to the rest of the job,
  // then saves straight away, confirmed. "See every date first" opens the full Reschedule screen.
  // A move that makes a new clash goes to the Reschedule screen instead of saving.
  var openBox = null;
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }
  // opts.date: show a date picker in the box (a tapped date on the job screen, George, 7 Nov 2026).
  function moveBox(card, params, what, onCancel, opts) {
    if (openBox) openBox.close();
    opts = opts || {};
    var job = card.getAttribute('data-job'), step = card.getAttribute('data-step');
    var name = card.getAttribute('data-label') || 'this step';
    var box = el('div', 'movebox');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Move ' + name);
    box.appendChild(el('strong', '', 'Move ' + name + (what ? ' ' + what : '')));
    box.appendChild(el('span', 'muted small', 'What happens to the rest of the job? It saves straight away, confirmed.'));
    var form = el('form');
    form.method = 'post';
    form.action = '/jobs/' + job + '/reschedule/quick';
    var hidden = function (n, v) { var i = el('input'); i.type = 'hidden'; i.name = n; i.value = v; form.appendChild(i); };
    hidden('step', step);
    hidden('back', location.pathname + location.search + '#s-' + step);
    var qs = '';
    Object.keys(params).forEach(function (k) { hidden(k, params[k]); qs += '&' + k + '=' + encodeURIComponent(params[k]); });
    var dateInput = null;
    if (opts.date !== undefined) {
      var lab = el('label', 'f', 'New date');
      dateInput = el('input'); dateInput.type = 'date'; dateInput.name = 'start'; dateInput.required = true;
      dateInput.value = opts.date || new Date().toISOString().slice(0, 10);
      lab.appendChild(dateInput);
      form.appendChild(lab);
    }
    var acts = el('div', 'acts');
    var choices = [['shift', 'Move everything after it', 'btn primary']];
    if (card.getAttribute('data-squeeze') === '1') choices.push(['squeeze', 'Keep the install date', 'btn']);
    choices.push(['only', 'Only this one', 'btn']);
    choices.forEach(function (c) {
      var b = el('button', c[2], c[1]);
      b.type = 'submit'; b.name = 'mode'; b.value = c[0];
      acts.appendChild(b);
    });
    form.appendChild(acts);
    box.appendChild(form);
    var links = el('div', 'links');
    var see = el('a', '', 'See every date first');
    see.href = '/jobs/' + job + '/reschedule?step=' + step + qs;
    if (dateInput) see.addEventListener('click', function () { see.href = '/jobs/' + job + '/reschedule?step=' + step + '&start=' + encodeURIComponent(dateInput.value); });
    var cancel = el('button', 'linkbtn', 'Cancel');
    cancel.type = 'button';
    links.appendChild(see);
    links.appendChild(cancel);
    box.appendChild(links);
    var esc = function (e) { if (e.key === 'Escape') close(); };
    var close = function () {
      box.remove(); openBox = null;
      document.removeEventListener('keydown', esc);
      if (onCancel) onCancel();
    };
    cancel.addEventListener('click', close);
    document.addEventListener('keydown', esc);
    document.body.appendChild(box);
    openBox = { close: close };
    if (dateInput) dateInput.focus(); else acts.firstChild.focus();
  }

  // The job screen (Editors): tap a date to move it (George, 7 Nov 2026). Without this file the
  // link opens the Reschedule screen, which does the same in more taps.
  document.querySelectorAll('a.datebtn[data-step]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      e.preventDefault();
      moveBox(a, {}, '', null, { date: a.getAttribute('data-date') || '' });
    });
  });
  var plural = function (n, one) { return (n > 0 ? '+' : '') + n + ' ' + one + (Math.abs(n) === 1 ? '' : 's'); };

  // All jobs timeline (Editors): drag a bar with a mouse to move it, or tap/click it to open
  // the Reschedule screen and pick a date there.
  var tl = document.querySelector('.tl[data-days]');
  if (tl) {
    var days = Number(tl.getAttribute('data-days'));
    var addDays = function (iso, n) { var p = iso.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n)).toISOString().slice(0, 10); };
    var leaving = false;
    var go = function (mk, shift) {
      if (leaving) return; // one drag fires pointerup and click; only the first counts
      leaving = true;
      if (shift) {
        moveBox(mk, { start: addDays(mk.getAttribute('data-start'), shift), snap: '1' }, plural(shift, 'day'), function () {
          leaving = false; mk.style.transform = '';
          var b = mk.querySelector('.shift-badge'); if (b) b.remove();
        });
        return;
      }
      location.href = '/jobs/' + mk.getAttribute('data-job') + '/reschedule?step=' + mk.getAttribute('data-step');
    };
    tl.querySelectorAll('.mk.drag').forEach(function (mk) {
      var x0 = null, moved = 0, dayPx = 0, badge = null;
      mk.addEventListener('dragstart', function (e) { e.preventDefault(); });
      mk.addEventListener('pointerdown', function (e) {
        if (e.pointerType === 'touch' || e.button !== 0) return; // phones: tap only, so sideways scrolling still works
        x0 = e.clientX; moved = 0; dayPx = mk.parentElement.getBoundingClientRect().width / days;
        mk.setPointerCapture(e.pointerId); mk.classList.add('dragging');
        badge = document.createElement('span'); badge.className = 'shift-badge'; mk.appendChild(badge);
        e.preventDefault();
      });
      mk.addEventListener('pointermove', function (e) {
        if (x0 === null) return;
        moved = Math.round((e.clientX - x0) / dayPx);
        mk.style.transform = 'translateX(' + moved * dayPx + 'px)';
        badge.textContent = moved === 0 ? '' : (moved > 0 ? '+' : '') + moved + (Math.abs(moved) === 1 ? ' day' : ' days');
      });
      var end = function () {
        if (x0 === null) return;
        x0 = null; mk.classList.remove('dragging');
        if (badge && !moved) { badge.remove(); badge = null; }
        go(mk, moved);
      };
      mk.addEventListener('pointerup', end);
      mk.addEventListener('pointercancel', function () { x0 = null; mk.style.transform = ''; mk.classList.remove('dragging'); if (badge) badge.remove(); });
      mk.addEventListener('click', function (e) { if (e.pointerType !== 'mouse' && e.detail !== 0) go(mk, 0); });
      mk.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(mk, 0); } });
    });
  }

  // Coming up week board (Editors): drag a card sideways to another day. Day columns are
  // working days, so the move is sent as working days (wd). A tap still opens the job.
  var board = document.querySelector('.board[data-dragdays]');
  if (board) {
    board.querySelectorAll('.chip.drag').forEach(function (chip) {
      var x0 = null, y0 = 0, pid = null, moved = 0, colPx = 0, dragging = false, badge = null, swallowClick = false;
      var reset = function () {
        x0 = null; dragging = false; chip.style.transform = ''; chip.classList.remove('dragging');
        if (badge) { badge.remove(); badge = null; }
      };
      // Stop the browser's own link dragging (Chrome, Safari), which would cancel ours.
      chip.addEventListener('dragstart', function (e) { e.preventDefault(); });
      chip.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return;
        if (e.pointerType === 'mouse') e.preventDefault();
        x0 = e.clientX; y0 = e.clientY; pid = e.pointerId; moved = 0; dragging = false;
        colPx = chip.parentElement.getBoundingClientRect().width / 5;
      });
      chip.addEventListener('pointermove', function (e) {
        if (x0 === null) return;
        var dx = e.clientX - x0, dy = e.clientY - y0;
        if (!dragging) {
          if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { x0 = null; return; } // scrolling, not dragging
          if (Math.abs(dx) < 8) return;
          dragging = true;
          try { chip.setPointerCapture(pid); } catch (err) {}
          chip.classList.add('dragging');
          badge = document.createElement('span'); badge.className = 'shift-badge'; chip.appendChild(badge);
        }
        e.preventDefault();
        moved = Math.round(dx / colPx);
        chip.style.transform = 'translateX(' + dx + 'px)';
        badge.textContent = moved === 0 ? 'Same day' : (moved > 0 ? '+' : '') + moved + ' working ' + (Math.abs(moved) === 1 ? 'day' : 'days');
      });
      chip.addEventListener('pointerup', function () {
        if (x0 === null) return;
        var was = dragging, n = moved;
        if (!was) { x0 = null; return; } // a plain tap: let the link open the job
        swallowClick = true;
        if (n === 0) { reset(); return; }
        chip.classList.remove('dragging');
        x0 = null;
        moveBox(chip, { wd: String(n) }, plural(n, 'working day'), reset);
      });
      chip.addEventListener('pointercancel', reset);
      chip.addEventListener('click', function (e) { if (swallowClick) { e.preventDefault(); swallowClick = false; } }, true);
    });
  }

  // Job picker: open the job as soon as one is chosen.
  document.querySelectorAll('select[data-autosubmit]').forEach(function (s) {
    s.addEventListener('change', function () { s.form.submit(); });
  });

  // Choosing Polyurethane ticks Painting needed, unless someone has already set it by hand.
  document.querySelectorAll('select[name="door_finish"]').forEach(function (sel) {
    var box = sel.form && sel.form.querySelector('[data-painting]');
    if (!box) return;
    var touched = false;
    box.addEventListener('change', function () { touched = true; });
    sel.addEventListener('change', function () { if (!touched) box.checked = sel.value === 'polyurethane'; });
  });

  // Job type fills door finish, painting, stone and the factory and install days from its template.
  document.querySelectorAll('select[data-template]').forEach(function (sel) {
    sel.addEventListener('change', function () {
      var o = sel.options[sel.selectedIndex], f = sel.form;
      if (!o || !o.getAttribute('data-door')) return;
      f.querySelector('[name="door_finish"]').value = o.getAttribute('data-door');
      f.querySelector('[name="has_painting"]').checked = o.getAttribute('data-painting') === '1';
      f.querySelector('[name="has_stone"]').checked = o.getAttribute('data-stone') === '1';
      f.querySelector('[name="factory_days"]').value = o.getAttribute('data-factory');
      f.querySelector('[name="install_days"]').value = o.getAttribute('data-install');
    });
  });

  // New job: fill site start from the job number (YYMMDD), and refresh the proposed dates as you type.
  var form = document.getElementById('newjob');
  if (!form) return;
  var num = form.querySelector('[data-jobnumber]');
  var start = form.querySelector('[data-sitestart]');
  var filledFromNumber = false;
  num.addEventListener('input', function () {
    var m = num.value.trim().match(/^(\d{2})(\d{2})(\d{2})$/);
    if (m && (!start.value || filledFromNumber)) { start.value = '20' + m[1] + '-' + m[2] + '-' + m[3]; filledFromNumber = true; refresh(); }
  });
  start.addEventListener('input', function () { filledFromNumber = false; });
  var timer;
  function refresh() {
    clearTimeout(timer);
    timer = setTimeout(function () {
      fetch('/jobs/preview', { method: 'POST', body: new URLSearchParams(new FormData(form)), credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.text() : null; })
        .then(function (t) { if (t) document.getElementById('proposal').innerHTML = t; })
        .catch(function () {});
    }, 300);
  }
  form.addEventListener('change', refresh);
  }
  init();
})();
