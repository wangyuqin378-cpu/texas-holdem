/**
 * 德州扑克客户端 v5
 * - 自己永远在底部中间（视角旋转）
 * - SHOWDOWN 展示所有人牌型，全员确认后续局
 * - 聊天窗可拖拽
 * - 倒计时 / 重购 / 20轮结算
 * - 断线自动重连
 */
(function () {
  'use strict';

  let socket = null;
  let myPlayerId = null;
  let myRoomId = null;
  let mySeatIndex = -1;
  let currentState = null;
  let timerInterval = null;
  let isReconnecting = false;

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
  const showdownBar = $('#showdownBar');
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
    $('#btnRebuyShowdown').addEventListener('click', doRebuy);
    $('#btnConfirmNext').addEventListener('click', doConfirmNext);
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

    // 页面加载时自动重连
    const savedRoom = localStorage.getItem('pokerRoom');
    const savedName = localStorage.getItem('pokerName');
    if (savedRoom && savedName) {
      isReconnecting = true;
      connectSocket();
    }
  }

  // ===== 聊天窗拖拽 =====
  function initDraggableChat() {
    let dragging = false;
    let startX, startY, origX, origY;

    function onStart(e) {
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
    if (socket) {
      // 如果已有连接且需要重连，直接发重连请求
      if (isReconnecting && socket.connected) {
        attemptRejoin();
      }
      return;
    }
    socket = io({
      reconnection: true,
      reconnectionAttempts: 50,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      timeout: 30000,
    });

    socket.on('connect', () => {
      myPlayerId = socket.id;
      // 如果之前在房间中，尝试重连
      if (isReconnecting) {
        attemptRejoin();
      }
    });

    socket.on('gameState', (s) => {
      currentState = s;
      const me = s.players.find(p => p.id === myPlayerId);
      if (me) mySeatIndex = me.seatIndex;
      renderGameState(s);
    });
    socket.on('message', (m) => { addMessage(m.text, m.type); });
    socket.on('chat', (d) => { addMessage(`${d.playerName}: ${d.message}`, 'chat'); });

    socket.on('disconnect', () => {
      // 不立即回大厅，标记重连中（Socket.IO 会自动重连 transport）
      const savedRoom = localStorage.getItem('pokerRoom');
      if (savedRoom && myRoomId) {
        isReconnecting = true;
        addMessage('连接断开，正在尝试重连...', 'warning');
      } else {
        showLobby();
      }
    });
  }

  // 尝试重新加入房间
  function attemptRejoin() {
    const savedRoom = localStorage.getItem('pokerRoom');
    const savedName = localStorage.getItem('pokerName');
    if (!savedRoom || !savedName) {
      isReconnecting = false;
      showLobby();
      return;
    }
    addMessage('正在重连...', 'info');
    socket.emit('rejoinRoom', { roomId: savedRoom, playerName: savedName }, (r) => {
      isReconnecting = false;
      if (r.success) {
        myRoomId = r.roomId;
        mySeatIndex = r.seatIndex;
        showGame();
        addMessage('重连成功！', 'success');
      } else {
        // 重连失败，清除保存的房间信息，回到大厅
        addMessage('重连失败: ' + r.message, 'error');
        localStorage.removeItem('pokerRoom');
        showLobby();
      }
    });
  }

  // ===== 大厅 =====
  function getName() {
    const n = playerNameInput.value.trim();
    if (!n) { playerNameInput.focus(); playerNameInput.style.borderColor = '#f56c6c'; setTimeout(() => { playerNameInput.style.borderColor = ''; }, 1500); return null; }
    localStorage.setItem('pokerName', n);
    return n;
  }
  function quickJoin() { const n = getName(); if (!n) return; connectSocket(); socket.emit('quickJoin', { playerName: n }, (r) => { if (r.success) { myRoomId = r.roomId; localStorage.setItem('pokerRoom', r.roomId); showGame(); } else alert(r.message); }); }
  function createRoom() { const n = getName(); if (!n) return; connectSocket(); socket.emit('createRoom', { playerName: n }, (r) => { if (r.success) { myRoomId = r.roomId; localStorage.setItem('pokerRoom', r.roomId); showGame(); } else alert(r.message); }); }
  function joinRoom() { const n = getName(); if (!n) return; const rid = roomIdInput.value.trim(); if (!rid) { roomIdInput.focus(); return; } connectSocket(); socket.emit('joinRoom', { roomId: rid, playerName: n }, (r) => { if (r.success) { myRoomId = r.roomId; localStorage.setItem('pokerRoom', r.roomId); showGame(); } else alert(r.message); }); }
  function leaveRoom() { localStorage.removeItem('pokerRoom'); isReconnecting = false; if (socket) { socket.disconnect(); socket = null; } myRoomId = null; myPlayerId = null; mySeatIndex = -1; currentState = null; showLobby(); }
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
  function doConfirmNext() {
    if (!socket) return;
    const btn = $('#btnConfirmNext');
    btn.disabled = true;
    btn.textContent = '⏳ 已确认，等待其他人...';
    btn.classList.remove('btn-primary');
    btn.classList.add('btn-secondary');
    socket.emit('confirmNext', (r) => {
      if (!r.success) {
        addMessage(r.message || '确认失败', 'error');
        btn.disabled = false;
        btn.textContent = '✅ 确认下一局';
        btn.classList.add('btn-primary');
        btn.classList.remove('btn-secondary');
      }
    });
  }
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
  function toVisualSeat(serverSeatIndex) {
    if (mySeatIndex < 0) return serverSeatIndex;
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

      // 断线状态
      if (!p.isConnected) {
        el.classList.add('disconnected');
      }

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
      } else if (st.phase === 'showdown' && st.lastResults) {
        // SHOWDOWN：显示牌型、赢家、确认状态
        const pResult = st.lastResults.find(r => r.playerId === p.id);
        if (pResult) {
          if (pResult.winAmount > 0) {
            statusEl.textContent = `🏆 +${pResult.winAmount} ${pResult.handName || ''}`;
            statusEl.classList.add('winner');
            el.classList.add('winner');
          } else if (p.status === 'folded') {
            statusEl.textContent = '弃牌';
          } else {
            statusEl.textContent = pResult.handName || '';
          }
        }
        // 已确认的玩家打勾
        if (p.confirmedNext) {
          el.classList.add('confirmed');
        }
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
      showdownBar.classList.add('hidden');
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

    // SHOWDOWN 阶段 → 显示确认栏
    if (st.phase === 'showdown') {
      readyBar.classList.add('hidden');
      showdownBar.classList.remove('hidden');

      // 确认状态
      const confirmStatusEl = $('#confirmStatus');
      confirmStatusEl.textContent = `已确认: ${st.confirmedCount}/${st.totalPlayerCount}`;

      // 自己是否已确认
      const me = st.players.find(p => p.id === myPlayerId);
      const myConfirmed = me && me.confirmedNext;
      const btnConfirm = $('#btnConfirmNext');
      if (myConfirmed) {
        btnConfirm.disabled = true;
        btnConfirm.textContent = '⏳ 已确认，等待其他人...';
        btnConfirm.classList.remove('btn-primary');
        btnConfirm.classList.add('btn-secondary');
      } else {
        btnConfirm.disabled = false;
        btnConfirm.textContent = '✅ 确认下一局';
        btnConfirm.classList.add('btn-primary');
        btnConfirm.classList.remove('btn-secondary');
      }

      // 重购按钮
      const btnRebuySD = $('#btnRebuyShowdown');
      btnRebuySD.classList.toggle('hidden', !st.canRebuy);
    } else {
      showdownBar.classList.add('hidden');
    }

    // 准备栏（只在等待阶段显示）
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

    // 20轮结算弹窗
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
