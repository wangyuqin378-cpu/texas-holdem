/** Duplicate-deal evaluation against the pre-repair hard bot. No production state. */
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { setup } = require('../tests/helpers');
const { BotManager } = require('../server/botManager');
const { decide, seededRandom } = require('../server/botStrategy');
const legacySource = fs.readFileSync(path.join(__dirname, '../tests/fixtures/legacy-bot.cjs'), 'utf8');
async function evaluate(players, deals) {
  const blocks = [], times = []; let hands = 0, baselineClamps = 0, newInvalid = 0;
  for (let deal = 0; deal < deals; deal++) {
    let duplicateProfit = 0;
    for (let heroSeat = 0; heroSeat < players; heroSeat++) {
      const seed = 10000 + deal, g = setup(players, [], seed), manager = new BotManager(null, g, 'BENCH');
      const seededMath = Object.create(Math); seededMath.random = seededRandom(seed * 31 + heroSeat);
      const context = { module: { exports: {} }, require: () => require('../server/handEvaluator'), Math: seededMath, Date, setTimeout };
      vm.runInNewContext(legacySource, context);
      const legacy = new Map();
      for (const id of g.players.keys()) { const b = new context.module.exports.BotPlayer('hard'); b.id = id; b._sleep = async () => {}; legacy.set(id, b); }
      let steps = 0;
      while (g.isLive && steps++ < 200) {
        const p = g.getCurrentPlayer(), state = manager.observation(p.id), isHero = p.id === `p${heroSeat}`;
        let decision;
        if (isHero) { const begin = performance.now(); decision = decide(state, { difficulty: 'medium', style: 'balanced', seed: seed * 401 + heroSeat * 31 + steps }); times.push(performance.now() - begin); }
        else decision = await legacy.get(p.id).makeDecision(state, p);
        // Give the old bot a fair comparison: normalize its broken raise sizes to legal bounds.
        if (!isHero && decision.action === 'raise' && state.availableActions.includes('raise')) {
          const amount = Math.min(state.maxRaiseTo - state.currentBet, Math.max(state.minRaise, decision.amount));
          if (amount !== decision.amount) baselineClamps++;
          decision.amount = amount;
        }
        let result = g.playerAction(p.id, decision.action, decision.amount || 0);
        if (!result.success) {
          if (isHero) newInvalid++; else baselineClamps++;
          result = g.playerAction(p.id, state.availableActions.includes('check') ? 'check' : 'fold');
        }
        if (!result.success) throw new Error(result.message);
      }
      if (g.isLive) throw new Error('Benchmark stalled');
      duplicateProfit += (g.players.get(`p${heroSeat}`).chips - 1000) / 20; hands++;
    }
    blocks.push(duplicateProfit / players);
  }
  const mean = blocks.reduce((a, b) => a + b, 0) / blocks.length;
  const variance = blocks.reduce((s, v) => s + (v - mean) ** 2, 0) / (blocks.length - 1);
  const margin = 1.96 * Math.sqrt(variance / blocks.length);
  times.sort((a, b) => a - b);
  return { players, duplicateDeals: deals, hands, bigBlindsPerHand: +mean.toFixed(3), confidence95: [+(mean - margin).toFixed(3), +(mean + margin).toFixed(3)], newInvalidActions: newInvalid, baselineLegalNormalizations: baselineClamps, decisionP95Ms: +times[Math.floor(times.length * .95)].toFixed(1) };
}
(async () => {
  const results = [];
  for (const [n, deals] of [[2,1000],[6,500]]) { const result = await evaluate(n,deals);results.push(result);console.log(JSON.stringify(result)); }
  if (results.some(r => r.newInvalidActions || r.confidence95[0] <= 0)) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
