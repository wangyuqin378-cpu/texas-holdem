# Texas Hold’em

[简体中文](README.zh-CN.md)

**A browser-based multiplayer poker experiment for up to seven players.**

Create a room, invite friends with its room code, or add bots to explore the game locally. Built for learning and casual play with virtual chips; no real-money payments are included.

**Stage:** runnable web-game prototype. Room handling, betting actions, hand evaluation, chat and bots exist in the source. The full multiplayer experience, poker edge cases and production reliability are not comprehensively verified.

## Run locally

Requires Node.js 18+ and npm.

```bash
git clone https://github.com/wangyuqin378-cpu/texas-holdem.git
cd texas-holdem
npm install
npm start
```

Open [localhost:3000](http://localhost:3000), create a room and add a bot or join from a second browser session. The server listens on all network interfaces; friends on the same network can use your computer's LAN address and the same port. Use `PORT=3001 npm start` if port 3000 is occupied.

## What is implemented

- Room creation, room-code joining and quick join.
- Up to seven players, including optional bots.
- Blinds, four betting rounds, hand evaluation and common betting actions.
- Room chat and virtual-chip rebuys.

The starting settings and game rules are described in the [Chinese guide](README.zh-CN.md#游戏规则). This is a prototype, not a certified rules engine or production gambling service.

## Project layout

- `server/index.js`: HTTP server and Socket.IO room events.
- `server/game.js`, `server/deck.js`, `server/handEvaluator.js`: game logic.
- `server/botManager.js`: bot behavior.
- `public/`: browser interface.

## License

The source is publicly visible. No open-source license has been granted in this repository.
