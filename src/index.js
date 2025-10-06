require('dotenv').config();
const axios = require('axios');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const MARKET_ABI = require('./abis/Market.json');
const ERC20_ABI = require('./abis/ERC20.json');
const ERC1155_ABI = require('./abis/ERC1155.json');
const TradeTracker = require('./tradeTracker');

// ========= Config =========
const RPC_URL = process.env.RPC_URL;
const CHAIN_ID = parseInt(process.env.CHAIN_ID || '8453', 10);
const TARGET_WALLET = process.env.TARGET_WALLET; // Wallet to monitor
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '15000', 10);
const BET_MULTIPLIER = process.env.BET_MULTIPLIER ? Number(process.env.BET_MULTIPLIER) : 1.0;
const MIN_BET_USDC = process.env.MIN_BET_USDC ? Number(process.env.MIN_BET_USDC) : 1;
const MAX_BET_USDC = process.env.MAX_BET_USDC ? Number(process.env.MAX_BET_USDC) : 100;
const SLIPPAGE_BPS = process.env.SLIPPAGE_BPS ? Number(process.env.SLIPPAGE_BPS) : 200; // 2%
const GAS_PRICE_GWEI = process.env.GAS_PRICE_GWEI ? String(process.env.GAS_PRICE_GWEI) : '0.005';
const CONFIRMATIONS = parseInt(process.env.CONFIRMATIONS || '1', 10);

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const STATE_FILE = process.env.STATE_FILE || path.join('data', 'state.json');

if (!RPC_URL) {
  console.error('❌ RPC_URL is required');
  process.exit(1);
}
if (!TARGET_WALLET || !ethers.isAddress(TARGET_WALLET)) {
  console.error('❌ Valid TARGET_WALLET is required');
  process.exit(1);
}
if (!PRIVATE_KEY) {
  console.error('❌ PRIVATE_KEY is required');
  process.exit(1);
}

const MAX_GAS_ETH = process.env.MAX_GAS_ETH ? Number(process.env.MAX_GAS_ETH) : 0.015;
const MAX_GAS_WEI = (() => { try { return ethers.parseEther(String(MAX_GAS_ETH)); } catch { return ethers.parseEther('0.015'); } })();

// State tracking
const lastSeenPositions = new Map(); // marketSlug -> { outcomeIndex, tokensBalance }
const ourPositions = new Map(); // marketSlug -> { outcomeIndex, amount, marketAddress, collateralToken, decimals }
let isInitialSync = true; // Flag to skip replicating existing positions on first poll

// Trade tracker
let tradeTracker = null;

// ========= Dynamic gas overrides =========
async function txOverrides(provider, gasLimit) {
  const ov = {};
  let gl = null;
  if (gasLimit != null) {
    try { gl = BigInt(gasLimit); ov.gasLimit = gl; } catch { gl = null; }
  }
  const fee = await provider.getFeeData();
  let suggested = fee.maxFeePerGas ?? fee.gasPrice ?? ethers.parseUnits(GAS_PRICE_GWEI, 'gwei');
  let priority = fee.maxPriorityFeePerGas ?? ethers.parseUnits('0.1', 'gwei');
  if (gl && gl > 0n) {
    const capPerGas = MAX_GAS_WEI / gl;
    if (suggested > capPerGas) suggested = capPerGas;
    if (priority > suggested) priority = suggested;
  }
  ov.maxFeePerGas = suggested;
  ov.maxPriorityFeePerGas = priority;
  return ov;
}

// ========= Logging helpers =========
function logInfo(emoji, msg) {
  console.log(`${emoji} ${msg}`);
}
function logWarn(emoji, msg) {
  console.warn(`${emoji} ${msg}`);
}
function logErr(emoji, msg, err) {
  const base = `${emoji} ${msg}`;
  if (err) console.error(base, err);
  else console.error(base);
}

// ========= Persistence =========
function ensureDirSync(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
}

function saveState() {
  try {
    ensureDirSync(path.dirname(STATE_FILE));
    const data = {
      lastSeenPositions: Array.from(lastSeenPositions.entries()),
      ourPositions: Array.from(ourPositions.entries())
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
    logInfo('💾', `State saved`);
  } catch (e) {
    logWarn('⚠️', `Failed to save state: ${e?.message || e}`);
  }
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data.lastSeenPositions) {
      for (const [slug, pos] of data.lastSeenPositions) {
        lastSeenPositions.set(slug, pos);
      }
    }
    if (data.ourPositions) {
      for (const [slug, pos] of data.ourPositions) {
        ourPositions.set(slug, pos);
      }
    }
    logInfo('📂', `State loaded: ${lastSeenPositions.size} target positions, ${ourPositions.size} our positions`);
  } catch (e) {
    logWarn('⚠️', `Failed to load state: ${e?.message || e}`);
  }
}

function delay(ms) {
  return new Promise(res => setTimeout(res, ms));
}

async function estimateGasFor(contract, wallet, fnName, args) {
  try {
    const data = contract.interface.encodeFunctionData(fnName, args);
    const gas = await wallet.provider.estimateGas({
      from: wallet.address,
      to: contract.target,
      data
    });
    return gas;
  } catch (e) {
    logErr('💥', `Gas estimation failed for ${fnName}`, e?.message || e);
    return null;
  }
}

async function readAllowance(usdc, owner, spender) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await usdc.allowance(owner, spender);
    } catch (e) {
      if (attempt < 2) {
        await delay(1000 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
  return 0n;
}

async function ensureUsdcApproval(wallet, usdc, marketAddress, needed) {
  let current;
  try {
    logInfo('🔎', `Checking USDC allowance...`);
    current = await readAllowance(usdc, wallet.address, marketAddress);
  } catch (e) {
    logWarn('⚠️', `Allowance read failed: ${e?.message || e}`);
    current = 0n;
  }
  if (current >= needed) return true;

  logInfo('🔓', `Approving USDC...`);

  // Reset to 0 first if current > 0
  if (current > 0n) {
    try {
      const gasEst0 = await estimateGasFor(usdc, wallet, 'approve', [marketAddress, 0n]);
      if (!gasEst0) { logWarn('🛑', 'Gas estimate approve(0) failed'); return false; }
      const pad0 = (gasEst0 * 120n) / 100n + 10000n;
      const ov0 = await txOverrides(wallet.provider, pad0);
      const tx0 = await usdc.approve(marketAddress, 0n, ov0);
      await tx0.wait(CONFIRMATIONS);
    } catch (e) {
      logErr('💥', 'approve(0) failed', e?.message || e);
      return false;
    }
  }

  try {
    const gasEst1 = await estimateGasFor(usdc, wallet, 'approve', [marketAddress, needed]);
    if (!gasEst1) { logWarn('🛑', 'Gas estimate approve failed'); return false; }
    const pad1 = (gasEst1 * 120n) / 100n + 10000n;
    const ov1 = await txOverrides(wallet.provider, pad1);
    const tx = await usdc.approve(marketAddress, needed, ov1);
    await tx.wait(CONFIRMATIONS);
  } catch (e) {
    logErr('💥', 'approve failed', e?.message || e);
    return false;
  }

  try {
    const after = await readAllowance(usdc, wallet.address, marketAddress);
    const ok = after >= needed;
    logInfo(ok ? '✅' : '⚠️', `Allowance: ${ethers.formatUnits(after, 6)} USDC`);
    return ok;
  } catch (e) {
    logWarn('⚠️', `Allowance re-check failed: ${e?.message || e}`);
    return false;
  }
}

async function ensureErc1155Approval(wallet, erc1155, marketAddress) {
  try {
    const approved = await erc1155.isApprovedForAll(wallet.address, marketAddress);
    if (approved) return true;
  } catch (e) {
    logWarn('⚠️', `isApprovedForAll check failed: ${e?.message || e}`);
  }

  const gasEst = await estimateGasFor(erc1155, wallet, 'setApprovalForAll', [marketAddress, true]);
  if (!gasEst) {
    logWarn('🛑', 'Gas estimate setApprovalForAll failed');
    return false;
  }

  try {
    logInfo('🔓', `Setting ERC1155 approval...`);
    const padded = (gasEst * 120n) / 100n + 10000n;
    const ov = await txOverrides(wallet.provider, padded);
    const tx = await erc1155.setApprovalForAll(marketAddress, true, ov);
    await tx.wait(CONFIRMATIONS);
    return true;
  } catch (e) {
    logErr('💥', 'setApprovalForAll failed', e?.message || e);
    return false;
  }
}

// ========= Fetch target wallet positions from API =========
async function fetchTargetPositions() {
  try {
    const url = `https://api.limitless.exchange/portfolio/${TARGET_WALLET}/positions`;
    const res = await axios.get(url, { timeout: 15000 });

    // Combine AMM, CLOB, and group positions
    const allPositions = [
      ...(res.data.amm || []),
      ...(res.data.clob || []),
      ...(res.data.group || [])
    ];

    return allPositions;
  } catch (e) {
    logErr('💥', `Failed to fetch target positions: ${e?.message || e}`);
    return [];
  }
}

// ========= Get market contracts =========
async function getMarketContracts(provider, conditionId, collateralTokenAddress, wallet) {
  // For CLOB markets, we need to construct the market contract address differently
  // For now, we'll use the Fix e dMarket contract pattern from Limitless
  // The actual market address is derived from conditionId and other params

  // This is a simplified approach - in production you'd need to query the actual market factory
  // For CLOB markets, the market address might not be directly available

  const usdc = new ethers.Contract(collateralTokenAddress, ERC20_ABI, wallet);
  const decimals = Number(await usdc.decimals());

  return { usdc, decimals };
}

// ========= Monitor target wallet positions =========
async function monitorTargetWallet(provider, wallet) {
  logInfo('🔍', `Monitoring target wallet: ${TARGET_WALLET}`);

  async function poll() {
    try {
      const positions = await fetchTargetPositions();

      if (!positions || positions.length === 0) {
        logInfo('ℹ️', 'No positions found for target wallet');
        return;
      }

      logInfo('📊', `Target has ${positions.length} position(s)`);

      for (const pos of positions) {
        await processPosition(provider, wallet, pos);
        await delay(500); // Rate limiting
      }

      // After first poll, mark as no longer initial sync
      if (isInitialSync) {
        isInitialSync = false;
        logInfo('✅', `Initial sync complete. Now monitoring for NEW positions only.`);
      }

      saveState();
    } catch (err) {
      logErr('💥', 'Error in poll:', err?.message || err);
    }
  }

  await poll();
  return setInterval(poll, POLL_INTERVAL_MS);
}

// ========= Process a single position =========
async function processPosition(provider, wallet, position) {
  try {
    const market = position.market;
    if (!market || !market.slug) return;

    const slug = market.slug;
    const status = market.status; // FUNDED, RESOLVED, etc.

    // Skip resolved/closed markets
    if (status === 'RESOLVED' || market.closed) {
      logInfo('ℹ️', `[${slug}] Market is ${status}, skipping`);
      return;
    }

    const tokensBalance = position.tokensBalance;
    if (!tokensBalance) return;

    const yesBalance = BigInt(tokensBalance.yes || '0');
    const noBalance = BigInt(tokensBalance.no || '0');

    // Determine which outcome target has
    let targetOutcome = null;
    let targetBalance = 0n;

    if (yesBalance > 0n && noBalance === 0n) {
      targetOutcome = 1; // Yes
      targetBalance = yesBalance;
    } else if (noBalance > 0n && yesBalance === 0n) {
      targetOutcome = 0; // No
      targetBalance = noBalance;
    } else if (yesBalance > 0n && noBalance > 0n) {
      // Has both - pick the larger one
      if (yesBalance > noBalance) {
        targetOutcome = 1;
        targetBalance = yesBalance;
      } else {
        targetOutcome = 0;
        targetBalance = noBalance;
      }
    }

    if (targetOutcome === null) {
      // Target closed their position
      const lastSeen = lastSeenPositions.get(slug);
      if (lastSeen) {
        logInfo('🔔', `[${slug}] Target CLOSED position (was ${lastSeen.outcomeIndex === 0 ? 'NO' : 'YES'})`);
        await replicateClose(provider, wallet, slug, market, lastSeen.outcomeIndex);
        lastSeenPositions.delete(slug);
      }
      return;
    }

    // Check if this is a new position or changed
    const lastSeen = lastSeenPositions.get(slug);

    if (!lastSeen) {
      // NEW position detected
      if (isInitialSync) {
        // First poll - just record, don't replicate
        logInfo('📝', `[${slug}] Recording existing ${targetOutcome === 0 ? 'NO' : 'YES'} position (not replicating)`);
      } else {
        // Subsequent polls - this is truly new, replicate it
        logInfo('🎯', `[${slug}] Target OPENED ${targetOutcome === 0 ? 'NO' : 'YES'} position`);
        await replicateOpen(provider, wallet, slug, market, targetOutcome);
      }
      lastSeenPositions.set(slug, { outcomeIndex: targetOutcome, tokensBalance: targetBalance.toString() });
    } else if (lastSeen.outcomeIndex !== targetOutcome) {
      // Target flipped sides
      logInfo('🔄', `[${slug}] Target SWITCHED from ${lastSeen.outcomeIndex === 0 ? 'NO' : 'YES'} to ${targetOutcome === 0 ? 'NO' : 'YES'}`);
      // Close old position and open new one
      await replicateClose(provider, wallet, slug, market, lastSeen.outcomeIndex);
      await replicateOpen(provider, wallet, slug, market, targetOutcome);
      lastSeenPositions.set(slug, { outcomeIndex: targetOutcome, tokensBalance: targetBalance.toString() });
    } else {
      // Same position, check if balance increased significantly (new buy)
      const lastBalance = BigInt(lastSeen.tokensBalance || '0');
      const increase = targetBalance - lastBalance;
      const increasePercent = lastBalance > 0n ? Number((increase * 100n) / lastBalance) : 0;

      if (increasePercent > 10) {
        logInfo('📈', `[${slug}] Target INCREASED ${targetOutcome === 0 ? 'NO' : 'YES'} position by ${increasePercent.toFixed(0)}%`);
        // Optionally replicate the increase - for now we'll just log it
      }

      lastSeenPositions.set(slug, { outcomeIndex: targetOutcome, tokensBalance: targetBalance.toString() });
    }

  } catch (err) {
    logErr('💥', `Error processing position:`, err?.message || err);
  }
}

// ========= Replicate opening a position =========
async function replicateOpen(provider, wallet, slug, market, outcomeIndex) {
  try {
    // For CLOB markets, we don't have direct market contract address
    // We need to use the Limitless API or SDK to place orders
    // For now, we'll skip CLOB markets and only support AMM markets with direct addresses

    if (!market.address) {
      logWarn('⚠️', `[${slug}] No market address (likely CLOB) - skipping replication`);
      return;
    }

    const marketAddress = market.address;
    const collateralTokenAddress = market.collateralToken.address;
    const decimals = market.collateralToken.decimals;

    logInfo('🔁', `[${slug}] Replicating BUY ${outcomeIndex === 0 ? 'NO' : 'YES'}`);

    // Use configured bet amount
    const ourInvestmentNumber = Math.max(MIN_BET_USDC, Math.min(MAX_BET_USDC, MIN_BET_USDC * BET_MULTIPLIER));
    const investment = ethers.parseUnits(ourInvestmentNumber.toFixed(decimals), decimals);

    const marketContract = new ethers.Contract(marketAddress, MARKET_ABI, wallet);
    const usdc = new ethers.Contract(collateralTokenAddress, ERC20_ABI, wallet);

    // Check balance
    const usdcBal = await usdc.balanceOf(wallet.address);
    if (usdcBal < investment) {
      logWarn('⚠️', `Insufficient USDC: have ${ethers.formatUnits(usdcBal, decimals)}, need ${ourInvestmentNumber}`);
      return;
    }

    // Approve
    const approvalOk = await ensureUsdcApproval(wallet, usdc, marketAddress, investment);
    if (!approvalOk) {
      logWarn('🛑', 'Approval failed');
      return;
    }

    // Calculate min tokens
    const expectedTokens = await marketContract.calcBuyAmount(investment, outcomeIndex);
    const minOutcomeTokensToBuy = expectedTokens - (expectedTokens * BigInt(SLIPPAGE_BPS)) / 10000n;

    // Estimate gas
    const gasEst = await estimateGasFor(marketContract, wallet, 'buy', [investment, outcomeIndex, minOutcomeTokensToBuy]);
    if (!gasEst) {
      logWarn('🛑', 'Gas estimate failed');
      return;
    }

    const padded = (gasEst * 120n) / 100n + 10000n;
    const buyOv = await txOverrides(wallet.provider, padded);

    logInfo('💸', `Buying ${ourInvestmentNumber} USDC...`);
    const buyTx = await marketContract.buy(investment, outcomeIndex, minOutcomeTokensToBuy, buyOv);
    logInfo('🧾', `Tx: ${buyTx.hash}`);

    const receipt = await buyTx.wait(CONFIRMATIONS);
    logInfo('✅', `Buy completed!`);

    // Track our position
    ourPositions.set(slug, {
      outcomeIndex,
      amount: investment.toString(),
      marketAddress,
      collateralToken: collateralTokenAddress,
      decimals
    });

    // Record trade in tracker
    if (tradeTracker) {
      const tradeId = tradeTracker.recordBuy({
        marketSlug: slug,
        marketTitle: market.title || slug,
        marketAddress: marketAddress,
        conditionId: market.conditionId || null,
        outcome: outcomeIndex,
        investmentAmount: investment.toString(),
        investmentAmountFormatted: ourInvestmentNumber.toFixed(2),
        expectedTokens: expectedTokens.toString(),
        minTokens: minOutcomeTokensToBuy.toString(),
        txHash: buyTx.hash,
        gasUsed: receipt.gasUsed?.toString() || null,
        targetWalletAction: 'NEW_POSITION',
        replicationReason: 'Target opened position',
        collateralToken: collateralTokenAddress,
        collateralDecimals: decimals
      });
      ourPositions.get(slug).tradeId = tradeId; // Store trade ID for later sell
    }

  } catch (err) {
    logErr('💥', `Error replicating open:`, err?.message || err);
  }
}

// ========= Replicate closing a position =========
async function replicateClose(provider, wallet, slug, market, outcomeIndex) {
  try {
    const ourPos = ourPositions.get(slug);
    if (!ourPos || ourPos.outcomeIndex !== outcomeIndex) {
      logInfo('ℹ️', `[${slug}] No matching position to close`);
      return;
    }

    if (!market.address) {
      logWarn('⚠️', `[${slug}] No market address (CLOB) - skipping close`);
      ourPositions.delete(slug);
      return;
    }

    logInfo('🔁', `[${slug}] Replicating SELL ${outcomeIndex === 0 ? 'NO' : 'YES'}`);

    const marketAddress = ourPos.marketAddress;
    const decimals = ourPos.decimals;
    const marketContract = new ethers.Contract(marketAddress, MARKET_ABI, wallet);

    // Get position IDs
    const positionId0 = await marketContract.positionId(0);
    const positionId1 = await marketContract.positionId(1);
    const tokenId = outcomeIndex === 0 ? positionId0 : positionId1;

    // Get conditionalTokens address
    const conditionalTokensAddress = await marketContract.conditionalTokens();
    const erc1155 = new ethers.Contract(conditionalTokensAddress, ERC1155_ABI, wallet);

    // Check balance
    const balance = await erc1155.balanceOf(wallet.address, tokenId);
    if (balance === 0n) {
      logWarn('⚠️', `No tokens to sell`);
      ourPositions.delete(slug);
      return;
    }

    // Approve
    const approvalOk = await ensureErc1155Approval(wallet, erc1155, marketAddress);
    if (!approvalOk) {
      logWarn('🛑', 'ERC1155 approval failed');
      return;
    }

    // Calculate return amount (conservative)
    const investedAmount = BigInt(ourPos.amount);
    const returnAmount = investedAmount - (investedAmount / 100n); // 1% safety margin

    // Estimate gas
    const gasEst = await estimateGasFor(marketContract, wallet, 'sell', [returnAmount, outcomeIndex, balance]);
    if (!gasEst) {
      logWarn('🛑', 'Gas estimate failed');
      return;
    }

    const padded = (gasEst * 120n) / 100n + 10000n;
    const sellOv = await txOverrides(wallet.provider, padded);

    logInfo('💰', `Selling ${ethers.formatUnits(balance, 0)} tokens...`);
    const sellTx = await marketContract.sell(returnAmount, outcomeIndex, balance, sellOv);
    logInfo('🧾', `Tx: ${sellTx.hash}`);

    const receipt = await sellTx.wait(CONFIRMATIONS);
    logInfo('✅', `Sell completed!`);

    // Calculate PnL
    const pnlAmount = returnAmount - investedAmount;
    const pnlPercentage = investedAmount > 0n ? Number((pnlAmount * 10000n) / investedAmount) / 100 : 0;

    // Record trade in tracker
    if (tradeTracker) {
      tradeTracker.recordSell({
        marketSlug: slug,
        marketTitle: market.title || slug,
        marketAddress: marketAddress,
        conditionId: market.conditionId || null,
        outcome: outcomeIndex,
        tokensSold: balance.toString(),
        returnAmount: returnAmount.toString(),
        returnAmountFormatted: ethers.formatUnits(returnAmount, decimals),
        actualReturnReceived: returnAmount.toString(), // Could parse from logs for exact amount
        txHash: sellTx.hash,
        gasUsed: receipt.gasUsed?.toString() || null,
        targetWalletAction: 'CLOSE_POSITION',
        replicationReason: 'Target closed position',
        relatedBuyTradeId: ourPos.tradeId || null,
        investedAmount: investedAmount.toString(),
        pnlAmount: pnlAmount.toString(),
        pnlPercentage: pnlPercentage
      });
    }

    ourPositions.delete(slug);

  } catch (err) {
    logErr('💥', `Error replicating close:`, err?.message || err);
  }
}

// ========= Main =========
async function main() {
  console.log('🤖 Starting Limitless Replication Bot...');
  console.log(`📋 Configuration:`);
  console.log(`   RPC_URL: ${RPC_URL}`);
  console.log(`   CHAIN_ID: ${CHAIN_ID}`);
  console.log(`   TARGET_WALLET: ${TARGET_WALLET}`);
  console.log(`   POLL_INTERVAL_MS: ${POLL_INTERVAL_MS}`);
  console.log(`   BET_MULTIPLIER: ${BET_MULTIPLIER}x`);
  console.log(`   MIN_BET_USDC: ${MIN_BET_USDC}`);
  console.log(`   MAX_BET_USDC: ${MAX_BET_USDC}`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);

  // Verify network
  try {
    const net = await provider.getNetwork();
    logInfo('🌐', `Connected to chainId=${net.chainId}`);
    if (Number(net.chainId) !== CHAIN_ID) {
      logErr('❌', `Wrong network. Expected ${CHAIN_ID} but connected to ${net.chainId}`);
      process.exit(1);
    }
  } catch (e) {
    logErr('💥', 'Failed to connect to RPC', e?.message || e);
    process.exit(1);
  }

  const pk = PRIVATE_KEY.startsWith('0x') ? PRIVATE_KEY : '0x' + PRIVATE_KEY;
  const wallet = new ethers.Wallet(pk, provider);

  logInfo('🔑', `Replicator wallet: ${wallet.address}`);

  // Initialize trade tracker
  tradeTracker = new TradeTracker('data/trades.json');
  tradeTracker.printSummary();

  // Load saved state
  loadState();

  // Start monitoring
  const timer = await monitorTargetWallet(provider, wallet);

  // Print summary every 5 minutes
  const summaryInterval = setInterval(() => {
    if (tradeTracker) {
      tradeTracker.printSummary();
    }
  }, 5 * 60 * 1000);

  process.on('SIGINT', () => {
    console.log('👋 Shutting down...');
    saveState();
    if (tradeTracker) {
      tradeTracker.printSummary();
      tradeTracker.exportToCSV();
    }
    clearInterval(timer);
    clearInterval(summaryInterval);
    process.exit(0);
  });
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
