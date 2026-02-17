/**
 * 德州扑克游戏核心逻辑
 * - 20轮制
 * - 重购积分
 * - 2分钟倒计时
 * - 庄家/大盲/小盲位置标记
 */

const { Deck } = require('./deck');
const { evaluateBestHand, determineWinners } = require('./handEvaluator');

const MAX_PLAYERS = 7;
const MAX_ROUNDS = 20;
const INITIAL_CHIPS = 1000;
const REBUY_AMOUNT = 1000;
const ACTION_TIMEOUT = 120; // 2分钟（秒）

const GAME_PHASES = {
  WAITING: 'waiting',
  PRE_FLOP: 'pre_flop',
  FLOP: 'flop',
  TURN: 'turn',
  RIVER: 'river',
  SHOWDOWN: 'showdown',
  SETTLED: 'settled',
};

const PLAYER_STATUS = {
  ACTIVE: 'active',
  FOLDED: 'folded',
  ALL_IN: 'all_in',
  SITTING_OUT: 'sitting_out',
};

class Player {
  constructor(id, name, seatIndex) {
    this.id = id;
    this.name = name;
    this.seatIndex = seatIndex;
    this.chips = INITIAL_CHIPS;
    this.initialChips = INITIAL_CHIPS; // 本局开始时的筹码（用于结算）
    this.totalBuyIn = INITIAL_CHIPS; // 总买入
    this.holeCards = [];
    this.currentBet = 0;
    this.totalBetThisRound = 0;
    this.status = PLAYER_STATUS.ACTIVE;
    this.isReady = false;
    this.isConnected = true;
  }

  reset() {
    this.holeCards = [];
    this.currentBet = 0;
    this.totalBetThisRound = 0;
    if (this.chips > 0) {
      this.status = PLAYER_STATUS.ACTIVE;
    } else {
      this.status = PLAYER_STATUS.SITTING_OUT;
    }
  }

  rebuy() {
    if (this.chips > 0) return { success: false, message: '还有筹码，无需重购' };
    this.chips = REBUY_AMOUNT;
    this.totalBuyIn += REBUY_AMOUNT;
    this.status = PLAYER_STATUS.ACTIVE;
    return { success: true, amount: REBUY_AMOUNT };
  }

  toJSON(revealCards = false) {
    return {
      id: this.id,
      name: this.name,
      seatIndex: this.seatIndex,
      chips: this.chips,
      holeCards: revealCards ? this.holeCards : this.holeCards.map(() => null),
      currentBet: this.currentBet,
      status: this.status,
      isReady: this.isReady,
      isConnected: this.isConnected,
      totalBuyIn: this.totalBuyIn,
    };
  }
}

class Game {
  constructor(roomId) {
    this.roomId = roomId;
    this.players = new Map();
    this.seatOrder = [];
    this.deck = new Deck();
    this.communityCards = [];
    this.pot = 0;
    this.sidePots = [];
    this.phase = GAME_PHASES.WAITING;
    this.dealerIndex = -1;
    this.currentPlayerIndex = -1;
    this.smallBlind = 10;
    this.bigBlind = 20;
    this.currentBet = 0;
    this.minRaise = 0;
    this.lastRaiserIndex = -1;
    this.roundHistory = [];

    // 20轮制
    this.currentRound = 0;
    this.maxRounds = MAX_ROUNDS;
    this.isGameStarted = false; // 整场比赛是否已开始

    // 倒计时
    this.turnStartTime = null;
    this.turnTimeLimit = ACTION_TIMEOUT;

    // 位置标记
    this.sbSeatIndex = -1;
    this.bbSeatIndex = -1;
  }

  get playerCount() {
    return this.players.size;
  }

  get activePlayers() {
    return this.seatOrder
      .map(id => this.players.get(id))
      .filter(p => p && p.status === PLAYER_STATUS.ACTIVE);
  }

  get activeAndAllInPlayers() {
    return this.seatOrder
      .map(id => this.players.get(id))
      .filter(p => p && (p.status === PLAYER_STATUS.ACTIVE || p.status === PLAYER_STATUS.ALL_IN));
  }

  addPlayer(id, name) {
    if (this.players.size >= MAX_PLAYERS) {
      return { success: false, message: '房间已满（最多7人）' };
    }
    if (this.players.has(id)) {
      return { success: false, message: '已在房间中' };
    }

    const takenSeats = new Set([...this.players.values()].map(p => p.seatIndex));
    let seatIndex = -1;
    for (let i = 0; i < MAX_PLAYERS; i++) {
      if (!takenSeats.has(i)) {
        seatIndex = i;
        break;
      }
    }

    const player = new Player(id, name, seatIndex);
    this.players.set(id, player);
    this.seatOrder.push(id);
    this.seatOrder.sort((a, b) => {
      return this.players.get(a).seatIndex - this.players.get(b).seatIndex;
    });

    return { success: true, player, seatIndex };
  }

  removePlayer(id) {
    const player = this.players.get(id);
    if (!player) return;

    this.players.delete(id);
    this.seatOrder = this.seatOrder.filter(pid => pid !== id);

    if (this.phase !== GAME_PHASES.WAITING && this.phase !== GAME_PHASES.SETTLED) {
      if (this.activeAndAllInPlayers.length <= 1) {
        this.endRound();
      } else if (this.currentPlayerIndex >= this.seatOrder.length) {
        this.currentPlayerIndex = 0;
        this.nextPlayer();
      } else if (this.seatOrder[this.currentPlayerIndex] === id) {
        this.nextPlayer();
      }
    }

    return player;
  }

  setPlayerReady(id, ready) {
    const player = this.players.get(id);
    if (!player) return false;
    player.isReady = ready;
    return true;
  }

  canStartGame() {
    const readyPlayers = [...this.players.values()].filter(p => p.isReady && p.chips > 0);
    return readyPlayers.length >= 2 && this.phase === GAME_PHASES.WAITING;
  }

  // 开始一轮
  startRound() {
    this.deck.reset();
    this.communityCards = [];
    this.pot = 0;
    this.sidePots = [];
    this.currentBet = 0;
    this.roundHistory = [];
    this.lastResults = null;

    // 有筹码的玩家参与
    this.seatOrder = [...this.players.values()]
      .filter(p => p.chips > 0)
      .sort((a, b) => a.seatIndex - b.seatIndex)
      .map(p => p.id);

    if (this.seatOrder.length < 2) return false;

    for (const id of this.seatOrder) {
      this.players.get(id).reset();
    }

    // 移动庄家位
    this.dealerIndex = (this.dealerIndex + 1) % this.seatOrder.length;

    // 发底牌
    for (const id of this.seatOrder) {
      const player = this.players.get(id);
      if (player.status !== PLAYER_STATUS.SITTING_OUT) {
        player.holeCards = this.deck.dealMultiple(2);
      }
    }

    this.postBlinds();
    this.phase = GAME_PHASES.PRE_FLOP;
    this.currentRound++;
    this.turnStartTime = Date.now();

    return true;
  }

  // 首次开始整场比赛
  startGame() {
    if (!this.canStartGame()) return false;
    this.isGameStarted = true;
    this.currentRound = 0;
    this.dealerIndex = -1;

    // 重置所有玩家的买入记录
    for (const [, player] of this.players) {
      player.totalBuyIn = player.chips;
    }

    return this.startRound();
  }

  postBlinds() {
    const numPlayers = this.seatOrder.length;
    let sbIndex, bbIndex;

    if (numPlayers === 2) {
      sbIndex = this.dealerIndex;
      bbIndex = (this.dealerIndex + 1) % numPlayers;
    } else {
      sbIndex = (this.dealerIndex + 1) % numPlayers;
      bbIndex = (this.dealerIndex + 2) % numPlayers;
    }

    const sbPlayer = this.players.get(this.seatOrder[sbIndex]);
    const bbPlayer = this.players.get(this.seatOrder[bbIndex]);

    this.sbSeatIndex = sbPlayer.seatIndex;
    this.bbSeatIndex = bbPlayer.seatIndex;

    const sbAmount = Math.min(this.smallBlind, sbPlayer.chips);
    sbPlayer.chips -= sbAmount;
    sbPlayer.currentBet = sbAmount;
    sbPlayer.totalBetThisRound = sbAmount;
    this.pot += sbAmount;
    if (sbPlayer.chips === 0) sbPlayer.status = PLAYER_STATUS.ALL_IN;

    const bbAmount = Math.min(this.bigBlind, bbPlayer.chips);
    bbPlayer.chips -= bbAmount;
    bbPlayer.currentBet = bbAmount;
    bbPlayer.totalBetThisRound = bbAmount;
    this.pot += bbAmount;
    if (bbPlayer.chips === 0) bbPlayer.status = PLAYER_STATUS.ALL_IN;

    this.currentBet = this.bigBlind;
    this.minRaise = this.bigBlind;

    if (numPlayers === 2) {
      this.currentPlayerIndex = sbIndex;
    } else {
      this.currentPlayerIndex = (bbIndex + 1) % numPlayers;
    }
    this.lastRaiserIndex = bbIndex;

    this.roundHistory.push({
      type: 'blinds',
      smallBlind: { playerId: sbPlayer.id, amount: sbAmount },
      bigBlind: { playerId: bbPlayer.id, amount: bbAmount },
    });
  }

  getCurrentPlayer() {
    if (this.currentPlayerIndex < 0 || this.currentPlayerIndex >= this.seatOrder.length) {
      return null;
    }
    return this.players.get(this.seatOrder[this.currentPlayerIndex]);
  }

  // 获取当前玩家剩余秒数
  getTurnTimeRemaining() {
    if (!this.turnStartTime) return this.turnTimeLimit;
    const elapsed = Math.floor((Date.now() - this.turnStartTime) / 1000);
    return Math.max(0, this.turnTimeLimit - elapsed);
  }

  // 超时自动弃牌
  handleTimeout() {
    const player = this.getCurrentPlayer();
    if (!player) return null;
    return this.playerAction(player.id, 'fold');
  }

  playerAction(playerId, action, amount = 0) {
    const player = this.players.get(playerId);
    if (!player) return { success: false, message: '玩家不存在' };

    const currentPlayer = this.getCurrentPlayer();
    if (!currentPlayer || currentPlayer.id !== playerId) {
      return { success: false, message: '还没轮到你' };
    }

    if (player.status !== PLAYER_STATUS.ACTIVE) {
      return { success: false, message: '你已经弃牌或全下' };
    }

    let result;

    switch (action) {
      case 'fold':
        result = this.fold(player);
        break;
      case 'check':
        result = this.check(player);
        break;
      case 'call':
        result = this.call(player);
        break;
      case 'raise':
        result = this.raise(player, amount);
        break;
      case 'allin':
        result = this.allIn(player);
        break;
      default:
        return { success: false, message: '无效操作' };
    }

    if (result.success) {
      this.roundHistory.push({
        type: 'action',
        playerId: player.id,
        playerName: player.name,
        action,
        amount: result.amount || 0,
      });

      if (this.activeAndAllInPlayers.length <= 1) {
        this.endRound();
        return { ...result, roundEnded: true };
      }

      if (this.isBettingRoundComplete()) {
        this.advancePhase();
        return { ...result, phaseChanged: true, newPhase: this.phase };
      }

      this.nextPlayer();
      this.turnStartTime = Date.now(); // 重置倒计时
    }

    return result;
  }

  fold(player) {
    player.status = PLAYER_STATUS.FOLDED;
    return { success: true, action: 'fold' };
  }

  check(player) {
    if (player.currentBet < this.currentBet) {
      return { success: false, message: '你需要跟注或弃牌' };
    }
    return { success: true, action: 'check' };
  }

  call(player) {
    const callAmount = Math.min(this.currentBet - player.currentBet, player.chips);
    player.chips -= callAmount;
    player.currentBet += callAmount;
    player.totalBetThisRound += callAmount;
    this.pot += callAmount;
    if (player.chips === 0) player.status = PLAYER_STATUS.ALL_IN;
    return { success: true, action: 'call', amount: callAmount };
  }

  raise(player, amount) {
    const totalToCall = this.currentBet - player.currentBet;
    const totalAmount = totalToCall + amount;

    if (amount < this.minRaise && player.chips > totalAmount) {
      return { success: false, message: `加注至少 ${this.minRaise}` };
    }
    if (totalAmount > player.chips) {
      return { success: false, message: '筹码不足' };
    }

    player.chips -= totalAmount;
    player.currentBet += totalAmount;
    player.totalBetThisRound += totalAmount;
    this.pot += totalAmount;
    this.currentBet = player.currentBet;
    this.minRaise = Math.max(this.minRaise, amount);
    this.lastRaiserIndex = this.currentPlayerIndex;
    if (player.chips === 0) player.status = PLAYER_STATUS.ALL_IN;
    return { success: true, action: 'raise', amount: totalAmount };
  }

  allIn(player) {
    const allInAmount = player.chips;
    player.currentBet += allInAmount;
    player.totalBetThisRound += allInAmount;
    this.pot += allInAmount;
    player.chips = 0;
    player.status = PLAYER_STATUS.ALL_IN;

    if (player.currentBet > this.currentBet) {
      const raiseBy = player.currentBet - this.currentBet;
      this.minRaise = Math.max(this.minRaise, raiseBy);
      this.currentBet = player.currentBet;
      this.lastRaiserIndex = this.currentPlayerIndex;
    }
    return { success: true, action: 'allin', amount: allInAmount };
  }

  nextPlayer() {
    const numPlayers = this.seatOrder.length;
    let nextIndex = (this.currentPlayerIndex + 1) % numPlayers;
    let checked = 0;
    while (checked < numPlayers) {
      const player = this.players.get(this.seatOrder[nextIndex]);
      if (player && player.status === PLAYER_STATUS.ACTIVE) {
        this.currentPlayerIndex = nextIndex;
        return;
      }
      nextIndex = (nextIndex + 1) % numPlayers;
      checked++;
    }
  }

  isBettingRoundComplete() {
    const activePlayers = this.activePlayers;
    if (activePlayers.length === 0) return true;
    const allBetsEqual = activePlayers.every(p => p.currentBet === this.currentBet);
    if (!allBetsEqual) return false;
    const nextIndex = this.findNextActivePlayerIndex(this.currentPlayerIndex);
    return nextIndex === this.lastRaiserIndex || nextIndex === -1;
  }

  findNextActivePlayerIndex(fromIndex) {
    const numPlayers = this.seatOrder.length;
    let nextIndex = (fromIndex + 1) % numPlayers;
    let checked = 0;
    while (checked < numPlayers) {
      const player = this.players.get(this.seatOrder[nextIndex]);
      if (player && player.status === PLAYER_STATUS.ACTIVE) {
        return nextIndex;
      }
      nextIndex = (nextIndex + 1) % numPlayers;
      checked++;
    }
    return -1;
  }

  advancePhase() {
    for (const id of this.seatOrder) {
      const player = this.players.get(id);
      if (player) player.currentBet = 0;
    }
    this.currentBet = 0;
    this.minRaise = this.bigBlind;

    switch (this.phase) {
      case GAME_PHASES.PRE_FLOP:
        this.phase = GAME_PHASES.FLOP;
        this.communityCards.push(...this.deck.dealMultiple(3));
        break;
      case GAME_PHASES.FLOP:
        this.phase = GAME_PHASES.TURN;
        this.communityCards.push(this.deck.deal());
        break;
      case GAME_PHASES.TURN:
        this.phase = GAME_PHASES.RIVER;
        this.communityCards.push(this.deck.deal());
        break;
      case GAME_PHASES.RIVER:
        this.phase = GAME_PHASES.SHOWDOWN;
        this.endRound();
        return;
    }

    const numPlayers = this.seatOrder.length;
    let startIdx = (this.dealerIndex + 1) % numPlayers;
    let found = false;
    for (let i = 0; i < numPlayers; i++) {
      const idx = (startIdx + i) % numPlayers;
      const player = this.players.get(this.seatOrder[idx]);
      if (player && player.status === PLAYER_STATUS.ACTIVE) {
        this.currentPlayerIndex = idx;
        this.lastRaiserIndex = idx;
        found = true;
        break;
      }
    }

    if (!found) {
      this.advancePhase();
    } else {
      this.turnStartTime = Date.now();
    }
  }

  endRound() {
    this.phase = GAME_PHASES.SHOWDOWN;
    this.turnStartTime = null;
    const remaining = this.activeAndAllInPlayers;

    let results;
    if (remaining.length === 1) {
      const winner = remaining[0];
      winner.chips += this.pot;
      results = [{
        playerId: winner.id,
        playerName: winner.name,
        winAmount: this.pot,
        hand: null,
        handName: '其他玩家弃牌',
      }];
    } else {
      results = this.calculateWinnings(remaining);
    }

    this.roundHistory.push({ type: 'showdown', results });
    this.lastResults = results;
    this.lastCommunityCards = [...this.communityCards];

    return results;
  }

  calculateWinnings(contenders) {
    const results = [];
    const evaluatedPlayers = contenders.map(p => {
      const allCards = [...p.holeCards, ...this.communityCards];
      const hand = evaluateBestHand(allCards);
      return { ...p, hand, allCards };
    });

    const winners = determineWinners(
      evaluatedPlayers.map(p => ({
        id: p.id,
        cards: [...p.holeCards, ...this.communityCards],
      }))
    );

    const winnerIds = new Set(winners.map(w => w.id));
    const winAmount = Math.floor(this.pot / winners.length);
    const remainder = this.pot - winAmount * winners.length;

    for (const ep of evaluatedPlayers) {
      const player = this.players.get(ep.id);
      let amount = 0;
      if (winnerIds.has(ep.id)) {
        amount = winAmount;
        if (ep.id === winners[0].id) amount += remainder;
        player.chips += amount;
      }

      results.push({
        playerId: ep.id,
        playerName: ep.name,
        winAmount: amount,
        hand: ep.hand,
        handName: ep.hand.name,
        holeCards: ep.holeCards,
      });
    }

    return results;
  }

  // 准备下一轮（不需要手动准备）
  prepareNextRound() {
    if (this.currentRound >= this.maxRounds) {
      this.phase = GAME_PHASES.SETTLED;
      return false;
    }

    this.communityCards = [];
    this.pot = 0;
    this.sidePots = [];
    this.currentBet = 0;
    this.currentPlayerIndex = -1;
    this.lastResults = null;
    this.sbSeatIndex = -1;
    this.bbSeatIndex = -1;

    for (const [, player] of this.players) {
      player.reset();
      player.isReady = true; // 自动准备
    }

    return true;
  }

  // 重购积分
  playerRebuy(playerId) {
    const player = this.players.get(playerId);
    if (!player) return { success: false, message: '玩家不存在' };
    return player.rebuy();
  }

  // 获取结算数据
  getSettlement() {
    const settlement = [];
    for (const [, player] of this.players) {
      const profit = player.chips - player.totalBuyIn;
      settlement.push({
        id: player.id,
        name: player.name,
        seatIndex: player.seatIndex,
        finalChips: player.chips,
        totalBuyIn: player.totalBuyIn,
        profit,
      });
    }
    settlement.sort((a, b) => b.profit - a.profit);
    return settlement;
  }

  // 重新开始整场比赛
  restartGame() {
    this.currentRound = 0;
    this.dealerIndex = -1;
    this.isGameStarted = false;
    this.phase = GAME_PHASES.WAITING;
    this.communityCards = [];
    this.pot = 0;
    this.lastResults = null;
    this.sbSeatIndex = -1;
    this.bbSeatIndex = -1;

    for (const [, player] of this.players) {
      player.chips = INITIAL_CHIPS;
      player.totalBuyIn = INITIAL_CHIPS;
      player.holeCards = [];
      player.currentBet = 0;
      player.totalBetThisRound = 0;
      player.status = PLAYER_STATUS.ACTIVE;
      player.isReady = false;
    }
  }

  getAvailableActions(playerId) {
    const player = this.players.get(playerId);
    if (!player || player.status !== PLAYER_STATUS.ACTIVE) return [];

    const currentPlayer = this.getCurrentPlayer();
    if (!currentPlayer || currentPlayer.id !== playerId) return [];

    const actions = ['fold'];
    const callAmount = this.currentBet - player.currentBet;

    if (callAmount === 0) {
      actions.push('check');
    } else {
      actions.push('call');
    }

    if (player.chips > callAmount) {
      actions.push('raise');
    }

    actions.push('allin');
    return actions;
  }

  getState(forPlayerId = null) {
    const players = [];
    for (const [id, player] of this.players) {
      const isShowdown = this.phase === GAME_PHASES.SHOWDOWN;
      const isSelf = id === forPlayerId;
      const revealCards = isSelf || isShowdown;
      players.push(player.toJSON(revealCards));
    }

    const currentPlayer = this.getCurrentPlayer();
    const dealerPlayer = this.seatOrder.length > 0
      ? this.players.get(this.seatOrder[this.dealerIndex])
      : null;

    return {
      roomId: this.roomId,
      phase: this.phase,
      players,
      communityCards: this.communityCards.map(c => c.toJSON()),
      pot: this.pot,
      currentBet: this.currentBet,
      dealerIndex: this.dealerIndex,
      dealerSeat: dealerPlayer?.seatIndex ?? -1,
      sbSeat: this.sbSeatIndex,
      bbSeat: this.bbSeatIndex,
      currentPlayerId: currentPlayer?.id || null,
      currentPlayerSeat: currentPlayer?.seatIndex ?? -1,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      availableActions: forPlayerId ? this.getAvailableActions(forPlayerId) : [],
      minRaise: this.minRaise,
      callAmount: forPlayerId
        ? Math.max(0, this.currentBet - (this.players.get(forPlayerId)?.currentBet || 0))
        : 0,
      lastResults: this.lastResults || null,
      playerCount: this.players.size,
      maxPlayers: MAX_PLAYERS,
      currentRound: this.currentRound,
      maxRounds: this.maxRounds,
      isGameStarted: this.isGameStarted,
      turnTimeRemaining: this.getTurnTimeRemaining(),
      turnTimeLimit: this.turnTimeLimit,
      settlement: this.phase === GAME_PHASES.SETTLED ? this.getSettlement() : null,
      canRebuy: forPlayerId ? (this.players.get(forPlayerId)?.chips === 0 && this.phase === GAME_PHASES.WAITING) : false,
    };
  }
}

module.exports = { Game, GAME_PHASES, PLAYER_STATUS, MAX_PLAYERS };
