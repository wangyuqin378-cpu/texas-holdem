const { test, expect } = require('@playwright/test');
const { createPokerServer } = require('../server/index');
const { Deck } = require('../server/deck');
const { seededRandom } = require('../server/botStrategy');
let runtime,url;
test.beforeAll(async()=>{runtime=createPokerServer({transitionDelay:40,botDelay:10,rateLimit:10000});await new Promise(r=>runtime.server.listen(0,'127.0.0.1',r));url=`http://127.0.0.1:${runtime.server.address().port}`;});
test.afterAll(async()=>{await runtime.close();});
async function create(page,name='测试玩家') {await page.goto(url);await page.locator('#playerName').fill(name);await expect(page.locator('#btnCreateRoom')).toBeEnabled();await page.locator('#btnCreateRoom').click();await expect(page.locator('#gameScreen')).toHaveClass(/active/);return (await page.locator('#roomIdDisplay').textContent()).split(' ').at(-1);}
async function join(page,room,name){await page.goto(url);await page.locator('#playerName').fill(name);await page.locator('#roomIdInput').fill(room);await expect(page.locator('#btnJoinRoom')).toBeEnabled();await page.locator('#btnJoinRoom').click();await expect(page.locator('#gameScreen')).toHaveClass(/active/);}
async function actHand(pages,room){let guard=0;while(runtime.rooms.get(room).game.isLive&&guard++<100){let acted=false;for(const page of pages){const button=page.locator('#btnCheck:visible, #btnCall:visible').first();if(await button.count()&&await button.isEnabled()){await button.click();acted=true;break;}}if(!acted)await expect.poll(()=>pages.some(p=>p.isClosed())).toBe(false);await new Promise(r=>setTimeout(r,15));}expect(runtime.rooms.get(room).game.phase).toBe('showdown');}
async function noOverflow(page){expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
async function noControlsOverlap(page, target, controls) {
 expect(await page.evaluate(({target,controls})=>{
  const a=document.querySelector(target).getBoundingClientRect(),b=document.querySelector(controls).getBoundingClientRect();
  return !(a.left<b.right && a.right>b.left && a.top<b.bottom && a.bottom>b.top);
 },{target,controls})).toBe(true);
}
async function seatsDoNotOverlap(page) {
 await expect.poll(()=>page.locator('.seat-inner').evaluateAll(nodes => {
  const rects=nodes.map(n=>n.getBoundingClientRect());
  return rects.flatMap((a,i)=>rects.flatMap((b,j)=>i>=j || !(a.left<b.right && a.right>b.left && a.top<b.bottom && a.bottom>b.top) ? [] : [{i,j,a:a.toJSON(),b:b.toJSON()}]));
 })).toEqual([]);
}

test('three players: folding first actor still reveals flop and every showdown hand',async({browser},testInfo)=>{
 const contexts=await Promise.all([0,1,2].map(()=>browser.newContext({viewport:{width:1440,height:960}})));
 const pages=await Promise.all(contexts.map(c=>c.newPage()));const errors=[];pages.forEach(p=>p.on('pageerror',e=>errors.push(e.message)));
 try{const room=await create(pages[0],'玩家甲');await join(pages[1],room,'玩家乙');await join(pages[2],room,'玩家丙');
  for(const p of pages)await p.locator('#btnReady').click();await expect(pages[0].locator('#btnFold')).toBeVisible();await pages[0].locator('#btnFold').click();
  await expect(pages[1].locator('#btnCall')).toBeVisible();await pages[1].locator('#btnCall').click();await expect(pages[2].locator('#btnCheck')).toBeVisible();await pages[2].locator('#btnCheck').click();
  await expect(pages[1].locator('#communityCards .face-up')).toHaveCount(3);await actHand(pages,room);
  for(const page of pages){await expect(page.locator('.result-hole .face-up')).toHaveCount(4);await expect(page.locator('.result-best .face-up')).toHaveCount(10);await expect(page.locator('.result-board .face-up')).toHaveCount(5);await noOverflow(page);}
  await pages[0].screenshot({path:testInfo.outputPath('desktop-showdown.png'),fullPage:true});expect(errors).toEqual([]);
 }finally{await Promise.all(contexts.map(c=>c.close()));}
});

test('20 hands in two independent browser sessions, summary and next match',async({browser},testInfo)=>{
 const contexts=await Promise.all([0,1].map(()=>browser.newContext({viewport:{width:390,height:844}}))),pages=await Promise.all(contexts.map(c=>c.newPage()));const errors=[];pages.forEach(p=>p.on('pageerror',e=>errors.push(e.message)));
 try{const room=await create(pages[0],'<img src=x>');await join(pages[1],room,'朋友');runtime.rooms.get(room).game.deck=new Deck(seededRandom(20));
  for(const p of pages)await p.locator('#btnReady').click();await expect(pages[0].locator('#btnCall')).toBeVisible();
  for(let round=1;round<=20;round++){
   await actHand(pages,room);for(const p of pages)await expect(p.locator('.result-hole .face-up')).toHaveCount(4);
   if(round===1){await noOverflow(pages[0]);await noControlsOverlap(pages[0],'#handResults','#showdownBar');await pages[0].screenshot({path:testInfo.outputPath('mobile-showdown.png'),fullPage:true});}
   for(const p of pages)await p.locator('#btnConfirmNext').click();
   if(round<20)await expect(pages[0].locator('#roundDisplay')).toHaveText(`第 ${round+1}/20 轮`);
  }
  for(const p of pages){await expect(p.locator('#settlementOverlay')).toBeVisible();await expect(p.locator('.settlement-name')).toHaveCount(2);expect(await p.locator('#settlementList img').count()).toBe(0);await p.locator('#btnConfirmSettlement').click();}
  await expect(pages[0].locator('#btnRestart')).toBeEnabled();await pages[0].locator('.settlement-content').focus();await pages[0].keyboard.press('Shift+Tab');await expect(pages[0].locator('#btnRestart')).toBeFocused();await pages[0].screenshot({path:testInfo.outputPath('mobile-summary.png'),fullPage:true});
  await pages[0].locator('#btnViewLastHand').click();await expect(pages[0].locator('#handResults')).toBeVisible();await pages[0].locator('#btnOpenSettlement').click();await pages[0].locator('#btnRestart').click();
  await expect(pages[1].locator('#roundDisplay')).toHaveText('等待开始');expect(errors).toEqual([]);
 }finally{await Promise.all(contexts.map(c=>c.close()));}
});

test('seven-seat phone and landscape controls stay reachable; bot defaults and refresh',async({browser},testInfo)=>{
 const context=await browser.newContext({viewport:{width:375,height:812}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 try{const room=await create(page);for(let i=0;i<6;i++){await page.locator('#btnAddBot').click();await expect(page.locator('#playerCountDisplay')).toHaveText(`${i+2}/7`);}
  expect([...runtime.rooms.get(room).bots.bots.values()].every(b=>b.difficulty==='medium')).toBe(true);
  expect(new Set([...runtime.rooms.get(room).bots.bots.values()].map(b=>b.style)).size).toBe(3);
  await noOverflow(page);await seatsDoNotOverlap(page);const before=[...runtime.rooms.get(room).game.players.keys()];await page.reload();await expect(page.locator('#gameScreen')).toHaveClass(/active/);expect([...runtime.rooms.get(room).game.players.keys()]).toEqual(before);
  await page.screenshot({path:testInfo.outputPath('seven-seats-mobile.png'),fullPage:true});
  await page.locator('#btnReady').click();await expect(page.locator('#btnCall')).toBeVisible();await expect(page.locator('.seat-remove-bot:visible')).toHaveCount(0);
  await page.locator('#btnRaise').click();await expect(page.locator('#raiseSummary')).toContainText('本次支付');await noOverflow(page);
  await page.setViewportSize({width:844,height:390});await noOverflow(page);await noControlsOverlap(page,'.poker-table','#actionBar');await seatsDoNotOverlap(page);await page.screenshot({path:testInfo.outputPath('seven-seats-landscape.png'),fullPage:true});
  await page.locator('#btnFold').click();await expect(page.locator('#handResults')).toBeVisible({timeout:20000});await expect(page.locator('#btnConfirmNext')).toBeVisible();expect(errors).toEqual([]);
 }finally{await context.close();}
});
