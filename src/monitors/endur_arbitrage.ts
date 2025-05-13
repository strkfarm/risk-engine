import { AvnuWrapper, SwapInfo } from '@strkfarm/sdk';
import { EkuboCLVault, EkuboCLVaultStrategies, ERC20, FatalError, getMainnetConfig, Global, IConfig, logger, PricerRedis, TelegramNotif, Web3Number } from '@strkfarm/sdk';
import { Quote } from "@avnu/avnu-sdk";
import { TransactionManager } from '@/utils';
import { scheduleJob } from 'node-schedule';
import { Contract } from 'starknet';
import * as EndurArbABI from '@/abis/endur-arb.abi.json';

export interface EndurArbitrageConfig {
  ARB_CONTRACT: string;
  BENEFICIARY: string;
  SPREAD_BPS: number; // default 10 (0.1%)
  REQUIRED_SPREAD_BPS: number; // e.g. 5 (0.05%)
  FROM_TOKEN: string; // e.g. 'STRK'
  TO_TOKEN: string; // e.g. 'xSTRK'
}

export class EndurArbitrage {
  private readonly avnu: AvnuWrapper;
  private readonly contractInfo: any;
  private readonly config: IConfig = getMainnetConfig();
  private readonly arbConfig: EndurArbitrageConfig;
  private module: EkuboCLVault;
  private telegramNotif: TelegramNotif;
  private readonly txManager: TransactionManager;

  private isInitialised = false;

  constructor(config: IConfig, txManager: TransactionManager) {
    this.avnu = new AvnuWrapper();
    this.contractInfo = EkuboCLVaultStrategies[0];
    this.arbConfig = {
      ARB_CONTRACT: '0x75ae1acedcf228c517bae52a37dcb37194adb4cf22e62e6e9eb83149ae469f3',
      BENEFICIARY: '0x07Cd45Ec21beB9ba4D1960A659dF0A16fa53aaC9CB30937A33910974E008e130',
      SPREAD_BPS: 30, // max spread 0.3%
      REQUIRED_SPREAD_BPS: 20, // e.g. 0.2%
      FROM_TOKEN: 'STRK',
      TO_TOKEN: 'xSTRK',
    }
    this.telegramNotif = new TelegramNotif(process.env.TG_TOKEN, false);
    this.config = config;
    this.txManager = txManager;
    this.init();
  }

  async init() {
    this.telegramNotif.sendMessage(`Starting EndurArbitrage monitor`);
    
    const tokens = await Global.getTokens();
    const pricer = new PricerRedis(this.config, tokens);
    if (!process.env.REDIS_URL) {
      throw new FatalError('REDIS_URL not set');
    }
    await pricer.initRedis(process.env.REDIS_URL);
    this.module = new EkuboCLVault(this.config, pricer, this.contractInfo);
    this.isInitialised = true;
  }

  tokenFrom(module: EkuboCLVault): string {
    const tokenInfo = module.metadata.depositTokens.find(d => d.symbol == this.arbConfig.FROM_TOKEN);
    if (!tokenInfo) {
      throw new Error('Token not found');
    }
    return tokenInfo.address.address;
  }

  tokenTo(module: EkuboCLVault): string {
    const tokenInfo = module.metadata.depositTokens.find(d => d.symbol == this.arbConfig.TO_TOKEN);
    if (!tokenInfo) {
      throw new Error('Token not found');
    }
    return tokenInfo.address.address;
  }

  async isArbitrageRequired(
    currentMarketPrice: number,
    truePrice: number,
  ) {
    // Spread in basis points
    const spread =
      Math.abs((currentMarketPrice - truePrice) / truePrice) * 10000;
    logger.info(
      `${EndurArbitrage.name}: isArbitrageRequired => currentMarketPrice: ${currentMarketPrice}, truePrice: ${truePrice}, spread: ${spread}, spreadBps: ${this.arbConfig.SPREAD_BPS}`,
    );

    // analyse ekubo vault
    const { price: ekuboPosCurrentPrice } = await this.module.getCurrentPrice();
    const positionBounds = await this.module.getCurrentBounds();
    const lowerPrice = EkuboCLVault.tickToPrice(positionBounds.lowerTick);
    const upperPrice = EkuboCLVault.tickToPrice(positionBounds.upperTick);

    // if current price below our ekubo positin price, we can arb
    const condition2 = ekuboPosCurrentPrice < lowerPrice;
    logger.info(
      `${EndurArbitrage.name}: isArbitrageRequired => ekuboPosCurrentPrice: ${ekuboPosCurrentPrice}, lowerPrice: ${lowerPrice}, upperPrice: ${upperPrice}`,
    );
    if (condition2) {
      return {
        shouldArb: true,
        ekuboPosCurrentPrice,
        lowerPrice,
        upperPrice,
      }
    }

    // if spread more than SPREAD_BPS (e.g. 0.3%), its not ideal, irrespective of our 
    // ekubo position, hence do the swap
    // todo if this is done, send a singal to ekubo to re-balance here
    const condition1 = spread > this.arbConfig.SPREAD_BPS;
    return {
      shouldArb: condition1,
      ekuboPosCurrentPrice,
      lowerPrice,
      upperPrice,
    }
  }

  async getTargetPrice(
    truePrice: number,
    lowerPrice: number,
    upperPrice: number,
  ): Promise<number> {
    // For now, target price is truePrice * (1 - requiredSpreadBps/10000)
    const idealTargetPrice = truePrice * (1 - this.arbConfig.REQUIRED_SPREAD_BPS / 10000);
    
    // if ekubo low and high price is between SPREAD_BPS and required SPREAD_BPS,
    // then target is a between in between
    const spreadBpsPrice = truePrice * (1 - this.arbConfig.SPREAD_BPS / 10000);
    logger.info(
      `${EndurArbitrage.name}: getTargetPrice => idealTargetPrice: ${idealTargetPrice}, lowerPrice: ${lowerPrice}, upperPrice: ${upperPrice}, spreadBpsPrice: ${spreadBpsPrice}`,
    );
    if (upperPrice < spreadBpsPrice) {
      // ekubo position is not ideal, so we can arb to target price
      return idealTargetPrice;
    } else if (lowerPrice > idealTargetPrice) {
      // ekubo position is not ideal, so we can arb to target price
      return idealTargetPrice;
    } else if (lowerPrice >= spreadBpsPrice && upperPrice <= idealTargetPrice) {
      // ekubo position is ideal, so we can arb to some between in range
      return (lowerPrice + upperPrice) / 2;
    } else if (upperPrice <= idealTargetPrice) {
      // ekubo position is ideal, so we can arb to some between in range
      return (spreadBpsPrice + upperPrice) / 2;
    } else if (lowerPrice >= spreadBpsPrice) {
      // ekubo position is ideal, so we can arb to some between in range
      return idealTargetPrice;
    } else if (lowerPrice < spreadBpsPrice && upperPrice > idealTargetPrice) {
      // ekubo position fully encompasses the acceptable spread range
      return idealTargetPrice;
    }

    throw new Error('Invalid target price');
  }

  async getTruePrice(): Promise<number> {
    return await this.module.truePrice();
  }

  async getMarketPrice(): Promise<number> {
    // Implement logic to get current market price for xSTRK/STRK
    // get Quote from Avnu for 1STRK to xSTRK, use the output to calculate price
    const quote = await this.avnu.getQuotes(
      this.tokenFrom(this.module),
      this.tokenTo(this.module),
      BigInt(1e18).toString(),
      this.arbConfig.BENEFICIARY,
    );

    const output = this._getPriceFromQuote(quote);
    logger.info(
      `${EndurArbitrage.name}: getMarketPrice => ${this.tokenFrom(this.module)} -> ${this.tokenTo(this.module)}, price: ${output}`,
    );
    return output;
  }

  _getPriceFromQuote(quote: Quote): number {
    // Implement logic to get price from quote
    // For now, just return the price from the quote
    return Number(quote.sellAmount) / Number(quote.buyAmount);
  }

  async getFromTokenBalance(): Promise<Web3Number> {
    const output = await (new ERC20(this.config)).balanceOf(this.tokenFrom(this.module), this.arbConfig.BENEFICIARY, 18);
    const allowance = await (new ERC20(this.config)).allowance(this.tokenFrom(this.module), this.arbConfig.BENEFICIARY, this.arbConfig.ARB_CONTRACT, 18);
    logger.verbose(
      `${EndurArbitrage.name}: getFromTokenBalance => ${this.tokenFrom(this.module)} balance: ${output}, allowance: ${allowance}`,
    );
    
    if (allowance.lte(50_000)) { // less than 50k
      // check if time with first first 5min of hr
      const now = new Date();
      const first5min = now.getMinutes() < 5;
      if (first5min) {
        this.telegramNotif.sendMessage(
          `EndurArbitrage: allowance is low, please approve the contract to spend more ${this.tokenFrom(this.module)} tokens`,
        );
      }
    }
   
    return BigInt(output.toWei()) < BigInt(allowance.toWei()) ? output : allowance;
  }

  async findOptimalAmount(
    targetPrice: number,
    maxAmount: bigint,
  ): Promise<bigint> {
    const epsilon = 10n ** 17n; // small amount in wei (0.1 STRK)
    let left = epsilon;
    let right = maxAmount;
    let best = 0n;

    const MAX_ITERATIONS = 100;
    let retry = 0;
  
    while (left + epsilon <= right) {
      if (retry >= MAX_ITERATIONS) {
        throw new Error(`${EndurArbitrage.name}: findOptimalAmount => max iterations reached`);
      }
      retry += 1;

      // Binary search
      const mid = (left + right) / 2n;
  
      // Quote for mid
      const quoteMid = await this.avnu.getQuotes(
        this.tokenFrom(this.module),
        this.tokenTo(this.module),
        mid.toString(),
        this.arbConfig.ARB_CONTRACT,
      );
      const executionPrice1 = this._getPriceFromQuote(quoteMid); // needs to return bigint
  
      // Quote for (mid - epsilon)
      const quoteEps = await this.avnu.getQuotes(
        this.tokenFrom(this.module),
        this.tokenTo(this.module),
        (mid - epsilon).toString(),
        this.arbConfig.ARB_CONTRACT,
      );
      const executionPrice2 = this._getPriceFromQuote(quoteEps); // needs to return bigint
      logger.verbose(
        `${EndurArbitrage.name}: findOptimalAmount => STRK -> xSTRK, mid: ${mid / 10n ** 18n}, executionPrice1: ${executionPrice1}, executionPrice2: ${executionPrice2}`,
      );

      // Estimate marginal price = ΔR / ΔQ
      const marginalPrice = Number(epsilon) / (Number(quoteMid.buyAmount) - Number(quoteEps.buyAmount));
  
      logger.verbose(
        `${EndurArbitrage.name}: findOptimalAmount => STRK -> xSTRK, mid: ${mid / 10n ** 18n}, marginalPrice: ${marginalPrice}, retry: ${retry}`,
      );
  
      if (marginalPrice <= targetPrice) {
        best = mid;
        left = mid + epsilon;
      } else {
        right = mid - epsilon;
      }
    }
  
    return best;
  }

  async executeArbitrage(amount: bigint, swapInfo: SwapInfo, minPercentBps: number) {
    // Implement logic to call perform_arb on ARB_CONTRACT
    // Placeholder: should be replaced with actual contract call
   const contract = new Contract(EndurArbABI, this.arbConfig.ARB_CONTRACT, this.config.provider as any);
   const call = contract.populate('perform_arb', [
      this.arbConfig.BENEFICIARY,
      amount.toString(),
      swapInfo,
      minPercentBps,
   ]);
   this.txManager.addCalls([call], 'EndurArbitrage');
  }

  async run() {
    const truePrice = await this.getTruePrice();
    const marketPrice = await this.getMarketPrice();

    const isArbRequired = await this.isArbitrageRequired(
      marketPrice,
      truePrice,
    );
    if (
      !isArbRequired.shouldArb
    ) {
      logger.info('No arbitrage opportunity detected.');
      return;
    }
    const targetPrice = await this.getTargetPrice(truePrice, isArbRequired.lowerPrice, isArbRequired.upperPrice);
    logger.info(
      `Arbitrage opportunity detected: marketPrice: ${marketPrice}, truePrice: ${truePrice}, targetPrice: ${targetPrice}`,
    );
    const maxAmount = await this.getFromTokenBalance();
    const amount = await this.findOptimalAmount(
      targetPrice,
      BigInt(maxAmount.toWei())
    );
    logger.info(
      `Optimal amount found: ${amount / 10n ** 18n} STRK`,
    );
    if (amount === 0n) {
      logger.info('No suitable amount found for arbitrage.');
      return;
    } else if (amount < 2n * (10n ** 18n)) {
      logger.info('Amount is too small for arbitrage.');
      return;
    }

    const quote = await this.avnu.getQuotes(
      this.tokenFrom(this.module),
      this.tokenTo(this.module),
      amount.toString(),
      this.arbConfig.ARB_CONTRACT,
    );
    const executionPrice = this._getPriceFromQuote(quote);
    logger.info(
      `Execution price: ${executionPrice}, buyAmount: ${quote.buyAmount}, sellAmount: ${quote.sellAmount}`
    );  
    const swapInfo = await this.avnu.getSwapInfo(
      quote,
      this.arbConfig.ARB_CONTRACT,
      0,
      this.arbConfig.ARB_CONTRACT,
    );
    await this.executeArbitrage(amount, swapInfo, this.arbConfig.REQUIRED_SPREAD_BPS);
    logger.info(`Arbitrage executed for amount: ${amount}`);
    this.telegramNotif.sendMessage(`Endur Arbitrage sent for amount: ${amount / 10n ** 18n} STRK`);
  }

  start() {
    // this.run().catch((err) => logger.error('EndurArbitrage error:', err));

    // Run every 5 minutes
    scheduleJob('*/1 * * * *', () => {
      this.run().catch((err) => {
        logger.error('EndurArbitrage error:', err);
        this.telegramNotif.sendMessage(`EndurArbitrage error: ${err}`);
      });
    });
    logger.info('EndurArbitrage monitor started (every 5min)');
  }
}
