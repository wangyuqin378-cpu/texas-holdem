# Texas Hold’em

[简体中文](README.zh-CN.md)

## What it is

A multiplayer poker game that runs in the browser. Create a room, share its code with friends, or fill seats with bots for local practice. A table supports up to seven players and uses virtual chips only; there are no real-money payments.

**Runnable prototype.** Rooms, betting actions, hand evaluation, chat and bots are implemented. Full multiplayer behavior, rules edge cases and production reliability have not been comprehensively verified.

<img src="assets/readme/table.png" width="100%" alt="Actual local browser game: a seven-seat poker table with the demonstration player Player.">

*Local development screenshot using a fictional player, not an online-service availability claim.*

## How to use it

Requires Node.js 18+ and npm.

```sh
git clone https://github.com/wangyuqin378-cpu/texas-holdem.git
cd texas-holdem
npm install
npm start
```

1. Open [localhost:3000](http://localhost:3000), enter a nickname and choose **创建房间** (Create room).
2. Share the room code. Another player can enter it from a second browser session connected to the same server, or you can use **+** on an empty seat to add a bot.
3. Ready the players, then use the on-screen fold, check, call and raise controls as the hand progresses. The interface is currently in Chinese.

On the same local network, friends can use your computer's LAN address and port 3000. The server listens on all network interfaces. If that port is occupied, use `PORT=3001 npm start` and open the corresponding port instead.

Starting chips, blinds and further instructions are in the [game guide (中文)](docs/GAME.zh-CN.md#游戏规则). A successful room launch does not establish correct handling of every poker rule.

## Why this project exists

A browser room is a small, direct way to share a game without installing a client. Poker also makes a useful real-time web experiment: several players must see the same table, act in order and stay synchronized as the state changes.

This project brings those pieces together in a playable prototype, with bots so the basic flow can be explored without assembling a full group.

**License:** source is public; no open-source license has been granted.
