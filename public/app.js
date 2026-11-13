(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const PHASES = { waiting: '等待准备', pre_flop: '翻牌前', flop: '翻牌', turn: '转牌', river: '河牌', showdown: '本手结果', settled: '比赛结束' };
  const DIFFICULTIES = { easy: '轻松', medium: '标准', hard: '挑战' };
  const STYLES = { steady: '稳健', balanced: '均衡', active: '积极' };
  let socket = null, currentState = null, myPlayerId = null, myRoomId = null, busy = false, connecting = false;
  let seated = false, timer = null, resultHand = null, dismissedSettlement = null, botStyleCounter = 0;
  const storage = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch {} },
    remove(key) { try { localStorage.removeItem(key); } catch {} },
  };
  const el = (tag, className = '', text = '') => { const node = document.createElement(tag); node.className = className; node.textContent = text; return node; };
  const show = (id, visible) => $(id).classList.toggle('hidden', !visible);
  const requestId = () => typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : [...crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, '0')).join('');
  function addMessage(text, type = 'info') {
    $('#messages').append(el('div', `msg ${['info','success','error','warning','chat'].includes(type) ? type : 'info'}`, text));
    while ($('#messages').children.length > 80) $('#messages').firstChild.remove();
    $('#messages').scrollTop = $('#messages').scrollHeight;
  }
  function error(text) { if (seated) { addMessage(text, 'error'); $('#connectionStatus').textContent = text; } else $('#lobbyError').textContent = text; }
  function updateDisabled() {
    $$('.action-buttons button, #btnConfirmRaise, #btnReady, #btnAddBot, .seat-add-bot, .seat-remove-bot, #btnRebuy, #btnRebuyShowdown, #btnSendChat').forEach(b => { b.disabled = busy || !seated || !socket?.connected; });
    $$('#btnCreateRoom, #btnJoinRoom, #btnQuickJoin').forEach(b => { b.disabled = connecting || busy; });
  }
  function request(event, data = {}) {
    return new Promise(resolve => {
      if (!socket?.connected) { resolve({ success: false, message: '连接尚未恢复，请稍后再试' }); return; }
      const payload = { protocolVersion: 2, requestId: requestId(), ...data };
      const send = attempt => socket.timeout(8000).emit(event, payload, (err, response) => {
        if (err && attempt === 0 && socket?.connected) { send(1); return; }
        resolve(err ? { success: false, retryable: true, message: '操作响应超时，请检查当前牌局再操作' } : response || { success: false, message: '没有收到操作结果' });
      });
      send(0);
    });
  }
  async function act(event, data = {}) {
    if (busy || !seated) return;
    busy = true; updateDisabled();
    const response = await request(event, data); busy = false;
    if (!response.success) error(response.message || '操作失败');
    if (currentState) render(currentState); else updateDisabled();
    return response;
  }
  function clearSession() { storage.remove('pokerRoom'); storage.remove('pokerSession'); seated = false; myPlayerId = null; myRoomId = null; }
  function lobby() {
    currentState = null; resultHand = null; clearInterval(timer); $('#gameScreen').classList.remove('active'); $('#lobby').classList.add('active');
    $('#messages').replaceChildren(); updateDisabled();
  }
  function enter(response) {
    myPlayerId = response.playerId; myRoomId = response.roomId; seated = true;
    storage.set('pokerSession', response.sessionToken); storage.set('pokerRoom', response.roomId);
    $('#lobby').classList.remove('active'); $('#gameScreen').classList.add('active');
    $('#roomIdDisplay').textContent = `房间 ${myRoomId}`; $('#connectionStatus').textContent = '已连接';
    if (currentState) render(currentState); else updateDisabled();
  }
  function connect() {
    if (socket) return;
    connecting = true; updateDisabled();
    socket = io({ autoConnect: false, reconnection: true, reconnectionAttempts: Infinity, reconnectionDelay: 1000, reconnectionDelayMax: 5000, timeout: 15000 });
    socket.on('connect', async () => {
      connecting = false;
      const token = storage.get('pokerSession');
      if (token) {
        const result = await request('rejoinRoom', { sessionToken: token });
        if (result.success) enter(result); else if (result.retryable) error(result.message); else { clearSession(); lobby(); error(result.message); }
      }
      updateDisabled();
    });
    socket.on('gameState', state => {
      if (state.protocolVersion !== 2) { error('版本已更新，请刷新页面'); return; }
      myPlayerId = state.youId; currentState = state;
      render(state);
    });
    socket.on('message', msg => addMessage(msg.text, msg.type));
    socket.on('chat', msg => addMessage(`${msg.playerName}: ${msg.message}`, 'chat'));
    socket.on('disconnect', () => { seated = false; clearInterval(timer); $('#connectionStatus').textContent = '连接断开，正在重连。座位保留 5 分钟。'; updateDisabled(); });
    socket.on('connect_error', () => { connecting = false; error('暂时无法连接服务器，正在重试…'); updateDisabled(); });
    socket.on('sessionReplaced', () => { seated = false; myPlayerId = null; myRoomId = null; socket.disconnect(); socket = null; lobby(); error('此座位已在另一个页面恢复'); });
    socket.connect();
  }
  async function join(event) {
    const name = $('#playerName').value.trim(), room = $('#roomIdInput').value.trim();
    if (!name) { error('请先输入昵称'); $('#playerName').focus(); return; }
    if (event === 'joinRoom' && !/^[a-f0-9]{6}$/i.test(room)) { error('请输入六位房间号'); $('#roomIdInput').focus(); return; }
    if (!socket) connect();
    if (!socket.connected) { error('正在连接服务器，连接成功后即可加入'); return; }
    if (busy) return; busy = true; updateDisabled(); $('#lobbyError').textContent = '';
    const response = await request(event, { playerName: name, roomId: room });
    busy = false;
    if (response.success) { storage.set('pokerName', name); enter(response); } else error(response.message);
    updateDisabled();
  }
  async function leave() {
    if (busy) return;
    if (socket?.connected && seated) { const result = await act('leaveRoom'); if (!result?.success) return; }
    clearSession(); lobby();
  }
  function card(c, large = false) {
    const node = el('div', `card ${c ? `face-up ${c.suit}` : 'face-down'}${large ? ' large' : ''}`);
    node.setAttribute('aria-label', c ? `${c.rank}${c.symbol}` : '隐藏手牌');
    if (c) node.append(el('span', 'card-rank', c.rank), el('span', 'card-suit', c.symbol));
    return node;
  }
  function cardRow(cards, className = '', large = true) { const row = el('div', `cards-row ${className}`); cards.forEach(c => row.append(card(c, large))); return row; }
  function buildSeats() {
    for (let i = 0; i < 7; i++) {
      const seat = el('div', 'seat empty'); seat.dataset.seat = i;
      const inner = el('div', 'seat-inner');
      for (const className of ['seat-role hidden', 'seat-name', 'seat-chips', 'seat-status', 'seat-cards', 'seat-timer hidden']) inner.append(el('div', className));
      const add = el('button', 'seat-add-bot', '+'); add.title = '添加机器人'; add.setAttribute('aria-label', '添加机器人'); add.addEventListener('click', addBot);
      const remove = el('button', 'seat-remove-bot', '×'); remove.title = '移除机器人'; remove.setAttribute('aria-label', '移除机器人'); remove.addEventListener('click', () => act('removeBot', { botId: seat.dataset.botId }));
      inner.append(add, remove); seat.append(inner, el('div', 'seat-bet hidden')); $('#seats').append(seat);
    }
  }
  async function addBot() {
    const choice = $('#botStyle').value, style = choice === 'mixed' ? ['steady', 'balanced', 'active'][botStyleCounter % 3] : choice;
    const result = await act('addBot', { difficulty: $('#botDifficulty').value, style }); if (result?.success) botStyleCounter++;
  }
  function render(state) {
    const me = state.players.find(p => p.id === myPlayerId), host = state.hostPlayerId === myPlayerId;
    const live = ['pre_flop', 'flop', 'turn', 'river'].includes(state.phase), between = ['waiting', 'showdown'].includes(state.phase);
    $('#playerCountDisplay').textContent = `${state.playerCount}/${state.maxPlayers}`;
    $('#roundDisplay').textContent = state.isGameStarted ? `第 ${state.currentRound}/${state.maxRounds} 轮` : '等待开始';
    const current = state.players.find(p => p.id === state.currentPlayerId);
    $('#tableStatus').textContent = `${PHASES[state.phase]}${current ? ` · ${current.id === myPlayerId ? '轮到你' : `等待 ${current.name}`}` : ''}${host ? ' · 你是房主' : ''}`;
    show('#botControls', host && between);
    for (const seat of $$('.seat')) {
      seat.className = 'seat empty'; delete seat.dataset.botId;
      for (const name of ['name', 'chips', 'status']) seat.querySelector(`.seat-${name}`).textContent = name === 'name' ? '空位' : '';
      seat.querySelector('.seat-cards').replaceChildren();
      seat.querySelector('.seat-role').className = 'seat-role hidden'; seat.querySelector('.seat-timer').classList.add('hidden'); seat.querySelector('.seat-bet').classList.add('hidden');
      seat.querySelector('.seat-add-bot').classList.toggle('hidden', !host || !between);
      seat.querySelector('.seat-remove-bot').classList.add('hidden');
    }
    for (const player of state.players) {
      const visual = (player.seatIndex - (me?.seatIndex || 0) + 7) % 7, seat = $(`.seat[data-seat="${visual}"]`);
      seat.classList.remove('empty');
      for (const [name, yes] of [['self', player.id === myPlayerId], ['folded', player.status === 'folded'], ['bot', player.isBot], ['disconnected', !player.isConnected], ['current-turn', live && player.id === state.currentPlayerId]]) seat.classList.toggle(name, !!yes);
      seat.querySelector('.seat-name').textContent = player.name;
      seat.querySelector('.seat-name').title = player.isBot ? `${DIFFICULTIES[player.difficulty]} · ${STYLES[player.style]}` : player.name;
      seat.querySelector('.seat-chips').textContent = `${player.chips} 筹码`;
      const result = state.lastResults?.find(r => r.playerId === player.id);
      seat.classList.toggle('winner', !!result?.winAmount);
      seat.classList.toggle('confirmed', !!player.confirmedNext && state.phase === 'showdown');
      seat.querySelector('.seat-status').textContent = result ? (result.winAmount ? `赢得 ${result.winAmount}` : result.handName) : state.phase === 'waiting' ? (player.isReady ? '已准备' : '未准备') : ({ folded: '弃牌', all_in: '全下', sitting_out: '等待下一手' }[player.status] || (player.isBot ? STYLES[player.style] : ''));
      const roles = [];
      if (player.seatIndex === state.dealerSeat) roles.push('D'); if (player.seatIndex === state.sbSeat) roles.push('SB'); if (player.seatIndex === state.bbSeat) roles.push('BB');
      if (state.isGameStarted && roles.length) { const role = seat.querySelector('.seat-role'); role.textContent = roles.join(' / '); role.className = `seat-role ${roles.includes('D') ? 'dealer' : roles.includes('SB') ? 'sb' : 'bb'}`; }
      player.holeCards.forEach(c => seat.querySelector('.seat-cards').append(card(c)));
      if (live && player.currentBet > 0) { const bet = seat.querySelector('.seat-bet'); bet.textContent = player.currentBet; bet.classList.remove('hidden'); }
      seat.querySelector('.seat-add-bot').classList.add('hidden');
      if (player.isBot && host && between) { seat.dataset.botId = player.id; seat.querySelector('.seat-remove-bot').classList.remove('hidden'); }
    }
    $('#communityCards').replaceChildren(...state.communityCards.map(c => card(c, true)));
    $('#potDisplay').textContent = `${state.potAwarded ? '本手总投入' : '底池'}: ${state.pot}`;
    const myTurn = live && state.currentPlayerId === myPlayerId && seated && socket?.connected;
    show('#actionBar', myTurn);
    for (const [action, id] of Object.entries({ fold: 'Fold', check: 'Check', call: 'Call', raise: 'Raise', allin: 'AllIn' })) show(`#btn${id}`, myTurn && state.availableActions.includes(action));
    $('#btnCall').textContent = `跟注 ${state.callAmount}`;
    $('#btnRaise').textContent = state.currentBet === 0 ? '下注' : '加注';
    if (!myTurn || $('#raiseControls').dataset.turn !== state.turnId) show('#raiseControls', false);
    show('#readyBar', state.phase === 'waiting' || (state.phase === 'showdown' && !me?.isReady));
    $('#btnReady').textContent = me?.isReady ? '取消准备' : state.phase === 'showdown' ? '下一手加入' : '准备';
    show('#btnRebuy', state.canRebuy); show('#btnRebuyShowdown', state.canRebuy);
    show('#showdownBar', state.phase === 'showdown');
    $('#confirmStatus').textContent = `已确认 ${state.confirmedCount}/${state.totalPlayerCount} · 断线玩家不阻塞续局`;
    $('#btnConfirmNext').textContent = me?.confirmedNext ? '已确认，等待其他人' : state.currentRound === state.maxRounds ? '确认并查看比赛总结' : '确认下一手';
    $('#btnConfirmNext').disabled = busy || !seated || !!me?.confirmedNext;
    renderResults(state); renderSettlement(state);
    clearInterval(timer);
    if (live && current) {
      const deadline = Date.now() + state.turnTimeRemaining * 1000;
      const tick = () => {
        const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
        $('#timerFill').style.width = `${left / state.turnTimeLimit * 100}%`;
        $('#timerText').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
        const visual = (current.seatIndex - (me?.seatIndex || 0) + 7) % 7;
        const badge = $(`.seat[data-seat="${visual}"] .seat-timer`); badge.textContent = left; badge.classList.remove('hidden'); badge.classList.toggle('urgent', left <= 15);
      };
      tick(); timer = setInterval(tick, 1000);
    }
    updateDisabled();
  }
  function renderResults(state) {
    const visible = ['showdown', 'settled'].includes(state.phase) && state.lastResults;
    show('#handResults', !!visible);
    if (!visible) { resultHand = null; return; }
    if (resultHand === state.handId) return;
    resultHand = state.handId;
    const area = $('#handResults'); area.replaceChildren(el('h2', '', `第 ${state.currentRound} 手 · ${state.isActualShowdown ? '比牌结果' : '其他玩家弃牌'}`));
    if (state.isActualShowdown) area.append(el('p', 'result-label', '公共牌'), cardRow(state.communityCards, 'result-board'));
    for (const r of state.lastResults) {
      const row = el('article', `hand-result${r.winAmount ? ' result-winner' : ''}`);
      row.append(el('h3', '', `${r.playerName} · ${r.handName}`), el('p', 'result-award', `赢得 ${r.winAmount} 筹码${r.returnedAmount ? ` · 未被跟注退回 ${r.returnedAmount}` : ''}`));
      if (r.holeCards?.length) {
        const own = el('div', 'result-group'); own.append(el('span', 'result-label', '底牌'), cardRow(r.holeCards, 'result-hole'));
        const best = el('div', 'result-group'); best.append(el('span', 'result-label', '最佳五张'), cardRow(r.hand.cards, 'result-best'));
        row.append(own, best);
      }
      area.append(row);
    }
    for (const [i, pot] of (state.sidePots || []).entries()) {
      area.append(el('p', 'pot-result', `${i === 0 ? '主池' : `边池 ${i}`} ${pot.amount}：${pot.awards.map(a => `${state.lastResults.find(r => r.playerId === a.playerId)?.playerName || '玩家'} +${a.amount}`).join('，')}`));
    }
    area.append(el('p', 'result-label', state.isActualShowdown ? '参与比牌者全部亮牌；已弃牌玩家的底牌保持隐藏。' : '无需比牌，获胜者的底牌保持隐藏。'));
  }
  function renderSettlement(state) {
    const settled = state.phase === 'settled', visible = settled && dismissedSettlement !== state.handId;
    const wasVisible = !$('#settlementOverlay').classList.contains('hidden');
    show('#settlementOverlay', visible); show('#btnOpenSettlement', settled && !visible);
    if (!settled) { dismissedSettlement = null; return; }
    $('#settlementList').replaceChildren(...state.settlement.map((p, i) => {
      const row = el('div', `settlement-row${i === 0 ? ' top' : ''}`);
      const detail = el('div'); detail.append(el('div', `settlement-profit ${p.profit >= 0 ? 'positive' : 'negative'}`, `${p.profit >= 0 ? '+' : ''}${p.profit}`), el('div', 'settlement-detail', `买入 ${p.totalBuyIn} · 剩余 ${p.finalChips}`));
      row.append(el('div', 'settlement-rank', String(i + 1)), el('div', 'settlement-name', `${p.name}${p.departed ? '（已离开）' : ''}`), detail); return row;
    }));
    const connected = state.players.filter(p => p.isConnected), confirmed = connected.filter(p => p.confirmedSettlement).length;
    $('#settlementProgress').textContent = `已确认 ${confirmed}/${connected.length}`;
    const mine = state.confirmedSettlement.includes(myPlayerId);
    $('#btnConfirmSettlement').disabled = busy || mine || !seated;
    $('#btnConfirmSettlement').textContent = mine ? '已确认总结' : '确认总结';
    show('#btnRestart', state.hostPlayerId === myPlayerId);
    $('#btnRestart').disabled = busy || !seated || !state.allConfirmedSettlement;
    if (visible && !wasVisible) $('.settlement-content').focus();
  }
  function updateRaise(value) {
    if (!currentState) return;
    const min = currentState.minRaiseTo, max = currentState.maxRaiseTo, target = Math.min(max, Math.max(min, Number(value) || min));
    $('#raiseSlider').value = target; $('#raiseAmount').value = target;
    const me = currentState.players.find(p => p.id === myPlayerId);
    $('#raiseSummary').textContent = `本轮总下注 ${target} · 本次支付 ${target - me.currentBet}（含跟注）`;
  }
  function openRaise() {
    if (!currentState?.availableActions.includes('raise')) return;
    for (const id of ['#raiseSlider', '#raiseAmount']) { $(id).min = currentState.minRaiseTo; $(id).max = currentState.maxRaiseTo; $(id).step = 1; }
    $('#raiseControls').dataset.turn = currentState.turnId;
    updateRaise(currentState.minRaiseTo); show('#raiseControls', true); $('#raiseAmount').focus();
  }
  async function action(name, amount) {
    if (!currentState) return;
    await act('action', { action: name, amount, turnId: currentState.turnId, handId: currentState.handId }); show('#raiseControls', false);
  }
  function init() {
    $('#playerName').value = storage.get('pokerName') || ''; buildSeats();
    for (const [id, event] of [['#btnCreateRoom','createRoom'], ['#btnJoinRoom','joinRoom'], ['#btnQuickJoin','quickJoin']]) $(id).addEventListener('click', () => join(event));
    $('#playerName').addEventListener('keydown', e => { if (e.key === 'Enter') join('quickJoin'); });
    $('#roomIdInput').addEventListener('keydown', e => { if (e.key === 'Enter') join('joinRoom'); });
    $('#btnLeave').addEventListener('click', leave);
    $('#btnReady').addEventListener('click', () => act('ready', { ready: !currentState?.players.find(p => p.id === myPlayerId)?.isReady }));
    for (const name of ['Fold','Check','Call','AllIn']) $(`#btn${name}`).addEventListener('click', () => action(name.toLowerCase()));
    $('#btnRaise').addEventListener('click', openRaise);
    $('#btnConfirmRaise').addEventListener('click', () => {
      const target = Number($('#raiseAmount').value);
      if (!Number.isSafeInteger(target) || target < currentState.minRaiseTo || target > currentState.maxRaiseTo) { error('请输入允许范围内的整数'); return; }
      action('raise', target - currentState.currentBet);
    });
    $('#raiseSlider').addEventListener('input', e => updateRaise(e.target.value));
    $('#raiseAmount').addEventListener('change', e => updateRaise(e.target.value));
    $$('.btn-preset').forEach(btn => btn.addEventListener('click', () => updateRaise(currentState.currentBet + Math.round((currentState.pot + currentState.callAmount) * Number(btn.dataset.multiplier)))));
    for (const id of ['#btnRebuy', '#btnRebuyShowdown']) $(id).addEventListener('click', () => act('rebuy'));
    $('#btnConfirmNext').addEventListener('click', () => act('confirmNext', { handId: currentState.handId }));
    $('#btnConfirmSettlement').addEventListener('click', () => act('confirmSettlement', { handId: currentState.handId }));
    $('#btnRestart').addEventListener('click', () => act('restart'));
    $('#btnViewLastHand').addEventListener('click', () => { dismissedSettlement = currentState.handId; renderSettlement(currentState); $('#btnOpenSettlement').focus(); $('#handResults').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
    $('#btnOpenSettlement').addEventListener('click', () => { dismissedSettlement = null; renderSettlement(currentState); });
    $('#settlementOverlay').addEventListener('keydown', e => {
      if (e.key === 'Escape') $('#btnViewLastHand').click();
      if (e.key === 'Tab') {
        const buttons = [...$('.settlement-content').querySelectorAll('button:not(:disabled)')].filter(b => !b.classList.contains('hidden'));
        if (e.shiftKey && (document.activeElement === buttons[0] || document.activeElement === $('.settlement-content'))) { e.preventDefault(); buttons.at(-1).focus(); }
        else if (!e.shiftKey && document.activeElement === buttons.at(-1)) { e.preventDefault(); buttons[0].focus(); }
      }
    });
    const chat = async () => { const message = $('#chatInput').value.trim(); if (message && (await act('chat', { message }))?.success) $('#chatInput').value = ''; };
    $('#btnSendChat').addEventListener('click', chat); $('#chatInput').addEventListener('keydown', e => { if (e.key === 'Enter') chat(); });
    $('#btnAddBot').addEventListener('click', addBot);
    $('#btnCopyRoom').addEventListener('click', async () => { try { await navigator.clipboard.writeText(myRoomId); $('#connectionStatus').textContent = '房间号已复制'; } catch { $('#connectionStatus').textContent = `房间号：${myRoomId}，可手动复制`; } });
    connect();
  }
  document.addEventListener('DOMContentLoaded', init);
})();
