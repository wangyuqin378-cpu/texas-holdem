# Texas Hold’em

[简体中文](README.zh-CN.md)

A browser poker room for friends, with up to seven players and optional bots. It uses virtual chips only, with no real-money payments.

Create a room, share its six-character code, or fill seats with bots. Each match has 20 hands, 1000 starting chips, and 10/20 blinds. Everyone can inspect complete showdown results before confirming the next hand.

**Status:** the repaired implementation has local rules, Socket.IO and browser regression coverage, including a complete 20-hand match. Production deployment, real-device compatibility and enjoyment remain separate acceptance steps. See the [verification record](docs/VERIFICATION.md) for evidence and limits.

## Start playing

Requires Node.js 18+; Node.js 22 is used in CI.

```sh
git clone https://github.com/wangyuqin378-cpu/texas-holdem.git
cd texas-holdem
npm ci
npm start
```

Open [localhost:3000](http://localhost:3000), enter a nickname and create a room. Friends can join with its code. The host can add bots; all participating humans then select **准备** (Ready). The UI is in Chinese.

The server listens on all network interfaces. On a trusted local network, friends can use the computer's LAN address and port. Set `PORT=3001 npm start` if port 3000 is occupied. The [hosted site](https://texas-holdem-production.up.railway.app/) may run an earlier release until the repair PR is deployed.

## What changed

- Betting rounds terminate correctly after folds and all-ins, with side pots, legal raise reopening and exactly-once payouts.
- Showdown results display every contender's hole cards, best five cards and awards; folded opponents' cards stay hidden.
- Reconnection uses stable identities and random session credentials, with stale-action and duplicate-request protection.
- Bots use public-information equity and range estimates, position and pot odds. Choose easy, standard or challenge difficulty and steady, balanced or active style. No model API is needed; this is not a GTO solver.
- Phone layouts keep cards, actions and chat separate. The final match summary supports confirmation and restart.

## Validate

```sh
npm run check
npm test
npx playwright install chromium
npm run test:browser
npm run test:ai
```

Tests use local fixtures, not production rooms. Dependencies are installed from the lockfile; `node_modules` is not versioned. The browser report is generated in `playwright-report/`.

[Quick start (中文)](QUICK_START.md) · [Rules, protocol and deployment](docs/RULES.md) · [Bot strategy](BOT_README.md) · [Verification](docs/VERIFICATION.md)

## Operational limits

Run a single server instance. Rooms and sessions live in memory, so a restart or deployment ends existing matches. Publish during an idle period and refresh older clients for protocol v2. `/healthz` reports service health and the protocol version.

**License:** source is public; no open-source license has been granted.
