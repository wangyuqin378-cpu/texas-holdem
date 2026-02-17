/**
 * 德州扑克客户端
 * - 20轮制 + 自动续局
 * - 2分钟倒计时
 * - 庄家/SB/BB/当前说话位置标记
 * - 重购 + 结算
 * - 移动端适配
 */
(function () {
  'use strict';

  let socket = null;
  let myPlayerId = null;
  let myRoomId = null;
  let currentState = null;
  let timerInterval = null;

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  // DOM
  const lobby = $('#lobby');
  const gameScreen = $('#gameScreen');
  const playerNameInput = $('#playerName');
  const roomIdInput = $('#roomIdInput');
  const roomIdDisplay = $('#roomIdDisplay');
  const roundDisplay = $('#roundDisplay');
  const playerCountDisplay = $('#playerCountDisplay');
  const seatsContainer = $('#seats');
  const communityCardsEl = $('#communityCards');
  const potDisplay = $('#potDisplay');
  const actionBar = $('#actionBar');
  const readyBar = $('#readyBar');
  const raiseControls = $('#raiseControls');
  const raiseSlider = $('#raiseSlider');
  const raiseAmountInput = $('#raiseAmount');
  const messagesEl = $('#messages');
  const chatInput = $('#chatInput');
  const resultOverlay = $('#resultOverlay');
  const resultTitle = $('#resultTitle');
  const resultDetails = $('#resultDetails');
  const timerFill = $('#timerFill');
  const timerText = $('#timerText');
  const settlementOverlay = $('#settlementOverlay');
  const settlementList = $('#settlementList');
  const btnRebuy = $('#btnRebuy');

  function init() {
    const saved = localStorage.getItem('pokerName');
    if (saved) playerNameInput.value = saved;

    $('#btnQuickJoin').addEventListener('click', quickJoin);
    $('#btnCreateRoom').addEventListener('click', createRoom);
    $('#btnJoinRoom').addEventListener('click', joinRoom);
    $('#btnLeave').addEventListener('click', leaveRoom);
    $('#btnCopyRoom').addEventListener('click', copyRoomId);
    $('#btnReady').addEventListener('click', toggleReady);
    $('#btnFold').addEventListener('click', () => doAction('fold'));
    $('#btnCheck').addEventListener('click', () => doAction('check'));
    $('#btnCall').addEventListener('click', () => doAction('call'));
    $('#btnRaise').addEventListener('click', showRaiseControls);
    $('#btnAllIn').addEventListener('click', () => doAction('allin'));
    $('#btnConfirmRaise').addEventListener('click', confirmRaise);
    $('#btnSendChat').addEventListener('click', sendChat);
    $('#btnRebuy').addEventListener('click', doRebuy);
    $('#btnRestart').addEventListener('click', doRestart);

    chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
    playerNameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') quickJoin(); });
    roomIdInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
    raiseSlider.addEventListener('input', () => { raiseAmountInput.value = raiseSlider.value; });
    raiseAmountInput.addEventListener('input', () => { raiseSlider.value = raiseAmountInput.value; });

    $$('.btn-preset').forEach((btn) => {
      btn.addEventListener('click', () => {
        const m = parseFloat(btn.dataset.multiplier);
        if (currentState) {
          const v = Math.max(Math.floor(currentState.pot * m), currentState.minRaise || 0);
          raiseAmountInput.value = v;
          raiseSlider.value = v;
        }
      });
    });

    generateSeats();
  }

  // ===== 连接 =====
  function connectSocket() {
    if (socket) return;
    socket = io();
    socket.on('connect', () => { myPlayerId = socket.id; });
    socket.on('gameState', (s) => { currentState = s; renderGameState(s); });
    socket.on('message', (m) => { addMessage(m.text, m.type); });
    socket.on('chat', (d) => { addMessage(`${d.playerName}: ${d.message}`, 'chat'); });
    socket.on('disconnect', () => { showLobby(); });
  }

  // ===== 大厅 =====
  function getName() {
    const n = playerNameInput.value.trim();
    if (!n) { playerNameInput.focus(); playerNameInput.style.borderColor = '#f56c6c'; setTimeout(() => { playerNameInput.style.borderColor = ''; }, 1500); return null; }
    localStorage.setItem('pokerName', n);
    return n;
  }

  function quickJoin() {
    const n = getName(); if (!n) return;
    connectSocket();
    socket.emit('quickJoin', { playerName: n }, (r) => { if (r.success) { myRoomId = r.roomId; showGame(); } else alert(r.message); });
  }
  function createRoom() {
    const n = getName(); if (!n) return;
    connectSocket();
    socket.emit('createRoom', { playerName: n }, (r) => { if (r.success) { myRoomId = r.roomId; showGame(); } else alert(r.message); });
  }
  function joinRoom() {
    const n = getName(); if (!n) return;
    const rid = roomIdInput.value.trim(); if (!rid) { roomIdInput.focus(); return; }
    connectSocket();
    socket.emit('joinRoom', { roomId: rid, playerName: n }, (r) => { if (r.success) { myRoomId = r.roomId; showGame(); } else alert(r.message); });
  }
  function leaveRoom() { if (socket) { socket.disconnect(); socket = null; } myRoomId = null; myPlayerId = null; currentState = null; showLobby(); }
  function copyRoomId() {
    if (!myRoomId) return;
    navigator.clipboard.writeText(myRoomId).then(() => { const b = $('#btnCopyRoom'); b.textContent = '✓'; setTimeout(() => { b.textContent = '📋'; }, 1200); });
  }
  function showLobby() { lobby.classList.add('active'); gameScreen.classList.remove('active'); messagesEl.innerHTML = ''; stopTimer(); }
  function showGame() { lobby.classList.remove('active'); gameScreen.classList.add('active'); roomIdDisplay.textContent = myRoomId; }

  // ===== 操作 =====
  function toggleReady() { if (socket) socket.emit('ready', () => {}); }
  function doAction(a) { if (!socket) return; socket.emit('action', { action: a }, (r) => { if (!r.success && r.message) addMessage(r.message, 'error'); }); raiseControls.classList.add('hidden'); }
  function showRaiseControls() {
    if (!currentState) return;
    const me = currentState.players.find(p => p.id === myPlayerId); if (!me) return;
    const max = me.chips - currentState.callAmount;
    const min = currentState.minRaise || 20;
    raiseSlider.min = min; raiseSlider.max = max; raiseSlider.value = min;
    raiseAmountInput.min = min; raiseAmountInput.max = max; raiseAmountInput.value = min;
    raiseControls.classList.remove('hidden');
  }
  function confirmRaise() {
    const a = parseInt(raiseAmountInput.value, 10); if (isNaN(a) || a <= 0) return;
    socket.emit('action', { action: 'raise', amount: a }, (r) => { if (!r.success && r.message) addMessage(r.message, 'error'); });
    raiseControls.classList.add('hidden');
  }
  function doRebuy() { if (socket) socket.emit('rebuy', (r) => { if (!r.success) addMessage(r.message || '重购失败', 'error'); }); }
  function doRestart() { if (socket) socket.emit('restart', () => {}); settlementOverlay.classList.add('hidden'); }
  function sendChat() { const m = chatInput.value.trim(); if (!m || !socket) return; socket.emit('chat', { message: m }); chatInput.value = ''; }

  // ===== 倒计时 =====
  function startTimer(remaining, total) {
    stopTimer();
    let left = remaining;
    updateTimerUI(left, total);
    timerInterval = setInterval(() => {
      left--;
      if (left < 0) left = 0;
      updateTimerUI(left, total);
    }, 1000);
  }
  function stopTimer() { if (timerInterval) { clearInterval(timerInterval); timerInterval = null; } }
  function updateTimerUI(left, total) {
    const pct = (left / total) * 100;
    timerFill.style.width = pct + '%';
    timerFill.classList.toggle('urgent', left <= 15);
    const m = Math.floor(left / 60);
    const s = left % 60;
    timerText.textContent = `${m}:${s.toString().padStart(2, '0')}`;
  }

  // ===== 渲染 =====
  function generateSeats() {
    seatsContainer.innerHTML = '';
    for (let i = 0; i < 7; i++) {
      const el = document.createElement('div');
      el.className = 'seat empty';
      el.dataset.seat = i;
      el.innerHTML = `
        <div class="seat-inner">
          <div class="seat-role hidden"></div>
          <div class="seat-name">空位</div>
          <div class="seat-chips"></div>
          <div class="seat-status"></div>
          <div class="seat-cards"></div>
          <div class="seat-timer hidden"></div>
        </div>
        <div class="seat-bet hidden"></div>
      `;
      seatsContainer.appendChild(el);
    }
  }

  function renderGameState(st) {
    if (!st) return;

    // 顶栏
    playerCountDisplay.textContent = `${st.playerCount}/${st.maxPlayers}`;
    if (st.isGameStarted) {
      roundDisplay.textContent = `第 ${st.currentRound}/${st.maxRounds} 轮`;
    } else {
      roundDisplay.textContent = '等待开始';
    }

    // 重置座位
    const seats = $$('.seat');
    seats.forEach(el => {
      el.className = 'seat empty';
      el.querySelector('.seat-name').textContent = '空位';
      el.querySelector('.seat-chips').textContent = '';
      el.querySelector('.seat-status').textContent = '';
      el.querySelector('.seat-status').className = 'seat-status';
      el.querySelector('.seat-cards').innerHTML = '';
      el.querySelector('.seat-bet').classList.add('hidden');
      const roleEl = el.querySelector('.seat-role');
      roleEl.className = 'seat-role hidden';
      roleEl.textContent = '';
      el.querySelector('.seat-timer').classList.add('hidden');
    });

    // 渲染玩家
    for (const p of st.players) {
      const el = $(`.seat[data-seat="${p.seatIndex}"]`);
      if (!el) continue;

      el.classList.remove('empty');
      if (p.id === myPlayerId) el.classList.add('self');
      if (p.status === 'folded') el.classList.add('folded');
      if (p.status === 'active') el.classList.add('active');
      if (p.id === st.currentPlayerId && st.phase !== 'waiting' && st.phase !== 'showdown' && st.phase !== 'settled') {
        el.classList.add('current-turn');
      }

      el.querySelector('.seat-name').textContent = p.name;
      el.querySelector('.seat-chips').textContent = `💰${p.chips}`;

      // 位置标签 D/SB/BB
      const roleEl = el.querySelector('.seat-role');
      if (st.phase !== 'waiting' && st.phase !== 'settled') {
        if (p.seatIndex === st.dealerSeat) {
          roleEl.textContent = 'D';
          roleEl.className = 'seat-role dealer';
        } else if (p.seatIndex === st.sbSeat) {
          roleEl.textContent = 'SB';
          roleEl.className = 'seat-role sb';
        } else if (p.seatIndex === st.bbSeat) {
          roleEl.textContent = 'BB';
          roleEl.className = 'seat-role bb';
        }
      }

      // 状态
      const statusEl = el.querySelector('.seat-status');
      if (st.phase === 'waiting') {
        statusEl.textContent = p.isReady ? '已准备' : '未准备';
        if (p.isReady) statusEl.classList.add('ready');
      } else if (st.phase === 'settled') {
        statusEl.textContent = '';
      } else {
        if (p.status === 'folded') statusEl.textContent = '弃牌';
        else if (p.status === 'all_in') statusEl.textContent = '全下';
        else statusEl.textContent = '';
      }

      // 手牌
      const cardsEl = el.querySelector('.seat-cards');
      cardsEl.innerHTML = '';
      if (p.holeCards && p.holeCards.length > 0) {
        for (const c of p.holeCards) {
          cardsEl.appendChild(createCard(c, false));
        }
      }

      // 下注
      const betEl = el.querySelector('.seat-bet');
      if (p.currentBet > 0) { betEl.textContent = p.currentBet; betEl.classList.remove('hidden'); }
      else betEl.classList.add('hidden');

      // 倒计时圆点（当前说话玩家）
      const timerEl = el.querySelector('.seat-timer');
      if (p.id === st.currentPlayerId && st.phase !== 'waiting' && st.phase !== 'showdown' && st.phase !== 'settled') {
        const rem = st.turnTimeRemaining || 0;
        const secs = rem % 60;
        timerEl.textContent = rem > 60 ? `${Math.floor(rem/60)}m` : rem;
        timerEl.classList.remove('hidden');
        timerEl.classList.toggle('urgent', rem <= 15);
      } else {
        timerEl.classList.add('hidden');
      }
    }

    // 公共牌
    communityCardsEl.innerHTML = '';
    if (st.communityCards && st.communityCards.length > 0) {
      for (const c of st.communityCards) communityCardsEl.appendChild(createCard(c, true));
    }

    potDisplay.textContent = `底池: ${st.pot}`;

    // 操作栏
    const isMyTurn = st.currentPlayerId === myPlayerId && st.phase !== 'waiting' && st.phase !== 'showdown' && st.phase !== 'settled';
    if (isMyTurn && st.availableActions.length > 0) {
      actionBar.classList.remove('hidden');
      readyBar.classList.add('hidden');

      $('#btnFold').classList.toggle('hidden', !st.availableActions.includes('fold'));
      $('#btnCheck').classList.toggle('hidden', !st.availableActions.includes('check'));
      $('#btnCall').classList.toggle('hidden', !st.availableActions.includes('call'));
      $('#btnRaise').classList.toggle('hidden', !st.availableActions.includes('raise'));
      $('#btnAllIn').classList.toggle('hidden', !st.availableActions.includes('allin'));

      $('#btnCall').textContent = st.callAmount > 0 ? `跟注${st.callAmount}` : '跟注';

      // 启动倒计时
      startTimer(st.turnTimeRemaining || 120, st.turnTimeLimit || 120);
    } else {
      actionBar.classList.add('hidden');
      raiseControls.classList.add('hidden');
      if (!isMyTurn) stopTimer();
    }

    // 准备栏
    if (st.phase === 'waiting') {
      readyBar.classList.remove('hidden');
      const me = st.players.find(p => p.id === myPlayerId);
      const readyBtn = $('#btnReady');
      if (me && me.isReady) {
        readyBtn.textContent = '取消准备';
        readyBtn.classList.remove('btn-primary');
        readyBtn.classList.add('btn-secondary');
      } else {
        readyBtn.textContent = '准备';
        readyBtn.classList.add('btn-primary');
        readyBtn.classList.remove('btn-secondary');
      }
      // 重购按钮
      btnRebuy.classList.toggle('hidden', !st.canRebuy);
    } else {
      readyBar.classList.add('hidden');
    }

    // 单轮结果
    if (st.phase === 'showdown' && st.lastResults) {
      showResults(st.lastResults);
    } else {
      resultOverlay.classList.add('hidden');
    }

    // 结算
    if (st.phase === 'settled' && st.settlement) {
      showSettlement(st.settlement);
    } else {
      settlementOverlay.classList.add('hidden');
    }
  }

  function createCard(card, large) {
    const el = document.createElement('div');
    if (!card) {
      el.className = `card face-down${large ? ' large' : ''}`;
      return el;
    }
    el.className = `card face-up ${card.suit}${large ? ' large' : ''}`;
    el.innerHTML = `<span class="card-rank">${card.rank}</span><span class="card-suit">${card.symbol}</span>`;
    return el;
  }

  function showResults(results) {
    resultOverlay.classList.remove('hidden');
    resultTitle.textContent = '🏆 本轮结果';
    let html = '';
    for (const r of results) {
      const w = r.winAmount > 0;
      html += `<div class="result-player ${w ? 'winner' : ''}">
        <div>
          <div class="result-player-name">${r.playerName}</div>
          <div class="result-hand">${r.handName || ''}</div>
          ${r.holeCards ? `<div class="result-cards">${r.holeCards.map(c =>
            `<div class="card face-up ${c.suit}" style="width:22px;height:30px"><span class="card-rank" style="font-size:9px">${c.rank}</span><span class="card-suit" style="font-size:7px">${c.symbol}</span></div>`
          ).join('')}</div>` : ''}
        </div>
        <div class="result-amount ${w ? '' : 'lost'}">${w ? '+' + r.winAmount : ''}</div>
      </div>`;
    }
    resultDetails.innerHTML = html;
  }

  function showSettlement(settlement) {
    settlementOverlay.classList.remove('hidden');
    let html = '';
    settlement.forEach((s, i) => {
      const isTop = i === 0;
      const prefix = s.profit >= 0 ? '+' : '';
      html += `<div class="settlement-row ${isTop ? 'top' : ''}">
        <div class="settlement-rank">${i + 1}</div>
        <div class="settlement-name">${s.name}</div>
        <div>
          <div class="settlement-profit ${s.profit >= 0 ? 'positive' : 'negative'}">${prefix}${s.profit}</div>
          <div class="settlement-detail">买入${s.totalBuyIn} 剩余${s.finalChips}</div>
        </div>
      </div>`;
    });
    settlementList.innerHTML = html;
  }

  function addMessage(text, type = 'info') {
    const el = document.createElement('div');
    el.className = `msg ${type}`;
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    while (messagesEl.children.length > 40) messagesEl.removeChild(messagesEl.firstChild);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
