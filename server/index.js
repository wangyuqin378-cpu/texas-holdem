/**
 * 德州扑克在线服务器
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

// 静态文件
app.use(express.static(path.join(__dirname, '..', 'public')));

// 房间管理
const rooms = new Map();
// 玩家 -> 房间映射
const playerRooms = new Map();

function createRoom() {
  const roomId = uuidv4().substring(0, 6).toUpperCase();
  const game = new Game(roomId);
  rooms.set(roomId, game);
  return roomId;
}

function broadcastGameState(roomId) {
  const game = rooms.get(roomId);
  if (!game) return;

  // 给每个玩家发送他们各自视角的状态
  for (const [playerId, player] of game.players) {
    const state = game.getState(playerId);
    io.to(playerId).emit('gameState', state);
  }
}

function broadcastMessage(roomId, message, type = 'info') {
  io.to(roomId).emit('message', { text: message, type, timestamp: Date.now() });
}

io.on('connection', (socket) => {
  console.log(`玩家连接: ${socket.id}`);

  // 创建房间
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

  // 加入房间
  socket.on('joinRoom', (data, callback) => {
    const { roomId, playerName } = data;
    const upperRoomId = roomId.toUpperCase();
    const game = rooms.get(upperRoomId);

    if (!game) {
      callback({ success: false, message: '房间不存在' });
      return;
    }

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

  // 快速加入（加入任意有空位的房间或创建新房间）
  socket.on('quickJoin', (data, callback) => {
    const { playerName } = data;
    let joined = false;

    // 寻找有空位的房间
    for (const [roomId, game] of rooms) {
      if (game.playerCount < 7 && game.phase === GAME_PHASES.WAITING) {
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
      // 创建新房间
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

  // 准备
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

    // 检查是否可以自动开始
    if (game.canStartGame()) {
      setTimeout(() => {
        if (game.canStartGame()) {
          game.startGame();
          broadcastGameState(roomId);
          broadcastMessage(roomId, '🎴 游戏开始！', 'success');

          const currentPlayer = game.getCurrentPlayer();
          if (currentPlayer) {
            broadcastMessage(roomId, `等待 ${currentPlayer.name} 操作...`);
          }
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
        broadcastGameState(roomId);
        const lastResults = game.lastResults;
        if (lastResults) {
          for (const r of lastResults) {
            if (r.winAmount > 0) {
              broadcastMessage(
                roomId,
                `🏆 ${r.playerName} 赢得 ${r.winAmount} 筹码${r.handName ? ` (${r.handName})` : ''}`,
                'success'
              );
            }
          }
        }

        // 5秒后重置
        setTimeout(() => {
          game.resetForNewRound();
          broadcastGameState(roomId);
          broadcastMessage(roomId, '准备下一局，请点击"准备"按钮');
        }, 5000);
      } else {
        broadcastGameState(roomId);
        if (result.phaseChanged) {
          const phaseNames = {
            flop: '翻牌',
            turn: '转牌',
            river: '河牌',
            showdown: '摊牌',
          };
          broadcastMessage(roomId, `--- ${phaseNames[result.newPhase] || result.newPhase} ---`, 'phase');
        }
        const nextPlayer = game.getCurrentPlayer();
        if (nextPlayer && game.phase !== GAME_PHASES.SHOWDOWN) {
          broadcastMessage(roomId, `等待 ${nextPlayer.name} 操作...`);
        }
      }
    }

    if (typeof callback === 'function') callback(result);
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

  // 断开连接
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

    // 如果房间空了，删除房间
    if (game.playerCount === 0) {
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
