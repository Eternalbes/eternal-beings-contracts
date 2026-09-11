# Eternal Beings 3D World Concept Demo

This is a read-only visual prototype. It reads public state from the deployed Ethereum Mainnet Eternal Beings contract and deterministically projects that state into an interactive Three.js character.

Live demo: [https://eternalbeings.space/world-demo/](https://eternalbeings.space/world-demo/)

- No wallet connection
- No transaction signing
- No contract writes
- Hunt, evolution, and hybrid actions are local simulations only
- Space attacks nearby Chain Fragments, shows a floating `+ORE` gain, and increases a clearly labeled local simulation balance

The combat, Hunt, evolution, hybrid, and ORE behavior in this directory are interface experiments. They do not represent an on-chain transaction or actual ORE issuance.

Install and build from this directory:

```bash
npm install
npm run build
npm run serve
```

Then open `http://127.0.0.1:4175/`.
