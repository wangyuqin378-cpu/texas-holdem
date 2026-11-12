/** Pure strategy: this module only receives a player's information set. */
const { Card, SUITS, RANKS } = require('./deck');
const { evaluateBestHand, compareHands } = require('./handEvaluator');
const CONFIGS = Object.freeze({ easy: { samples: 192, margin: .10 }, medium: { samples: 512, margin: .035 }, hard: { samples: 1024, margin: .015 } });
const STYLES = Object.freeze({ steady: { looseness: -.04, aggression: .35, bluff: .035 }, balanced: { looseness: 0, aggression: .55, bluff: .08 }, active: { looseness: .04, aggression: .75, bluff: .13 } });
function seededRandom(seed = 1) { let a = seed >>> 0; return () => { a += 0x6D2B79F5; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function preflopStrength(cards) {
  const [a, b] = cards.map(c => c.value), hi = Math.max(a, b), lo = Math.min(a, b), gap = hi - lo;
  if (a === b) return .5 + hi / 14 * .45;
  return Math.min(1, (hi + lo) / 28 * .6 + (cards[0].suit === cards[1].suit ? .05 : 0) + (gap === 1 ? .04 : gap === 2 ? .02 : 0) + (hi === 14 ? .08 : hi === 13 ? .04 : 0));
}
function positionValue(state, player) {
  const seated = state.players.filter(p => p.holeCards?.length === 2).sort((a, b) => a.seatIndex - b.seatIndex);
  if (seated.length < 2) return .5;
  const dealer = seated.findIndex(p => p.seatIndex === state.dealerSeat), me = seated.findIndex(p => p.id === player.id);
  if (dealer < 0 || me < 0) return .5;
  const start = state.phase === 'pre_flop' ? (seated.length === 2 ? dealer : (dealer + 3) % seated.length) : (dealer + 1) % seated.length;
  return ((me - start + seated.length) % seated.length) / (seated.length - 1);
}
function postflopRangeWeight(hole, board, actions, profile) {
  const pressure = actions.filter(a => a.phase !== 'pre_flop' && (a.action === 'raise' || (a.action === 'allin' && a.betTo > a.betBefore)));
  if (!pressure.length || board.length < 3) return 1;
  const hand = evaluateBestHand([...hole, ...board]);
  const top = Math.max(...board.map(c => c.value));
  const pairValue = hand.rank === 2 ? hand.kickers[0] : 0;
  const ownPair = hole.some(c => c.value === pairValue);
  let value = hand.rank >= 7 ? 1 : hand.rank === 6 ? .95 : hand.rank === 5 ? .90 : hand.rank === 4 ? .80 : hand.rank === 3 ? .65 : ownPair && pairValue >= top ? .45 : ownPair ? .18 : .035;
  // A board-made monster doesn't make every random private hand a value raise.
  if (board.length === 5 && compareHands(hand, evaluateBestHand(board)) === 0) value = .06;
  const flushDraw = board.length < 5 && hole.some(c => [...hole, ...board].filter(x => x.suit === c.suit).length === 4);
  if (flushDraw) value = Math.max(value, .35);
  const large = pressure.some(a => a.amount / Math.max(20, a.potBefore || 20) >= .9 || a.betBefore > 0);
  const tight = profile?.observations >= 12 && profile.aggression < .25;
  return Math.max(tight ? .015 : .035, value ** (large ? 2 : 1));
}
function estimateEquity(state, player, { samples = 512, random = Math.random, profiles = {} } = {}) {
  const visible = [...player.holeCards, ...state.communityCards];
  const key = c => `${c.suit}:${c.value}`;
  const known = new Set(visible.map(key));
  const pool = SUITS.flatMap(s => RANKS.map(r => new Card(s, r))).filter(c => !known.has(key(c)));
  const opponents = state.players.filter(p => p.id !== player.id && ['active', 'all_in'].includes(p.status));
  if (!opponents.length) return 1;
  let shares = 0;
  for (let sample = 0; sample < samples; sample++) {
    const deck = [...pool];
    const draw = () => deck.splice(Math.floor(random() * deck.length), 1)[0];
    const hands = opponents.map(p => {
      const profile = profiles[p.id];
      const history = (state.history || []).filter(a => a.playerId === p.id);
      const raised = history.some(a => a.phase === 'pre_flop' && (a.action === 'raise' || (a.action === 'allin' && a.betTo > a.betBefore)));
      let cards;
      for (let attempt = 0; attempt < 20; attempt++) {
        cards = [draw(), draw()];
        const strength = preflopStrength(cards);
        // A prior, not a claim to know their cards; shrink small samples to neutral.
        const tight = profile?.observations >= 12 ? Math.max(0, .5 - profile.aggression) * .18 : 0;
        const threshold = raised ? .62 + tight : .30 + tight;
        const preflopWeight = strength >= threshold ? 1 : .12;
        const weight = preflopWeight * postflopRangeWeight(cards, state.communityCards, history, profile);
        if (random() < weight || attempt === 19) break;
        deck.push(...cards);
      }
      return cards;
    });
    const board = [...state.communityCards];
    while (board.length < 5) board.push(draw());
    const own = evaluateBestHand([...player.holeCards, ...board]);
    let ties = 1, lost = false;
    for (const hole of hands) { const cmp = compareHands(own, evaluateBestHand([...hole, ...board])); if (cmp < 0) { lost = true; break; } if (cmp === 0) ties++; }
    if (!lost) shares += 1 / ties;
  }
  return shares / samples;
}
function decide(state, { difficulty = 'medium', style = 'balanced', seed = 1, profiles = {}, samples } = {}) {
  const config = CONFIGS[difficulty] || CONFIGS.medium, personality = STYLES[style] || STYLES.balanced;
  const random = seededRandom(seed), player = state.players.find(p => p.id === state.youId), actions = state.availableActions;
  if (!player || player.holeCards.some(c => !c)) throw new Error('Missing own cards');
  const safe = () => ({ action: actions.includes('check') ? 'check' : actions.includes('call') && state.callAmount === 0 ? 'call' : 'fold' });
  const equity = estimateEquity(state, player, { samples: samples || config.samples, random, profiles });
  const call = state.callAmount, odds = call / Math.max(1, state.pot + call), pos = positionValue(state, player);
  const opponents = state.players.filter(p => p.id !== player.id && ['active', 'all_in'].includes(p.status));
  const effective = Math.min(player.chips, Math.max(0, ...opponents.map(p => p.chips + Math.max(0, p.currentBet - player.currentBet))));
  const spr = effective / Math.max(state.pot, state.bigBlind);
  const raise = fraction => {
    if (!actions.includes('raise')) return null;
    const target = state.phase === 'pre_flop' && state.currentBet <= state.bigBlind
      ? Math.round(state.bigBlind * (2.5 + state.history.filter(a => a.phase === 'pre_flop' && a.action === 'call').length))
      : state.currentBet + Math.max(state.minRaise, Math.round((state.pot + call) * fraction));
    return { action: 'raise', amount: Math.min(state.maxRaiseTo, Math.max(state.minRaiseTo, target)) - state.currentBet };
  };
  const strength = preflopStrength(player.holeCards);
  if (state.phase === 'pre_flop' && state.currentBet <= state.bigBlind && strength >= .55 - pos * .14 - personality.looseness) {
    const opening = raise(.55); if (opening) return opening;
  }
  if (state.phase === 'pre_flop' && call > 0 && strength < .50 - pos * .13 - personality.looseness && equity < odds + .18) return { action: 'fold' };
  // Price matters: avoid calling large bets with weak equity, never fold a free check.
  if (call > 0 && equity < odds + config.margin - personality.looseness * .3) return { action: 'fold' };
  const valueLine = opponents.length > 2 ? .56 : .64;
  if (actions.includes('allin') && ((equity > .80 && spr < 2) || (state.phase === 'pre_flop' && strength > .88 && effective <= state.bigBlind * 15))) return { action: 'allin' };
  if (equity > valueLine && random() < .65 + personality.aggression * .3) {
    const valueRaise = raise(equity > .85 ? .85 : .55); if (valueRaise) return valueRaise;
  }
  const foldable = opponents.filter(p => p.status === 'active');
  const measured = foldable.map(p => profiles[p.id]).filter(p => p?.observations >= 12);
  const foldRate = measured.length ? measured.reduce((s, p) => s + p.foldRate, 0) / measured.length : .4;
  const boardSuits = state.communityCards.map(c => c.suit);
  const flushDraw = state.phase !== 'river' && player.holeCards.some(c => [...boardSuits, ...player.holeCards.map(h => h.suit)].filter(s => s === c.suit).length === 4);
  const semiBluff = state.phase !== 'river' && equity > .24 && equity < valueLine && (flushDraw || equity > .38);
  const riverBluff = state.phase === 'river' && equity < .25 && player.holeCards.some(c => c.value === 14) && foldRate > .5;
  if (difficulty !== 'easy' && opponents.length <= 2 && foldable.length === opponents.length && pos >= .5 && call <= state.pot * .35 && (semiBluff || riverBluff) && random() < personality.bluff * (1 + foldRate)) {
    const bluff = raise(.6); if (bluff) return bluff;
  }
  if (actions.includes('check')) return { action: 'check' };
  if (actions.includes('call')) return { action: 'call' };
  return safe();
}
module.exports = { decide, estimateEquity, preflopStrength, positionValue, seededRandom, CONFIGS, STYLES };
