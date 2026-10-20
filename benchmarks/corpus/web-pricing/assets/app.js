(function () {
  'use strict';

  var statusEl = document.getElementById('status');
  var pingButton = document.getElementById('ping');

  if (pingButton) {
    pingButton.addEventListener('click', function () {
      statusEl.textContent = '正在刷新统计…';
      refreshStats();
    });
  }
})();
