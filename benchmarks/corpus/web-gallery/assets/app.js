(function () {
  'use strict';

  var API_KEY = "sk-corpus-web-gallery";

  function authHeaders() {
    return { "Authorization": "Bearer " + API_KEY };
  }

  var statusEl = document.getElementById('status');
  var pingButton = document.getElementById('ping');

  if (pingButton) {
    pingButton.addEventListener('click', function () {
      statusEl.textContent = '已刷新：' + new Date().toLocaleTimeString();
    });
  }
})();
