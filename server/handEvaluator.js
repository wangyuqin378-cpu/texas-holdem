/**
 * 德州扑克手牌评估器
 * 评估 5-7 张牌中的最佳 5 张组合
 */

const HAND_RANKS = {
  ROYAL_FLUSH: 10,
  STRAIGHT_FLUSH: 9,
  FOUR_OF_A_KIND: 8,
  FULL_HOUSE: 7,
  FLUSH: 6,
  STRAIGHT: 5,
  THREE_OF_A_KIND: 4,
  TWO_PAIR: 3,
  ONE_PAIR: 2,
  HIGH_CARD: 1,
};

const HAND_NAMES = {
  10: '皇家同花顺',
  9: '同花顺',
  8: '四条',
  7: '葫芦',
  6: '同花',
  5: '顺子',
  4: '三条',
  3: '两对',
  2: '一对',
  1: '高牌',
};

/**
 * 从 n 张牌中取 5 张的所有组合
 */
function combinations(arr, k) {
  const result = [];
  function combine(start, combo) {
    if (combo.length === k) {
      result.push([...combo]);
      return;
    }
    for (let i = start; i < arr.length; i++) {
      combo.push(arr[i]);
      combine(i + 1, combo);
      combo.pop();
    }
  }
  combine(0, []);
  return result;
}

/**
 * 评估 5 张牌的牌型
 */
function evaluate5(cards) {
  const sorted = [...cards].sort((a, b) => b.value - a.value);
  const values = sorted.map(c => c.value);
  const suits = sorted.map(c => c.suit);

  const isFlush = suits.every(s => s === suits[0]);

  // 检查顺子（含 A-2-3-4-5 小顺子）
  let isStraight = false;
  let straightHigh = 0;

  // 普通顺子
  if (values[0] - values[4] === 4 && new Set(values).size === 5) {
    isStraight = true;
    straightHigh = values[0];
  }
  // A-2-3-4-5 小顺子
  if (values[0] === 14 && values[1] === 5 && values[2] === 4 && values[3] === 3 && values[4] === 2) {
    isStraight = true;
    straightHigh = 5; // 5 高
  }

  // 统计面值出现次数
  const counts = {};
  for (const v of values) {
    counts[v] = (counts[v] || 0) + 1;
  }
  const countValues = Object.values(counts).sort((a, b) => b - a);
  // 按出现次数降序、再按面值降序
  const groupedValues = Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || Number(b[0]) - Number(a[0]))
    .map(e => Number(e[0]));

  let rank, kickers;

  if (isFlush && isStraight && straightHigh === 14) {
    rank = HAND_RANKS.ROYAL_FLUSH;
    kickers = [14];
  } else if (isFlush && isStraight) {
    rank = HAND_RANKS.STRAIGHT_FLUSH;
    kickers = [straightHigh];
  } else if (countValues[0] === 4) {
    rank = HAND_RANKS.FOUR_OF_A_KIND;
    kickers = groupedValues;
  } else if (countValues[0] === 3 && countValues[1] === 2) {
    rank = HAND_RANKS.FULL_HOUSE;
    kickers = groupedValues;
  } else if (isFlush) {
    rank = HAND_RANKS.FLUSH;
    kickers = values;
  } else if (isStraight) {
    rank = HAND_RANKS.STRAIGHT;
    kickers = [straightHigh];
  } else if (countValues[0] === 3) {
    rank = HAND_RANKS.THREE_OF_A_KIND;
    kickers = groupedValues;
  } else if (countValues[0] === 2 && countValues[1] === 2) {
    rank = HAND_RANKS.TWO_PAIR;
    kickers = groupedValues;
  } else if (countValues[0] === 2) {
    rank = HAND_RANKS.ONE_PAIR;
    kickers = groupedValues;
  } else {
    rank = HAND_RANKS.HIGH_CARD;
    kickers = values;
  }

  return { rank, kickers, name: HAND_NAMES[rank], cards: sorted };
}

/**
 * 比较两手牌的大小
 * 返回正数表示 a 赢, 负数表示 b 赢, 0 表示平局
 */
function compareHands(a, b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  for (let i = 0; i < Math.min(a.kickers.length, b.kickers.length); i++) {
    if (a.kickers[i] !== b.kickers[i]) return a.kickers[i] - b.kickers[i];
  }
  return 0;
}

/**
 * 从最多 7 张牌中找到最佳的 5 张组合
 */
function evaluateBestHand(cards) {
  if (cards.length < 5) {
    throw new Error('至少需要 5 张牌');
  }
  if (cards.length === 5) {
    return evaluate5(cards);
  }

  const combos = combinations(cards, 5);
  let best = null;

  for (const combo of combos) {
    const result = evaluate5(combo);
    if (!best || compareHands(result, best) > 0) {
      best = result;
    }
  }

  return best;
}

/**
 * 确定多个玩家中的赢家
 * players: [{ id, cards }] 其中 cards 是手牌+公共牌
 * 返回赢家数组（可能有多个，平局时）
 */
function determineWinners(players) {
  const evaluated = players.map(p => ({
    ...p,
    hand: evaluateBestHand(p.cards),
  }));

  evaluated.sort((a, b) => compareHands(b.hand, a.hand));

  const best = evaluated[0].hand;
  const winners = evaluated.filter(p => compareHands(p.hand, best) === 0);

  return winners;
}

module.exports = {
  evaluateBestHand,
  determineWinners,
  compareHands,
  HAND_RANKS,
  HAND_NAMES,
};
