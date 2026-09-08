# Stock World UI Demo

An isolated, front-end-only prototype for the proposed Eternal Beings Stock
World flow. It does not connect to a wallet, deploy contracts, or move assets.

## Included flows

- Select a supported Stock Token or quote asset.
- Configure the World identity, NFT supply, and graduation target.
- Allocate the 1% trading fee across World Token holders, NFT holders, and the
  creator. The allocation must total 100% and the creator share is capped at
  30%.
- Simulate bonding-curve buys and sells.
- Run the NFT Commit, Reveal, and Claim sequence with a two-NFT wallet limit.
- Simulate NFT Fusion, participation weight, and fee claims.
- Demonstrate the zero-NFT rule that commits unallocated NFT fees to permanently
  locked liquidity.

## Run locally

No build step or dependencies are required. Open `index.html` directly, or run a
static server from this directory:

```bash
python3 -m http.server 4177
```

Then visit `http://127.0.0.1:4177`.

## Live preview

https://stock-world-demo.eternalbeings.pages.dev

## Scope

This is an interface and economic-flow demonstration. It is not production
contract code, an offer of securities, a promise of returns, or a guarantee of
liquidity or rewards. Supported assets and final parameters remain subject to
contract implementation, testing, and release review.
