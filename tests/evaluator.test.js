const {test}=require('node:test');const assert=require('node:assert/strict');
const {evaluateBestHand,compareHands}=require('../server/handEvaluator');const {cards}=require('./helpers');const {Deck}=require('../server/deck');
test('all hand classes, wheel, full house choice, board tie and kicker ordering',()=>{
 const cases=[['As Ks Qs Js Ts 2d 3c',10],['9h 8h 7h 6h 5h As Ac',9],['As Ah Ad Ac Kh Kc 2s',8],['As Ah Ad Ks Kh Kd 2s',7],['As Js 8s 5s 3s Kh Qd',6],['As 2h 3d 4c 5s Kc Qc',5],['As Ah Ad Ks Qh 2d 3c',4],['As Ah Ks Kh Qd Jc 2s',3],['As Ah Ks Qh Jd 2c 3s',2],['As Kh Qd Jc 9s 7c 3h',1]];
 for(const [text,rank]of cases)assert.equal(evaluateBestHand(cards(text)).rank,rank);
 assert(compareHands(evaluateBestHand(cards('As 2h 3d 4c 5s')),evaluateBestHand(cards('2s 3h 4d 5c 6s')))<0);
 assert(compareHands(evaluateBestHand(cards('As Ah Ks Qh Jd')),evaluateBestHand(cards('Ad Ac Kh Qd Ts')))>0);
 assert.equal(compareHands(evaluateBestHand(cards('As Ks Qs Js Ts 2d 3c')),evaluateBestHand(cards('As Ks Qs Js Ts 8d 9c'))),0);
});
test('deck produces 52 unique cards and refuses exhaustion',()=>{const d=new Deck(),all=d.dealMultiple(52);assert.equal(new Set(all.map(c=>c.toString())).size,52);assert.throws(()=>d.deal());});
