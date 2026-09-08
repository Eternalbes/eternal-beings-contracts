(function () {
  "use strict";

  const STORAGE_KEY = "eternal-stock-world-demo-v3";
  const pairedAssets = [
    "ETH", "NVDA", "SPCX", "GOOGL", "TSLA", "GME", "AAPL", "SPY", "SNDK", "AMD",
    "AMZN", "MSFT", "META", "CRCL", "COIN", "MU", "PLTR", "TTWO", "RIVN", "COST",
    "DJT", "MSTR", "QQQ", "RDDT", "HIMS", "BB", "GLD", "cbBTC", "USDG", "LLY",
    "WYFI", "TSM", "RBLX", "SKHY", "DELL", "USO", "SNAP", "LULU", "FIG", "MRNA",
    "PFE", "MRVL", "JNJ", "AMC", "SGOV", "BABA", "INDA", "IBM", "NFLX", "BULL",
    "NU", "SLV", "SHOP", "BE", "F", "UPS", "TAO"
  ];
  const assetNames = {
    ETH: "Ether", NVDA: "NVIDIA", SPCX: "SpaceX", GOOGL: "Alphabet", TSLA: "Tesla", GME: "GameStop",
    AAPL: "Apple", SPY: "S&P 500 ETF", SNDK: "SanDisk", AMD: "AMD", AMZN: "Amazon", MSFT: "Microsoft",
    META: "Meta", CRCL: "Circle", COIN: "Coinbase", MU: "Micron", PLTR: "Palantir", TTWO: "Take-Two",
    RIVN: "Rivian", COST: "Costco", DJT: "Trump Media", MSTR: "Strategy", QQQ: "Nasdaq 100 ETF",
    RDDT: "Reddit", HIMS: "Hims & Hers", BB: "BlackBerry", GLD: "Gold ETF", cbBTC: "Coinbase Bitcoin",
    USDG: "Global Dollar", LLY: "Eli Lilly", TSM: "TSMC", RBLX: "Roblox", DELL: "Dell", USO: "Oil Fund",
    SNAP: "Snap", LULU: "Lululemon", MRNA: "Moderna", PFE: "Pfizer", MRVL: "Marvell", JNJ: "Johnson & Johnson",
    AMC: "AMC", BABA: "Alibaba", IBM: "IBM", NFLX: "Netflix", SLV: "Silver ETF", SHOP: "Shopify", F: "Ford", UPS: "UPS"
  };
  const defaults = {
    split: { token: 40, nft: 40, creator: 20 },
    selectedAsset: "NVDA",
    worldName: "NVSignal World",
    worldSymbol: "NVSIGNAL",
    nftMaxSupply: 1000,
    created: false,
    tradeMode: "buy",
    target: 41.6,
    raised: 0,
    liquidityReserve: 0,
    unallocatedNftFees: 0,
    wallet: { nvda: 0, world: 0 },
    mintedTotal: 0,
    nextNftId: 1,
    nfts: [],
    rewards: { token: 0, nft: 0, creator: 0 },
    claimed: 0,
    graduated: false,
    fairLaunch: {
      phase: "commit",
      epoch: 1,
      commitments: 0,
      reveals: 0,
      claims: 0,
      walletCommitted: false,
      walletRevealed: false,
      walletClaims: 0
    },
    activity: []
  };

  let state = loadState();
  const $ = (id) => document.getElementById(id);
  const money = (value, digits = 4) => Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const worldAmount = (value) => Number(value || 0).toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  const totalWeight = () => state.nfts.reduce((sum, nft) => sum + nft.weight, 0);
  const totalRewards = () => state.rewards.token + state.rewards.nft + state.rewards.creator;
  const curvePrice = () => 0.00005 + (Math.min(state.raised / state.target, 1) * 0.00005);
  const quote = () => state.selectedAsset;
  const worldSymbol = () => state.worldSymbol;

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      return saved ? Object.assign(structuredClone(defaults), saved) : structuredClone(defaults);
    } catch (_) {
      return structuredClone(defaults);
    }
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function addActivity(label, amount, detail) {
    state.activity.unshift({ label, amount, detail, time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) });
    state.activity = state.activity.slice(0, 10);
  }

  function showView(name) {
    if (name !== "create" && !state.created) name = "create";
    document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === `${name}View`));
    document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === name));
    location.hash = name;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function renderStockGrid(filter = "") {
    const query = filter.trim().toLowerCase();
    const matches = pairedAssets.filter((ticker) => `${ticker} ${assetNames[ticker] || "Stock Token"}`.toLowerCase().includes(query));
    $("stockGrid").innerHTML = matches.map((ticker) => `
      <button class="stock-option ${ticker === state.selectedAsset ? "active" : ""}" data-stock="${ticker}" type="button">
        <strong>${ticker}</strong><small>${escapeHtml(assetNames[ticker] || "Robinhood asset")}</small>
      </button>`).join("") || '<p class="empty-state">No paired assets match this search.</p>';
    $("assetCount").textContent = `${matches.length} ASSETS`;
    document.querySelectorAll(".stock-option").forEach((button) => button.addEventListener("click", () => {
      state.selectedAsset = button.dataset.stock;
      $("selectedStockLabel").textContent = state.selectedAsset;
      $("targetAsset").textContent = state.selectedAsset;
      $("checkPair").textContent = state.selectedAsset;
      updateCreatePairSummary();
      renderStockGrid($("stockSearch").value);
    }));
  }

  function updateCreatePairSummary() {
    const symbol = ($("worldSymbolInput").value || "WORLD").trim().toUpperCase();
    $("createPairSummary").textContent = `${symbol} / ${state.selectedAsset}`;
  }

  function renderCreateSplits() {
    const token = Number($("createTokenSplit").value);
    const nft = Number($("createNftSplit").value);
    const creator = Number($("createCreatorSplit").value);
    const total = token + nft + creator;
    $("createTokenOutput").textContent = `${token}%`;
    $("createNftOutput").textContent = `${nft}%`;
    $("createCreatorOutput").textContent = `${creator}%`;
    $("createSplitStatus").textContent = total === 100 ? "100% ALLOCATED" : `${Math.abs(100 - total)}% ${total < 100 ? "UNALLOCATED" : "OVER LIMIT"}`;
    $("createSplitStatus").className = total === 100 ? "status-ok" : "status-error";
    $("createWorldButton").disabled = total !== 100;
  }

  function createDemoWorld() {
    const name = $("worldNameInput").value.trim();
    const symbol = $("worldSymbolInput").value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    const supply = Number($("nftSupplyInput").value);
    const target = Number($("targetInput").value);
    if (!name || !symbol) return setCreateMessage("World name and token symbol are required.", true);
    if (!Number.isFinite(supply) || supply < 100 || supply > 10000) return setCreateMessage("NFT supply must be between 100 and 10,000.", true);
    if (!Number.isFinite(target) || target <= 0) return setCreateMessage("Enter a valid graduation target.", true);

    state.worldName = name;
    state.worldSymbol = symbol;
    state.nftMaxSupply = Math.floor(supply);
    state.target = target;
    state.split = {
      token: Number($("createTokenSplit").value),
      nft: Number($("createNftSplit").value),
      creator: Number($("createCreatorSplit").value)
    };
    state.created = true;
    state.tradeMode = "buy";
    state.raised = target * 0.2;
    state.liquidityReserve = target * 0.153846;
    state.unallocatedNftFees = target * 0.020192;
    state.wallet = { nvda: target * 1.25, world: 0 };
    state.mintedTotal = 0;
    state.nextNftId = 1;
    state.nfts = [];
    state.rewards = { token: 0, nft: 0, creator: target * 0.01369 };
    state.claimed = 0;
    state.graduated = false;
    state.fairLaunch = structuredClone(defaults.fairLaunch);
    state.activity = [];
    addActivity("Demo World created", `${symbol}/${state.selectedAsset}`, `${state.split.token}/${state.split.nft}/${state.split.creator} fee split`);
    saveState();
    render();
    showView("overview");
  }

  function setCreateMessage(text, error) {
    $("createMessage").textContent = text;
    $("createMessage").className = `inline-message ${error ? "error" : "success"}`;
  }

  function distributeFee(fee) {
    const tokenFee = fee * state.split.token / 100;
    const nftFee = fee * state.split.nft / 100;
    const creatorFee = fee * state.split.creator / 100;

    if (state.wallet.world > 0) state.rewards.token += tokenFee;
    else state.liquidityReserve += tokenFee;

    if (totalWeight() > 0) state.rewards.nft += nftFee;
    else state.unallocatedNftFees += nftFee;

    state.rewards.creator += creatorFee;
    return { tokenFee, nftFee, creatorFee };
  }

  function graduateIfReady() {
    if (!state.graduated && state.raised >= state.target) {
      state.graduated = true;
      state.liquidityReserve += state.raised;
      state.raised = state.target;
      addActivity("World graduated", `${money(state.target)} ${quote()}`, "V4 liquidity locked");
    }
  }

  function tradePreview() {
    const amount = Math.max(0, Number($("tradeAmount").value || 0));
    const price = curvePrice();
    const isBuy = state.tradeMode === "buy";
    const grossQuote = isBuy ? amount : amount * price * 0.97;
    const fee = grossQuote * 0.01;
    const receive = isBuy ? Math.max(0, amount - fee) / price : Math.max(0, grossQuote - fee);
    const impact = Math.min(12, (grossQuote / Math.max(state.raised, 1)) * 2.4);

    $("tradeInputLabel").textContent = isBuy ? "YOU PAY" : "YOU SELL";
    $("tradeInputAsset").textContent = isBuy ? quote() : worldSymbol();
    $("tradeBalance").textContent = isBuy ? `Balance ${money(state.wallet.nvda)} ${quote()}` : `Balance ${worldAmount(state.wallet.world)} ${worldSymbol()}`;
    $("tradeReceive").textContent = isBuy ? `${worldAmount(receive)} ${worldSymbol()}` : `${money(receive)} ${quote()}`;
    $("tradeFee").textContent = `${money(fee)} ${quote()} · 1%`;
    $("priceImpact").textContent = `${impact.toFixed(2)}%`;
    $("feeBreakdown").textContent = `${state.split.token} / ${state.split.nft} / ${state.split.creator}`;
    $("executeTradeButton").textContent = isBuy ? `Buy ${worldSymbol()}` : `Sell ${worldSymbol()}`;
    return { amount, grossQuote, fee, receive, price };
  }

  function executeTrade() {
    const preview = tradePreview();
    const message = $("tradeMessage");
    message.className = "inline-message";
    if (preview.amount <= 0) return setTradeMessage("Enter an amount greater than zero.", true);
    if (state.graduated) return setTradeMessage("This demo World has graduated. Curve trading is closed.", true);

    if (state.tradeMode === "buy") {
      if (preview.amount > state.wallet.nvda) return setTradeMessage(`Insufficient demo ${quote()} balance.`, true);
      state.wallet.nvda -= preview.amount;
      state.wallet.world += preview.receive;
      state.raised += preview.amount - preview.fee;
      distributeFee(preview.fee);
      addActivity(`Bought ${worldSymbol()}`, `-${money(preview.amount)} ${quote()}`, `${worldAmount(preview.receive)} ${worldSymbol()} received`);
      setTradeMessage(`Bought ${worldAmount(preview.receive)} ${worldSymbol()}.`, false);
    } else {
      if (preview.amount > state.wallet.world) return setTradeMessage(`Insufficient demo ${worldSymbol()} balance.`, true);
      if (preview.receive > state.raised) return setTradeMessage("Curve reserve cannot cover this sale.", true);
      state.wallet.world -= preview.amount;
      state.wallet.nvda += preview.receive;
      state.raised -= preview.grossQuote;
      distributeFee(preview.fee);
      addActivity(`Sold ${worldSymbol()}`, `+${money(preview.receive)} ${quote()}`, `${worldAmount(preview.amount)} ${worldSymbol()} sold`);
      setTradeMessage(`Received ${money(preview.receive)} ${quote()}.`, false);
    }
    graduateIfReady();
    saveState();
    render();
  }

  function setTradeMessage(text, error) {
    $("tradeMessage").textContent = text;
    $("tradeMessage").className = `inline-message ${error ? "error" : "success"}`;
  }

  function issueNft() {
    if (state.mintedTotal >= state.nftMaxSupply) return;
    if (state.mintedTotal === 0 && state.unallocatedNftFees > 0) {
      const swept = state.unallocatedNftFees;
      state.liquidityReserve += swept;
      state.unallocatedNftFees = 0;
      addActivity("Zero-NFT fees committed", `+${money(swept)} ${quote()}`, "Automatically added to locked liquidity reserve");
    }
    state.nfts.push({ id: state.nextNftId++, level: "Origin", weight: 1 });
    state.mintedTotal += 1;
    addActivity("World NFT minted", "+1 WEIGHT", `Being #${state.nextNftId - 1}`);
    saveState();
    render();
  }

  function commitMint() {
    const fair = state.fairLaunch;
    if (fair.phase !== "commit" || fair.walletCommitted || fair.walletClaims >= 2) return;
    fair.walletCommitted = true;
    fair.commitments += 1;
    addActivity("NFT mint committed", `EPOCH ${fair.epoch}`, "Secret stored in this browser");
    $("fairLaunchMessage").textContent = "Commitment saved. Advance to Reveal when the phase opens.";
    $("fairLaunchMessage").className = "inline-message success";
    saveState();
    render();
  }

  function revealMint() {
    const fair = state.fairLaunch;
    if (fair.phase !== "reveal" || !fair.walletCommitted || fair.walletRevealed) return;
    fair.walletRevealed = true;
    fair.reveals += 1;
    addActivity("NFT mint revealed", `EPOCH ${fair.epoch}`, "Eligible for randomized claim");
    $("fairLaunchMessage").textContent = "Reveal accepted. Advance to Claim for the allocation result.";
    $("fairLaunchMessage").className = "inline-message success";
    saveState();
    render();
  }

  function claimMint() {
    const fair = state.fairLaunch;
    if (fair.phase !== "claim" || !fair.walletRevealed || fair.walletClaims >= 2) return;
    issueNft();
    fair.claims += 1;
    fair.walletClaims += 1;
    fair.walletCommitted = false;
    fair.walletRevealed = false;
    $("fairLaunchMessage").textContent = "NFT claimed fairly. It now participates only in future NFT fee rewards.";
    $("fairLaunchMessage").className = "inline-message success";
    saveState();
    render();
  }

  function advanceFairPhase() {
    const fair = state.fairLaunch;
    if (fair.phase === "commit") fair.phase = "reveal";
    else if (fair.phase === "reveal") fair.phase = "claim";
    else {
      fair.phase = "commit";
      fair.epoch += 1;
      fair.walletCommitted = false;
      fair.walletRevealed = false;
    }
    addActivity("NFT launch phase advanced", fair.phase.toUpperCase(), `Epoch ${fair.epoch}`);
    saveState();
    render();
  }

  function fuseNfts() {
    if (state.nfts.length < 2) return;
    const first = state.nfts.shift();
    const second = state.nfts.shift();
    const newWeight = Math.max(3, first.weight + second.weight + 1);
    state.nfts.unshift({ id: state.nextNftId++, level: "Fusion I", weight: newWeight });
    addActivity("NFT Fusion complete", `+${newWeight} WEIGHT`, `Beings #${first.id} and #${second.id} fused`);
    saveState();
    render();
  }

  function commitToLiquidity() {
    if (state.mintedTotal > 0 || state.unallocatedNftFees <= 0) return;
    const amount = state.unallocatedNftFees;
    state.liquidityReserve += amount;
    state.unallocatedNftFees = 0;
    addActivity("Creator committed NFT fees", `+${money(amount)} ${quote()}`, "Permanent liquidity reserve");
    saveState();
    render();
  }

  function claim(kind) {
    const amount = state.rewards[kind] || 0;
    if (amount <= 0) return;
    state.rewards[kind] = 0;
    state.wallet.nvda += amount;
    state.claimed += amount;
    const labels = { token: "Token-holder rewards claimed", nft: "NFT-holder rewards claimed", creator: "Creator rewards claimed" };
    addActivity(labels[kind], `+${money(amount)} ${quote()}`, "Sent to connected demo wallet");
    saveState();
    render();
  }

  function claimAll() {
    const amount = totalRewards();
    if (amount <= 0) return;
    state.rewards = { token: 0, nft: 0, creator: 0 };
    state.wallet.nvda += amount;
    state.claimed += amount;
    addActivity("All rewards claimed", `+${money(amount)} ${quote()}`, "3 reward categories settled");
    saveState();
    render();
  }

  function renderSplits() {
    const token = Number($("tokenSplit").value);
    const nft = Number($("nftSplit").value);
    const creator = Number($("creatorSplit").value);
    const total = token + nft + creator;
    $("tokenSplitOutput").textContent = `${token}%`;
    $("nftSplitOutput").textContent = `${nft}%`;
    $("creatorSplitOutput").textContent = `${creator}%`;
    $("splitTotal").textContent = `${total}%`;
    $("splitStatus").textContent = total === 100 ? "100% ALLOCATED" : `${Math.abs(100 - total)}% ${total < 100 ? "UNALLOCATED" : "OVER LIMIT"}`;
    $("splitStatus").className = total === 100 ? "status-ok" : "status-error";
    $("applySplitButton").disabled = total !== 100;
    $("splitTotal").style.color = total === 100 ? "var(--white)" : "var(--red)";
    document.querySelector(".split-chart").style.background = `conic-gradient(var(--cyan) 0 ${token}%, var(--yellow) ${token}% ${token + nft}%, var(--white) ${token + nft}% ${Math.min(total, 100)}%, #202526 ${Math.min(total, 100)}% 100%)`;
  }

  function renderActivity() {
    $("activityList").innerHTML = state.activity.map((item) => `
      <div class="activity-item">
        <time>${escapeHtml(item.time)}</time>
        <div><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(item.amount)}</strong></div>
        <small>${escapeHtml(item.detail)}</small>
      </div>`).join("");
  }

  function renderNfts() {
    const weight = totalWeight();
    $("nftList").innerHTML = state.nfts.length ? state.nfts.map((nft) => `
      <div class="nft-item"><b>BEING #${nft.id}</b><span>${escapeHtml(nft.level)}</span><small>${nft.weight} REWARD WEIGHT</small></div>`).join("") : '<p class="empty-state">No World NFTs minted in this demo.</p>';
    $("mintedCount").textContent = state.mintedTotal;
    $("mintMaxSupply").textContent = state.nftMaxSupply.toLocaleString("en-US");
    $("fairMaxSupply").textContent = state.nftMaxSupply.toLocaleString("en-US");
    $("fusionNftCount").textContent = state.nfts.length;
    $("fusionWeight").textContent = weight;
    $("eligibleWeightHeader").textContent = weight;
    $("collectionSummary").textContent = `${state.nfts.length} NFTs · ${weight} WEIGHT`;
    $("fusionButton").disabled = state.nfts.length < 2;
    $("walletNfts").textContent = `${state.nfts.length} NFTs`;
    $("walletWeight").textContent = weight;

    const commitDisabled = state.mintedTotal > 0 || state.unallocatedNftFees <= 0;
    $("commitLiquidityButton").disabled = commitDisabled;
    $("unallocatedNftFees").textContent = money(state.unallocatedNftFees);
    if (state.mintedTotal > 0) {
      $("commitExplanation").textContent = "NFT fee distribution is active. Creator liquidity commitment is permanently disabled.";
      $("commitRule").textContent = "Future NFT fees are distributed by eligible NFT weight.";
    } else if (state.unallocatedNftFees <= 0) {
      $("commitExplanation").textContent = "All zero-NFT fees have been permanently committed to liquidity.";
      $("commitRule").textContent = "The reserve cannot be withdrawn by the creator or platform.";
    } else {
      $("commitExplanation").textContent = "No NFTs exist. The creator may permanently commit all unallocated NFT fees to locked liquidity.";
      $("commitRule").textContent = "Disabled permanently after the first NFT is minted.";
    }
  }

  function renderFairLaunch() {
    const fair = state.fairLaunch;
    const phaseData = {
      commit: { title: "COMMIT", description: "Submit a hidden mint commitment. No wallet can see another wallet's choice.", next: "NEXT: REVEAL", progress: 33.33 },
      reveal: { title: "REVEAL", description: "Reveal the saved secret during the open window to enter the fair allocation.", next: "NEXT: CLAIM", progress: 66.66 },
      claim: { title: "CLAIM", description: "Claim the randomized NFT result. New NFTs receive no historical fee rewards.", next: "NEXT: NEW EPOCH", progress: 100 }
    }[fair.phase];
    $("fairPhaseTitle").textContent = phaseData.title;
    $("fairPhaseDescription").textContent = phaseData.description;
    $("fairNextPhase").textContent = phaseData.next;
    $("fairEpoch").textContent = fair.epoch;
    $("fairCountdown").textContent = fair.phase === "commit" ? "02:00" : fair.phase === "reveal" ? "01:00" : "OPEN";
    $("fairProgressBar").style.width = `${phaseData.progress}%`;
    $("commitCount").textContent = fair.commitments;
    $("revealCount").textContent = fair.reveals;
    $("claimCount").textContent = fair.claims;
    $("fairCommitButton").disabled = fair.phase !== "commit" || fair.walletCommitted || fair.walletClaims >= 2;
    $("fairRevealButton").disabled = fair.phase !== "reveal" || !fair.walletCommitted || fair.walletRevealed;
    $("fairClaimButton").disabled = fair.phase !== "claim" || !fair.walletRevealed || fair.walletClaims >= 2;
    $("fairCommitButton").textContent = fair.walletCommitted ? "Committed" : "Commit Mint";
    $("fairRevealButton").textContent = fair.walletRevealed ? "Revealed" : "Reveal";
    $("fairClaimButton").textContent = fair.walletClaims >= 2 ? "Wallet Limit Reached" : "Claim NFT";
  }

  function render() {
    const progress = Math.min(100, state.raised / state.target * 100);
    const priceText = `${curvePrice().toFixed(6)} ${quote()}`;
    const weight = totalWeight();
    const rewardTotal = totalRewards();
    const activeRewards = Object.values(state.rewards).filter((value) => value > 0).length;

    document.querySelectorAll(".tab").forEach((tab) => { tab.disabled = tab.dataset.view !== "create" && !state.created; });

    $("phaseLabel").textContent = state.graduated ? "GRADUATED" : "CURVE LIVE";
    $("phaseDetail").textContent = state.graduated ? "V4 liquidity permanently locked" : `Raising ${quote()} for graduation`;
    $("marketStateBadge").textContent = state.graduated ? "GRADUATED" : "LIVE";
    $("graduationPercent").textContent = `${progress.toFixed(1)}%`;
    $("raisedMetric").textContent = `${money(state.raised, 2)} / ${money(state.target, 2)} ${quote()}`;
    $("raisedLarge").textContent = money(state.raised);
    $("marketRaised").textContent = `${money(state.raised)} / ${money(state.target)} ${quote()}`;
    $("graduationBar").style.width = `${progress}%`;
    $("marketGraduationBar").style.width = `${progress}%`;
    $("curvePrice").textContent = priceText;
    $("marketPrice").textContent = priceText;
    $("liquidityReserve").textContent = `${money(state.liquidityReserve)} ${quote()}`;
    $("unallocatedOverview").textContent = `${money(state.unallocatedNftFees)} ${quote()}`;
    $("walletNvda").textContent = `${money(state.wallet.nvda)} ${quote()}`;
    $("walletWorld").textContent = `${worldAmount(state.wallet.world)} ${worldSymbol()}`;
    $("tokenReward").textContent = `${money(state.rewards.token)} ${quote()}`;
    $("nftReward").textContent = `${money(state.rewards.nft)} ${quote()}`;
    $("creatorReward").textContent = `${money(state.rewards.creator)} ${quote()}`;
    $("totalClaimable").textContent = `${money(rewardTotal)} ${quote()}`;
    $("totalClaimableHeader").textContent = `${money(rewardTotal)} ${quote()}`;
    $("claimAllAmount").textContent = `${money(rewardTotal)} ${quote()}`;
    $("rewardCategoryCount").textContent = `${activeRewards} active reward ${activeRewards === 1 ? "category" : "categories"}`;
    $("rewardBadge").textContent = activeRewards;
    $("tokenRewardBasis").textContent = `${worldAmount(state.wallet.world)} ${worldSymbol()} held`;
    $("nftRewardBasis").textContent = `${state.nfts.length} NFTs · ${weight} weight`;
    $("claimAllButton").disabled = rewardTotal <= 0;
    document.querySelectorAll(".claim-button").forEach((button) => { button.disabled = state.rewards[button.dataset.claim] <= 0; });
    $("executeTradeButton").disabled = state.graduated;
    $("buyMode").classList.toggle("active", state.tradeMode === "buy");
    $("sellMode").classList.toggle("active", state.tradeMode === "sell");
    $("tokenSplit").value = state.split.token;
    $("nftSplit").value = state.split.nft;
    $("creatorSplit").value = state.split.creator;
    $("overviewPairEyebrow").textContent = quote();
    $("overviewWorldName").textContent = state.worldName;
    $("overviewPairName").textContent = assetNames[quote()] ? `${assetNames[quote()]} (${quote()})` : quote();
    $("overviewSymbol").textContent = `$${worldSymbol()}`;
    $("overviewPairAsset").textContent = quote();
    $("overviewPairMarket").textContent = `${worldSymbol()} / ${quote()}`;
    $("targetLabel").textContent = `TARGET ${money(state.target, 2)} ${quote()}`;
    $("selectedStockLabel").textContent = quote();
    $("targetAsset").textContent = quote();
    $("checkPair").textContent = quote();
    $("worldNameInput").value = state.worldName;
    $("worldSymbolInput").value = state.worldSymbol;
    $("nftSupplyInput").value = state.nftMaxSupply;
    $("targetInput").value = state.target;
    $("createTokenSplit").value = state.split.token;
    $("createNftSplit").value = state.split.nft;
    $("createCreatorSplit").value = state.split.creator;
    updateCreatePairSummary();
    renderCreateSplits();
    renderSplits();
    renderNfts();
    renderFairLaunch();
    renderActivity();
    tradePreview();
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
  }

  document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => showView(tab.dataset.view)));
  document.querySelectorAll("[data-go]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.go)));
  ["tokenSplit", "nftSplit", "creatorSplit"].forEach((id) => $(id).addEventListener("input", renderSplits));
  $("applySplitButton").addEventListener("click", () => {
    state.split = { token: Number($("tokenSplit").value), nft: Number($("nftSplit").value), creator: Number($("creatorSplit").value) };
    addActivity("Fee split updated", `${state.split.token}/${state.split.nft}/${state.split.creator}`, "Demo launch configuration");
    saveState();
    render();
  });
  $("buyMode").addEventListener("click", () => { state.tradeMode = "buy"; render(); });
  $("sellMode").addEventListener("click", () => { state.tradeMode = "sell"; render(); });
  $("tradeAmount").addEventListener("input", tradePreview);
  $("executeTradeButton").addEventListener("click", executeTrade);
  $("stockSearch").addEventListener("input", () => renderStockGrid($("stockSearch").value));
  $("worldSymbolInput").addEventListener("input", updateCreatePairSummary);
  ["createTokenSplit", "createNftSplit", "createCreatorSplit"].forEach((id) => $(id).addEventListener("input", renderCreateSplits));
  $("createWorldButton").addEventListener("click", createDemoWorld);
  $("fairCommitButton").addEventListener("click", commitMint);
  $("fairRevealButton").addEventListener("click", revealMint);
  $("fairClaimButton").addEventListener("click", claimMint);
  $("advancePhaseButton").addEventListener("click", advanceFairPhase);
  document.querySelectorAll("[data-focus-fair-launch]").forEach((button) => button.addEventListener("click", () => document.querySelector(".fair-launch-panel").scrollIntoView({ behavior: "smooth" })));
  $("fusionButton").addEventListener("click", fuseNfts);
  $("commitLiquidityButton").addEventListener("click", commitToLiquidity);
  document.querySelectorAll(".claim-button").forEach((button) => button.addEventListener("click", () => claim(button.dataset.claim)));
  $("claimAllButton").addEventListener("click", claimAll);
  $("resetButton").addEventListener("click", () => {
    state = structuredClone(defaults);
    saveState();
    showView("create");
    render();
  });
  window.addEventListener("hashchange", () => {
    const name = location.hash.slice(1);
    if (["create", "overview", "market", "nfts", "rewards"].includes(name)) showView(name);
  });

  renderStockGrid();
  const requestedView = ["create", "overview", "market", "nfts", "rewards"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "create";
  const initialView = state.created ? requestedView : "create";
  showView(initialView);
  render();
}());
