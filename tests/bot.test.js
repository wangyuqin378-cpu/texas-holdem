const {test}=require('node:test');const assert=require('node:assert/strict');
const {setup,cards,passive}=require('./helpers');const {BotManager}=require('../server/botManager');const {BotPlayer}=require('../server/botPlayer');
const {decide,estimateEquity,seededRandom,positionValue}=require('../server/botStrategy');const {BotPool}=require('../server/botPool');
function fixture(){const g=setup(2);g.playerAction('p0','call');g.playerAction('p1','check');g.communityCards=cards('Ac 7d 2s');g.players.get('p0').holeCards=cards('As Kh');g.playerAction('p1','raise',20);return new BotManager(null,g,'TEST').observation('p0');}
test('top pair/top kicker no longer folds to a small heads-up bet',()=>{const s=fixture();s.pot=100;for(let seed=1;seed<=10;seed++)assert.notEqual(decide(s,{seed,difficulty:'hard'}).action,'fold');});
test('equity uses showdown shares and known cards, including board ties',()=>{
 const s=fixture(),p=s.players.find(p=>p.id===s.youId);s.communityCards=cards('As Ks Qs Js Ts');p.holeCards=cards('2h 3c');
 assert.equal(estimateEquity(s,p,{samples:50,random:seededRandom(1)}),.5);
 s.communityCards=cards('As Ks Qs Js 2h');p.holeCards=cards('Ts 3c');assert.equal(estimateEquity(s,p,{samples:50,random:seededRandom(1)}),1);
});
test('hidden card/deck permutations cannot change a seeded decision',()=>{
 const g=setup(3),m=new BotManager(null,g,'TEST');const first=m.observation('p0');
 g.players.get('p1').holeCards=cards('As Ah');g.players.get('p2').holeCards=cards('Ks Kh');g.deck.cards.reverse();
 const second=m.observation('p0');assert.deepEqual(first,second);assert.deepEqual(decide(first,{seed:42}),decide(second,{seed:42}));
});
test('button is late after flop, heads-up position reverses by street',()=>{const s=fixture(),p=s.players.find(p=>p.id==='p0');assert.equal(positionValue(s,p),1);s.phase='pre_flop';assert.equal(positionValue(s,p),0);});
test('all human and bot public actions reach memory once; repeated ready never toggles bots off',()=>{
 const g=setup(2),m=new BotManager(null,g,'TEST'),b=new BotPlayer();b.id='p1';m.bots.set('p1',b);
 g.playerAction('p0','call');m.observeActions();m.observeActions();assert.equal(b.opponentMemory.get('p0').observations,1);
 m.allBotsReady();m.allBotsReady();assert.equal(g.players.get('p1').isReady,true);
});
test('bot choices stay legal across seeded multiplayer hands',()=>{
 for(let h=1;h<=30;h++){const g=setup(2+h%6,[],h),m=new BotManager(null,g,'TEST');let steps=0;
  while(g.isLive&&steps++<150){const p=g.getCurrentPlayer(),state=m.observation(p.id),d=decide(state,{seed:h*100+steps,samples:48,style:['steady','balanced','active'][h%3]});assert(g.getAvailableActions(p.id).includes(d.action));assert(g.playerAction(p.id,d.action,d.amount||0).success);}
  assert.equal(g.phase,'showdown');
 }
});
test('worker pool returns a legal decision without blocking event loop and shuts down',async()=>{
 const pool=new BotPool(1);try{const s=fixture();let tick=false;setTimeout(()=>{tick=true;},1);const result=await pool.run(s,{seed:1,difficulty:'hard'});assert(tick);assert(s.availableActions.includes(result.action));}finally{await pool.close();}
});
