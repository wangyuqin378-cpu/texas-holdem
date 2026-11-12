const {test}=require('node:test');const assert=require('node:assert/strict');
const {io}=require('socket.io-client');const {randomUUID}=require('node:crypto');
const {createPokerServer}=require('../server/index');
function cmd(socket,event,data={},requestId=randomUUID()){return new Promise((resolve,reject)=>socket.timeout(2500).emit(event,{protocolVersion:2,requestId,...data},(err,r)=>err?reject(err):resolve(r)));}
function waitState(socket,predicate,ms=4000){if(socket.state&&predicate(socket.state))return Promise.resolve(socket.state);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{socket.off('gameState',listener);reject(new Error('State timeout: '+JSON.stringify(socket.state)));},ms);const listener=s=>{if(predicate(s)){clearTimeout(timer);socket.off('gameState',listener);resolve(s);}};socket.on('gameState',listener);});}
async function fixture(t,options={}){
 const runtime=createPokerServer({transitionDelay:5,botDelay:5,disconnectTimeout:150,rateLimit:10000,...options});
 await new Promise(resolve=>runtime.server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${runtime.server.address().port}`,sockets=[];
 const connect=async()=>{const socket=io(url,{transports:['websocket'],reconnection:false});sockets.push(socket);socket.on('gameState',s=>{socket.state=s;});await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('connect_error',reject);});return socket;};
 t.after(async()=>{for(const s of sockets)s.disconnect();await runtime.close();});return{runtime,url,connect};
}

test('HTTP health, protocol rejection, malformed events and safe callbacks',async t=>{
 const f=await fixture(t),s=await f.connect();const health=await fetch(f.url+'/healthz');assert.deepEqual(await health.json(),{status:'ok',protocolVersion:2});
 assert((await fetch(f.url)).headers.get('content-security-policy').includes("script-src 'self'"));
 for(const payload of [null,[],{},'bad',{playerName:'Legacy'}]){
  const response=await new Promise(resolve=>s.emit('createRoom',payload,resolve));assert.equal(response.success,false);
 }
 s.emit('createRoom');s.emit('action',null);s.emit('chat',{message:{}});
 assert((await cmd(s,'createRoom',{playerName:'Healthy'})).success);
 assert.equal(f.runtime.rooms.size,1);
});
test('stable session rejoin requires token, preserves chips, and prevents same-name takeover',async t=>{
 const f=await fixture(t,{disconnectTimeout:1000}),a=await f.connect(),created=await cmd(a,'createRoom',{playerName:'Same'});
 const room=f.runtime.rooms.get(created.roomId);room.game.players.get(created.playerId).chips=723;
 a.disconnect();const b=await f.connect();
 assert.equal((await cmd(b,'rejoinRoom',{playerName:'Same',roomId:created.roomId})).success,false);
 const newcomer=await cmd(b,'joinRoom',{playerName:'Same',roomId:created.roomId});assert.notEqual(newcomer.playerId,created.playerId);
 const c=await f.connect(),resumed=await cmd(c,'rejoinRoom',{sessionToken:created.sessionToken});assert.equal(resumed.playerId,created.playerId);
 const state=await waitState(c,s=>s.youId===created.playerId);assert.equal(state.players.find(p=>p.id===created.playerId).chips,723);
 assert(!JSON.stringify(state).includes(created.sessionToken));assert.equal(state.players.length,2);
});
test('host authority, request dedupe and stale actions across real sockets',async t=>{
 const f=await fixture(t),a=await f.connect(),b=await f.connect();const ca=await cmd(a,'createRoom',{playerName:'A'}),cb=await cmd(b,'joinRoom',{roomId:ca.roomId,playerName:'B'});
 assert.equal((await cmd(b,'addBot',{})).success,false);
 const id=randomUUID();const first=await cmd(a,'addBot',{difficulty:'easy',style:'steady'},id);const duplicate=await cmd(a,'addBot',{difficulty:'easy',style:'steady'},id);
 assert.deepEqual(first,duplicate);assert.equal(f.runtime.rooms.get(ca.roomId).game.playerCount,3);
 await cmd(a,'removeBot',{botId:first.botId});
 await cmd(a,'ready',{ready:true});await cmd(b,'ready',{ready:true});const st=await waitState(a,s=>s.phase==='pre_flop');
 const data={action:'call',handId:st.handId,turnId:st.turnId},aid=randomUUID();
 assert((await cmd(a,'action',data,aid)).success);assert((await cmd(a,'action',data,aid)).success);
 assert.equal((await cmd(b,'action',data)).success,false);
 assert.equal((await cmd(a,'restart')).success,false);
 assert.equal((await cmd(a,'joinRoom',{roomId:ca.roomId,playerName:'A'})).success,false);
 assert.equal(f.runtime.rooms.get(ca.roomId).game.players.get(ca.playerId).currentBet,20);
});
test('20 full hands through sockets, all comparison cards visible and restart works',async t=>{
 const f=await fixture(t),a=await f.connect(),b=await f.connect();const ca=await cmd(a,'createRoom',{playerName:'A'}),cb=await cmd(b,'joinRoom',{roomId:ca.roomId,playerName:'B'});
 const sockets=new Map([[ca.playerId,a],[cb.playerId,b]]),room=f.runtime.rooms.get(ca.roomId),g=room.game;
 await cmd(a,'ready',{ready:true});await cmd(b,'ready',{ready:true});await waitState(a,s=>s.phase==='pre_flop');
 for(let round=1;round<=20;round++){
  assert.equal(g.currentRound,round);
  while(g.isLive){const p=g.getCurrentPlayer(),state=g.getState(p.id),r=await cmd(sockets.get(p.id),'action',{action:state.availableActions.includes('check')?'check':'call',turnId:state.turnId,handId:state.handId});assert(r.success,r.message);}
  const result=await waitState(a,s=>s.phase==='showdown'&&s.currentRound===round);
  assert.equal(result.communityCards.length,5);assert(result.lastResults.every(r=>r.holeCards.length===2&&r.hand.cards.length===5));
  for(const [id,s]of sockets){if(g.players.get(id).chips===0&&round<20)assert((await cmd(s,'rebuy')).success);assert((await cmd(s,'confirmNext',{handId:g.handId})).success);}
  await waitState(a,s=>round===20?s.phase==='settled':s.currentRound===round+1);
 }
 assert.equal(g.phase,'settled');assert.equal(g.getSettlement().reduce((s,p)=>s+p.profit,0),0);
 for(const s of sockets.values())assert((await cmd(s,'confirmSettlement',{handId:g.handId})).success);
 assert((await cmd(a,'restart')).success);await waitState(b,s=>s.phase==='waiting'&&s.currentRound===0);
});
test('seven clients, mid-hand disconnect, rejoin, leave and expiry clean up',async t=>{
 const f=await fixture(t),clients=[];let code;
 for(let i=0;i<7;i++){const s=await f.connect(),r=await cmd(s,i?'joinRoom':'createRoom',{playerName:`P${i}`,roomId:code});assert(r.success);code=r.roomId;clients.push({s,r});}
 const extra=await f.connect();assert.equal((await cmd(extra,'joinRoom',{playerName:'Full',roomId:code})).success,false);
 for(const c of clients)await cmd(c.s,'ready',{ready:true});await waitState(clients[0].s,s=>s.phase==='pre_flop');
 const g=f.runtime.rooms.get(code).game,current=clients.find(c=>c.r.playerId===g.getCurrentPlayer().id);current.s.disconnect();
 for(const c of clients){const state=g.getState(c.r.playerId);for(const p of state.players)assert(p.holeCards.every(card=>p.id===c.r.playerId?!!card:card===null));}
 await waitState(clients[1].s,s=>s.currentPlayerId!==current.r.playerId);
 const resumed=await f.connect();assert((await cmd(resumed,'rejoinRoom',{sessionToken:current.r.sessionToken})).success);
 assert.equal(g.playerCount,7);
 for(const c of clients)if(c!==current)await cmd(c.s,'leaveRoom');await cmd(resumed,'leaveRoom');assert.equal(f.runtime.rooms.size,0);assert.equal(f.runtime.sessions.size,0);
});
test('bot computation cannot act after room deletion; bot-only rooms are cleaned on expiry',async t=>{
 const f=await fixture(t,{botDelay:80,disconnectTimeout:30}),a=await f.connect(),c=await cmd(a,'createRoom',{playerName:'A'});
 await cmd(a,'addBot',{difficulty:'hard'});await cmd(a,'addBot',{difficulty:'medium'});await cmd(a,'ready',{ready:true});await waitState(a,s=>s.phase==='pre_flop');
 a.disconnect();await new Promise(resolve=>setTimeout(resolve,180));assert.equal(f.runtime.rooms.size,0);assert.equal(f.runtime.sessions.size,0);
});
