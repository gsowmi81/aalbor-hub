// Small conveniences only. Every screen works without this file.
(function () {
  // Keep your place: after a tick, save or delete, the page comes back where you were,
  // not at the top. (Without this file, the form's #anchor still lands near the item.)
  var KEY = 'hub-scroll';
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f || (f.method || '').toLowerCase() !== 'post') return;
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

  // All jobs timeline (Editors): drag a bar with a mouse to move it, or tap/click it.
  // Either way the Reschedule screen opens; nothing saves until it's confirmed there.
  var tl = document.querySelector('.tl[data-days]');
  if (tl) {
    var days = Number(tl.getAttribute('data-days'));
    var addDays = function (iso, n) { var p = iso.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n)).toISOString().slice(0, 10); };
    var leaving = false;
    var go = function (mk, shift) {
      if (leaving) return; // one drag fires pointerup and click; only the first counts
      leaving = true;
      var url = '/jobs/' + mk.getAttribute('data-job') + '/reschedule?step=' + mk.getAttribute('data-step');
      if (shift) url += '&start=' + addDays(mk.getAttribute('data-start'), shift) + '&snap=1';
      location.href = url;
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
        location.href = '/jobs/' + chip.getAttribute('data-job') + '/reschedule?step=' + chip.getAttribute('data-step') + '&wd=' + n;
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
})();
