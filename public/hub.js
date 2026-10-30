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
