require('dotenv').config();
const axios = require('axios');
const TradeTracker = require('./tradeTracker');

/**
 * Backtesting Simulator for Limitless Replication Bot
 *
 * Simulates copying a target wallet's trades without actual blockchain execution
 * Useful for backtesting strategy performance
 */

// ========= Config =========
const TARGET_WALLET = process.env.TARGET_WALLET || '0x333Afd65D93A95eE6e66415C07785B2E341Bff2d';
const STARTING_BALANCE_USDC = process.env.STARTING_BALANCE_USDC ? Number(process.env.STARTING_BALANCE_USDC) : 100;
const BET_MULTIPLIER = process.env.BET_MULTIPLIER ? Number(process.env.BET_MULTIPLIER) : 1.0;
const MIN_BET_USDC = process.env.MIN_BET_USDC ? Number(process.env.MIN_BET_USDC) : 1;
const MAX_BET_USDC = process.env.MAX_BET_USDC ? Number(process.env.MAX_BET_USDC) : 100;
const SLIPPAGE_BPS = process.env.SLIPPAGE_BPS ? Number(process.env.SLIPPAGE_BPS) : 200; // 2%
const FEE_BPS = process.env.FEE_BPS ? Number(process.env.FEE_BPS) : 100; // 1% fee estimate

class TradingSimulator {
  constructor() {
    this.balance = STARTING_BALANCE_USDC;
    this.startingBalance = STARTING_BALANCE_USDC;
    this.positions = new Map(); // marketSlug -> { outcome, invested, tokens, entryPrice }
    this.tradeTracker = new TradeTracker('data/simulation_trades.json');
    this.targetPositions = new Map(); // Track target's position history
  }

  /**
   * Fetch target wallet's current positions
   */
  async fetchTargetPositions() {
    try {
      const url = `https://api.limitless.exchange/portfolio/${TARGET_WALLET}/positions`;
      const res = await axios.get(url, { timeout: 15000 });

      const allPositions = [
        ...(res.data.amm || []),
        ...(res.data.clob || []),
        ...(res.data.group || [])
      ];

      return allPositions;
    } catch (e) {
      console.error('❌ Failed to fetch target positions:', e?.message || e);
      return [];
    }
  }

  /**
   * Simulate buying a position
   */
  simulateBuy(marketSlug, marketTitle, outcome, outcomeLabel, targetInvestment) {
    // Calculate our investment based on multiplier and limits
    let ourInvestment = targetInvestment * BET_MULTIPLIER;
    ourInvestment = Math.max(MIN_BET_USDC, Math.min(MAX_BET_USDC, ourInvestment));

    // Check if we have enough balance
    if (this.balance < ourInvestment) {
      console.log(`⚠️  [${marketSlug}] Insufficient balance: ${this.balance.toFixed(2)} < ${ourInvestment.toFixed(2)}`);
      return false;
    }

    // Deduct from balance
    this.balance -= ourInvestment;

    // Simulate token purchase (simplified: assume 1:1 minus slippage)
    const slippageLoss = ourInvestment * (SLIPPAGE_BPS / 10000);
    const effectiveInvestment = ourInvestment - slippageLoss;
    const tokens = effectiveInvestment; // Simplified: 1 USDC = 1 token equivalent

    // Record position
    this.positions.set(marketSlug, {
      outcome,
      outcomeLabel,
      invested: ourInvestment,
      tokens,
      entryPrice: 1.0, // Simplified
      marketTitle
    });

    // Record in tracker
    const tradeId = this.tradeTracker.recordBuy({
      marketSlug,
      marketTitle,
      outcome,
      investmentAmount: (ourInvestment * 1e6).toString(),
      investmentAmountFormatted: ourInvestment.toFixed(2),
      expectedTokens: tokens.toString(),
      targetWalletAction: 'NEW_POSITION',
      replicationReason: `Simulated buy - target invested ${targetInvestment.toFixed(2)}`,
      collateralDecimals: 6
    });

    console.log(`✅ BUY  [${marketSlug.substring(0, 30)}...] ${outcomeLabel} for ${ourInvestment.toFixed(2)} USDC (Balance: ${this.balance.toFixed(2)})`);

    return tradeId;
  }

  /**
   * Simulate selling a position
   */
  simulateSell(marketSlug, outcome, marketValue, winningOutcome = null) {
    const position = this.positions.get(marketSlug);
    if (!position || position.outcome !== outcome) {
      console.log(`ℹ️  [${marketSlug}] No matching position to sell`);
      return false;
    }

    let returnAmount;

    if (winningOutcome !== null) {
      // Market is resolved - calculate based on win/loss
      if (winningOutcome === outcome) {
        // We won! Return close to invested amount (minus fees)
        returnAmount = position.invested * (1 - FEE_BPS / 10000);
      } else {
        // We lost - return 0
        returnAmount = 0;
      }
    } else {
      // Market not resolved - use market value estimate
      returnAmount = marketValue || position.invested * 0.95; // Default to 95% if no market value
    }

    // Apply fees
    const feeLoss = returnAmount * (FEE_BPS / 10000);
    const netReturn = returnAmount - feeLoss;

    // Add to balance
    this.balance += netReturn;

    // Calculate PnL
    const pnlAmount = netReturn - position.invested;
    const pnlPercentage = (pnlAmount / position.invested) * 100;

    // Record in tracker
    this.tradeTracker.recordSell({
      marketSlug,
      marketTitle: position.marketTitle,
      outcome,
      tokensSold: position.tokens.toString(),
      returnAmount: (netReturn * 1e6).toString(),
      returnAmountFormatted: netReturn.toFixed(2),
      actualReturnReceived: (netReturn * 1e6).toString(),
      targetWalletAction: winningOutcome !== null ? 'MARKET_RESOLVED' : 'CLOSE_POSITION',
      replicationReason: winningOutcome !== null
        ? `Market resolved - ${winningOutcome === outcome ? 'WON' : 'LOST'}`
        : 'Target closed position',
      investedAmount: (position.invested * 1e6).toString(),
      pnlAmount: (pnlAmount * 1e6).toString(),
      pnlPercentage
    });

    const pnlSign = pnlAmount >= 0 ? '+' : '';
    console.log(`✅ SELL [${marketSlug.substring(0, 30)}...] ${position.outcomeLabel} for ${netReturn.toFixed(2)} USDC (PnL: ${pnlSign}${pnlAmount.toFixed(2)} / ${pnlSign}${pnlPercentage.toFixed(1)}%) (Balance: ${this.balance.toFixed(2)})`);

    this.positions.delete(marketSlug);
    return true;
  }

  /**
   * Estimate market value based on position data
   */
  estimateMarketValue(position, positionData) {
    try {
      // Use the position's market value from API if available
      const outcome = position.outcome === 0 ? 'no' : 'yes';
      const marketValueRaw = positionData.positions?.[outcome]?.marketValue;

      if (marketValueRaw) {
        return Number(marketValueRaw) / 1e6; // Convert from wei to USDC
      }

      // Fallback: use current price
      const latestPrice = positionData.latestTrade?.[outcome === 'no' ? 'latestNoPrice' : 'latestYesPrice'];
      if (latestPrice) {
        return position.invested * latestPrice;
      }

      return null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Run simulation based on target wallet's positions
   */
  async runSimulation() {
    console.log('\n' + '='.repeat(80));
    console.log('🎮 STARTING SIMULATION');
    console.log('='.repeat(80));
    console.log(`Target Wallet:     ${TARGET_WALLET}`);
    console.log(`Starting Balance:  ${this.startingBalance.toFixed(2)} USDC`);
    console.log(`Bet Multiplier:    ${BET_MULTIPLIER}x`);
    console.log(`Min/Max Bet:       ${MIN_BET_USDC} - ${MAX_BET_USDC} USDC`);
    console.log(`Slippage:          ${SLIPPAGE_BPS / 100}%`);
    console.log(`Est. Fees:         ${FEE_BPS / 100}%`);
    console.log('='.repeat(80) + '\n');

    // Fetch target's positions
    console.log('📡 Fetching target wallet positions...\n');
    const positions = await this.fetchTargetPositions();

    if (!positions || positions.length === 0) {
      console.log('⚠️  No positions found for target wallet');
      return;
    }

    console.log(`Found ${positions.length} position(s)\n`);

    // Process each position
    for (const pos of positions) {
      const market = pos.market;
      if (!market || !market.slug) continue;

      const slug = market.slug;
      const status = market.status;
      const tokensBalance = pos.tokensBalance;

      if (!tokensBalance) continue;

      const yesBalance = Number(tokensBalance.yes || '0');
      const noBalance = Number(tokensBalance.no || '0');

      // Determine target's position
      let targetOutcome = null;
      let outcomeLabel = null;

      if (yesBalance > 0 && noBalance === 0) {
        targetOutcome = 1;
        outcomeLabel = 'YES';
      } else if (noBalance > 0 && yesBalance === 0) {
        targetOutcome = 0;
        outcomeLabel = 'NO';
      } else if (yesBalance > 0 && noBalance > 0) {
        targetOutcome = yesBalance > noBalance ? 1 : 0;
        outcomeLabel = targetOutcome === 1 ? 'YES' : 'NO';
      }

      if (targetOutcome === null) continue;

      // Estimate target's investment (use cost if available)
      const outcome = targetOutcome === 0 ? 'no' : 'yes';
      const targetCostRaw = pos.positions?.[outcome]?.cost;
      const targetInvestment = targetCostRaw ? Number(targetCostRaw) / 1e6 : MIN_BET_USDC;

      // Check if market is resolved
      const isResolved = status === 'RESOLVED';
      const winningOutcome = market.winningOutcomeIndex;

      if (isResolved) {
        // Simulate sell for resolved markets
        const hasPosition = this.positions.has(slug);
        if (hasPosition) {
          console.log(`🏁 [${slug.substring(0, 30)}...] Market RESOLVED (Winner: ${winningOutcome === 0 ? 'NO' : 'YES'})`);
          this.simulateSell(slug, this.positions.get(slug).outcome, null, winningOutcome);
        }
      } else {
        // Active market - simulate buy if we don't have position
        const hasPosition = this.positions.has(slug);
        if (!hasPosition) {
          this.simulateBuy(slug, market.title, targetOutcome, outcomeLabel, targetInvestment);
        } else {
          // Check if we need to update position (target switched sides)
          const ourPos = this.positions.get(slug);
          if (ourPos.outcome !== targetOutcome) {
            console.log(`🔄 [${slug.substring(0, 30)}...] Target SWITCHED from ${ourPos.outcomeLabel} to ${outcomeLabel}`);

            // Estimate market value for current position
            const marketValue = this.estimateMarketValue(ourPos, pos);
            this.simulateSell(slug, ourPos.outcome, marketValue);
            this.simulateBuy(slug, market.title, targetOutcome, outcomeLabel, targetInvestment);
          } else {
            console.log(`ℹ️  [${slug.substring(0, 30)}...] Already holding ${outcomeLabel} position`);
          }
        }
      }

      // Add small delay to simulate real-world
      await new Promise(res => setTimeout(res, 100));
    }

    // Print final results
    this.printResults();
  }

  /**
   * Print simulation results
   */
  printResults() {
    console.log('\n' + '='.repeat(80));
    console.log('📊 SIMULATION RESULTS');
    console.log('='.repeat(80));

    const endBalance = this.balance;
    const pnl = endBalance - this.startingBalance;
    const pnlPercent = (pnl / this.startingBalance) * 100;
    const pnlSign = pnl >= 0 ? '+' : '';

    console.log(`Starting Balance:  ${this.startingBalance.toFixed(2)} USDC`);
    console.log(`Ending Balance:    ${endBalance.toFixed(2)} USDC`);
    console.log(`Total PnL:         ${pnlSign}${pnl.toFixed(2)} USDC (${pnlSign}${pnlPercent.toFixed(2)}%)`);
    console.log(`Active Positions:  ${this.positions.size}`);

    if (this.positions.size > 0) {
      console.log('\nActive Positions:');
      for (const [slug, pos] of this.positions.entries()) {
        console.log(`  - [${slug.substring(0, 40)}...] ${pos.outcomeLabel}: ${pos.invested.toFixed(2)} USDC`);
      }
    }

    console.log('='.repeat(80) + '\n');

    // Print trade tracker summary
    this.tradeTracker.printSummary();

    // Export CSV
    this.tradeTracker.exportToCSV('data/simulation_trades.csv');
  }
}

// ========= Main =========
async function main() {
  const simulator = new TradingSimulator();
  await simulator.runSimulation();
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
