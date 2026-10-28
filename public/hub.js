// Small conveniences only. Every screen works without this file.
(function () {
  // Job picker: open the job as soon as one is chosen.
  document.querySelectorAll('select[data-autosubmit]').forEach(function (s) {
    s.addEventListener('change', function () { s.form.submit(); });
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
