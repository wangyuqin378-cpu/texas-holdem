/**
 * 德州扑克游戏核心逻辑
 * - 20轮制
 * - 重购积分
 * - 2分钟倒计时
 * - 庄家/大盲/小盲位置标记
 * - SHOWDOWN 阶段需全员确认才续局
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
    this.initialChips = INITIAL_CHIPS;
    this.totalBuyIn = INITIAL_CHIPS;
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
    this.isGameStarted = false;

    // 倒计时
    this.turnStartTime = null;
    this.turnTimeLimit = ACTION_TIMEOUT;

    // 位置标记
    this.sbSeatIndex = -1;
    this.bbSeatIndex = -1;

    // SHOWDOWN 确认续局
    // SETTLED 阶段确认总结
    this.confirmedSettlement = new Set();

    this.confirmedNextPlayers = new Set();

    // 是否为实际摊牌（多人对决，非全员弃牌）
    this.isActualShowdown = false;
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

  // 标记玩家断线（不移除）
  markDisconnected(id) {
    const player = this.players.get(id);
    if (!player) return null;
    player.isConnected = false;

    // 如果在游戏中且轮到该玩家，自动弃牌
    if (this.phase !== GAME_PHASES.WAITING && this.phase !== GAME_PHASES.SETTLED && this.phase !== GAME_PHASES.SHOWDOWN) {
      if (this.seatOrder[this.currentPlayerIndex] === id && player.status === PLAYER_STATUS.ACTIVE) {
        player.status = PLAYER_STATUS.FOLDED;
        this.roundHistory.push({ type: 'action', playerId: id, playerName: player.name, action: 'fold', amount: 0 });
        if (this.activeAndAllInPlayers.length <= 1) {
          this.endRound();
          return { player, roundEnded: true };
        }
        this.nextPlayer();
      }
    }

    // SHOWDOWN 阶段，断线玩家自动确认
    if (this.phase === GAME_PHASES.SHOWDOWN) {
      this.confirmedNextPlayers.add(id);
    }

    // SETTLED 阶段，断线玩家自动确认
    if (this.phase === GAME_PHASES.SETTLED) {
      this.confirmedSettlement.add(id);
    }

    return { player, roundEnded: false };
  }

  // 玩家重连（替换 socket ID）
  reconnectPlayer(oldId, newId) {
    const player = this.players.get(oldId);
    if (!player) return null;

    player.id = newId;
    player.isConnected = true;
    this.players.delete(oldId);
    this.players.set(newId, player);
    this.seatOrder = this.seatOrder.map(pid => pid === oldId ? newId : pid);

    // 更新确认状态
    if (this.confirmedNextPlayers.has(oldId)) {
      this.confirmedNextPlayers.delete(oldId);
      this.confirmedNextPlayers.add(newId);
    }

    return player;
  }

  removePlayer(id) {
    const player = this.players.get(id);
    if (!player) return;

    this.players.delete(id);
    this.seatOrder = this.seatOrder.filter(pid => pid !== id);
    this.confirmedNextPlayers.delete(id);
    this.confirmedSettlement.delete(id);

    if (this.phase !== GAME_PHASES.WAITING && this.phase !== GAME_PHASES.SETTLED) {
      if (this.phase === GAME_PHASES.SHOWDOWN) {
        // SHOWDOWN 阶段，玩家离开不需要 endRound，只需更新确认状态
        // 外部会检查 allConfirmed
      } else if (this.activeAndAllInPlayers.length <= 1) {
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
    this.confirmedNextPlayers.clear();

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
    // 设置 lastRaiserIndex 为第一个行动者（UTG），这样 BB 有机会在行动回到 UTG 之前行动
    this.lastRaiserIndex = this.currentPlayerIndex;

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

  getTurnTimeRemaining() {
    if (!this.turnStartTime) return this.turnTimeLimit;
    const elapsed = Math.floor((Date.now() - this.turnStartTime) / 1000);
    return Math.max(0, this.turnTimeLimit - elapsed);
  }

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
        if (this.phase === GAME_PHASES.SHOWDOWN) {
          return { ...result, roundEnded: true };
        }
        return { ...result, phaseChanged: true, newPhase: this.phase };
      }

      this.nextPlayer();
      this.turnStartTime = Date.now();
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
    this.confirmedNextPlayers.clear();
    const remaining = this.activeAndAllInPlayers;

    // 标记是否为实际摊牌（多人对决）
    this.isActualShowdown = remaining.length > 1;

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
    // 计算每个玩家本轮的总投注（包含所有阶段）
    // 使用 totalBetThisRound 来追踪
    const allParticipants = this.seatOrder
      .map(id => this.players.get(id))
      .filter(p => p);

    // 收集每个参与者的总投注
    const playerBets = [];
    for (const p of allParticipants) {
      playerBets.push({ id: p.id, totalBet: p.totalBetThisRound, status: p.status });
    }

    // 计算边池：按总投注额从小到大排序，逐级切分
    const sidePots = this._buildSidePots(playerBets);

    // 评估还在对决中的玩家的牌力
    const evaluatedPlayers = contenders.map(p => {
      const allCards = [...p.holeCards, ...this.communityCards];
      const hand = evaluateBestHand(allCards);
      return { id: p.id, name: p.name, hand, holeCards: p.holeCards };
    });

    // 每个玩家的赢利
    const winnings = {};
    for (const ep of evaluatedPlayers) {
      winnings[ep.id] = 0;
    }

    // 对每个边池分别决定赢家
    for (const pot of sidePots) {
      // 在该边池有资格竞争的玩家 = 在 contenders 中且在 eligible 列表中
      const eligible = evaluatedPlayers.filter(ep => pot.eligible.has(ep.id));
      if (eligible.length === 0) continue;

      // 从有资格的玩家中决出赢家
      const potWinners = determineWinners(
        eligible.map(ep => ({
          id: ep.id,
          cards: [...ep.holeCards, ...this.communityCards],
        }))
      );

      const winPerPlayer = Math.floor(pot.amount / potWinners.length);
      const remainder = pot.amount - winPerPlayer * potWinners.length;

      for (let i = 0; i < potWinners.length; i++) {
        let amt = winPerPlayer;
        if (i === 0) amt += remainder;
        winnings[potWinners[i].id] += amt;
      }
    }

    // 分配筹码并构建结果
    const results = [];
    for (const ep of evaluatedPlayers) {
      const player = this.players.get(ep.id);
      const amount = winnings[ep.id] || 0;
      if (amount > 0) {
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

  /**
   * 构建边池列表
   * 标准算法：按投注额从小到大依次"切"出边池
   * 返回: [{ amount, eligible: Set<playerId> }, ...]
   */
  _buildSidePots(playerBets) {
    // 过滤掉投注为0的（纯旁观者）
    const bets = playerBets
      .filter(pb => pb.totalBet > 0)
      .map(pb => ({ ...pb }));

    if (bets.length === 0) return [];

    // 按总投注额排序
    bets.sort((a, b) => a.totalBet - b.totalBet);

    const pots = [];
    let prevLevel = 0;

    for (let i = 0; i < bets.length; i++) {
      const currentLevel = bets[i].totalBet;
      const diff = currentLevel - prevLevel;

      if (diff > 0) {
        // 从所有投注额 >= currentLevel 的玩家处各收 diff
        const eligible = new Set();
        let potAmount = 0;
        for (const b of bets) {
          if (b.totalBet >= currentLevel) {
            potAmount += diff;
            eligible.add(b.id);
          }
        }
        // 只有未弃牌的玩家才有资格赢
        const activeEligible = new Set();
        for (const id of eligible) {
          const p = this.players.get(id);
          if (p && (p.status === PLAYER_STATUS.ACTIVE || p.status === PLAYER_STATUS.ALL_IN)) {
            activeEligible.add(id);
          }
        }
        // 如果没有活跃玩家有资格，把筹码给投入最多的活跃玩家
        if (activeEligible.size > 0) {
          pots.push({ amount: potAmount, eligible: activeEligible });
        } else {
          // 理论上不会出现，但兜底：给第一个活跃玩家
          const fallback = bets.find(b => {
            const p = this.players.get(b.id);
            return p && (p.status === PLAYER_STATUS.ACTIVE || p.status === PLAYER_STATUS.ALL_IN);
          });
          if (fallback) {
            pots.push({ amount: potAmount, eligible: new Set([fallback.id]) });
          }
        }
      }
      prevLevel = currentLevel;
    }

    return pots;
  }

  // 玩家确认下一局
  playerConfirmNext(playerId) {
    if (this.phase !== GAME_PHASES.SHOWDOWN) {
      return { success: false, message: '当前不在结算阶段' };
    }
    if (!this.players.has(playerId)) {
      return { success: false, message: '玩家不存在' };
    }
    this.confirmedNextPlayers.add(playerId);
    return { success: true };
  }

  // 是否所有人都确认了
  get allConfirmedNext() {
    if (this.phase !== GAME_PHASES.SHOWDOWN) return false;
    for (const [id] of this.players) {
      if (!this.confirmedNextPlayers.has(id)) return false;
    }
    return this.players.size >= 1;
  }

  // 玩家确认总结
  playerConfirmSettlement(playerId) {
    if (this.phase !== GAME_PHASES.SETTLED) {
      return { success: false, message: '当前不在总结阶段' };
    }
    if (!this.players.has(playerId)) {
      return { success: false, message: '玩家不存在' };
    }
    this.confirmedSettlement.add(playerId);
    return { success: true };
  }

  // 检查是否所有人都确认了总结
  get allConfirmedSettlement() {
    if (this.phase !== GAME_PHASES.SETTLED) return false;
    for (const [id] of this.players) {
      if (!this.confirmedSettlement.has(id)) return false;
    }
    return this.players.size >= 1;
  }

  prepareNextRound() {
    if (this.currentRound >= this.maxRounds) {
      this.phase = GAME_PHASES.SETTLED;
      this.confirmedSettlement.clear();
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
    this.confirmedNextPlayers.clear();

    for (const [, player] of this.players) {
      player.reset();
      player.isReady = true;
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
    this.confirmedNextPlayers.clear();
    this.confirmedSettlement.clear();

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
      // 亮牌规则：自己的牌始终可见；摊牌阶段只有实际对决（多人）时才亮牌，且已弃牌的不亮
      const revealCards = isSelf || (isShowdown && this.isActualShowdown && player.status !== PLAYER_STATUS.FOLDED);
      const pJson = player.toJSON(revealCards);
      // 在 SHOWDOWN 时标记该玩家是否已确认下一局
      if (isShowdown) {
        pJson.confirmedNext = this.confirmedNextPlayers.has(id);
      }
      players.push(pJson);
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
      canRebuy: forPlayerId
        ? (this.players.get(forPlayerId)?.chips === 0
          && (this.phase === GAME_PHASES.WAITING || this.phase === GAME_PHASES.SHOWDOWN || this.phase === GAME_PHASES.SETTLED))
        : false,
      confirmedCount: this.confirmedNextPlayers.size,
      totalPlayerCount: this.players.size,
      isActualShowdown: this.isActualShowdown,
    };
  }
}

module.exports = { Game, GAME_PHASES, PLAYER_STATUS, MAX_PLAYERS };
