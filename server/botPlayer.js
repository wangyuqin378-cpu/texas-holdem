const { randomInt } = require('node:crypto');
const { CONFIGS, STYLES, decide } = require('./botStrategy');
const STYLE_NAMES = { steady: '稳健', balanced: '均衡', active: '积极' };
class BotPlayer {
  constructor(difficulty = 'medium', botNumber = 1, style = 'balanced') {
    if (!CONFIGS[difficulty] || !STYLES[style]) throw new Error('无效机器人难度或风格');
    this.difficulty = difficulty; this.style = style; this.name = `${STYLE_NAMES[style]}玩家${botNumber}`;
    this.id = null; this.opponentMemory = new Map();
  }
  options() { return { difficulty: this.difficulty, style: this.style, seed: randomInt(0x100000000), profiles: Object.fromEntries(this.opponentMemory) }; }
  makeDecision(state, pool = null) { return pool ? pool.run(state, this.options()) : Promise.resolve(decide(state, this.options())); }
  updateOpponentMemory(id, action) {
    if (id === this.id) return;
    const m = this.opponentMemory.get(id) || { observations: 0, raises: 0, folds: 0, faced: 0, aggression: .5, foldRate: .4 };
    m.observations++; if (['raise', 'allin'].includes(action)) m.raises++;
    if (action !== 'check') { m.faced++; if (action === 'fold') m.folds++; }
    m.aggression = (m.raises + 5) / (m.observations + 10); m.foldRate = (m.folds + 4) / (m.faced + 10);
    this.opponentMemory.set(id, m);
  }
  resetRound() {} // Persistent public-action statistics intentionally survive each hand.
}
module.exports = { BotPlayer, BOT_CONFIGS: CONFIGS };
