/**
 * 德州扑克在线服务器
 * - 20轮制 + 全员确认后续局
 * - 重购 + 结算
 * - 2分钟倒计时
 * - 断线重连支持
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { Game, GAME_PHASES } = require('./game');
const { BotManager } = require('./botManager');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 30000,      // 30秒无响应才判定断开（移动端切后台友好）
  pingInterval: 10000,     // 每10秒 ping 一次
});

app.use(express.static(path.join(__dirname, '..', 'public')));

const rooms = new Map();
const botManagers = new Map();       // roomId → BotManager
const playerRooms = new Map();       // socketId → roomId
const roomTimers = new Map();
const disconnectTimers = new Map();  // socketId → { timer, roomId, playerName }
const DISCONNECT_TIMEOUT = 5 * 60 * 1000; // 5分钟断线保护

function createRoom() {
  const roomId = uuidv4().substring(0, 6).toUpperCase();
  const game = new Game(roomId);
  rooms.set(roomId, game);
  // 创建机器人管理器
  const botManager = new BotManager(io, game, roomId);
  botManagers.set(roomId, botManager);
  return roomId;
}

function broadcastGameState(roomId) {
  const game = rooms.get(roomId);
  if (!game) return;
  for (const [playerId, player] of game.players) {
    // 只给在线玩家发送状态
    if (!player.isConnected) continue;
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
    // 非对局阶段直接停止计时器，而非空转
    if (game.phase === GAME_PHASES.WAITING || game.phase === GAME_PHASES.SHOWDOWN || game.phase === GAME_PHASES.SETTLED) {
      clearTurnTimer(roomId);
      return;
    }

    const remaining = game.getTurnTimeRemaining();
    // 只在关键时刻广播（每30秒一次、最后10秒每秒、超时）
    if (remaining <= 10 || remaining % 30 === 0) {
      broadcastGameState(roomId);
    }
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

// 广播本轮结果消息
function broadcastRoundResults(roomId, game) {
  const lastResults = game.lastResults;
  if (lastResults) {
    for (const r of lastResults) {
      if (r.winAmount > 0) {
        broadcastMessage(roomId, `🏆 ${r.playerName} +${r.winAmount}${r.handName ? ` (${r.handName})` : ''}`, 'success');
      }
    }
  }
}

// 进入 SHOWDOWN：广播结果，等待全员确认
async function enterShowdown(roomId, game) {
  clearTurnTimer(roomId);
  broadcastRoundResults(roomId, game);
  broadcastGameState(roomId);
  broadcastMessage(roomId, '📋 请所有人查看结果后点击「确认下一局」');
  
  // 机器人自动确认
  const botManager = botManagers.get(roomId);
  if (botManager) {
    await botManager.allBotsConfirmNext();
    broadcastGameState(roomId);
    
    // 如果全员都确认了,开始下一轮
    if (game.allConfirmedNext) {
      broadcastMessage(roomId, '🚀 全员确认，开始下一轮！', 'success');
      setTimeout(() => {
        tryStartNextRound(roomId, game);
      }, 1000);
    }
  }
}

// 尝试开始下一轮（所有人确认后调用）
async function tryStartNextRound(roomId, game) {
  const botManager = botManagers.get(roomId);
  
  if (!game.prepareNextRound()) {
    broadcastMessage(roomId, '🏁 20轮结束！查看结算', 'success');
    broadcastGameState(roomId);
    
    // 机器人自动确认总结
    if (botManager) {
      await botManager.allBotsConfirmSettlement();
      broadcastGameState(roomId);
    }
    return;
  }

  if (!game.startRound()) {
    // 有筹码的玩家不足2人
    broadcastMessage(roomId, '⚠️ 有筹码的玩家不足2人，请重购后重新准备', 'warning');
    game.phase = GAME_PHASES.WAITING;
    for (const [, p] of game.players) { p.isReady = false; }
    broadcastGameState(roomId);
    return;
  }

  broadcastMessage(roomId, `🎴 第 ${game.currentRound}/${game.maxRounds} 轮`, 'phase');
  const nextPlayer = game.getCurrentPlayer();
  if (nextPlayer) {
    broadcastMessage(roomId, `等待 ${nextPlayer.name} 操作...`);
  }
  broadcastGameState(roomId);
  startTurnTimer(roomId);
  
  // 检查首个玩家是否是机器人
  if (nextPlayer && botManager && botManager.isBot(nextPlayer.id)) {
    const state = game.getState(nextPlayer.id);
    await botManager.checkAndActBot(state);
  }
}

// 统一处理操作结果
async function handleActionResult(roomId, game, result, player, action) {
  const botManager = botManagers.get(roomId);
  
  // 非机器人行动时才广播消息(机器人自己会广播)
  if (!botManager || !botManager.isBot(player.id)) {
    let actionMsg = '';
    switch (action) {
      case 'fold': actionMsg = `${player.name} 弃牌`; break;
      case 'check': actionMsg = `${player.name} 过牌`; break;
      case 'call': actionMsg = `${player.name} 跟注 ${result.amount}`; break;
      case 'raise': actionMsg = `${player.name} 加注 ${result.amount}`; break;
      case 'allin': actionMsg = `${player.name} 全下 ${result.amount}`; break;
    }
    broadcastMessage(roomId, actionMsg);
  }

  if (result.roundEnded || (result.phaseChanged && game.phase === GAME_PHASES.SHOWDOWN)) {
    // 本轮结束 → 进入 SHOWDOWN，等待全员确认
    await enterShowdown(roomId, game);
  } else {
    // 正常推进
    broadcastGameState(roomId);
    if (result.phaseChanged) {
      const phaseNames = { flop: '翻牌', turn: '转牌', river: '河牌' };
      broadcastMessage(roomId, `--- ${phaseNames[result.newPhase] || result.newPhase} ---`, 'phase');
      startTurnTimer(roomId);
    }
    const nextPlayer = game.getCurrentPlayer();
    if (nextPlayer && game.phase !== GAME_PHASES.SHOWDOWN) {
      broadcastMessage(roomId, `等待 ${nextPlayer.name} 操作...`);
      
      // 检查是否轮到机器人,如果是则触发行动
      if (botManager && botManager.isBot(nextPlayer.id)) {
        const state = game.getState(nextPlayer.id);
        await botManager.checkAndActBot(state);
      }
    }
  }
}

/**
 * 尝试自动重连：检查房间中是否有同名断线玩家
 * 如果有，执行重连并返回 player；否则返回 null
 */
function tryAutoReconnect(socket, game, roomId, playerName) {
  let oldPlayerId = null;
  for (const [pid, player] of game.players) {
    if (player.name === playerName && !player.isConnected) {
      oldPlayerId = pid;
      break;
    }
  }
  if (!oldPlayerId) return null;

  // 取消断线计时器
  const dcInfo = disconnectTimers.get(oldPlayerId);
  if (dcInfo) {
    clearTimeout(dcInfo.timer);
    disconnectTimers.delete(oldPlayerId);
  }

  const player = game.reconnectPlayer(oldPlayerId, socket.id);
  if (!player) return null;

  socket.join(roomId);
  playerRooms.set(socket.id, roomId);
  playerRooms.delete(oldPlayerId);

  console.log(`自动重连: ${playerName} (${oldPlayerId} → ${socket.id}) 房间 ${roomId}`);
  broadcastMessage(roomId, `🔄 ${playerName} 重新连接`);
  broadcastGameState(roomId);
  return player;
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

    // 检查是否有同名断线玩家 → 自动走重连
    const reconnected = tryAutoReconnect(socket, game, upperRoomId, playerName);
    if (reconnected) {
      callback({ success: true, roomId: upperRoomId, seatIndex: reconnected.seatIndex });
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

  // 断线重连
  socket.on('rejoinRoom', (data, callback) => {
    const { roomId, playerName } = data;
    const upperRoomId = roomId.toUpperCase();
    const game = rooms.get(upperRoomId);
    if (!game) {
      callback({ success: false, message: '房间不存在或已解散' });
      return;
    }

    const player = tryAutoReconnect(socket, game, upperRoomId, playerName);
    if (player) {
      callback({ success: true, roomId: upperRoomId, seatIndex: player.seatIndex });
    } else {
      callback({ success: false, message: '未找到断线记录，请重新加入' });
    }
  });

  socket.on('quickJoin', (data, callback) => {
    const { playerName } = data;
    let joined = false;

    // 先检查所有房间是否有同名断线玩家 → 自动重连
    for (const [roomId, game] of rooms) {
      const reconnected = tryAutoReconnect(socket, game, roomId, playerName);
      if (reconnected) {
        callback({ success: true, roomId, seatIndex: reconnected.seatIndex });
        return;
      }
    }

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

  // 添加机器人
  socket.on('addBot', (data, callback) => {
    const roomId = playerRooms.get(socket.id);
    if (!roomId) {
      if (typeof callback === 'function') callback({ success: false, message: '你不在任何房间' });
      return;
    }
    const game = rooms.get(roomId);
    const botManager = botManagers.get(roomId);
    if (!game || !botManager) {
      if (typeof callback === 'function') callback({ success: false, message: '房间不存在' });
      return;
    }

    const difficulty = data?.difficulty || 'medium';
    const result = botManager.addBot(difficulty);
    
    if (result.success) {
      broadcastGameState(roomId);
      broadcastMessage(roomId, `🤖 ${result.bot.name} 加入了房间`);
      if (typeof callback === 'function') callback({ success: true, botName: result.bot.name });
    } else {
      if (typeof callback === 'function') callback(result);
    }
  });

  // 移除所有机器人
  socket.on('removeAllBots', (callback) => {
    const roomId = playerRooms.get(socket.id);
    if (!roomId) {
      if (typeof callback === 'function') callback({ success: false, message: '你不在任何房间' });
      return;
    }
    const botManager = botManagers.get(roomId);
    if (!botManager) {
      if (typeof callback === 'function') callback({ success: false, message: '房间不存在' });
      return;
    }

    const botIds = botManager.getBotIds();
    botManager.removeAllBots();
    
    broadcastGameState(roomId);
    if (botIds.length > 0) {
      broadcastMessage(roomId, `🤖 所有机器人已移除`);
    }
    if (typeof callback === 'function') callback({ success: true, count: botIds.length });
  });

  // 准备（首轮需要准备，后续全员确认续局）
  socket.on('ready', async (callback) => {
    const roomId = playerRooms.get(socket.id);
    if (!roomId) return;
    const game = rooms.get(roomId);
    const botManager = botManagers.get(roomId);
    if (!game) return;

    const player = game.players.get(socket.id);
    if (!player) return;

    player.isReady = !player.isReady;
    broadcastGameState(roomId);
    broadcastMessage(roomId, `${player.name} ${player.isReady ? '已准备' : '取消准备'}`);

    // 机器人也准备
    if (botManager && player.isReady) {
      await botManager.allBotsReady();
      broadcastGameState(roomId);
    }

    if (game.canStartGame()) {
      setTimeout(async () => {
        if (game.canStartGame()) {
          game.startGame();
          broadcastGameState(roomId);
          broadcastMessage(roomId, `🎴 第 ${game.currentRound}/${game.maxRounds} 轮开始！`, 'success');
          const currentPlayer = game.getCurrentPlayer();
          if (currentPlayer) {
            broadcastMessage(roomId, `等待 ${currentPlayer.name} 操作...`);
          }
          startTurnTimer(roomId);
          
          // 检查首个玩家是否是机器人
          if (currentPlayer && botManager && botManager.isBot(currentPlayer.id)) {
            const state = game.getState(currentPlayer.id);
            await botManager.checkAndActBot(state);
          }
        }
      }, 1000);
    }

    if (typeof callback === 'function') callback({ success: true });
  });

  // 确认下一局（SHOWDOWN 阶段）
  socket.on('confirmNext', (callback) => {
    const roomId = playerRooms.get(socket.id);
    if (!roomId) return;
    const game = rooms.get(roomId);
    if (!game) return;

    const player = game.players.get(socket.id);
    if (!player) return;

    const result = game.playerConfirmNext(socket.id);
    if (!result.success) {
      if (typeof callback === 'function') callback(result);
      return;
    }

    broadcastMessage(roomId, `✅ ${player.name} 确认 (${game.confirmedNextPlayers.size}/${game.players.size})`);
    broadcastGameState(roomId);

    // 全员确认 → 开始下一轮
    if (game.allConfirmedNext) {
      broadcastMessage(roomId, '🚀 全员确认，开始下一轮！', 'success');
      setTimeout(() => {
        tryStartNextRound(roomId, game);
      }, 1000);
    }

    if (typeof callback === 'function') callback({ success: true });
  });


  // 确认总结（20轮结束后）
  socket.on('confirmSettlement', (callback) => {
    const roomId = playerRooms.get(socket.id);
    if (!roomId) return;
    const game = rooms.get(roomId);
    if (!game) return;

    const player = game.players.get(socket.id);
    if (!player) return;

    const result = game.playerConfirmSettlement(socket.id);
    if (!result.success) {
      if (typeof callback === 'function') callback(result);
      return;
    }

    broadcastMessage(roomId, `✅ ${player.name} 已确认总结 (${game.confirmedSettlement.size}/${game.players.size})`);
    broadcastGameState(roomId);

    if (game.allConfirmedSettlement) {
      broadcastMessage(roomId, '🎉 全员确认！现在可以开始新的比赛了', 'success');
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

    if (game.phase !== GAME_PHASES.WAITING && game.phase !== GAME_PHASES.SHOWDOWN && game.phase !== GAME_PHASES.SETTLED) {
      if (typeof callback === 'function') callback({ success: false, message: '对局进行中，无法重购' });
      return;
    }

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

    // 在 SETTLED 阶段需要所有人确认后才能重启
    if (game.phase === GAME_PHASES.SETTLED) {
      if (!game.allConfirmedSettlement) {
        if (typeof callback === 'function') {
          callback({ success: false, message: '需要所有玩家确认总结后才能重新开始' });
        }
        return;
      }
    }

    game.restartGame();
    clearTurnTimer(roomId);
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
    if (!player) return;
    const playerName = player.name;

    // 标记断线，而不是立即移除
    const dcResult = game.markDisconnected(socket.id);
    broadcastMessage(roomId, `⚠️ ${playerName} 断线（5分钟内可重连）`, 'warning');

    // 检查所有已连接的玩家数量
    const connectedPlayers = [...game.players.values()].filter(p => p.isConnected);
    if (connectedPlayers.length === 0) {
      clearTurnTimer(roomId);
    }

    // 如果断线触发了 endRound
    if (dcResult && dcResult.roundEnded && game.phase === GAME_PHASES.SHOWDOWN) {
      enterShowdown(roomId, game);
    } else if (game.phase === GAME_PHASES.SHOWDOWN && game.allConfirmedNext) {
      broadcastMessage(roomId, '🚀 全员确认，开始下一轮！', 'success');
      setTimeout(() => {
        tryStartNextRound(roomId, game);
      }, 1000);
    } else {
      broadcastGameState(roomId);
    }

    // 5分钟后真正移除玩家
    const dcTimer = setTimeout(() => {
      disconnectTimers.delete(socket.id);
      const currentGame = rooms.get(roomId);
      if (!currentGame) return;
      const currentPlayer = currentGame.players.get(socket.id);
      if (!currentPlayer || currentPlayer.isConnected) return;

      console.log(`断线超时移除: ${playerName} (${socket.id})`);
      const wasInGame = currentGame.isGameStarted
        && currentGame.phase !== GAME_PHASES.WAITING
        && currentGame.phase !== GAME_PHASES.SETTLED
        && currentGame.phase !== GAME_PHASES.SHOWDOWN;

      currentGame.removePlayer(socket.id);
      playerRooms.delete(socket.id);
      broadcastMessage(roomId, `${playerName} 断线超时，已移出房间`);

      if (currentGame.playerCount === 0) {
        clearTurnTimer(roomId);
        rooms.delete(roomId);
        console.log(`房间 ${roomId} 已删除`);
        return;
      }

      if (wasInGame && currentGame.phase === GAME_PHASES.SHOWDOWN) {
        enterShowdown(roomId, currentGame);
      } else if (currentGame.phase === GAME_PHASES.SHOWDOWN && currentGame.allConfirmedNext) {
        broadcastMessage(roomId, '🚀 全员确认，开始下一轮！', 'success');
        setTimeout(() => {
          tryStartNextRound(roomId, currentGame);
        }, 1000);
      } else {
        broadcastGameState(roomId);
      }
    }, DISCONNECT_TIMEOUT);

    disconnectTimers.set(socket.id, { timer: dcTimer, roomId, playerName });
  });
});

// 定期清理：无人在线的房间
setInterval(() => {
  for (const [roomId, game] of rooms) {
    const connectedPlayers = [...game.players.values()].filter(p => p.isConnected);
    if (connectedPlayers.length === 0 && game.players.size === 0) {
      clearTurnTimer(roomId);
      rooms.delete(roomId);
      console.log(`[清理] 空房间 ${roomId} 已删除`);
    }
  }
}, 60 * 1000); // 每分钟检查一次

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`\n🃏 德州扑克服务器已启动`);
  console.log(`📍 地址: http://${HOST}:${PORT}`);
  console.log(`\n等待玩家加入...\n`);
});
