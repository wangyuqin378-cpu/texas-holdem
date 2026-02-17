/**
 * 德州扑克在线服务器
 * - 20轮制 + 自动续局
 * - 重购 + 结算
 * - 2分钟倒计时
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { Game, GAME_PHASES } = require('./game');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

app.use(express.static(path.join(__dirname, '..', 'public')));

const rooms = new Map();
const playerRooms = new Map();
const roomTimers = new Map(); // roomId -> timer interval

function createRoom() {
  const roomId = uuidv4().substring(0, 6).toUpperCase();
  const game = new Game(roomId);
  rooms.set(roomId, game);
  return roomId;
}

function broadcastGameState(roomId) {
  const game = rooms.get(roomId);
  if (!game) return;
  for (const [playerId] of game.players) {
    const state = game.getState(playerId);
    io.to(playerId).emit('gameState', state);
  }
}

function broadcastMessage(roomId, message, type = 'info') {
  io.to(roomId).emit('message', { text: message, type, timestamp: Date.now() });
}

// 启动倒计时检测
function startTurnTimer(roomId) {
  clearTurnTimer(roomId);
  const timer = setInterval(() => {
    const game = rooms.get(roomId);
    if (!game) { clearTurnTimer(roomId); return; }
    if (game.phase === GAME_PHASES.WAITING || game.phase === GAME_PHASES.SHOWDOWN || game.phase === GAME_PHASES.SETTLED) {
      return;
    }

    const remaining = game.getTurnTimeRemaining();
    // 每10秒广播一次状态（同步倒计时）
    if (remaining % 10 === 0 || remaining <= 10) {
      broadcastGameState(roomId);
    }
    // 超时
    if (remaining <= 0) {
      const player = game.getCurrentPlayer();
      if (player) {
        broadcastMessage(roomId, `⏰ ${player.name} 操作超时，自动弃牌`);
        const result = game.handleTimeout();
        if (result && result.success) {
          handleActionResult(roomId, game, result, player, 'fold');
        }
      }
    }
  }, 1000);
  roomTimers.set(roomId, timer);
}

function clearTurnTimer(roomId) {
  const timer = roomTimers.get(roomId);
  if (timer) {
    clearInterval(timer);
    roomTimers.delete(roomId);
  }
}

// 统一处理操作结果
function handleActionResult(roomId, game, result, player, action) {
  let actionMsg = '';
  switch (action) {
    case 'fold': actionMsg = `${player.name} 弃牌`; break;
    case 'check': actionMsg = `${player.name} 过牌`; break;
    case 'call': actionMsg = `${player.name} 跟注 ${result.amount}`; break;
    case 'raise': actionMsg = `${player.name} 加注 ${result.amount}`; break;
    case 'allin': actionMsg = `${player.name} 全下 ${result.amount}`; break;
  }
  broadcastMessage(roomId, actionMsg);

  if (result.roundEnded) {
    clearTurnTimer(roomId);

    // 立即广播结果（不弹窗，走消息流）
    const lastResults = game.lastResults;
    if (lastResults) {
      for (const r of lastResults) {
        if (r.winAmount > 0) {
          broadcastMessage(roomId, `🏆 ${r.playerName} +${r.winAmount}${r.handName ? ` (${r.handName})` : ''}`, 'success');
        }
      }
    }
    broadcastGameState(roomId);

    // 2秒后自动开始下一轮（不需要确认）
    setTimeout(() => {
      if (game.prepareNextRound()) {
        if (game.startRound()) {
          broadcastMessage(roomId, `🎴 第 ${game.currentRound}/${game.maxRounds} 轮`, 'phase');
          const nextPlayer = game.getCurrentPlayer();
          if (nextPlayer) {
            broadcastMessage(roomId, `等待 ${nextPlayer.name} 操作...`);
          }
          broadcastGameState(roomId);
          startTurnTimer(roomId);
        }
      } else {
        broadcastMessage(roomId, '🏁 20轮结束！查看结算', 'success');
        broadcastGameState(roomId);
        clearTurnTimer(roomId);
      }
    }, 2500);
  } else {
    broadcastGameState(roomId);
    if (result.phaseChanged) {
      const phaseNames = { flop: '翻牌', turn: '转牌', river: '河牌', showdown: '摊牌' };
      broadcastMessage(roomId, `--- ${phaseNames[result.newPhase] || result.newPhase} ---`, 'phase');
    }
    const nextPlayer = game.getCurrentPlayer();
    if (nextPlayer && game.phase !== GAME_PHASES.SHOWDOWN) {
      broadcastMessage(roomId, `等待 ${nextPlayer.name} 操作...`);
    }
  }
}

io.on('connection', (socket) => {
  console.log(`玩家连接: ${socket.id}`);

  socket.on('createRoom', (data, callback) => {
    const { playerName } = data;
    const roomId = createRoom();
    const game = rooms.get(roomId);
    socket.join(roomId);
    const result = game.addPlayer(socket.id, playerName);
    if (result.success) {
      playerRooms.set(socket.id, roomId);
      callback({ success: true, roomId, seatIndex: result.seatIndex });
      broadcastGameState(roomId);
      broadcastMessage(roomId, `${playerName} 创建了房间`);
    } else {
      callback({ success: false, message: result.message });
    }
  });

  socket.on('joinRoom', (data, callback) => {
    const { roomId, playerName } = data;
    const upperRoomId = roomId.toUpperCase();
    const game = rooms.get(upperRoomId);
    if (!game) { callback({ success: false, message: '房间不存在' }); return; }

    socket.join(upperRoomId);
    const result = game.addPlayer(socket.id, playerName);
    if (result.success) {
      playerRooms.set(socket.id, upperRoomId);
      callback({ success: true, roomId: upperRoomId, seatIndex: result.seatIndex });
      broadcastGameState(upperRoomId);
      broadcastMessage(upperRoomId, `${playerName} 加入了房间`);
    } else {
      callback({ success: false, message: result.message });
    }
  });

  socket.on('quickJoin', (data, callback) => {
    const { playerName } = data;
    let joined = false;
    for (const [roomId, game] of rooms) {
      if (game.playerCount < 7 && (game.phase === GAME_PHASES.WAITING || !game.isGameStarted)) {
        socket.join(roomId);
        const result = game.addPlayer(socket.id, playerName);
        if (result.success) {
          playerRooms.set(socket.id, roomId);
          callback({ success: true, roomId, seatIndex: result.seatIndex });
          broadcastGameState(roomId);
          broadcastMessage(roomId, `${playerName} 加入了房间`);
          joined = true;
          break;
        }
      }
    }
    if (!joined) {
      const roomId = createRoom();
      const game = rooms.get(roomId);
      socket.join(roomId);
      const result = game.addPlayer(socket.id, playerName);
      if (result.success) {
        playerRooms.set(socket.id, roomId);
        callback({ success: true, roomId, seatIndex: result.seatIndex });
        broadcastGameState(roomId);
        broadcastMessage(roomId, `${playerName} 创建了房间`);
      }
    }
  });

  // 准备（首轮需要准备，后续自动）
  socket.on('ready', (callback) => {
    const roomId = playerRooms.get(socket.id);
    if (!roomId) return;
    const game = rooms.get(roomId);
    if (!game) return;

    const player = game.players.get(socket.id);
    if (!player) return;

    player.isReady = !player.isReady;
    broadcastGameState(roomId);
    broadcastMessage(roomId, `${player.name} ${player.isReady ? '已准备' : '取消准备'}`);

    if (game.canStartGame()) {
      setTimeout(() => {
        if (game.canStartGame()) {
          game.startGame();
          broadcastGameState(roomId);
          broadcastMessage(roomId, `🎴 第 ${game.currentRound}/${game.maxRounds} 轮开始！`, 'success');
          const currentPlayer = game.getCurrentPlayer();
          if (currentPlayer) {
            broadcastMessage(roomId, `等待 ${currentPlayer.name} 操作...`);
          }
          startTurnTimer(roomId);
        }
      }, 1000);
    }

    if (typeof callback === 'function') callback({ success: true });
  });

  // 玩家操作
  socket.on('action', (data, callback) => {
    const roomId = playerRooms.get(socket.id);
    if (!roomId) return;
    const game = rooms.get(roomId);
    if (!game) return;

    const { action, amount } = data;
    const player = game.players.get(socket.id);
    if (!player) return;

    const result = game.playerAction(socket.id, action, amount || 0);

    if (result.success) {
      handleActionResult(roomId, game, result, player, action);
    }

    if (typeof callback === 'function') callback(result);
  });

  // 重购积分
  socket.on('rebuy', (callback) => {
    const roomId = playerRooms.get(socket.id);
    if (!roomId) return;
    const game = rooms.get(roomId);
    if (!game) return;

    const result = game.playerRebuy(socket.id);
    if (result.success) {
      const player = game.players.get(socket.id);
      broadcastMessage(roomId, `💰 ${player.name} 重购了 ${result.amount} 筹码`);
      broadcastGameState(roomId);
    }
    if (typeof callback === 'function') callback(result);
  });

  // 重新开始整场
  socket.on('restart', (callback) => {
    const roomId = playerRooms.get(socket.id);
    if (!roomId) return;
    const game = rooms.get(roomId);
    if (!game) return;

    game.restartGame();
    broadcastMessage(roomId, '🔄 比赛已重置，请重新准备', 'success');
    broadcastGameState(roomId);
    if (typeof callback === 'function') callback({ success: true });
  });

  // 聊天
  socket.on('chat', (data) => {
    const roomId = playerRooms.get(socket.id);
    if (!roomId) return;
    const game = rooms.get(roomId);
    if (!game) return;
    const player = game.players.get(socket.id);
    if (!player) return;

    io.to(roomId).emit('chat', {
      playerName: player.name,
      message: data.message,
      timestamp: Date.now(),
    });
  });

  socket.on('disconnect', () => {
    console.log(`玩家断开: ${socket.id}`);
    const roomId = playerRooms.get(socket.id);
    if (!roomId) return;
    const game = rooms.get(roomId);
    if (!game) return;

    const player = game.players.get(socket.id);
    const playerName = player?.name || '未知玩家';

    game.removePlayer(socket.id);
    playerRooms.delete(socket.id);

    broadcastMessage(roomId, `${playerName} 离开了房间`);
    broadcastGameState(roomId);

    if (game.playerCount === 0) {
      clearTurnTimer(roomId);
      rooms.delete(roomId);
      console.log(`房间 ${roomId} 已删除`);
    }
  });
});

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`\n🃏 德州扑克服务器已启动`);
  console.log(`📍 地址: http://${HOST}:${PORT}`);
  console.log(`\n等待玩家加入...\n`);
});
