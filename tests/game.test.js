const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Game } = require('../server/game');
const { setup, cards, passive, total } = require('./helpers');
const { seededRandom } = require('../server/botStrategy');

test('regression: first actor folds; remaining calls/checks advance exactly once', () => {
  const g = setup();
  assert.equal(g.playerAction('p0', 'fold').success, true);
  g.playerAction('p1', 'call'); g.playerAction('p2', 'check');
  assert.equal(g.phase, 'flop'); assert.equal(g.communityCards.length, 3);
  g.playerAction('p1', 'check'); assert.equal(g.phase, 'flop');
  g.playerAction('p2', 'check'); assert.equal(g.phase, 'turn');
  passive(g); assert.equal(total(g), 3000);
});
test('short all-in actor does not prevent later streets or leave forced check loops', () => {
  const g = setup(3, [100, 1000, 1000]);
  g.playerAction('p0', 'allin'); g.playerAction('p1', 'call'); g.playerAction('p2', 'call');
  assert.equal(g.phase, 'flop'); passive(g); assert.equal(g.communityCards.length, 5); assert.equal(total(g), 2100);
});
test('heads-up blinds, preflop action, postflop action and all-in blind runout', () => {
  const g = setup(2); assert.equal(g.sbSeatIndex, 0); assert.equal(g.getCurrentPlayer().id, 'p0');
  g.playerAction('p0', 'call'); assert.equal(g.getCurrentPlayer().id, 'p1');
  g.playerAction('p1', 'check'); assert.equal(g.phase, 'flop'); assert.equal(g.getCurrentPlayer().id, 'p1');
  const h = setup(2, [5, 100]); assert.equal(h.phase, 'showdown'); assert.equal(h.communityCards.length, 5); assert.equal(total(h), 105);
});
test('incomplete raise does not reopen, cumulative full raise does', () => {
  const g = setup(4, [150, 1000, 1000, 1000]);
  g.playerAction('p3', 'raise', 80); g.playerAction('p0', 'allin'); g.playerAction('p1', 'call'); g.playerAction('p2', 'call');
  assert.deepEqual(g.getAvailableActions('p3'), ['fold','call']);
  g.playerAction('p3', 'call'); assert.equal(g.phase, 'flop');
  const h = setup(5, [200, 1000, 1000, 1000, 150]);
  h.playerAction('p3', 'raise', 80); h.playerAction('p4', 'allin'); h.playerAction('p0', 'allin'); h.playerAction('p1', 'call'); h.playerAction('p2', 'call');
  assert(h.getAvailableActions('p3').includes('raise')); assert.equal(h.getState('p3').minRaiseTo, 280);
});
test('one active player can only call an outstanding all-in, not bet into an empty side pot', () => {
  const g = setup(2, [100, 1000]); g.playerAction('p0', 'allin');
  assert.deepEqual(g.getAvailableActions('p1'), ['fold','call']);
  g.playerAction('p1', 'call'); assert.equal(g.phase, 'showdown'); assert.equal(g.communityCards.length, 5); assert.equal(total(g), 1100);
});
test('main pot, side pot, uncalled excess and public showdown cards', () => {
  const g = setup(3, [300, 100, 200]);
  g.players.get('p0').holeCards = cards('Qs Qh'); g.players.get('p1').holeCards = cards('As Ah'); g.players.get('p2').holeCards = cards('Ks Kh');
  g.deck.cards = cards('Jc 9s 7h 3d 2c');
  g.playerAction('p0', 'allin'); g.playerAction('p1', 'call'); g.playerAction('p2', 'call');
  assert.equal(g.phase, 'showdown'); assert.equal(total(g), 600);
  assert.deepEqual([...g.players.values()].map(p => p.chips), [100,300,200]);
  assert.deepEqual(g.sidePots.map(p => p.amount), [300,200]);
  assert.equal(g.lastResults.find(r => r.playerId === 'p0').returnedAmount, 100);
  for (const viewer of ['p0','p1','p2']) { const state = g.getState(viewer); assert(state.players.every(p => p.holeCards.every(Boolean))); assert(state.lastResults.every(r => r.hand.cards.length === 5)); }
});
test('odd chip goes to first winner clockwise left of button', () => {
  const g = setup(3); g.players.get('p0').holeCards = cards('As Kd'); g.players.get('p1').holeCards = cards('Ah Ks'); g.players.get('p2').holeCards = cards('3s 4d');
  g.communityCards = cards('Ac Kh 8c 8d 2h');
  for (const p of g.players.values()) { p.chips = 999; p.totalBetThisRound = 1; }
  g.players.get('p2').status = 'folded'; g.pot = 3; g.endRound();
  assert.equal(g.players.get('p1').chips, 1001); assert.equal(g.players.get('p0').chips, 1000); assert.equal(total(g), 3000);
});
test('settlement is idempotent and terminal actions cannot pay twice', () => {
  const g = setup(2); passive(g); const before = JSON.stringify(g.getState('p0'));
  for (const action of ['fold','check','call','allin','raise']) assert.equal(g.playerAction('p1', action, 20).success, false);
  g.endRound(); assert.equal(JSON.stringify(g.getState('p0')), before); assert.equal(total(g), 2000);
});
test('malformed, fractional, too-small, over-stack and out-of-turn actions leave state intact', () => {
  for (const amount of [{}, [], '20', NaN, Infinity, -1, 20.5, 0, 19, Number.MAX_SAFE_INTEGER]) {
    const g = setup(), before = JSON.stringify(g.getState('p0'));
    assert.equal(g.playerAction('p0', 'raise', amount).success, false, String(amount));
    assert.equal(JSON.stringify(g.getState('p0')), before);
  }
  const g = setup(); assert.equal(g.playerAction('p1','call').success,false);
  const token = g.turnId; g.playerAction('p0','call',0,token); assert.equal(g.playerAction('p1','call',0,token).success,false);
});
test('all participants ready before first hand; mid-hand entrants wait and need readiness', () => {
  const g = new Game('READY'); for (let i=0;i<3;i++) g.addPlayer(`p${i}`,`P${i}`);
  g.setPlayerReady('p0',true);g.setPlayerReady('p1',true);assert.equal(g.startGame(),false);
  g.setPlayerReady('p2',true);assert.equal(g.startGame(),true);
  g.addPlayer('p3','Late'); assert.equal(g.players.get('p3').holeCards.length,0);passive(g);
  for (const id of g.players.keys()) g.playerConfirmNext(id);
  assert(g.prepareNextRound());g.startRound();assert.equal(g.players.get('p3').holeCards.length,0);
});
test('disconnect before own turn auto-acts, all-in stays live, confirmations exclude offline users', () => {
  const g = setup();g.markDisconnected('p1');g.playerAction('p0','call');assert.equal(g.getCurrentPlayer().id,'p2');
  passive(g); for (const id of ['p0','p2']) g.playerConfirmNext(id); assert.equal(g.allConfirmedNext,true);
  const h = setup(3,[100,1000,1000]);h.playerAction('p0','allin');h.markDisconnected('p0');
  assert.equal(h.players.get('p0').status,'all_in');passive(h);assert.equal(total(h),2100);
});
test('departed players retain contribution and their final accounting', () => {
  const g = setup();g.playerAction('p0','call');g.removePlayer('p1');passive(g);
  assert.equal(total(g),3000);assert.equal(g.players.has('p1'),false);assert(g.getSettlement().some(p=>p.id==='p1'&&p.departed));
});
test('20 complete hands, rebuys, final confirmation, restart and button rotation', () => {
  const g = setup(3);const buttons=[];
  for(let round=1;round<=20;round++) {
    assert.equal(g.currentRound,round);buttons.push(g.dealerSeat);passive(g);
    for(const p of g.players.values()) { if(p.chips===0)g.playerRebuy(p.id);g.playerConfirmNext(p.id); }
    if(round<20){assert(g.prepareNextRound());assert(g.startRound());}else assert.equal(g.prepareNextRound(),false);
  }
  assert.deepEqual(buttons.slice(0,6),[0,1,2,0,1,2]);assert.equal(g.phase,'settled');
  assert.equal(g.restartGame().success,false);for(const id of g.players.keys())g.playerConfirmSettlement(id);
  assert(g.getState('p0').allConfirmedSettlement);assert(g.restartGame().success);assert.equal(g.phase,'waiting');assert.equal(total(g),3000);
});
test('10,000 seeded hands conserve integer chips and always terminate under legal play', () => {
  const random=seededRandom(8675309);
  for(let hand=0;hand<10000;hand++) {
    const n=2+Math.floor(random()*6), stacks=Array.from({length:n},()=>1+Math.floor(random()*1500));
    const g=setup(n,stacks,hand+1), expected=stacks.reduce((a,b)=>a+b,0);let steps=0;
    while(g.isLive && steps++<250) {
      const p=g.getCurrentPlayer(), actions=g.getAvailableActions(p.id);
      assert(actions.length>0,`no action hand ${hand}`);
      const action=actions[Math.floor(random()*actions.length)];
      const state=g.getState(p.id), increment=action==='raise' ? state.minRaise + Math.floor(random()*(state.maxRaiseTo-state.minRaiseTo+1)) : 0;
      const result=g.playerAction(p.id,action,increment); assert(result.success,`${hand}: ${action}: ${result.message}`);
      assert.equal(total(g),expected,`conservation hand ${hand}`);
      for(const q of g.players.values())assert(Number.isSafeInteger(q.chips)&&q.chips>=0);
    }
    assert.equal(g.phase,'showdown',`stalled hand ${hand}`);assert.equal(total(g),expected);
  }
});

test('busted human can rebuy before bots start another hand without them',()=>{
 const g=new Game('HUMAN');g.addPlayer('p0','Human');g.addPlayer('b0','Bot',{isBot:true,isReady:true});g.addPlayer('b1','Bot2',{isBot:true,isReady:true});
 g.players.get('p0').chips=0;g.players.get('p0').isReady=true;
 assert.equal(g.canStartGame(),false);assert.equal(g.startRound(),false);assert(g.playerRebuy('p0').success);assert(g.canStartGame());
});
