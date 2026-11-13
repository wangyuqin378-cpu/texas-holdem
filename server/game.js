/** Server-authoritative, integer-chip no-limit hold'em engine. */
const { Deck } = require('./deck');
const { evaluateBestHand, compareHands } = require('./handEvaluator');
const MAX_PLAYERS = 7;
const GAME_PHASES = Object.freeze({ WAITING: 'waiting', PRE_FLOP: 'pre_flop', FLOP: 'flop', TURN: 'turn', RIVER: 'river', SHOWDOWN: 'showdown', SETTLED: 'settled' });
const PLAYER_STATUS = Object.freeze({ ACTIVE: 'active', FOLDED: 'folded', ALL_IN: 'all_in', SITTING_OUT: 'sitting_out' });
const LIVE = new Set(['pre_flop', 'flop', 'turn', 'river']);
const fail = message => ({ success: false, message });
const cardJSON = c => c.toJSON ? c.toJSON() : { ...c };

class Player {
  constructor(id, name, seatIndex, options = {}) {
    Object.assign(this, { id, name, seatIndex, chips: 1000, totalBuyIn: 1000, holeCards: [], currentBet: 0, totalBetThisRound: 0,
      status: PLAYER_STATUS.SITTING_OUT, isReady: false, isConnected: true, departed: false, isBot: false, ...options });
  }
  reset() {
    this.holeCards = []; this.currentBet = 0; this.totalBetThisRound = 0;
    this.status = PLAYER_STATUS.SITTING_OUT;
  }
  toJSON(reveal = false) {
    const { id, name, seatIndex, chips, currentBet, status, isReady, isConnected, totalBuyIn, isBot, difficulty, style } = this;
    return { id, name, seatIndex, chips, currentBet, status, isReady, isConnected, totalBuyIn, isBot, difficulty, style,
      holeCards: this.holeCards.map(c => reveal ? cardJSON(c) : null) };
  }
}

class Game {
  constructor(roomId, options = {}) {
    this.roomId = roomId; this.players = new Map(); this.departedPlayers = new Map();
    this.seatOrder = []; this.deck = options.deck || new Deck(); this.communityCards = [];
    this.pot = 0; this.lastPot = 0; this.sidePots = []; this.phase = GAME_PHASES.WAITING;
    this.dealerSeat = -1; this.dealerIndex = -1; this.currentPlayerIndex = -1;
    this.smallBlind = 10; this.bigBlind = 20; this.currentBet = 0; this.minRaise = 20;
    this.roundHistory = []; this.currentRound = 0; this.maxRounds = 20; this.isGameStarted = false;
    this.handId = 0; this.revision = 0; this.pending = new Set(); this.actedAtBet = new Map();
    this.turnStartTime = null; this.turnTimeLimit = 120; this.sbSeatIndex = -1; this.bbSeatIndex = -1;
    this.confirmedNextPlayers = new Set(); this.confirmedSettlement = new Set(); this.handParticipants = new Set();
    this.lastResults = null; this.isActualShowdown = false; this.hostPlayerId = null;
  }
  get playerCount() { return [...this.players.values()].filter(p => !p.departed).length; }
  get isLive() { return LIVE.has(this.phase); }
  get activePlayers() { return this.seatOrder.map(id => this.players.get(id)).filter(p => p?.status === 'active'); }
  get activeAndAllInPlayers() { return this.seatOrder.map(id => this.players.get(id)).filter(p => p && ['active', 'all_in'].includes(p.status)); }
  get turnId() { return this.isLive ? `${this.handId}:${this.revision}:${this.getCurrentPlayer()?.id || ''}` : null; }
  touch() { this.revision++; }
  addPlayer(id, name, options = {}) {
    if (this.players.size >= MAX_PLAYERS) return fail('房间已满（最多7人）');
    if (this.players.has(id)) return fail('已在房间中');
    const taken = new Set([...this.players.values()].map(p => p.seatIndex));
    const seat = Array.from({ length: MAX_PLAYERS }, (_, i) => i).find(i => !taken.has(i));
    const player = new Player(id, name, seat, options);
    this.players.set(id, player);
    if (!player.isBot && !this.hostPlayerId) this.hostPlayerId = id;
    // Membership changes never change the current hand's ordering or turn token.
    return { success: true, player, seatIndex: seat };
  }
  transferHost() {
    const host = this.players.get(this.hostPlayerId);
    if (host?.isConnected && !host.departed) return;
    this.hostPlayerId = [...this.players.values()].find(p => !p.isBot && p.isConnected && !p.departed)?.id || null;
  }
  markDisconnected(id) {
    const p = this.players.get(id); if (!p) return null;
    p.isConnected = false; this.transferHost();
    // A disconnected player keeps their hand until their turn (all-ins stay live).
    if (this.isLive && this.getCurrentPlayer()?.id === id) this.progress(this.currentPlayerIndex - 1);
    return { player: p, roundEnded: this.phase === 'showdown' };
  }
  reconnectPlayer(id) {
    const p = this.players.get(id); if (!p || p.departed) return null;
    p.isConnected = true; if (!this.hostPlayerId) this.hostPlayerId = id;
    return p;
  }
  removePlayer(id) {
    const p = this.players.get(id); if (!p) return null;
    p.departed = true; p.isConnected = false; this.transferHost();
    if (this.isLive && this.handParticipants.has(id)) {
      if (p.status === 'active') { p.status = 'folded'; this.pending.delete(id); }
      // Preserve contributed chips and an all-in hand until settlement.
      this.progress(this.currentPlayerIndex - 1);
    } else this.archivePlayer(p);
    return p;
  }
  archivePlayer(p) {
    this.departedPlayers.set(p.id, { id: p.id, name: p.name, seatIndex: p.seatIndex, finalChips: p.chips, totalBuyIn: p.totalBuyIn, profit: p.chips - p.totalBuyIn, departed: true });
    this.players.delete(p.id); this.confirmedNextPlayers.delete(p.id); this.confirmedSettlement.delete(p.id);
  }
  setPlayerReady(id, ready) {
    const p = this.players.get(id); if (!p || this.isLive || this.phase === 'settled') return false;
    p.isReady = !!ready; return true;
  }
  canStartGame() {
    const participants = [...this.players.values()].filter(p => p.isConnected && !p.departed && p.chips > 0);
    return this.phase === 'waiting' && participants.length >= 2 && participants.some(p => !p.isBot) && participants.every(p => p.isReady);
  }
  startGame() {
    if (!this.canStartGame()) return false;
    this.isGameStarted = true;
    return this.startRound();
  }
  startRound() {
    if (this.isLive || this.phase === 'settled' || this.currentRound >= this.maxRounds) return false;
    const participants = [...this.players.values()].filter(p => p.isReady && p.isConnected && !p.departed && p.chips > 0).sort((a, b) => a.seatIndex - b.seatIndex);
    if (participants.length < 2 || !participants.some(p => !p.isBot)) return false;
    for (const p of this.players.values()) p.reset();
    this.seatOrder = participants.map(p => p.id); this.handParticipants = new Set(this.seatOrder);
    this.deck.reset(); this.communityCards = []; this.pot = 0; this.lastPot = 0; this.lastResults = null; this.sidePots = [];
    this.roundHistory = []; this.confirmedNextPlayers.clear(); this.currentBet = 0; this.minRaise = this.bigBlind;
    this.isActualShowdown = false; this.pending.clear(); this.actedAtBet.clear();
    this.dealerSeat = (participants.find(p => p.seatIndex > this.dealerSeat) || participants[0]).seatIndex;
    this.dealerIndex = participants.findIndex(p => p.seatIndex === this.dealerSeat);
    for (const p of participants) { p.status = 'active'; p.holeCards = this.deck.dealMultiple(2); }
    this.phase = 'pre_flop'; this.handId++; this.currentRound++; this.touch();
    const n = participants.length;
    const sb = n === 2 ? this.dealerIndex : (this.dealerIndex + 1) % n;
    const bb = (sb + 1) % n;
    this.sbSeatIndex = participants[sb].seatIndex; this.bbSeatIndex = participants[bb].seatIndex;
    this.commit(participants[sb], Math.min(this.smallBlind, participants[sb].chips));
    this.commit(participants[bb], Math.min(this.bigBlind, participants[bb].chips));
    this.currentBet = this.bigBlind;
    this.roundHistory.push({ type: 'blinds', smallBlind: { playerId: participants[sb].id, amount: participants[sb].currentBet }, bigBlind: { playerId: participants[bb].id, amount: participants[bb].currentBet } });
    this.pending = new Set(this.activePlayers.map(p => p.id));
    this.progress(bb);
    return true;
  }
  commit(p, amount) {
    p.chips -= amount; p.currentBet += amount; p.totalBetThisRound += amount; this.pot += amount;
    if (p.chips === 0) p.status = 'all_in';
  }
  getCurrentPlayer() { return this.isLive ? this.players.get(this.seatOrder[this.currentPlayerIndex]) || null : null; }
  getTurnTimeRemaining() { return this.turnStartTime === null ? 0 : Math.max(0, this.turnTimeLimit - Math.floor((Date.now() - this.turnStartTime) / 1000)); }
  callAmount(p) {
    let target = this.currentBet;
    if (this.activePlayers.length === 1) target = Math.min(target, Math.max(0, ...this.activeAndAllInPlayers.filter(q => q.id !== p.id).map(q => q.currentBet)));
    return Math.min(p.chips, Math.max(0, target - p.currentBet));
  }
  canRaise(p) {
    if (this.activePlayers.length < 2 || p.chips <= this.currentBet - p.currentBet) return false;
    const previous = this.actedAtBet.get(p.id);
    return previous === undefined || previous === 0 || this.currentBet - previous >= this.minRaise;
  }
  raiseBounds(p) {
    return { min: Math.max(this.bigBlind, this.currentBet + (this.currentBet >= this.bigBlind ? this.minRaise : 0)), max: p.currentBet + p.chips };
  }
  getAvailableActions(id) {
    const p = this.players.get(id);
    if (!this.isLive || !p || p.status !== 'active' || this.getCurrentPlayer()?.id !== id || !p.isConnected) return [];
    const call = this.callAmount(p), actions = ['fold', call > 0 ? 'call' : 'check'];
    if (this.canRaise(p) && this.raiseBounds(p).max >= this.raiseBounds(p).min) actions.push('raise');
    if (p.chips <= call || this.canRaise(p)) actions.push('allin');
    return actions;
  }
  playerAction(id, action, amount = 0, expectedTurn = null) {
    if (!this.isLive) return fail('本手已结束或尚未开始');
    if (expectedTurn !== null && expectedTurn !== this.turnId) return fail('牌局已更新，请按当前牌局操作');
    const p = this.players.get(id);
    if (!p || this.getCurrentPlayer()?.id !== id) return fail('还没轮到你');
    if (p.status !== 'active') return fail('你已经弃牌或全下');
    const available = this.getAvailableActions(id);
    if (!available.includes(action)) return fail('当前不能执行此操作');
    const beforeBet = this.currentBet, beforePhase = this.phase, beforePot = this.pot;
    let paid = 0;
    if (action === 'raise') {
      // The wire amount remains the increment above the table's current bet.
      if (!Number.isSafeInteger(amount) || amount <= 0) return fail('加注金额必须为正整数');
      const target = beforeBet + amount, bounds = this.raiseBounds(p);
      if (target < bounds.min || target > bounds.max) return fail(`加注到 ${bounds.min}–${bounds.max} 之间`);
      paid = target - p.currentBet;
    } else if (action === 'call') paid = this.callAmount(p);
    else if (action === 'allin') paid = p.chips;
    if (action === 'fold') p.status = 'folded';
    else if (paid) this.commit(p, paid);
    this.pending.delete(id); this.actedAtBet.set(id, Math.max(beforeBet, p.currentBet));
    if (p.currentBet > beforeBet) {
      const increase = p.currentBet - beforeBet;
      const fullRaise = beforeBet < this.bigBlind ? p.currentBet >= this.bigBlind : increase >= this.minRaise;
      this.currentBet = p.currentBet;
      if (fullRaise) this.minRaise = beforeBet < this.bigBlind ? p.currentBet : increase;
      for (const q of this.activePlayers) if (q.id !== id && q.currentBet < this.currentBet) this.pending.add(q.id);
    }
    this.roundHistory.push({ type: 'action', handId: this.handId, phase: beforePhase, playerId: id, playerName: p.name, action, amount: paid, betBefore: beforeBet, betTo: p.currentBet, potBefore: beforePot });
    this.touch(); this.progress(this.currentPlayerIndex);
    return { success: true, action, amount: paid, phaseChanged: this.phase !== beforePhase, newPhase: this.phase, roundEnded: this.phase === 'showdown' };
  }
  handleTimeout() {
    const p = this.getCurrentPlayer(); if (!p) return null;
    return this.playerAction(p.id, this.callAmount(p) === 0 ? 'check' : 'fold');
  }
  progress(fromIndex) {
    // All automatic transitions are synchronous; the server schedules only the next actor.
    for (let guard = 0; guard < 100 && this.isLive; guard++) {
      const live = this.activeAndAllInPlayers, active = this.activePlayers;
      if (live.length <= 1) { this.endRound(); return; }
      if (!active.length || (active.length === 1 && this.callAmount(active[0]) === 0)) { this.runOut(); return; }
      for (const id of this.pending) if (!active.some(p => p.id === id)) this.pending.delete(id);
      if (!this.pending.size) {
        if (active.some(p => p.currentBet < this.currentBet)) throw new Error('Unmatched bet without pending action');
        if (this.phase === 'river') { this.endRound(); return; }
        this.advanceStreet(); fromIndex = this.dealerIndex; continue;
      }
      const n = this.seatOrder.length;
      let p;
      for (let i = 1; i <= n; i++) {
        const idx = ((fromIndex + i) % n + n) % n;
        if (this.pending.has(this.seatOrder[idx])) { this.currentPlayerIndex = idx; p = this.players.get(this.seatOrder[idx]); break; }
      }
      if (!p) throw new Error('Pending action has no seated player');
      if (!p.isConnected || p.departed) {
        const action = this.callAmount(p) === 0 ? 'check' : 'fold';
        if (action === 'fold') p.status = 'folded';
        this.pending.delete(p.id); this.actedAtBet.set(p.id, this.currentBet);
        this.roundHistory.push({ type: 'action', handId: this.handId, phase: this.phase, playerId: p.id, playerName: p.name, action, amount: 0, automatic: true, potBefore: this.pot });
        this.touch(); fromIndex = this.currentPlayerIndex; continue;
      }
      this.turnStartTime = Date.now(); return;
    }
    if (this.isLive) throw new Error('Automatic transition limit reached');
  }
  advanceStreet() {
    for (const id of this.seatOrder) this.players.get(id).currentBet = 0;
    this.currentBet = 0; this.minRaise = this.bigBlind; this.actedAtBet.clear();
    if (this.phase === 'pre_flop') { this.phase = 'flop'; this.communityCards.push(...this.deck.dealMultiple(3)); }
    else if (this.phase === 'flop') { this.phase = 'turn'; this.communityCards.push(this.deck.deal()); }
    else if (this.phase === 'turn') { this.phase = 'river'; this.communityCards.push(this.deck.deal()); }
    this.pending = new Set(this.activePlayers.map(p => p.id)); this.touch();
  }
  runOut() {
    while (this.communityCards.length < 5) this.communityCards.push(this.deck.deal());
    this.endRound();
  }
  endRound() {
    if (!this.isLive) return this.lastResults; // Exactly once, even after duplicate callbacks.
    const remaining = this.activeAndAllInPlayers;
    if (!remaining.length) throw new Error('No contender to settle');
    const contributors = this.seatOrder.map(id => this.players.get(id));
    this.isActualShowdown = remaining.length > 1;
    if (this.isActualShowdown && this.communityCards.length !== 5) throw new Error('Incomplete showdown board');
    const results = new Map(remaining.map(p => {
      const hand = this.isActualShowdown ? evaluateBestHand([...p.holeCards, ...this.communityCards]) : null;
      return [p.id, { playerId: p.id, playerName: p.name, seatIndex: p.seatIndex, winAmount: 0, returnedAmount: 0,
        hand: hand ? { ...hand, cards: hand.cards.map(cardJSON) } : null, handName: hand?.name || '其他玩家弃牌',
        holeCards: this.isActualShowdown ? p.holeCards.map(cardJSON) : [] }];
    }));
    this.lastPot = this.pot; this.sidePots = [];
    const levels = [...new Set(contributors.map(p => p.totalBetThisRound).filter(v => v > 0))].sort((a, b) => a - b);
    let previous = 0;
    for (const level of levels) {
      const payers = contributors.filter(p => p.totalBetThisRound >= level);
      const amount = (level - previous) * payers.length; previous = level;
      if (payers.length === 1) {
        const p = payers[0]; p.chips += amount; this.pot -= amount;
        if (!results.has(p.id)) results.set(p.id, { playerId: p.id, playerName: p.name, seatIndex: p.seatIndex, winAmount: 0, returnedAmount: 0, hand: null, handName: '未被跟注部分退回', holeCards: [] });
        results.get(p.id).returnedAmount += amount; continue;
      }
      let eligible = remaining.filter(p => p.totalBetThisRound >= level);
      if (!eligible.length || remaining.length === 1) eligible = remaining;
      const best = eligible.reduce((a, p) => !a || (this.isActualShowdown && compareHands(results.get(p.id).hand, results.get(a.id).hand) > 0) ? p : a, null);
      const winners = eligible.filter(p => !this.isActualShowdown || compareHands(results.get(p.id).hand, results.get(best.id).hand) === 0)
        .sort((a, b) => ((a.seatIndex - this.dealerSeat + MAX_PLAYERS - 1) % MAX_PLAYERS) - ((b.seatIndex - this.dealerSeat + MAX_PLAYERS - 1) % MAX_PLAYERS));
      const each = Math.floor(amount / winners.length), odd = amount % winners.length;
      const awards = winners.map((p, i) => { const won = each + (i < odd ? 1 : 0); p.chips += won; results.get(p.id).winAmount += won; return { playerId: p.id, amount: won }; });
      this.sidePots.push({ amount, eligiblePlayerIds: eligible.map(p => p.id), awards }); this.pot -= amount;
    }
    if (this.pot !== 0) throw new Error('Settlement did not conserve chips');
    this.lastResults = [...results.values()]; this.phase = 'showdown'; this.pending.clear(); this.currentPlayerIndex = -1; this.turnStartTime = null;
    this.confirmedNextPlayers.clear(); this.touch();
    this.roundHistory.push({ type: 'showdown', results: this.lastResults });
    for (const p of contributors) if (p.departed) this.archivePlayer(p);
    return this.lastResults;
  }
  get confirmationPlayers() { return [...this.players.values()].filter(p => p.isConnected && !p.departed && this.handParticipants.has(p.id)); }
  playerConfirmNext(id) {
    if (this.phase !== 'showdown' || !this.players.has(id)) return fail('当前无法确认下一手');
    this.confirmedNextPlayers.add(id); return { success: true };
  }
  get allConfirmedNext() { return this.phase === 'showdown' && this.confirmationPlayers.every(p => this.confirmedNextPlayers.has(p.id)); }
  playerConfirmSettlement(id) {
    if (this.phase !== 'settled' || !this.players.has(id)) return fail('当前无法确认总结');
    this.confirmedSettlement.add(id); return { success: true };
  }
  get allConfirmedSettlement() { return this.phase === 'settled' && [...this.players.values()].filter(p => p.isConnected && !p.departed).every(p => this.confirmedSettlement.has(p.id)); }
  prepareNextRound() {
    if (!this.allConfirmedNext) return false;
    if (this.currentRound >= this.maxRounds) { this.phase = 'settled'; this.confirmedSettlement.clear(); this.touch(); return false; }
    return true;
  }
  playerRebuy(id) {
    if (this.isLive || this.phase === 'settled') return fail('请在两手之间重购');
    const p = this.players.get(id); if (!p || p.chips > 0) return fail('当前无需重购');
    p.chips = 1000; p.totalBuyIn += 1000; p.isReady = true;
    return { success: true, amount: 1000 };
  }
  getSettlement() {
    return [...this.departedPlayers.values(), ...[...this.players.values()].map(p => ({ id: p.id, name: p.name, seatIndex: p.seatIndex, finalChips: p.chips, totalBuyIn: p.totalBuyIn, profit: p.chips - p.totalBuyIn }))].sort((a, b) => b.profit - a.profit);
  }
  restartGame() {
    if (this.phase !== 'settled' || !this.allConfirmedSettlement) return fail('需全员确认总结后再开始');
    this.phase = 'waiting'; this.currentRound = 0; this.isGameStarted = false; this.dealerSeat = -1; this.dealerIndex = -1;
    this.communityCards = []; this.pot = 0; this.lastPot = 0; this.lastResults = null; this.sidePots = []; this.roundHistory = [];
    this.currentBet = 0; this.minRaise = this.bigBlind; this.pending.clear(); this.actedAtBet.clear(); this.seatOrder = []; this.handParticipants.clear();
    this.confirmedNextPlayers.clear(); this.confirmedSettlement.clear(); this.departedPlayers.clear(); this.turnStartTime = null;
    this.sbSeatIndex = -1; this.bbSeatIndex = -1;
    for (const p of this.players.values()) { p.chips = 1000; p.totalBuyIn = 1000; p.isReady = p.isBot; p.reset(); }
    this.touch(); return { success: true };
  }
  getState(forPlayerId = null) {
    const me = this.players.get(forPlayerId), showdown = ['showdown', 'settled'].includes(this.phase);
    const players = [...this.players.values()].filter(p => !p.departed).map(p => ({
      ...p.toJSON(p.id === forPlayerId || (showdown && this.isActualShowdown && ['active', 'all_in'].includes(p.status))),
      confirmedNext: this.confirmedNextPlayers.has(p.id), confirmedSettlement: this.confirmedSettlement.has(p.id),
    }));
    const bounds = me ? this.raiseBounds(me) : { min: 0, max: 0 };
    return {
      protocolVersion: 2, roomId: this.roomId, youId: forPlayerId, hostPlayerId: this.hostPlayerId, handId: this.handId, revision: this.revision, turnId: this.turnId,
      phase: this.phase, players, communityCards: this.communityCards.map(cardJSON), pot: showdown ? this.lastPot : this.pot, potAwarded: showdown, sidePots: showdown ? this.sidePots : [],
      currentBet: this.currentBet, dealerIndex: this.dealerIndex, dealerSeat: this.dealerSeat, sbSeat: this.sbSeatIndex, bbSeat: this.bbSeatIndex,
      currentPlayerId: this.getCurrentPlayer()?.id || null, currentPlayerSeat: this.getCurrentPlayer()?.seatIndex ?? -1,
      smallBlind: this.smallBlind, bigBlind: this.bigBlind, availableActions: this.getAvailableActions(forPlayerId),
      minRaise: Math.max(0, bounds.min - this.currentBet), minRaiseTo: bounds.min, maxRaiseTo: bounds.max, callAmount: me ? this.callAmount(me) : 0,
      lastResults: showdown ? this.lastResults : null, playerCount: this.playerCount, maxPlayers: MAX_PLAYERS,
      currentRound: this.currentRound, maxRounds: this.maxRounds, isGameStarted: this.isGameStarted,
      turnTimeRemaining: this.getTurnTimeRemaining(), turnTimeLimit: this.turnTimeLimit,
      settlement: this.phase === 'settled' ? this.getSettlement() : null,
      canRebuy: !!me && me.chips === 0 && ['waiting', 'showdown'].includes(this.phase),
      confirmedCount: this.confirmationPlayers.filter(p => this.confirmedNextPlayers.has(p.id)).length, totalPlayerCount: this.confirmationPlayers.length,
      confirmedSettlement: [...this.confirmedSettlement], allConfirmedSettlement: this.allConfirmedSettlement, isActualShowdown: this.isActualShowdown,
    };
  }
}
module.exports = { Game, Player, GAME_PHASES, PLAYER_STATUS, MAX_PLAYERS };
