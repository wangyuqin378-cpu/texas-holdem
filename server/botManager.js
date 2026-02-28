/**
 * 机器人管理器
 * 负责创建、管理、调度机器人玩家
 */

const { BotPlayer } = require('./botPlayer');

class BotManager {
  constructor(io, game, roomId) {
    this.io = io;
    this.game = game;
    this.roomId = roomId;
    this.bots = new Map(); // socketId -> BotPlayer
    this.actionQueue = []; // 待处理的机器人行动队列
    this.isProcessing = false;
  }

  /**
   * 添加一个机器人到游戏
   * @param {string} difficulty - 'easy' | 'medium' | 'hard'
   * @returns {Object} { success: boolean, bot?: BotPlayer, message?: string }
   */
  addBot(difficulty = 'medium') {
    if (this.game.playerCount >= 7) {
      return { success: false, message: '房间已满' };
    }

    const botNumber = this.bots.size + 1;
    const bot = new BotPlayer(difficulty, botNumber);
    
    // 生成一个虚拟的socket ID
    const botSocketId = `bot_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    bot.id = botSocketId;

    // 添加到游戏
    const result = this.game.addPlayer(botSocketId, bot.name);
    if (!result.success) {
      return { success: false, message: result.message };
    }

    this.bots.set(botSocketId, bot);
    
    console.log(`机器人加入: ${bot.name} (${difficulty}) - ${this.roomId}`);
    return { success: true, bot, socketId: botSocketId };
  }

  /**
   * 移除指定机器人
   */
  removeBot(botSocketId) {
    const bot = this.bots.get(botSocketId);
    if (!bot) return false;

    this.game.removePlayer(botSocketId);
    this.bots.delete(botSocketId);
    console.log(`机器人离开: ${bot.name} - ${this.roomId}`);
    return true;
  }

  /**
   * 移除所有机器人
   */
  removeAllBots() {
    const botIds = [...this.bots.keys()];
    for (const id of botIds) {
      this.removeBot(id);
    }
  }

  /**
   * 检查当前玩家是否是机器人，如果是则执行决策并返回结果
   * 由外部 handleActionResult 处理后续流转（广播状态、阶段推进、触发下一个机器人）
   * @returns {{ result, player, action }|null}
   */
  async checkAndActBot(gameState) {
    const currentPlayerId = gameState.currentPlayerId;
    if (!currentPlayerId) return null;

    const bot = this.bots.get(currentPlayerId);
    if (!bot) return null; // 不是机器人

    const player = this.game.players.get(bot.id);
    if (!player) return null;

    try {
      // 机器人决策（含模拟思考延迟）
      const decision = await bot.makeDecision(gameState, player);

      // 执行行动
      const result = this.game.playerAction(bot.id, decision.action, decision.amount || 0);

      if (result.success) {
        // 广播行动消息
        this.broadcastBotAction(bot, decision, result);

        // 更新所有机器人的对手记忆
        this.updateAllBotsMemory(bot.id, decision.action, decision.amount || 0, gameState.pot);
      }

      return { result, player, action: decision.action };
    } catch (error) {
      console.error(`机器人行动错误: ${bot.name}`, error);
      return null;
    }
  }

  /**
   * 广播机器人行动
   */
  broadcastBotAction(bot, decision, result) {
    let actionMsg = '';
    const { action, amount } = decision;
    
    switch (action) {
      case 'fold':
        actionMsg = `${bot.name} 弃牌`;
        break;
      case 'check':
        actionMsg = `${bot.name} 过牌`;
        break;
      case 'call':
        actionMsg = `${bot.name} 跟注 ${result.amount || amount}`;
        break;
      case 'raise':
        actionMsg = `${bot.name} 加注 ${result.amount || amount}`;
        break;
      case 'allin':
        actionMsg = `${bot.name} 全下 ${result.amount || amount}`;
        break;
    }

    this.io.to(this.roomId).emit('message', { 
      text: actionMsg, 
      type: 'info', 
      timestamp: Date.now() 
    });
  }

  /**
   * 更新所有机器人的对手记忆
   */
  updateAllBotsMemory(playerId, action, amount, pot) {
    for (const [botId, bot] of this.bots) {
      if (botId !== playerId) {
        bot.updateOpponentMemory(playerId, action, amount, pot);
      }
    }
  }

  /**
   * 机器人准备
   */
  async botReady(botSocketId) {
    const bot = this.bots.get(botSocketId);
    if (!bot) return false;

    const player = this.game.players.get(botSocketId);
    if (!player) return false;

    // 随机延迟 500-1500ms 后准备
    await this._sleep(500 + Math.random() * 1000);
    player.isReady = !player.isReady;
    return true;
  }

  /**
   * 机器人确认下一局
   */
  async botConfirmNext(botSocketId) {
    const bot = this.bots.get(botSocketId);
    if (!bot) return false;

    // 随机延迟后确认
    await this._sleep(300 + Math.random() * 700);
    const result = this.game.playerConfirmNext(botSocketId);
    return result.success;
  }

  /**
   * 机器人确认总结
   */
  async botConfirmSettlement(botSocketId) {
    const bot = this.bots.get(botSocketId);
    if (!bot) return false;

    await this._sleep(300 + Math.random() * 700);
    const result = this.game.playerConfirmSettlement(botSocketId);
    return result.success;
  }

  /**
   * 所有机器人自动重购（筹码为0时）
   */
  autoRebuyAll() {
    for (const botId of this.bots.keys()) {
      const player = this.game.players.get(botId);
      if (player && player.chips === 0) {
        const result = this.game.playerRebuy(botId);
        if (result.success) {
          this.io.to(this.roomId).emit('message', {
            text: `💰 ${player.name} 重购了 ${result.amount} 筹码`,
            type: 'info',
            timestamp: Date.now()
          });
        }
      }
    }
  }

  /**
   * 所有机器人准备
   */
  async allBotsReady() {
    // 准备前先自动重购
    this.autoRebuyAll();
    const promises = [];
    for (const botId of this.bots.keys()) {
      promises.push(this.botReady(botId));
    }
    await Promise.all(promises);
  }

  /**
   * 所有机器人确认下一局
   */
  async allBotsConfirmNext() {
    const promises = [];
    for (const botId of this.bots.keys()) {
      promises.push(this.botConfirmNext(botId));
    }
    await Promise.all(promises);
  }

  /**
   * 所有机器人确认总结
   */
  async allBotsConfirmSettlement() {
    const promises = [];
    for (const botId of this.bots.keys()) {
      promises.push(this.botConfirmSettlement(botId));
    }
    await Promise.all(promises);
  }

  /**
   * 重置所有机器人的轮次记忆
   */
  resetAllBotsRound() {
    for (const bot of this.bots.values()) {
      bot.resetRound();
    }
  }

  /**
   * 获取所有机器人ID列表
   */
  getBotIds() {
    return [...this.bots.keys()];
  }

  /**
   * 检查是否是机器人
   */
  isBot(socketId) {
    return this.bots.has(socketId);
  }

  /**
   * 工具:延迟
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { BotManager };
