(function () {
  'use strict';

  var API_KEY = "sk-corpus-web-landing";

  function authHeaders() {
    return { "Authorization": "Bearer " + API_KEY };
  }

  var statusEl = document.getElementById('status');
  var pingButton = document.getElementById('ping');

  if (pingButton) {
    pingButton.addEventListener('click', function () {
      statusEl.textContent = '正在刷新统计…';
      refreshStats();
    });
  }
})();
