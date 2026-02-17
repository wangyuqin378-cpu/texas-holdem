/**
 * 德州扑克客户端 v3
 * - 自己永远在底部中间（视角旋转）
 * - 每局快速结算，自动续局，无弹窗阻断
 * - 聊天窗可拖拽
 * - 倒计时 / 重购 / 20轮结算
 */
(function () {
  'use strict';

  let socket = null;
  let myPlayerId = null;
  let myRoomId = null;
  let mySeatIndex = -1;
  let currentState = null;
  let timerInterval = null;

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

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
  const timerFill = $('#timerFill');
  const timerText = $('#timerText');
  const settlementOverlay = $('#settlementOverlay');
  const settlementList = $('#settlementList');
  const btnRebuy = $('#btnRebuy');
  const messageLog = $('#messageLog');

  // ===== 初始化 =====
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
    initDraggableChat();
  }

  // ===== 聊天窗拖拽 =====
  function initDraggableChat() {
    let dragging = false;
    let startX, startY, origX, origY;

    function onStart(e) {
      // 不在输入框和按钮上拖拽
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
      dragging = true;
      const touch = e.touches ? e.touches[0] : e;
      const rect = messageLog.getBoundingClientRect();
      origX = rect.left;
      origY = rect.top;
      startX = touch.clientX;
      startY = touch.clientY;
      messageLog.style.transition = 'none';
      e.preventDefault();
    }

    function onMove(e) {
      if (!dragging) return;
      const touch = e.touches ? e.touches[0] : e;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      const newX = Math.max(0, Math.min(window.innerWidth - messageLog.offsetWidth, origX + dx));
      const newY = Math.max(0, Math.min(window.innerHeight - messageLog.offsetHeight, origY + dy));
      messageLog.style.left = newX + 'px';
      messageLog.style.top = newY + 'px';
      messageLog.style.bottom = 'auto';
      messageLog.style.right = 'auto';
      e.preventDefault();
    }

    function onEnd() {
      dragging = false;
      messageLog.style.transition = '';
    }

    messageLog.addEventListener('mousedown', onStart);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onEnd);
    messageLog.addEventListener('touchstart', onStart, { passive: false });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
  }

  // ===== 连接 =====
  function connectSocket() {
    if (socket) return;
    socket = io();
    socket.on('connect', () => { myPlayerId = socket.id; });
    socket.on('gameState', (s) => {
      currentState = s;
      // 记住自己的座位
      const me = s.players.find(p => p.id === myPlayerId);
      if (me) mySeatIndex = me.seatIndex;
      renderGameState(s);
    });
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
  function quickJoin() { const n = getName(); if (!n) return; connectSocket(); socket.emit('quickJoin', { playerName: n }, (r) => { if (r.success) { myRoomId = r.roomId; showGame(); } else alert(r.message); }); }
  function createRoom() { const n = getName(); if (!n) return; connectSocket(); socket.emit('createRoom', { playerName: n }, (r) => { if (r.success) { myRoomId = r.roomId; showGame(); } else alert(r.message); }); }
  function joinRoom() { const n = getName(); if (!n) return; const rid = roomIdInput.value.trim(); if (!rid) { roomIdInput.focus(); return; } connectSocket(); socket.emit('joinRoom', { roomId: rid, playerName: n }, (r) => { if (r.success) { myRoomId = r.roomId; showGame(); } else alert(r.message); }); }
  function leaveRoom() { if (socket) { socket.disconnect(); socket = null; } myRoomId = null; myPlayerId = null; mySeatIndex = -1; currentState = null; showLobby(); }
  function copyRoomId() { if (!myRoomId) return; navigator.clipboard.writeText(myRoomId).then(() => { const b = $('#btnCopyRoom'); b.textContent = '✓'; setTimeout(() => { b.textContent = '📋'; }, 1200); }); }
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
  function confirmRaise() { const a = parseInt(raiseAmountInput.value, 10); if (isNaN(a) || a <= 0) return; socket.emit('action', { action: 'raise', amount: a }, (r) => { if (!r.success && r.message) addMessage(r.message, 'error'); }); raiseControls.classList.add('hidden'); }
  function doRebuy() { if (socket) socket.emit('rebuy', (r) => { if (!r.success) addMessage(r.message || '重购失败', 'error'); }); }
  function doRestart() { if (socket) socket.emit('restart', () => {}); settlementOverlay.classList.add('hidden'); }
  function sendChat() { const m = chatInput.value.trim(); if (!m || !socket) return; socket.emit('chat', { message: m }); chatInput.value = ''; }

  // ===== 倒计时 =====
  function startTimer(remaining, total) {
    stopTimer();
    let left = remaining;
    updateTimerUI(left, total);
    timerInterval = setInterval(() => { left--; if (left < 0) left = 0; updateTimerUI(left, total); }, 1000);
  }
  function stopTimer() { if (timerInterval) { clearInterval(timerInterval); timerInterval = null; } }
  function updateTimerUI(left, total) {
    const pct = (left / total) * 100;
    timerFill.style.width = pct + '%';
    timerFill.classList.toggle('urgent', left <= 15);
    timerText.textContent = `${Math.floor(left / 60)}:${(left % 60).toString().padStart(2, '0')}`;
  }

  // ===== 视角旋转 =====
  // 将服务器 seatIndex 映射到视觉位置（自己永远在 0 = 底部中间）
  function toVisualSeat(serverSeatIndex) {
    if (mySeatIndex < 0) return serverSeatIndex;
    // 共7个位置，自己占位置0
    return (serverSeatIndex - mySeatIndex + 7) % 7;
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

    playerCountDisplay.textContent = `${st.playerCount}/${st.maxPlayers}`;
    roundDisplay.textContent = st.isGameStarted ? `第${st.currentRound}/${st.maxRounds}轮` : '等待开始';

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
      const r = el.querySelector('.seat-role');
      r.className = 'seat-role hidden'; r.textContent = '';
      el.querySelector('.seat-timer').classList.add('hidden');
    });

    const isPlaying = st.phase !== 'waiting' && st.phase !== 'settled';

    // 渲染玩家（使用视角旋转）
    for (const p of st.players) {
      const vSeat = toVisualSeat(p.seatIndex);
      const el = $(`.seat[data-seat="${vSeat}"]`);
      if (!el) continue;

      el.classList.remove('empty');
      if (p.id === myPlayerId) el.classList.add('self');
      if (p.status === 'folded') el.classList.add('folded');
      if (p.status === 'active') el.classList.add('active');
      if (p.id === st.currentPlayerId && isPlaying && st.phase !== 'showdown') {
        el.classList.add('current-turn');
      }

      el.querySelector('.seat-name').textContent = p.name;
      el.querySelector('.seat-chips').textContent = `💰${p.chips}`;

      // 位置标签 D / SB / BB
      const roleEl = el.querySelector('.seat-role');
      if (isPlaying || st.phase === 'showdown') {
        if (p.seatIndex === st.dealerSeat) { roleEl.textContent = 'D'; roleEl.className = 'seat-role dealer'; }
        else if (p.seatIndex === st.sbSeat) { roleEl.textContent = 'SB'; roleEl.className = 'seat-role sb'; }
        else if (p.seatIndex === st.bbSeat) { roleEl.textContent = 'BB'; roleEl.className = 'seat-role bb'; }
      }

      // 状态
      const statusEl = el.querySelector('.seat-status');
      if (st.phase === 'waiting') {
        statusEl.textContent = p.isReady ? '已准备' : '未准备';
        if (p.isReady) statusEl.classList.add('ready');
      } else if (st.phase !== 'settled') {
        if (p.status === 'folded') statusEl.textContent = '弃牌';
        else if (p.status === 'all_in') statusEl.textContent = '全下';
      }

      // 手牌
      const cardsEl = el.querySelector('.seat-cards');
      cardsEl.innerHTML = '';
      if (p.holeCards && p.holeCards.length > 0) {
        for (const c of p.holeCards) cardsEl.appendChild(createCard(c, false));
      }

      // 下注
      const betEl = el.querySelector('.seat-bet');
      if (p.currentBet > 0) { betEl.textContent = p.currentBet; betEl.classList.remove('hidden'); }
      else betEl.classList.add('hidden');

      // 座位倒计时
      const timerEl = el.querySelector('.seat-timer');
      if (p.id === st.currentPlayerId && isPlaying && st.phase !== 'showdown') {
        const rem = st.turnTimeRemaining || 0;
        timerEl.textContent = rem > 60 ? `${Math.floor(rem / 60)}m` : rem;
        timerEl.classList.remove('hidden');
        timerEl.classList.toggle('urgent', rem <= 15);
      }
    }

    // 公共牌
    communityCardsEl.innerHTML = '';
    if (st.communityCards && st.communityCards.length > 0) {
      for (const c of st.communityCards) communityCardsEl.appendChild(createCard(c, true));
    }

    potDisplay.textContent = `底池: ${st.pot}`;

    // 操作栏
    const isMyTurn = st.currentPlayerId === myPlayerId && isPlaying && st.phase !== 'showdown';
    if (isMyTurn && st.availableActions.length > 0) {
      actionBar.classList.remove('hidden');
      readyBar.classList.add('hidden');
      $('#btnFold').classList.toggle('hidden', !st.availableActions.includes('fold'));
      $('#btnCheck').classList.toggle('hidden', !st.availableActions.includes('check'));
      $('#btnCall').classList.toggle('hidden', !st.availableActions.includes('call'));
      $('#btnRaise').classList.toggle('hidden', !st.availableActions.includes('raise'));
      $('#btnAllIn').classList.toggle('hidden', !st.availableActions.includes('allin'));
      $('#btnCall').textContent = st.callAmount > 0 ? `跟注${st.callAmount}` : '跟注';
      startTimer(st.turnTimeRemaining || 120, st.turnTimeLimit || 120);
    } else {
      actionBar.classList.add('hidden');
      raiseControls.classList.add('hidden');
      if (!isMyTurn) stopTimer();
    }

    // 准备栏（只在等待阶段 & 未开始时显示）
    if (st.phase === 'waiting') {
      readyBar.classList.remove('hidden');
      const me = st.players.find(p => p.id === myPlayerId);
      const readyBtn = $('#btnReady');
      if (me && me.isReady) {
        readyBtn.textContent = '取消准备';
        readyBtn.classList.remove('btn-primary'); readyBtn.classList.add('btn-secondary');
      } else {
        readyBtn.textContent = '准备';
        readyBtn.classList.add('btn-primary'); readyBtn.classList.remove('btn-secondary');
      }
      btnRebuy.classList.toggle('hidden', !st.canRebuy);
    } else if (st.phase !== 'showdown') {
      readyBar.classList.add('hidden');
    }

    // showdown 阶段不弹窗，结果走消息流，2.5秒后自动续局
    // 只在20轮结算时弹窗
    if (st.phase === 'settled' && st.settlement) {
      showSettlement(st.settlement);
    } else {
      settlementOverlay.classList.add('hidden');
    }
  }

  function createCard(card, large) {
    const el = document.createElement('div');
    if (!card) { el.className = `card face-down${large ? ' large' : ''}`; return el; }
    el.className = `card face-up ${card.suit}${large ? ' large' : ''}`;
    el.innerHTML = `<span class="card-rank">${card.rank}</span><span class="card-suit">${card.symbol}</span>`;
    return el;
  }

  function showSettlement(settlement) {
    settlementOverlay.classList.remove('hidden');
    let html = '';
    settlement.forEach((s, i) => {
      const prefix = s.profit >= 0 ? '+' : '';
      html += `<div class="settlement-row ${i === 0 ? 'top' : ''}">
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
