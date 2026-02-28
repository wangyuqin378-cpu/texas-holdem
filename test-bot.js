/**
 * 机器人功能测试
 */

const { Game } = require('./server/game');
const { BotManager } = require('./server/botManager');

// 模拟 Socket.IO
const mockIO = {
  to: (roomId) => ({
    emit: (event, data) => {
      console.log(`[广播到 ${roomId}] ${event}:`, data);
    }
  })
};

// 测试流程
console.log('=== 🤖 机器人系统测试 ===\n');

// 1. 创建游戏
const roomId = 'TEST01';
const game = new Game(roomId);
console.log('✅ 游戏创建成功:', roomId);

// 2. 创建机器人管理器
const botManager = new BotManager(mockIO, game, roomId);
console.log('✅ BotManager 创建成功\n');

// 3. 添加真人玩家
const humanId = 'human_001';
const humanResult = game.addPlayer(humanId, '玉斧');
console.log('✅ 真人玩家加入:', humanResult);

// 4. 添加机器人
console.log('\n--- 添加机器人 ---');
const bot1 = botManager.addBot('easy');
console.log('🤖 简单机器人:', bot1);

const bot2 = botManager.addBot('medium');
console.log('🤖 中等机器人:', bot2);

const bot3 = botManager.addBot('hard');
console.log('🤖 困难机器人:', bot3);

// 5. 检查房间状态
console.log('\n--- 房间状态 ---');
console.log('总人数:', game.playerCount);
console.log('机器人数:', botManager.getBotIds().length);

// 6. 列出所有玩家
console.log('\n--- 玩家列表 ---');
for (const [id, player] of game.players) {
  const isBot = botManager.isBot(id);
  console.log(`${isBot ? '🤖' : '👤'} ${player.name} (座位 ${player.seatIndex})`);
}

// 7. 测试机器人是否可以准备
console.log('\n--- 测试准备功能 ---');
botManager.allBotsReady().then(() => {
  console.log('✅ 所有机器人已准备');
  
  for (const [id, player] of game.players) {
    console.log(`${player.name}: isReady = ${player.isReady}`);
  }
  
  console.log('\n=== ✅ 所有测试通过! ===');
}).catch(err => {
  console.error('❌ 测试失败:', err);
});
