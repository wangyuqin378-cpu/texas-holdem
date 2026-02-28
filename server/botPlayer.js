/**
 * 德州扑克AI机器人
 * 三种难度级别:
 * - easy: 基于简单牌力和赔率
 * - medium: 考虑位置、对手风格、适度诈唬
 * - hard: GTO策略 + 动态调整
 */

const { evaluateBestHand, getHandStrength } = require('./handEvaluator');

// 机器人配置
const BOT_CONFIGS = {
  easy: {
    name: 'Bot简单',
    thinkTime: [800, 1500], // 思考时间范围（毫秒）
    bluffFrequency: 0.05,   // 诈唬频率 5%
    aggressiveness: 0.3,    // 激进程度
    foldThreshold: 0.25,    // 弃牌阈值
    callThreshold: 0.5,     // 跟注阈值
    raiseThreshold: 0.7,    // 加注阈值
  },
  medium: {
    name: 'Bot中等',
    thinkTime: [1000, 2000],
    bluffFrequency: 0.15,
    aggressiveness: 0.5,
    foldThreshold: 0.3,
    callThreshold: 0.55,
    raiseThreshold: 0.75,
  },
  hard: {
    name: 'Bot困难',
    thinkTime: [1200, 2500],
    bluffFrequency: 0.20,
    aggressiveness: 0.7,
    foldThreshold: 0.35,
    callThreshold: 0.6,
    raiseThreshold: 0.8,
  }
};

class BotPlayer {
  constructor(difficulty = 'medium', botNumber = 1) {
    this.difficulty = difficulty;
    this.config = BOT_CONFIGS[difficulty];
    this.name = `${this.config.name}${botNumber}`;
    this.id = null; // 由 Game 分配
    this.isBot = true;
    
    // 记忆系统:记录对手行为
    this.opponentMemory = new Map(); // playerId -> { aggression, foldRate, bluffRate }
    this.roundActions = []; // 本轮行动历史
  }

  /**
   * 决策核心:根据当前游戏状态做出行动
   * @param {Object} gameState - 游戏状态
   * @param {Object} player - 机器人玩家对象
   * @returns {Object} { action: 'fold'|'check'|'call'|'raise'|'allin', amount?: number }
   */
  async makeDecision(gameState, player) {
    // 模拟思考时间
    await this._sleep(this._randomThinkTime());

    const { phase, communityCards, pot, currentBet, callAmount, availableActions } = gameState;
    
    // 计算当前手牌强度
    const handStrength = this._evaluateHandStrength(player.holeCards, communityCards);
    
    // 计算赔率
    const potOdds = this._calculatePotOdds(pot, callAmount);
    
    // 位置价值(庄家附近更激进)
    const positionValue = this._getPositionValue(gameState, player);
    
    // 对手画像分析
    const opponentProfile = this._analyzeOpponents(gameState);
    
    // 根据难度级别选择策略
    let decision;
    switch(this.difficulty) {
      case 'easy':
        decision = this._easyStrategy(handStrength, potOdds, availableActions, callAmount, player);
        break;
      case 'medium':
        decision = this._mediumStrategy(handStrength, potOdds, positionValue, opponentProfile, 
                                       availableActions, callAmount, player, gameState);
        break;
      case 'hard':
        decision = this._hardStrategy(handStrength, potOdds, positionValue, opponentProfile,
                                      availableActions, callAmount, player, gameState);
        break;
      default:
        decision = this._easyStrategy(handStrength, potOdds, availableActions, callAmount, player);
    }

    // 记录本次行动
    this.roundActions.push({
      phase,
      action: decision.action,
      handStrength,
      pot,
      timestamp: Date.now()
    });

    return decision;
  }

  /**
   * 简单策略:纯基于牌力和赔率
   */
  _easyStrategy(handStrength, potOdds, availableActions, callAmount, player) {
    const { foldThreshold, callThreshold, raiseThreshold } = this.config;

    // 牌力太弱 -> 弃牌
    if (handStrength < foldThreshold) {
      if (availableActions.includes('check')) return { action: 'check' };
      return { action: 'fold' };
    }

    // 牌力中等 -> 跟注
    if (handStrength < callThreshold) {
      // 赔率不好时弃牌
      if (potOdds < 0.25 && callAmount > player.chips * 0.2) {
        return { action: 'fold' };
      }
      if (availableActions.includes('check')) return { action: 'check' };
      if (availableActions.includes('call')) return { action: 'call' };
      return { action: 'fold' };
    }

    // 牌力很强 -> 加注或全下
    if (handStrength >= raiseThreshold) {
      if (Math.random() < 0.3 && availableActions.includes('allin')) {
        return { action: 'allin' };
      }
      if (availableActions.includes('raise')) {
        const raiseAmount = this._calculateRaiseAmount(player, callAmount, 'conservative');
        return { action: 'raise', amount: raiseAmount };
      }
      if (availableActions.includes('call')) return { action: 'call' };
    }

    // 默认:跟注或过牌
    if (availableActions.includes('check')) return { action: 'check' };
    if (availableActions.includes('call')) return { action: 'call' };
    return { action: 'fold' };
  }

  /**
   * 中等策略:加入位置、对手分析、适度诈唬
   */
  _mediumStrategy(handStrength, potOdds, positionValue, opponentProfile, 
                  availableActions, callAmount, player, gameState) {
    const { bluffFrequency, foldThreshold, callThreshold, raiseThreshold } = this.config;

    // 位置调整后的牌力
    const adjustedStrength = handStrength + (positionValue * 0.1);

    // 诈唬机会:在晚位且对手表现弱时
    const shouldBluff = Math.random() < bluffFrequency 
                        && positionValue > 0.6 
                        && opponentProfile.averageAggression < 0.4;

    if (shouldBluff && handStrength > 0.2) {
      if (availableActions.includes('raise')) {
        const raiseAmount = this._calculateRaiseAmount(player, callAmount, 'moderate');
        return { action: 'raise', amount: raiseAmount };
      }
    }

    // 对抗激进对手:更谨慎
    const effectiveFoldThreshold = opponentProfile.averageAggression > 0.7 
      ? foldThreshold + 0.1 
      : foldThreshold;

    if (adjustedStrength < effectiveFoldThreshold) {
      if (availableActions.includes('check')) return { action: 'check' };
      // 便宜跟注(pot odds好)
      if (potOdds > 0.4 && callAmount < player.chips * 0.1 && availableActions.includes('call')) {
        return { action: 'call' };
      }
      return { action: 'fold' };
    }

    // 中等牌力:根据赔率和对手风格决定
    if (adjustedStrength < callThreshold) {
      if (potOdds > 0.3 || callAmount < player.chips * 0.15) {
        if (availableActions.includes('call')) return { action: 'call' };
        if (availableActions.includes('check')) return { action: 'check' };
      }
      if (availableActions.includes('check')) return { action: 'check' };
      return { action: 'fold' };
    }

    // 强牌:加注或全下
    if (adjustedStrength >= raiseThreshold) {
      // 超强牌:有概率全下
      if (adjustedStrength > 0.9 && Math.random() < 0.4 && availableActions.includes('allin')) {
        return { action: 'allin' };
      }
      if (availableActions.includes('raise')) {
        const raiseAmount = this._calculateRaiseAmount(player, callAmount, 'aggressive');
        return { action: 'raise', amount: raiseAmount };
      }
      if (availableActions.includes('call')) return { action: 'call' };
    }

    // 默认
    if (availableActions.includes('call')) return { action: 'call' };
    if (availableActions.includes('check')) return { action: 'check' };
    return { action: 'fold' };
  }

  /**
   * 困难策略:GTO近似 + 动态平衡
   */
  _hardStrategy(handStrength, potOdds, positionValue, opponentProfile,
                availableActions, callAmount, player, gameState) {
    const { phase, pot } = gameState;
    
    // GTO范围:根据阶段动态调整
    const gtoRanges = this._getGTORanges(phase, positionValue);
    
    // 平衡诈唬和价值下注
    const bluffRange = gtoRanges.bluff;
    const valueRange = gtoRanges.value;
    
    // 极化策略:要么强牌价值下注,要么诈唬,避免中等牌慢打
    const shouldPolarize = positionValue > 0.5 && opponentProfile.foldRate > 0.4;
    
    if (shouldPolarize) {
      // 强牌
      if (handStrength >= valueRange.min) {
        if (availableActions.includes('raise')) {
          // 大pot时下大注
          const sizing = pot > player.chips * 0.5 ? 'large' : 'aggressive';
          const raiseAmount = this._calculateRaiseAmount(player, callAmount, sizing);
          return { action: 'raise', amount: raiseAmount };
        }
        if (availableActions.includes('call')) return { action: 'call' };
      }
      
      // 诈唬范围
      if (handStrength >= bluffRange.min && handStrength <= bluffRange.max 
          && Math.random() < 0.25) {
        if (availableActions.includes('raise')) {
          const raiseAmount = this._calculateRaiseAmount(player, callAmount, 'moderate');
          return { action: 'raise', amount: raiseAmount };
        }
      }
    }

    // 防守vs激进对手:更多跟注
    if (opponentProfile.averageAggression > 0.7) {
      if (handStrength > 0.35 && potOdds > 0.25) {
        if (availableActions.includes('call')) return { action: 'call' };
      }
    }

    // 标准GTO决策树
    if (handStrength < 0.25) {
      if (availableActions.includes('check')) return { action: 'check' };
      if (potOdds > 0.5 && callAmount < player.chips * 0.05) {
        if (availableActions.includes('call')) return { action: 'call' };
      }
      return { action: 'fold' };
    }

    if (handStrength < 0.5) {
      if (potOdds > 0.3 || callAmount < player.chips * 0.1) {
        if (availableActions.includes('call')) return { action: 'call' };
      }
      if (availableActions.includes('check')) return { action: 'check' };
      return { action: 'fold' };
    }

    // 强牌:平衡加注和慢打
    if (handStrength >= 0.75) {
      const slowPlayChance = phase === 'flop' ? 0.2 : 0.1; // 翻牌圈偶尔慢打
      if (Math.random() < slowPlayChance) {
        if (availableActions.includes('check')) return { action: 'check' };
        if (availableActions.includes('call')) return { action: 'call' };
      }
      
      if (handStrength > 0.9 && pot > player.chips * 0.3 && availableActions.includes('allin')) {
        return { action: 'allin' };
      }
      
      if (availableActions.includes('raise')) {
        const raiseAmount = this._calculateRaiseAmount(player, callAmount, 'aggressive');
        return { action: 'raise', amount: raiseAmount };
      }
    }

    // 默认
    if (availableActions.includes('call')) return { action: 'call' };
    if (availableActions.includes('check')) return { action: 'check' };
    return { action: 'fold' };
  }

  /**
   * 评估手牌强度 (0-1)
   */
  _evaluateHandStrength(holeCards, communityCards) {
    if (!holeCards || holeCards.length !== 2) return 0;
    
    const allCards = [...holeCards];
    if (communityCards && communityCards.length > 0) {
      allCards.push(...communityCards);
    }
    
    // 使用handEvaluator获取手牌评分
    const hand = evaluateBestHand(allCards);
    return getHandStrength(hand);
  }

  /**
   * 计算赔率
   */
  _calculatePotOdds(pot, callAmount) {
    if (callAmount === 0) return 1;
    return pot / (pot + callAmount);
  }

  /**
   * 位置价值评估(0-1,越晚位越高)
   */
  _getPositionValue(gameState, player) {
    const { players, currentPlayerId, dealerSeat } = gameState;
    const playerSeat = player.seatIndex;
    const activePlayers = players.filter(p => p.status === 'active' || p.status === 'all_in');
    
    if (activePlayers.length <= 2) return 0.8; // 单挑永远是好位置
    
    // 计算相对于庄家的位置
    const seatsInPlay = activePlayers.map(p => p.seatIndex).sort((a, b) => a - b);
    const dealerIndex = seatsInPlay.indexOf(dealerSeat);
    const myIndex = seatsInPlay.indexOf(playerSeat);
    
    if (dealerIndex === -1 || myIndex === -1) return 0.5;
    
    // 庄家=1, SB=0, 线性分布
    const relativePosition = (myIndex - dealerIndex + seatsInPlay.length) % seatsInPlay.length;
    return relativePosition / seatsInPlay.length;
  }

  /**
   * 分析对手画像
   */
  _analyzeOpponents(gameState) {
    const { players } = gameState;
    let totalAggression = 0;
    let totalFoldRate = 0;
    let count = 0;

    for (const p of players) {
      if (p.id === this.id || !p.isConnected) continue;
      
      const memory = this.opponentMemory.get(p.id) || { aggression: 0.5, foldRate: 0.5, observations: 0 };
      totalAggression += memory.aggression;
      totalFoldRate += memory.foldRate;
      count++;
    }

    return {
      averageAggression: count > 0 ? totalAggression / count : 0.5,
      foldRate: count > 0 ? totalFoldRate / count : 0.5,
    };
  }

  /**
   * 更新对手记忆(在观察到对手行动后调用)
   */
  updateOpponentMemory(playerId, action, amount, pot) {
    if (playerId === this.id) return;
    
    const memory = this.opponentMemory.get(playerId) || { 
      aggression: 0.5, 
      foldRate: 0.5, 
      observations: 0 
    };

    memory.observations++;
    const weight = Math.min(0.2, 1 / memory.observations); // 新观察的权重

    switch(action) {
      case 'fold':
        memory.foldRate = memory.foldRate * (1 - weight) + weight * 1;
        memory.aggression = memory.aggression * (1 - weight) + weight * 0;
        break;
      case 'raise':
      case 'allin':
        memory.aggression = memory.aggression * (1 - weight) + weight * 1;
        memory.foldRate = memory.foldRate * (1 - weight) + weight * 0;
        break;
      case 'call':
        memory.aggression = memory.aggression * (1 - weight) + weight * 0.3;
        memory.foldRate = memory.foldRate * (1 - weight) + weight * 0;
        break;
      case 'check':
        memory.aggression = memory.aggression * (1 - weight) + weight * 0.1;
        break;
    }

    this.opponentMemory.set(playerId, memory);
  }

  /**
   * 计算加注金额
   */
  _calculateRaiseAmount(player, callAmount, sizing = 'moderate') {
    const { chips } = player;
    const availableChips = chips - callAmount;
    
    if (availableChips <= 0) return 0;

    const sizingMultipliers = {
      'conservative': 0.5,  // 半池
      'moderate': 0.75,     // 3/4池
      'aggressive': 1.0,    // 1倍池
      'large': 1.5,         // 1.5倍池
    };

    const multiplier = sizingMultipliers[sizing] || 0.75;
    const baseRaise = Math.floor(callAmount * (1 + multiplier));
    
    // 确保不超过筹码量
    const raiseAmount = Math.min(baseRaise, availableChips);
    
    // 至少加注大盲的1倍
    return Math.max(raiseAmount, 20);
  }

  /**
   * 获取GTO范围(简化版)
   */
  _getGTORanges(phase, positionValue) {
    // 简化的GTO范围:根据阶段和位置
    const ranges = {
      'pre_flop': {
        value: { min: 0.7 + positionValue * 0.1 },
        bluff: { min: 0.15, max: 0.25 }
      },
      'flop': {
        value: { min: 0.65 + positionValue * 0.15 },
        bluff: { min: 0.2, max: 0.35 }
      },
      'turn': {
        value: { min: 0.7 + positionValue * 0.1 },
        bluff: { min: 0.25, max: 0.4 }
      },
      'river': {
        value: { min: 0.75 },
        bluff: { min: 0.3, max: 0.45 }
      }
    };

    return ranges[phase] || ranges['flop'];
  }

  /**
   * 重置轮次记忆
   */
  resetRound() {
    this.roundActions = [];
  }

  /**
   * 工具:随机思考时间
   */
  _randomThinkTime() {
    const [min, max] = this.config.thinkTime;
    return Math.floor(Math.random() * (max - min) + min);
  }

  /**
   * 工具:延迟
   */
  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { BotPlayer, BOT_CONFIGS };
