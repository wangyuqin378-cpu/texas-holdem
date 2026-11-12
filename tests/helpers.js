const { Game } = require('../server/game');
const { Card, Deck } = require('../server/deck');
const { seededRandom } = require('../server/botStrategy');
function setup(n = 3, stacks = [], seed = 123) {
  const game = new Game('TEST01', { deck: new Deck(seededRandom(seed)) });
  for (let i = 0; i < n; i++) {
    game.addPlayer(`p${i}`, `Player ${i}`); const p = game.players.get(`p${i}`);
    p.chips = stacks[i] ?? 1000; p.totalBuyIn = p.chips; p.isReady = true;
  }
  game.startGame(); return game;
}
const suits = { s: 'spades', h: 'hearts', c: 'clubs', d: 'diamonds' };
function cards(text) { return text.split(' ').map(s => new Card(suits[s.at(-1)], s.slice(0, -1).replace('T', '10'))); }
function passive(game, limit = 100) {
  for (let i = 0; game.isLive && i < limit; i++) {
    const p = game.getCurrentPlayer(), actions = game.getAvailableActions(p.id);
    const result = game.playerAction(p.id, actions.includes('check') ? 'check' : 'call');
    if (!result.success) throw new Error(result.message);
  }
  if (game.isLive) throw new Error('Hand failed to end');
}
function total(game) { return [...game.players.values()].reduce((s, p) => s + p.chips, game.pot) + [...game.departedPlayers.values()].reduce((s, p) => s + p.finalChips, 0); }
module.exports = { setup, cards, passive, total };
