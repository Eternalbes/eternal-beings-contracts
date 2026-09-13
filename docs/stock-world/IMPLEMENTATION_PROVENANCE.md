# Stock World Implementation Provenance

Stock World is an independent Robinhood Chain protocol with its own contracts,
configuration, reward allocation, NFT system, and public identity.

The pre-graduation market implementation intentionally adapts battle-tested
engineering patterns from the MIT-licensed `ponsdotdev/ponsfamily` V2 contracts,
pinned at commit `e9dfc58128e8534d2e9d4d65be18f1dea32c404f`.

The adapted market properties are:

- constant-product pricing with a virtual quote reserve;
- separately tracked reserves so forced token transfers cannot change pricing;
- fees charged only on the quote-asset leg;
- a reserved token boundary and partial final buy;
- buy and sell closure as soon as graduation becomes ready; and
- graduation state committed before external reserve transfers.

Stock World replaces the upstream fee destinations and launch policy with its
own immutable Token/NFT/Creator reward vault and ERC-20 quote-asset registry.
The upstream repository is used as an implementation reference, not as a
runtime dependency or an administrative dependency.
