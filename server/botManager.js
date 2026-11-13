const { randomUUID } = require('node:crypto');
const { BotPlayer, BOT_CONFIGS } = require('./botPlayer');
const { STYLES } = require('./botStrategy');
class BotManager {
  constructor(io, game, roomId, pool = null) { this.io = io; this.game = game; this.roomId = roomId; this.pool = pool; this.bots = new Map(); this.serial = 0; this.observedHand = 0; this.observedIndex = 0; }
  addBot(difficulty = 'medium', style = 'balanced') {
    if (!BOT_CONFIGS[difficulty] || !STYLES[style]) return { success: false, message: '无效机器人难度或风格' };
    if (!['waiting', 'showdown'].includes(this.game.phase)) return { success: false, message: '请在两手之间添加机器人' };
    const bot = new BotPlayer(difficulty, ++this.serial, style); bot.id = `bot_${randomUUID()}`;
    const result = this.game.addPlayer(bot.id, bot.name, { isBot: true, difficulty, style, isReady: true });
    if (!result.success) return result;
    this.bots.set(bot.id, bot); return { success: true, bot, socketId: bot.id };
  }
  removeBot(id) {
    if (this.game.isLive || !this.bots.has(id)) return false;
    this.game.removePlayer(id); this.bots.delete(id); return true;
  }
  isBot(id) { return this.bots.has(id); }
  getBotIds() { return [...this.bots.keys()]; }
  updateAllBotsMemory(id, action) { for (const bot of this.bots.values()) bot.updateOpponentMemory(id, action); }
  observeActions() {
    if (this.observedHand !== this.game.handId) { this.observedHand = this.game.handId; this.observedIndex = 0; }
    const history = this.game.roundHistory;
    for (; this.observedIndex < history.length; this.observedIndex++) {
      const event = history[this.observedIndex]; if (event.type === 'action') this.updateAllBotsMemory(event.playerId, event.action);
    }
  }
  observation(id) {
    const state = this.game.getState(id);
    // Explicit whitelist: no live Player object, deck, other private hands, or settlement internals.
    return { youId: id, turnId: state.turnId, phase: state.phase, communityCards: state.communityCards,
      players: state.players.map(p => ({ id: p.id, seatIndex: p.seatIndex, chips: p.chips, currentBet: p.currentBet, status: p.status, isConnected: p.isConnected, holeCards: p.id === id ? p.holeCards : p.holeCards.map(() => null) })),
      pot: state.pot, currentBet: state.currentBet, callAmount: state.callAmount, availableActions: state.availableActions,
      dealerSeat: state.dealerSeat, bigBlind: state.bigBlind, minRaise: state.minRaise, minRaiseTo: state.minRaiseTo, maxRaiseTo: state.maxRaiseTo,
      history: this.game.roundHistory.filter(e => e.type === 'action').map(({ playerId, phase, action, amount, betBefore, betTo, potBefore }) => ({ playerId, phase, action, amount, betBefore, betTo, potBefore })) };
  }
  async decision(id) { this.observeActions(); return this.bots.get(id).makeDecision(this.observation(id), this.pool); }
  allBotsReady() { for (const id of this.bots.keys()) { const p = this.game.players.get(id); if (p) p.isReady = true; } }
  autoRebuyAll() { for (const id of this.bots.keys()) if (this.game.players.get(id)?.chips === 0) this.game.playerRebuy(id); }
  allBotsConfirmNext() { for (const id of this.bots.keys()) this.game.playerConfirmNext(id); }
  allBotsConfirmSettlement() { for (const id of this.bots.keys()) this.game.playerConfirmSettlement(id); }
  resetAllBotsRound() {}
}
module.exports = { BotManager };
