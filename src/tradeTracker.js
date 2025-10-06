const fs = require('fs');
const path = require('path');

/**
 * Trade Tracker - Persists all trade activity and performance metrics
 */
class TradeTracker {
  constructor(filePath = 'data/trades.json') {
    this.filePath = filePath;
    this.trades = [];
    this.stats = {
      totalTrades: 0,
      totalBuys: 0,
      totalSells: 0,
      totalInvested: '0',
      totalReturned: '0',
      totalPnL: '0',
      activePositions: 0,
      closedPositions: 0,
      winRate: 0,
      lastUpdated: null
    };
    this.load();
  }

  /**
   * Load trades from file
   */
  load() {
    try {
      if (!fs.existsSync(this.filePath)) {
        this.ensureDir();
        this.save();
        return;
      }

      const raw = fs.readFileSync(this.filePath, 'utf8');
      const data = JSON.parse(raw);

      this.trades = data.trades || [];
      this.stats = data.stats || this.stats;

      console.log(`📂 Loaded ${this.trades.length} trade records`);
    } catch (e) {
      console.warn('⚠️ Failed to load trade tracker:', e?.message || e);
    }
  }

  /**
   * Save trades to file
   */
  save() {
    try {
      this.ensureDir();
      this.updateStats();

      const data = {
        trades: this.trades,
        stats: this.stats,
        version: '1.0'
      };

      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
    } catch (e) {
      console.warn('⚠️ Failed to save trade tracker:', e?.message || e);
    }
  }

  /**
   * Ensure directory exists
   */
  ensureDir() {
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
    } catch (_) {}
  }

  /**
   * Record a BUY trade
   */
  recordBuy(data) {
    const trade = {
      id: this.generateTradeId(),
      type: 'BUY',
      timestamp: new Date().toISOString(),

      // Market info
      marketSlug: data.marketSlug,
      marketTitle: data.marketTitle || null,
      marketAddress: data.marketAddress || null,
      conditionId: data.conditionId || null,

      // Trade details
      outcome: data.outcome, // 0 = NO, 1 = YES
      outcomeLabel: data.outcome === 0 ? 'NO' : 'YES',

      // Amounts
      investmentAmount: data.investmentAmount, // in wei
      investmentAmountFormatted: data.investmentAmountFormatted, // human readable
      expectedTokens: data.expectedTokens || null,
      minTokens: data.minTokens || null,
      actualTokensReceived: data.actualTokensReceived || null,

      // Transaction
      txHash: data.txHash || null,
      gasUsed: data.gasUsed || null,
      gasPrice: data.gasPrice || null,

      // Metadata
      targetWalletAction: data.targetWalletAction || 'NEW_POSITION',
      replicationReason: data.replicationReason || 'Target opened position',

      // Position tracking
      positionId: data.positionId || null,
      status: 'OPEN',

      // PnL tracking
      entryPrice: data.entryPrice || null,
      currentPrice: null,
      unrealizedPnL: null,
      realizedPnL: null,

      // Collateral
      collateralToken: data.collateralToken || null,
      collateralDecimals: data.collateralDecimals || 6,

      // Closure tracking
      closedAt: null,
      closeTxHash: null,
      exitPrice: null
    };

    this.trades.push(trade);
    this.save();

    console.log(`✅ Recorded BUY: ${trade.id} - ${trade.marketSlug} ${trade.outcomeLabel} for ${trade.investmentAmountFormatted}`);
    return trade.id;
  }

  /**
   * Record a SELL trade
   */
  recordSell(data) {
    const trade = {
      id: this.generateTradeId(),
      type: 'SELL',
      timestamp: new Date().toISOString(),

      // Market info
      marketSlug: data.marketSlug,
      marketTitle: data.marketTitle || null,
      marketAddress: data.marketAddress || null,
      conditionId: data.conditionId || null,

      // Trade details
      outcome: data.outcome,
      outcomeLabel: data.outcome === 0 ? 'NO' : 'YES',

      // Amounts
      tokensSold: data.tokensSold || null,
      returnAmount: data.returnAmount || null,
      returnAmountFormatted: data.returnAmountFormatted || null,
      actualReturnReceived: data.actualReturnReceived || null,

      // Transaction
      txHash: data.txHash || null,
      gasUsed: data.gasUsed || null,
      gasPrice: data.gasPrice || null,

      // Metadata
      targetWalletAction: data.targetWalletAction || 'CLOSE_POSITION',
      replicationReason: data.replicationReason || 'Target closed position',

      // Reference to original buy
      relatedBuyTradeId: data.relatedBuyTradeId || null,

      // PnL
      investedAmount: data.investedAmount || null,
      pnlAmount: data.pnlAmount || null,
      pnlPercentage: data.pnlPercentage || null,

      // Exit info
      exitPrice: data.exitPrice || null,

      status: 'CLOSED'
    };

    this.trades.push(trade);

    // Update the related buy trade if found
    if (data.relatedBuyTradeId) {
      this.closeTrade(data.relatedBuyTradeId, {
        closedAt: trade.timestamp,
        closeTxHash: trade.txHash,
        exitPrice: trade.exitPrice,
        realizedPnL: data.pnlAmount,
        status: 'CLOSED'
      });
    } else {
      // Try to find matching buy by market slug and outcome
      const relatedBuy = this.findOpenBuy(data.marketSlug, data.outcome);
      if (relatedBuy) {
        this.closeTrade(relatedBuy.id, {
          closedAt: trade.timestamp,
          closeTxHash: trade.txHash,
          exitPrice: trade.exitPrice,
          realizedPnL: data.pnlAmount,
          status: 'CLOSED'
        });
        trade.relatedBuyTradeId = relatedBuy.id;
      }
    }

    this.save();

    console.log(`✅ Recorded SELL: ${trade.id} - ${trade.marketSlug} ${trade.outcomeLabel} for ${trade.returnAmountFormatted}`);
    return trade.id;
  }

  /**
   * Update a trade (e.g., when it gets filled)
   */
  updateTrade(tradeId, updates) {
    const trade = this.trades.find(t => t.id === tradeId);
    if (!trade) {
      console.warn(`⚠️ Trade ${tradeId} not found`);
      return false;
    }

    Object.assign(trade, updates);
    this.save();
    return true;
  }

  /**
   * Close a trade (mark as closed and update PnL)
   */
  closeTrade(tradeId, closeData) {
    const trade = this.trades.find(t => t.id === tradeId);
    if (!trade) {
      console.warn(`⚠️ Trade ${tradeId} not found`);
      return false;
    }

    trade.status = 'CLOSED';
    trade.closedAt = closeData.closedAt || new Date().toISOString();
    trade.closeTxHash = closeData.closeTxHash || null;
    trade.exitPrice = closeData.exitPrice || null;
    trade.realizedPnL = closeData.realizedPnL || null;

    this.save();
    return true;
  }

  /**
   * Find an open buy trade for a market/outcome
   */
  findOpenBuy(marketSlug, outcome) {
    return this.trades.find(t =>
      t.type === 'BUY' &&
      t.marketSlug === marketSlug &&
      t.outcome === outcome &&
      t.status === 'OPEN'
    );
  }

  /**
   * Get all trades for a specific market
   */
  getTradesByMarket(marketSlug) {
    return this.trades.filter(t => t.marketSlug === marketSlug);
  }

  /**
   * Get all open positions
   */
  getOpenPositions() {
    return this.trades.filter(t => t.type === 'BUY' && t.status === 'OPEN');
  }

  /**
   * Get all closed positions
   */
  getClosedPositions() {
    return this.trades.filter(t => t.type === 'BUY' && t.status === 'CLOSED');
  }

  /**
   * Get recent trades (last N)
   */
  getRecentTrades(count = 10) {
    return this.trades.slice(-count).reverse();
  }

  /**
   * Update statistics
   */
  updateStats() {
    const buys = this.trades.filter(t => t.type === 'BUY');
    const sells = this.trades.filter(t => t.type === 'SELL');
    const openPositions = buys.filter(t => t.status === 'OPEN');
    const closedPositions = buys.filter(t => t.status === 'CLOSED');

    // Calculate totals (using BigInt for precision)
    let totalInvested = 0n;
    let totalReturned = 0n;

    for (const buy of buys) {
      if (buy.investmentAmount) {
        try {
          totalInvested += BigInt(buy.investmentAmount);
        } catch (_) {}
      }
    }

    for (const sell of sells) {
      if (sell.actualReturnReceived) {
        try {
          totalReturned += BigInt(sell.actualReturnReceived);
        } catch (_) {}
      } else if (sell.returnAmount) {
        try {
          totalReturned += BigInt(sell.returnAmount);
        } catch (_) {}
      }
    }

    const totalPnL = totalReturned - totalInvested;

    // Win rate (closed positions that are profitable)
    const profitableClosedTrades = closedPositions.filter(t => {
      if (!t.realizedPnL) return false;
      try {
        return BigInt(t.realizedPnL) > 0n;
      } catch (_) {
        return false;
      }
    });

    const winRate = closedPositions.length > 0
      ? (profitableClosedTrades.length / closedPositions.length * 100)
      : 0;

    this.stats = {
      totalTrades: this.trades.length,
      totalBuys: buys.length,
      totalSells: sells.length,
      totalInvested: totalInvested.toString(),
      totalReturned: totalReturned.toString(),
      totalPnL: totalPnL.toString(),
      activePositions: openPositions.length,
      closedPositions: closedPositions.length,
      winRate: winRate.toFixed(2),
      lastUpdated: new Date().toISOString()
    };
  }

  /**
   * Get statistics
   */
  getStats() {
    this.updateStats();
    return this.stats;
  }

  /**
   * Print summary to console
   */
  printSummary() {
    this.updateStats();

    console.log('\n' + '='.repeat(60));
    console.log('📊 TRADE TRACKER SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total Trades:      ${this.stats.totalTrades}`);
    console.log(`  - Buys:          ${this.stats.totalBuys}`);
    console.log(`  - Sells:         ${this.stats.totalSells}`);
    console.log(`Active Positions:  ${this.stats.activePositions}`);
    console.log(`Closed Positions:  ${this.stats.closedPositions}`);
    console.log(`Win Rate:          ${this.stats.winRate}%`);

    try {
      const invested = BigInt(this.stats.totalInvested);
      const returned = BigInt(this.stats.totalReturned);
      const pnl = BigInt(this.stats.totalPnL);

      // Format assuming 6 decimals (USDC)
      const investedFormatted = (Number(invested) / 1e6).toFixed(2);
      const returnedFormatted = (Number(returned) / 1e6).toFixed(2);
      const pnlFormatted = (Number(pnl) / 1e6).toFixed(2);
      const pnlSign = pnl >= 0n ? '+' : '';

      console.log(`Total Invested:    ${pnlSign}${investedFormatted} USDC`);
      console.log(`Total Returned:    ${pnlSign}${returnedFormatted} USDC`);
      console.log(`Total PnL:         ${pnlSign}${pnlFormatted} USDC`);
    } catch (_) {
      console.log(`Total Invested:    ${this.stats.totalInvested} (raw)`);
      console.log(`Total Returned:    ${this.stats.totalReturned} (raw)`);
      console.log(`Total PnL:         ${this.stats.totalPnL} (raw)`);
    }

    console.log(`Last Updated:      ${this.stats.lastUpdated}`);
    console.log('='.repeat(60) + '\n');
  }

  /**
   * Export trades to CSV
   */
  exportToCSV(outputPath = 'data/trades.csv') {
    try {
      this.ensureDir();

      const headers = [
        'ID', 'Type', 'Timestamp', 'Market', 'Outcome',
        'Investment (USDC)', 'Return (USDC)', 'PnL (USDC)', 'PnL %',
        'Status', 'Tx Hash', 'Market Address'
      ];

      const rows = this.trades.map(t => {
        const investment = t.investmentAmountFormatted || '-';
        const returnAmt = t.returnAmountFormatted || '-';
        const pnl = t.pnlAmount ? (Number(t.pnlAmount) / 1e6).toFixed(2) : '-';
        const pnlPct = t.pnlPercentage ? t.pnlPercentage.toFixed(2) + '%' : '-';

        return [
          t.id,
          t.type,
          t.timestamp,
          t.marketSlug || '-',
          t.outcomeLabel,
          investment,
          returnAmt,
          pnl,
          pnlPct,
          t.status,
          t.txHash || '-',
          t.marketAddress || '-'
        ].map(field => `"${field}"`).join(',');
      });

      const csv = [headers.join(','), ...rows].join('\n');
      fs.writeFileSync(outputPath, csv);

      console.log(`📄 Exported ${this.trades.length} trades to ${outputPath}`);
      return true;
    } catch (e) {
      console.error('❌ Failed to export CSV:', e?.message || e);
      return false;
    }
  }

  /**
   * Generate unique trade ID
   */
  generateTradeId() {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 9);
    return `trade_${timestamp}_${random}`;
  }
}

module.exports = TradeTracker;
