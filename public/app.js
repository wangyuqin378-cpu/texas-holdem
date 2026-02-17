/**
 * 德州扑克客户端
 */

(function () {
  'use strict';

  // ===== 状态 =====
  let socket = null;
  let myPlayerId = null;
  let myRoomId = null;
  let currentState = null;

  // ===== DOM 元素 =====
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const lobby = $('#lobby');
  const gameScreen = $('#gameScreen');
  const playerNameInput = $('#playerName');
  const roomIdInput = $('#roomIdInput');
  const roomIdDisplay = $('#roomIdDisplay');
  const playerCountDisplay = $('#playerCountDisplay');
  const seatsContainer = $('#seats');
  const communityCardsEl = $('#communityCards');
  const potDisplay = $('#potDisplay');
  const dealerChip = $('#dealerChip');
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

  // ===== 初始化 =====
  function init() {
    // 从 localStorage 恢复昵称
    const savedName = localStorage.getItem('pokerName');
    if (savedName) playerNameInput.value = savedName;

    // 绑定事件
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

    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendChat();
    });

    playerNameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') quickJoin();
    });

    roomIdInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') joinRoom();
    });

    raiseSlider.addEventListener('input', () => {
      raiseAmountInput.value = raiseSlider.value;
    });

    raiseAmountInput.addEventListener('input', () => {
      raiseSlider.value = raiseAmountInput.value;
    });

    // 加注预设按钮
    $$('.btn-preset').forEach((btn) => {
      btn.addEventListener('click', () => {
        const multiplier = parseFloat(btn.dataset.multiplier);
        if (currentState) {
          const potAmount = currentState.pot;
          const presetAmount = Math.floor(potAmount * multiplier);
          const minR = currentState.minRaise || 0;
          const finalAmount = Math.max(presetAmount, minR);
          raiseAmountInput.value = finalAmount;
          raiseSlider.value = finalAmount;
        }
      });
    });

    // 生成7个空座位
    generateSeats();
  }

  // ===== 连接服务器 =====
  function connectSocket() {
    if (socket) return;

    socket = io();

    socket.on('connect', () => {
      myPlayerId = socket.id;
      console.log('已连接:', myPlayerId);
    });

    socket.on('gameState', (state) => {
      currentState = state;
      renderGameState(state);
    });

    socket.on('message', (msg) => {
      addMessage(msg.text, msg.type);
    });

    socket.on('chat', (data) => {
      addMessage(`${data.playerName}: ${data.message}`, 'chat');
    });

    socket.on('disconnect', () => {
      console.log('断开连接');
      showLobby();
    });
  }

  // ===== 大厅操作 =====
  function getPlayerName() {
    const name = playerNameInput.value.trim();
    if (!name) {
      playerNameInput.focus();
      playerNameInput.style.borderColor = '#f56c6c';
      setTimeout(() => { playerNameInput.style.borderColor = ''; }, 2000);
      return null;
    }
    localStorage.setItem('pokerName', name);
    return name;
  }

  function quickJoin() {
    const name = getPlayerName();
    if (!name) return;
    connectSocket();
    socket.emit('quickJoin', { playerName: name }, (res) => {
      if (res.success) {
        myRoomId = res.roomId;
        showGameScreen();
      } else {
        alert(res.message);
      }
    });
  }

  function createRoom() {
    const name = getPlayerName();
    if (!name) return;
    connectSocket();
    socket.emit('createRoom', { playerName: name }, (res) => {
      if (res.success) {
        myRoomId = res.roomId;
        showGameScreen();
      } else {
        alert(res.message);
      }
    });
  }

  function joinRoom() {
    const name = getPlayerName();
    if (!name) return;
    const roomId = roomIdInput.value.trim();
    if (!roomId) {
      roomIdInput.focus();
      return;
    }
    connectSocket();
    socket.emit('joinRoom', { roomId, playerName: name }, (res) => {
      if (res.success) {
        myRoomId = res.roomId;
        showGameScreen();
      } else {
        alert(res.message);
      }
    });
  }

  function leaveRoom() {
    if (socket) {
      socket.disconnect();
      socket = null;
    }
    myRoomId = null;
    myPlayerId = null;
    currentState = null;
    showLobby();
  }

  function copyRoomId() {
    if (myRoomId) {
      navigator.clipboard.writeText(myRoomId).then(() => {
        const btn = $('#btnCopyRoom');
        btn.textContent = '✓';
        setTimeout(() => { btn.textContent = '📋'; }, 1500);
      });
    }
  }

  function showLobby() {
    lobby.classList.add('active');
    gameScreen.classList.remove('active');
    messagesEl.innerHTML = '';
  }

  function showGameScreen() {
    lobby.classList.remove('active');
    gameScreen.classList.add('active');
    roomIdDisplay.textContent = myRoomId;
  }

  // ===== 游戏操作 =====
  function toggleReady() {
    if (!socket) return;
    socket.emit('ready', () => {});
  }

  function doAction(action) {
    if (!socket) return;
    socket.emit('action', { action }, (res) => {
      if (!res.success) {
        addMessage(res.message, 'error');
      }
    });
    raiseControls.classList.add('hidden');
  }

  function showRaiseControls() {
    if (!currentState) return;
    const minRaise = currentState.minRaise || 20;
    const myPlayer = currentState.players.find(p => p.id === myPlayerId);
    if (!myPlayer) return;

    const maxRaise = myPlayer.chips - currentState.callAmount;
    raiseSlider.min = minRaise;
    raiseSlider.max = maxRaise;
    raiseSlider.value = minRaise;
    raiseAmountInput.min = minRaise;
    raiseAmountInput.max = maxRaise;
    raiseAmountInput.value = minRaise;

    raiseControls.classList.remove('hidden');
  }

  function confirmRaise() {
    const amount = parseInt(raiseAmountInput.value, 10);
    if (isNaN(amount) || amount <= 0) return;
    socket.emit('action', { action: 'raise', amount }, (res) => {
      if (!res.success) {
        addMessage(res.message, 'error');
      }
    });
    raiseControls.classList.add('hidden');
  }

  function sendChat() {
    const msg = chatInput.value.trim();
    if (!msg || !socket) return;
    socket.emit('chat', { message: msg });
    chatInput.value = '';
  }

  // ===== 渲染 =====
  function generateSeats() {
    seatsContainer.innerHTML = '';
    const positions = ['bottom', 'bottom', 'left', 'top', 'top', 'right', 'bottom'];
    for (let i = 0; i < 7; i++) {
      const seat = document.createElement('div');
      seat.className = 'seat empty';
      seat.dataset.seat = i;
      seat.dataset.position = positions[i];
      seat.innerHTML = `
        <div class="seat-inner">
          <div class="seat-name">空位</div>
          <div class="seat-chips"></div>
          <div class="seat-status"></div>
          <div class="seat-cards"></div>
        </div>
        <div class="seat-bet hidden"></div>
      `;
      seatsContainer.appendChild(seat);
    }
  }

  function renderGameState(state) {
    if (!state) return;

    playerCountDisplay.textContent = `${state.playerCount}/${state.maxPlayers}`;

    // 重置所有座位
    const seatElements = $$('.seat');
    seatElements.forEach((el) => {
      el.className = 'seat empty';
      el.querySelector('.seat-name').textContent = '空位';
      el.querySelector('.seat-chips').textContent = '';
      el.querySelector('.seat-status').textContent = '';
      el.querySelector('.seat-status').className = 'seat-status';
      el.querySelector('.seat-cards').innerHTML = '';
      el.querySelector('.seat-bet').classList.add('hidden');
    });

    // 渲染玩家
    for (const player of state.players) {
      const seatEl = $(`.seat[data-seat="${player.seatIndex}"]`);
      if (!seatEl) continue;

      seatEl.classList.remove('empty');
      if (player.id === myPlayerId) seatEl.classList.add('self');
      if (player.status === 'folded') seatEl.classList.add('folded');
      if (player.status === 'active') seatEl.classList.add('active');
      if (player.id === state.currentPlayerId) seatEl.classList.add('current-turn');

      seatEl.querySelector('.seat-name').textContent = player.name;
      seatEl.querySelector('.seat-chips').textContent = `💰 ${player.chips}`;

      // 状态
      const statusEl = seatEl.querySelector('.seat-status');
      if (state.phase === 'waiting') {
        if (player.isReady) {
          statusEl.textContent = '已准备';
          statusEl.classList.add('ready');
        } else {
          statusEl.textContent = '未准备';
        }
      } else {
        if (player.status === 'folded') statusEl.textContent = '已弃牌';
        else if (player.status === 'all_in') statusEl.textContent = '全下';
        else statusEl.textContent = '';
      }

      // 手牌
      const cardsEl = seatEl.querySelector('.seat-cards');
      cardsEl.innerHTML = '';
      if (player.holeCards && player.holeCards.length > 0) {
        for (const card of player.holeCards) {
          cardsEl.appendChild(createCardElement(card, false));
        }
      }

      // 下注
      const betEl = seatEl.querySelector('.seat-bet');
      if (player.currentBet > 0) {
        betEl.textContent = player.currentBet;
        betEl.classList.remove('hidden');
      } else {
        betEl.classList.add('hidden');
      }
    }

    // 公共牌
    communityCardsEl.innerHTML = '';
    if (state.communityCards && state.communityCards.length > 0) {
      for (const card of state.communityCards) {
        communityCardsEl.appendChild(createCardElement(card, true));
      }
    }

    // 底池
    potDisplay.textContent = `底池: ${state.pot}`;

    // 庄家标记
    if (state.dealerSeat >= 0 && state.phase !== 'waiting') {
      dealerChip.classList.remove('hidden');
      positionDealerChip(state.dealerSeat);
    } else {
      dealerChip.classList.add('hidden');
    }

    // 操作栏
    const isMyTurn = state.currentPlayerId === myPlayerId && state.phase !== 'waiting' && state.phase !== 'showdown';
    if (isMyTurn && state.availableActions.length > 0) {
      actionBar.classList.remove('hidden');
      readyBar.classList.add('hidden');

      // 控制按钮可见性
      $('#btnFold').classList.toggle('hidden', !state.availableActions.includes('fold'));
      $('#btnCheck').classList.toggle('hidden', !state.availableActions.includes('check'));
      $('#btnCall').classList.toggle('hidden', !state.availableActions.includes('call'));
      $('#btnRaise').classList.toggle('hidden', !state.availableActions.includes('raise'));
      $('#btnAllIn').classList.toggle('hidden', !state.availableActions.includes('allin'));

      // 跟注金额
      if (state.callAmount > 0) {
        $('#btnCall').textContent = `跟注 ${state.callAmount}`;
      } else {
        $('#btnCall').textContent = '跟注';
      }
    } else {
      actionBar.classList.add('hidden');
      raiseControls.classList.add('hidden');
    }

    // 准备栏
    if (state.phase === 'waiting') {
      readyBar.classList.remove('hidden');
      const myPlayer = state.players.find(p => p.id === myPlayerId);
      const readyBtn = $('#btnReady');
      if (myPlayer && myPlayer.isReady) {
        readyBtn.textContent = '取消准备';
        readyBtn.classList.remove('btn-primary');
        readyBtn.classList.add('btn-secondary');
      } else {
        readyBtn.textContent = '准备';
        readyBtn.classList.add('btn-primary');
        readyBtn.classList.remove('btn-secondary');
      }
    } else {
      readyBar.classList.add('hidden');
    }

    // 结果展示
    if (state.phase === 'showdown' && state.lastResults) {
      showResults(state.lastResults);
    } else {
      resultOverlay.classList.add('hidden');
    }
  }

  function createCardElement(card, large = false) {
    const el = document.createElement('div');

    if (!card) {
      // 暗牌
      el.className = `card face-down${large ? ' large' : ''}`;
      return el;
    }

    el.className = `card face-up ${card.suit}${large ? ' large' : ''}`;
    el.innerHTML = `
      <span class="card-rank">${card.rank}</span>
      <span class="card-suit">${card.symbol}</span>
    `;
    return el;
  }

  function positionDealerChip(seatIndex) {
    const seatEl = $(`.seat[data-seat="${seatIndex}"]`);
    if (!seatEl) return;

    const tableRect = $('.poker-table').getBoundingClientRect();
    const seatRect = seatEl.getBoundingClientRect();

    const x = seatRect.left - tableRect.left + seatRect.width / 2;
    const y = seatRect.top - tableRect.top + seatRect.height / 2;

    // 向桌心方向偏移
    const centerX = tableRect.width / 2;
    const centerY = tableRect.height / 2;
    const dx = centerX - x;
    const dy = centerY - y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const offsetDist = 40;

    dealerChip.style.left = `${x + (dx / dist) * offsetDist - 12}px`;
    dealerChip.style.top = `${y + (dy / dist) * offsetDist - 12}px`;
  }

  function showResults(results) {
    resultOverlay.classList.remove('hidden');

    const hasWinner = results.some(r => r.winAmount > 0);
    resultTitle.textContent = '🏆 本局结果';

    let html = '';
    for (const r of results) {
      const isWinner = r.winAmount > 0;
      html += `
        <div class="result-player ${isWinner ? 'winner' : ''}">
          <div>
            <div class="result-player-name">${r.playerName}</div>
            <div class="result-hand">${r.handName || ''}</div>
            ${r.holeCards ? `
              <div class="result-cards">
                ${r.holeCards.map(c => `
                  <div class="card face-up ${c.suit}" style="width:28px;height:38px;font-size:9px;">
                    <span class="card-rank" style="font-size:10px;">${c.rank}</span>
                    <span class="card-suit" style="font-size:8px;">${c.symbol}</span>
                  </div>
                `).join('')}
              </div>
            ` : ''}
          </div>
          <div class="result-amount ${isWinner ? '' : 'lost'}">
            ${isWinner ? `+${r.winAmount}` : ''}
          </div>
        </div>
      `;
    }

    resultDetails.innerHTML = html;
  }

  function addMessage(text, type = 'info') {
    const msg = document.createElement('div');
    msg.className = `msg ${type}`;
    msg.textContent = text;
    messagesEl.appendChild(msg);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    // 保留最近50条消息
    while (messagesEl.children.length > 50) {
      messagesEl.removeChild(messagesEl.firstChild);
    }
  }

  // ===== 启动 =====
  document.addEventListener('DOMContentLoaded', init);
})();
