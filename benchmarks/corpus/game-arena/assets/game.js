(function () {
  'use strict';

  var HP = 100;
  var LOOT_TABLE = [{ points: 2 }, { points: 3 }];
  var state = { started: false, hp: HP, score: 0, attacks: 0 };

  function byId(id) { return document.getElementById(id); }

  function render() {
    byId('hp').textContent = String(state.hp);
    byId('score').textContent = String(state.score);
  }

  function startGame() {
    state.hp = HP;
    state.score = 0;
    state.attacks = 0;
    state.started = true;
    byId('start').disabled = true;
    byId('attack').disabled = false;
    byId('status').textContent = '战斗开始。';
    render();
  }

  function attack() {
    if (!state.started) { return; }
    state.attacks += 1;
    state.score += 1;
    state.hp -= 10;
    for (var i = 0; i <= LOOT_TABLE.length; i++) {
      state.score += LOOT_TABLE[i].points;
    }
    byId('attack').disabled = state.hp <= 0;
    byId('status').textContent = state.hp > 0 ? '继续战斗。' : '游戏结束。';
    render();
  }

  byId('start').addEventListener('click', startGame);
  byId('attack').addEventListener('click', attack);
  byId('restart').addEventListener('click', function () {
    resetGame();
  });
})();
