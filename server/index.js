const express = require('express');
const http = require('node:http');
const path = require('node:path');
const { randomBytes, randomUUID, randomInt } = require('node:crypto');
const { Server } = require('socket.io');
const { Game } = require('./game');
const { BotManager } = require('./botManager');
const { BotPool } = require('./botPool');
const PROTOCOL_VERSION = 2;
const failure = message => ({ success: false, message });

function createPokerServer(options = {}) {
  const app = express(), server = http.createServer(app);
  const io = new Server(server, { pingTimeout: 30000, pingInterval: 10000, maxHttpBufferSize: 16384 });
  const rooms = new Map(), sessions = new Map(), pool = new BotPool(options.workers || 2);
  const disconnectTimeout = options.disconnectTimeout ?? 300000, transitionDelay = options.transitionDelay ?? 800;
  const createLimits = new Map(); let closed = false;
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (/\.(?:js|css)$/.test(req.path) || req.path === '/') res.setHeader('Cache-Control', 'no-cache');
    next();
  });
  app.get('/healthz', (req, res) => res.json({ status: 'ok', protocolVersion: PROTOCOL_VERSION }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  const message = (room, text, type = 'info') => io.to(room.game.roomId).emit('message', { text, type, timestamp: Date.now() });
  const humanOnline = room => [...room.game.players.values()].some(p => !p.isBot && p.isConnected && !p.departed);
  function publish(room) {
    for (const [id, token] of room.members) {
      const session = sessions.get(token);
      if (session?.socketId) io.to(session.socketId).emit('gameState', room.game.getState(id));
    }
  }
  function clearScheduled(room) { clearTimeout(room.turnTimer); clearTimeout(room.transitionTimer); room.turnTimer = null; room.turnKey = null; room.transitionTimer = null; room.transitionKey = null; room.botKey = null; }
  function destroyRoom(room) {
    clearScheduled(room);
    for (const token of room.members.values()) { const s = sessions.get(token); clearTimeout(s?.expiryTimer); sessions.delete(token); }
    rooms.delete(room.game.roomId); room.closed = true;
  }
  function createRoom() {
    let id; do { id = randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(id));
    const game = new Game(id);
    const room = { game, members: new Map(), closed: false, observedHand: -1, observedIndex: 0, announcedShowdown: -1 };
    room.bots = new BotManager(io, game, id, pool); rooms.set(id, room); return room;
  }
  function broadcastActions(room) {
    if (room.observedHand !== room.game.handId) { room.observedHand = room.game.handId; room.observedIndex = 0; }
    const labels = { fold: '弃牌', check: '过牌', call: '跟注', raise: '加注', allin: '全下' };
    for (; room.observedIndex < room.game.roundHistory.length; room.observedIndex++) {
      const event = room.game.roundHistory[room.observedIndex];
      if (event.type === 'action') message(room, `${event.playerName} ${labels[event.action]}${event.amount ? ` ${event.amount}` : ''}${event.automatic ? '（断线托管）' : ''}`);
    }
    room.bots.observeActions();
  }
  function scheduleTransition(room, key, condition, run) {
    if (room.transitionKey === key) return;
    clearTimeout(room.transitionTimer); room.transitionKey = key;
    room.transitionTimer = setTimeout(() => {
      room.transitionKey = null; room.transitionTimer = null;
      if (room.closed || !humanOnline(room) || !condition()) return;
      run(); drive(room);
    }, transitionDelay);
    room.transitionTimer.unref();
  }
  function drive(room) {
    if (room.closed || closed) return;
    const game = room.game;
    broadcastActions(room);
    if (game.phase === 'showdown') {
      room.bots.allBotsConfirmNext();
      if (room.announcedShowdown !== game.handId) {
        room.announcedShowdown = game.handId;
        for (const r of game.lastResults || []) if (r.winAmount) message(room, `${r.playerName} 赢得 ${r.winAmount} · ${r.handName}`, 'success');
      }
    } else if (game.phase === 'settled') room.bots.allBotsConfirmSettlement();
    publish(room);
    if (!humanOnline(room)) { clearScheduled(room); return; }
    if (game.isLive) {
      clearTimeout(room.transitionTimer); room.transitionTimer = null; room.transitionKey = null;
      const key = game.turnId;
      if (room.turnKey !== key) {
        clearTimeout(room.turnTimer); room.turnKey = key;
        room.turnTimer = setTimeout(() => {
          room.turnKey = null;
          if (room.closed || game.turnId !== key) return;
          const p = game.getCurrentPlayer(), result = game.handleTimeout();
          if (result?.success) message(room, `${p.name} 超时，自动${result.action === 'check' ? '过牌' : '弃牌'}`);
          drive(room);
        }, Math.max(1, game.getTurnTimeRemaining()) * 1000);
        room.turnTimer.unref();
      }
      const player = game.getCurrentPlayer();
      if (player?.isBot && room.botKey !== key) {
        room.botKey = key;
        const delay = options.botDelay ?? randomInt(650, 1151);
        Promise.all([room.bots.decision(player.id).catch(() => null), new Promise(resolve => setTimeout(resolve, delay))]).then(([decision]) => {
          if (room.closed || closed || game.turnId !== key || !humanOnline(room)) return;
          let result = decision && game.playerAction(player.id, decision.action, decision.amount || 0, key);
          if (!result?.success) result = game.playerAction(player.id, game.getAvailableActions(player.id).includes('check') ? 'check' : 'fold', 0, key);
          room.botKey = null; drive(room);
        }).catch(error => { console.error('Bot scheduling failed:', error.message); room.botKey = null; });
      }
      return;
    }
    clearTimeout(room.turnTimer); room.turnTimer = null; room.turnKey = null; room.botKey = null;
    if (game.phase === 'waiting' && game.canStartGame()) {
      const hand = game.handId;
      scheduleTransition(room, `start:${hand}`, () => game.handId === hand && game.canStartGame(), () => game.startGame());
    } else if (game.phase === 'showdown' && game.allConfirmedNext) {
      const hand = game.handId;
      scheduleTransition(room, `next:${hand}`, () => game.handId === hand && game.allConfirmedNext, () => {
        if (!game.prepareNextRound()) return;
        room.bots.autoRebuyAll();
        if (!game.startRound()) { game.phase = 'waiting'; message(room, '至少需要两名有筹码且已准备的玩家。可重购后准备。'); }
      });
    } else { clearTimeout(room.transitionTimer); room.transitionTimer = null; room.transitionKey = null; }
  }
  function attach(socket, room, session) {
    clearTimeout(session.expiryTimer); session.expiryTimer = null;
    const previous = session.socketId; session.socketId = socket.id;
    socket.data.session = session; socket.join(room.game.roomId); room.game.reconnectPlayer(session.playerId);
    if (previous && previous !== socket.id) { const old = io.sockets.sockets.get(previous); old?.emit('sessionReplaced'); old?.disconnect(true); }
    return { success: true, protocolVersion: PROTOCOL_VERSION, roomId: room.game.roomId, playerId: session.playerId, sessionToken: session.token, seatIndex: room.game.players.get(session.playerId).seatIndex };
  }
  function join(socket, room, name) {
    const id = randomUUID(), result = room.game.addPlayer(id, name);
    if (!result.success) return result;
    const token = randomBytes(32).toString('base64url');
    const session = { token, playerId: id, roomId: room.game.roomId, socketId: null, recent: new Map() };
    room.members.set(id, token); sessions.set(token, session);
    const joined = attach(socket, room, session); message(room, `${name} 加入了房间`); return joined;
  }
  function leave(socket, explicit) {
    const session = socket.data.session; if (!session || session.socketId !== socket.id) return;
    socket.data.session = null; session.socketId = null;
    const room = rooms.get(session.roomId); if (!room) return;
    socket.leave(session.roomId);
    if (explicit) {
      room.game.removePlayer(session.playerId); room.members.delete(session.playerId); sessions.delete(session.token); clearTimeout(session.expiryTimer);
    } else {
      room.game.markDisconnected(session.playerId);
      session.expiryTimer = setTimeout(() => {
        if (session.socketId || !rooms.has(session.roomId)) return;
        room.game.removePlayer(session.playerId); room.members.delete(session.playerId); sessions.delete(session.token);
        if (![...room.game.players.values()].some(p => !p.isBot && !p.departed)) destroyRoom(room); else drive(room);
      }, disconnectTimeout);
      session.expiryTimer.unref();
    }
    if (![...room.game.players.values()].some(p => !p.isBot && !p.departed)) destroyRoom(room); else drive(room);
  }
  io.on('connection', socket => {
    let budgetStart = Date.now(), budget = 0, chatStart = 0, chatCount = 0;
    const preSessionRecent = new Map();
    function command(event, fn, { requireRoom = true, host = false } = {}) {
      socket.on(event, (data, callback) => {
        const ack = typeof callback === 'function' ? callback : () => {};
        try {
          if (!data || typeof data !== 'object' || Array.isArray(data)) return ack(failure('请求格式错误，请刷新页面'));
          if (data.protocolVersion !== PROTOCOL_VERSION) return ack(failure('版本已更新，请刷新页面'));
          if (typeof data.requestId !== 'string' || data.requestId.length < 1 || data.requestId.length > 80) return ack(failure('缺少操作标识'));
          const session = socket.data.session, recent = session?.recent || preSessionRecent;
          const old = recent.get(data.requestId) || preSessionRecent.get(data.requestId);
          if (old) return ack(old.event === event ? old.response : failure('操作标识已使用'));
          if (Date.now() - budgetStart > 10000) { budgetStart = Date.now(); budget = 0; }
          if (++budget > (options.rateLimit ?? 80)) return ack(failure('操作太频繁，请稍后再试'));
          const room = session && rooms.get(session.roomId);
          if (requireRoom && (!room || session.socketId !== socket.id)) return ack(failure('请先加入房间'));
          if (host && room.game.hostPlayerId !== session.playerId) return ack(failure('只有房主可以操作'));
          const response = fn(data, room, session) || { success: true };
          recent.set(data.requestId, { event, response }); if (recent.size > 128) recent.delete(recent.keys().next().value);
          ack(response);
          const currentRoom = rooms.get(socket.data.session?.roomId); if (currentRoom) drive(currentRoom);
        } catch (error) { console.error(`Rejected ${event}:`, error.message); ack(failure('操作未完成，请刷新状态后再试')); }
      });
    }
    const nameFrom = data => typeof data.playerName === 'string' && data.playerName.trim().length >= 1 && data.playerName.trim().length <= 16 ? data.playerName.trim() : null;
    for (const event of ['createRoom', 'joinRoom', 'quickJoin']) command(event, data => {
      if (socket.data.session) return failure('请先离开当前房间');
      const name = nameFrom(data); if (!name) return failure('昵称需为 1–16 个字符');
      let room;
      if (event === 'joinRoom') {
        if (typeof data.roomId !== 'string' || !/^[a-f0-9]{6}$/i.test(data.roomId)) return failure('请输入正确的六位房间号');
        room = rooms.get(data.roomId.toUpperCase()); if (!room) return failure('房间不存在或已解散');
      } else if (event === 'quickJoin') room = [...rooms.values()].find(r => r.game.phase === 'waiting' && r.game.playerCount < 7 && humanOnline(r));
      if (!room) {
        if (rooms.size >= 200) return failure('当前房间较多，请稍后再试');
        const address = socket.handshake.address;
        const limit = createLimits.get(address) || { start: Date.now(), count: 0 };
        if (Date.now() - limit.start > 60000) { limit.start = Date.now(); limit.count = 0; }
        if (++limit.count > 6) return failure('创建房间太频繁，请稍后再试');
        createLimits.set(address, limit); room = createRoom();
      }
      return join(socket, room, name);
    }, { requireRoom: false });
    command('rejoinRoom', data => {
      if (socket.data.session) return failure('已连接到房间');
      if (typeof data.sessionToken !== 'string') return failure('没有可恢复的连接，请重新加入');
      const session = sessions.get(data.sessionToken), room = session && rooms.get(session.roomId);
      if (!room || !room.game.players.has(session.playerId)) return failure('房间或重连记录已过期，请重新加入');
      return attach(socket, room, session);
    }, { requireRoom: false });
    command('leaveRoom', () => { leave(socket, true); return { success: true }; });
    command('ready', (data, room, session) => {
      if (typeof data.ready !== 'boolean') return failure('准备状态无效');
      if (!room.game.setPlayerReady(session.playerId, data.ready)) return failure('当前无法修改准备状态');
      room.bots.allBotsReady(); return { success: true };
    });
    command('addBot', (data, room) => {
      const result = room.bots.addBot(data.difficulty || 'medium', data.style || 'balanced');
      return result.success ? { success: true, botName: result.bot.name, botId: result.socketId } : result;
    }, { host: true });
    command('removeBot', (data, room) => ({ success: room.bots.removeBot(data.botId), message: '请在两手之间移除有效的机器人' }), { host: true });
    command('action', (data, room, session) => {
      if (typeof data.turnId !== 'string' || data.handId !== room.game.handId) return failure('牌局已更新，请重试');
      return room.game.playerAction(session.playerId, data.action, data.amount ?? 0, data.turnId);
    });
    command('confirmNext', (data, room, session) => data.handId === room.game.handId ? room.game.playerConfirmNext(session.playerId) : failure('本手结果已更新'));
    command('confirmSettlement', (data, room, session) => data.handId === room.game.handId ? room.game.playerConfirmSettlement(session.playerId) : failure('比赛结果已更新'));
    command('rebuy', (data, room, session) => room.game.playerRebuy(session.playerId));
    command('restart', (data, room) => {
      const result = room.game.restartGame();
      if (result.success) { clearScheduled(room); for (const b of room.bots.bots.values()) b.opponentMemory.clear(); }
      return result;
    }, { host: true });
    command('chat', (data, room, session) => {
      if (typeof data.message !== 'string' || !data.message.trim() || data.message.length > 60) return failure('消息需为 1–60 个字符');
      if (Date.now() - chatStart > 10000) { chatStart = Date.now(); chatCount = 0; }
      if (++chatCount > 8) return failure('消息太频繁，请稍后再试');
      io.to(room.game.roomId).emit('chat', { playerName: room.game.players.get(session.playerId).name, message: data.message.trim(), timestamp: Date.now() });
      return { success: true };
    });
    socket.on('disconnect', () => leave(socket, false));
  });
  const housekeeping = setInterval(() => { for (const [address, record] of createLimits) if (Date.now() - record.start > 60000) createLimits.delete(address); }, 60000);
  housekeeping.unref();
  async function close() { closed = true; clearInterval(housekeeping); for (const room of rooms.values()) destroyRoom(room); await pool.close(); await new Promise(resolve => io.close(resolve)); }
  return { app, server, io, rooms, sessions, drive, close };
}
if (require.main === module) {
  const runtime = createPokerServer();
  runtime.server.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log(`Poker server listening on ${runtime.server.address().port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => runtime.close().then(() => process.exit(0)));
}
module.exports = { createPokerServer, PROTOCOL_VERSION };
