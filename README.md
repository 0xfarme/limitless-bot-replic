# Limitless Replic - Copy Trading Bot

A bot that monitors a target wallet's positions on Limitless Exchange and automatically replicates their trades to your wallet.

## Features

- 🎯 **Monitor any wallet** - Track successful traders on Limitless Exchange
- 📊 **Auto-replicate trades** - Copies buy/sell positions automatically
- ⚙️ **Configurable multiplier** - Scale bet sizes up or down
- 🛡️ **Risk management** - Min/max bet limits
- 💾 **Full tracking** - Detailed trade history and performance metrics
- 🎮 **Backtesting** - Test strategies without risking real funds
- 📈 **Performance reports** - CSV exports and real-time stats

## Quick Start

### 1. Prerequisites

- **Node.js** v16 or higher
- **USDC on Base** - Ensure your wallet has USDC for trading
- **Base RPC endpoint** - Get one from [Alchemy](https://www.alchemy.com/) or use public endpoint
- **Target wallet address** - The wallet you want to copy trades from

### 2. Installation

```bash
# Clone the repository
git clone <your-repo-url>
cd limitless-replic

# Install dependencies
npm install

# Copy environment file
cp .env.example .env
```

### 3. Configuration

Edit `.env` and configure:

```bash
# Required Configuration
TARGET_WALLET=0x333Afd65D93A95eE6e66415C07785B2E341Bff2d  # Wallet to copy
PRIVATE_KEY=your_private_key_here                          # Your wallet private key
RPC_URL=https://mainnet.base.org                           # Base RPC endpoint

# Trading Parameters
BET_MULTIPLIER=1.0      # 1.0 = same size, 0.5 = half, 2.0 = double
MIN_BET_USDC=5          # Minimum bet in USDC
MAX_BET_USDC=100        # Maximum bet in USDC
SLIPPAGE_BPS=200        # Slippage tolerance (200 = 2%)

# Monitoring
POLL_INTERVAL_MS=15000  # Check for new positions every 15 seconds

# Optional
STARTING_BALANCE_USDC=100  # For simulation mode
```

### 4. Test with Simulation (Recommended First!)

Before risking real funds, run the simulator:

```bash
npm run simulate
```

This will:
- Fetch the target wallet's current positions
- Simulate copying their trades with virtual money
- Show you what the results would be
- Generate performance reports

### 5. Run the Bot (Live Trading)

⚠️ **WARNING: This will execute real trades with real money!**

```bash
npm start
```

The bot will:
- Monitor target wallet every 15 seconds
- Automatically replicate new positions
- Close positions when target exits
- Log all activity to console and files

### 6. Monitor Performance

The bot tracks everything:

```bash
# View live trades
tail -f data/trades.json

# Export to spreadsheet
# CSV is auto-generated on shutdown (Ctrl+C)
# Located at: data/trades.csv
```

## How It Works

The bot uses the Limitless API to monitor positions in real-time:

1. **Polls API** every 15 seconds for target wallet's positions
2. **Detects changes**:
   - New positions opened → Replicates the buy
   - Positions closed → Replicates the sell
   - Position switched (YES↔NO) → Closes old, opens new
3. **Executes trades** on-chain via smart contracts:
   - Approves USDC/ERC1155 tokens
   - Calculates amounts with your multiplier
   - Applies slippage protection
   - Confirms transactions
4. **Tracks everything**:
   - Records all trades to `data/trades.json`
   - Saves state to `data/state.json`
   - Exports performance reports

## Configuration

### Trading Parameters
- `BET_MULTIPLIER`: Scale factor for bet sizes (1.0 = same size, 0.5 = half, 2.0 = double)
- `MIN_BET_USDC`: Minimum bet in USDC (trades below this are skipped)
- `MAX_BET_USDC`: Maximum bet in USDC (trades above this are capped)
- `SLIPPAGE_BPS`: Slippage tolerance in basis points (200 = 2%)

### Monitoring Parameters
- `POLL_INTERVAL_MS`: How often to scan for new blocks (15000 = 15 seconds)
- `LOOKBACK_BLOCKS`: How many blocks to scan on startup (10000 blocks)

### Network & Gas
- `RPC_URL`: Your Base RPC endpoint
- `CHAIN_ID`: 8453 for Base mainnet
- `GAS_PRICE_GWEI`: Base gas price
- `MAX_GAS_ETH`: Maximum gas to spend per transaction
- `CONFIRMATIONS`: Number of confirmations to wait

## Safety Features

- ✅ Minimum and maximum bet size limits
- ✅ Slippage protection on buys
- ✅ Gas price caps
- ✅ Transaction confirmation tracking
- ✅ State persistence (won't duplicate trades after restart)
- ✅ Balance checks before trading
- ✅ Approval management for USDC and ERC1155 tokens

## Example Usage

To copy a successful trader at 50% of their bet size:
```bash
TARGET_WALLET=0x1234...
PRIVATE_KEY=0xabcd...
BET_MULTIPLIER=0.5
MIN_BET_USDC=5
MAX_BET_USDC=50
```

## Backtesting / Simulation Mode

Before risking real funds, test your strategy with the simulator:

```bash
npm run simulate
# or
npm run backtest
```

**What it does:**
- Fetches target wallet's current positions from the API
- Simulates copying each trade without blockchain execution
- Starts with a virtual balance (default: 100 USDC)
- Applies realistic slippage and fees
- Tracks performance metrics and PnL
- Generates reports: `data/simulation_trades.json` and `data/simulation_trades.csv`

**Configuration:**
```bash
TARGET_WALLET=0x333Afd65D93A95eE6e66415C07785B2E341Bff2d
STARTING_BALANCE_USDC=100
BET_MULTIPLIER=1.0
MIN_BET_USDC=1
MAX_BET_USDC=100
```

**Example Output:**
```
🎮 STARTING SIMULATION
Target Wallet:     0x333Afd...
Starting Balance:  100.00 USDC
Bet Multiplier:    1.0x

✅ BUY  [dollarbtc-above-...] YES for 5.00 USDC (Balance: 95.00)
✅ SELL [dollareth-above-...] NO for 4.85 USDC (PnL: -0.15 / -3.0%) (Balance: 99.85)

📊 SIMULATION RESULTS
Starting Balance:  100.00 USDC
Ending Balance:    105.50 USDC
Total PnL:         +5.50 USDC (+5.50%)
```

**Use Cases:**
- Test different bet multipliers (0.5x, 1x, 2x)
- Evaluate target wallet performance
- Find optimal min/max bet sizes
- Understand risk/reward before going live

## Trade Tracking

All trades (live or simulated) are tracked in detail:

**`data/trades.json`** - Complete trade history with:
- Buy/sell details (amounts, prices, timestamps)
- Market information (slug, title, address)
- Transaction hashes
- PnL calculations
- Performance statistics

**`data/trades.csv`** - Exportable spreadsheet format

**Statistics Tracked:**
- Total trades (buys/sells)
- Active vs closed positions
- Win rate
- Total invested/returned
- Overall PnL

The bot prints a summary every 5 minutes and on shutdown.

## State Files

**`data/state.json`** - Runtime state:
- Target's last seen positions
- Your current open positions
- Prevents duplicate trades on restart

**`data/trades.json`** - Permanent trade history:
- All executed trades
- Performance metrics
- Historical record

**`data/simulation_trades.json`** - Simulation results (created by simulator)

## Disclaimer

⚠️ **Use at your own risk.** Always test with small amounts first. This bot requires careful configuration and monitoring. Never share your private key or commit it to version control.
