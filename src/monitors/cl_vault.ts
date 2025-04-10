import { getAccount, pollHeartbeat, TransactionManager } from "@/utils";
import { Bind } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { getDefaultStoreConfig, IConfig, logger, Network, Store, ContractAddr, TelegramNotif, EkuboCLVaultStrategies, Global, PricerRedis, FatalError, EkuboCLVault, IStrategyMetadata, EkuboPoolKey, CLVaultStrategySettings, EkuboBounds, SwapInfo, Web3Number } from "@strkfarm/sdk";
import { Account, Contract, uint256 } from "starknet";
const schedule = require('node-schedule');

export interface ContractInfo {
  address: string,
  name: string,
  priceSpread: number,
  poolKey?: EkuboPoolKey,
  truePrice: () => Promise<number>
}

export class CLVault {
  readonly config: IConfig;
  readonly contractsInfo = EkuboCLVaultStrategies;
  
  readonly ekuboCLModules: EkuboCLVault[] = [];
  readonly transactionManager: TransactionManager;
  readonly telegramNotif: TelegramNotif;

  ekuboPositionsContract: Contract;
  xSTRKContract: Contract;
  private initialised = false;

  constructor(config: IConfig, txManager: TransactionManager) {
    this.config = config;

    this.transactionManager = txManager;
    this.telegramNotif = new TelegramNotif(process.env.TG_TOKEN, false);
    this.init();
  }

  async init() {
    this.telegramNotif.sendMessage(`Starting Ekubo CL manager`);
    
    const tokens = await Global.getTokens();
    const pricer = new PricerRedis(this.config, tokens);
    if (!process.env.REDIS_URL) {
      throw new FatalError('REDIS_URL not set');
    }
    await pricer.initRedis(process.env.REDIS_URL);
    
    for (let i=0; i<this.contractsInfo.length; i++) {
      const c = this.contractsInfo[i];
      const cls = new EkuboCLVault(this.config, pricer, c);
      this.ekuboCLModules.push(cls);
    }
    logger.log('CLVault initialised');

    // init Ekubo Position
    const ekuboPosition = '0x02e0af29598b407c8716b17f6d2795eca1b471413fa03fb145a5e33722184067';
    const cls = await this.config.provider.getClassAt(ekuboPosition);
    this.ekuboPositionsContract = new Contract(cls.abi, ekuboPosition, this.config.provider as any);
    logger.log('Ekubo Position initialised');

    // init xSTRK Contract
    const xSTRK = '0x028d709c875c0ceac3dce7065bec5328186dc89fe254527084d1689910954b0a';
    const clsXSTRK = await this.config.provider.getClassAt(xSTRK);
    this.xSTRKContract = new Contract(clsXSTRK.abi, xSTRK, this.config.provider as any);
    logger.log('xSTRK Contract initialised');

    this.handleFees();
    const handleFeeJob = schedule.scheduleJob('42 12 * * *', () => {
      this.handleFees();
    });
    this.initialised = true;
  }

  waitForInitialisation() {
    return new Promise<void>((resolve, reject) => {
        const interval = setInterval(() => {
            if (this.initialised) {
                clearInterval(interval);
                resolve();
            }
        }, 1000);
    })
  }

  async start() {
    if (!this.initialised) {
      throw new Error('CLVault not initialised');
    }

    const prisma = new PrismaClient();

    for (let i=0; i<this.contractsInfo.length; i++) {
      try {
        const module = this.ekuboCLModules[i];
        const bounds = await module.getCurrentBounds();
        const poolKey = await module.getPoolKey();
        const currentPrice = await module.getCurrentPrice();
        const poolFee = this.getPoolFeeNumber(poolKey);
        const truePrice = await module.truePrice();
        this.telegramNotif.sendMessage(`[${module.metadata.name}] Bounds: ${bounds.lowerTick} - ${bounds.upperTick}, Current Price: ${currentPrice.price}, tick: ${currentPrice.tick}, Pool Fee: ${poolFee}`);
        this.telegramNotif.sendMessage(`[${module.metadata.name}] True Price: ${truePrice}, tick: ${EkuboCLVault.priceToTick(truePrice, true, Number(poolKey.tick_spacing)).mag}`);

        // create a record
        await prisma.cl_vault_record.create({
          data: {
            contract_address: module.address.address,
            is_below_range: currentPrice.tick < bounds.lowerTick,
            is_above_range: currentPrice.tick > bounds.upperTick,
            timestamp: Math.round(new Date().getTime() / 1000),
            block_number: (await this.config.provider.getBlockLatestAccepted()).block_number
          }
        });

        // just extra notifs in the initial phase
        if (currentPrice.tick < bounds.lowerTick) {
          this.telegramNotif.sendMessage(`[${module.metadata.name}] Price is below lowerTick bound`);
        }
        if (currentPrice.tick > bounds.upperTick) {
          this.telegramNotif.sendMessage(`[${module.metadata.name}] Price is above upperTick bound`);
        }

        // if price is above upperTick bound, do nothing, all good
        if (currentPrice.tick >= bounds.lowerTick && currentPrice.tick <= bounds.upperTick) {
          logger.log(`[${module.metadata.name}] Price is within bounds`);
          continue;
        }

        const last24HrRangeHistory = await this.summariseLast24HrRangeHistory(module);

        // if lowerTick, do nothing, wait for price to go up
        // arb engine should pick it up      if (currentPrice.tick < bounds.lowerTick) {
        if (currentPrice.tick < bounds.lowerTick && last24HrRangeHistory.isAllLower) {
          this.telegramNotif.sendMessage(`[${module.metadata.name}] Price is below lowerTick bound and has been below lowerTick bound for the last 24 hours`);
          continue;
        }

        // if higher but current price below true price, may need to adjust
        if (currentPrice.tick > bounds.upperTick && currentPrice.price < truePrice) {
          this.telegramNotif.sendMessage(`[${module.metadata.name}] Price is above upperTick bound and has been above upperTick bound for the last 24 hours but current price is below true price`);
          this.telegramNotif.sendMessage(`Need to adjust range for ${module.metadata.name}`);
          await this.rebalance(module);
          continue;
        }
      } catch (err) {
        logger.error(err);
        this.telegramNotif.sendMessage(`Error in CLVault:`);
        this.telegramNotif.sendMessage(`${err.message}`);
      }
    }

    pollHeartbeat();
    setTimeout(() => {
      this.start();
    }, 1000 * 60 * 55); // every 55 minutes
  }

  /**
   * @description Get the pool fee number
   * @param poolKey 
   * @returns number
   */
  getPoolFeeNumber(poolKey: EkuboPoolKey) {
    return EkuboCLVault.div2Power128(BigInt(poolKey.fee));
  }

  private async summariseLast24HrRangeHistory(mod: EkuboCLVault) {
    const contract_address = mod.address.address;
    const prisma = new PrismaClient();
    const now = new Date();
    const records = await prisma.cl_vault_record.findMany({
      orderBy: {
        timestamp: 'desc'
      },
      where: {
        contract_address: contract_address.toString(),
        timestamp: {
          lte: Math.round(now.getTime() / 1000)
        }
      },
      take: 24,
    });

    let isTooFewRecords = false;
    if (records.length < 20) {
      isTooFewRecords = true;
    }

    const filteredRecords = records.filter((record, index) => record.timestamp > Math.round(now.getTime() / 1000) - 3600 * 24);
    let isTooFewRecordsInLast24Hrs = false;
    if (filteredRecords.length < 20) {
      isTooFewRecordsInLast24Hrs = true;
    }

    if (!isTooFewRecords && isTooFewRecordsInLast24Hrs) {
      this.telegramNotif.sendMessage(`Too few records in the last 24 hours for ${mod.metadata.name}`);
      return null;
    } else {
      // check if all records are below or above range
      const isAllLower = filteredRecords.every(record => record.is_below_range);
      const isAllHigher = filteredRecords.every(record => record.is_above_range);

      return {
        isAllLower,
        isAllHigher
      }
    }
  }

  async rebalance(mod: EkuboCLVault, retry = 0, factorPercent = 1) {
    const swapInfo = await mod.getSwapInfoToHandleUnused(true);
    logger.verbose(`Swap Info: ${JSON.stringify(swapInfo)}`);
    const acc = getAccount(this.config);
    const newBounds = await mod.getNewBounds();
    const calls = await mod.rebalanceIter(swapInfo, acc, async (_swapInfo) => {
      return await mod.rebalanceCall(newBounds, _swapInfo);
    }, 0, factorPercent);
    logger.verbose(`Rebalance calls: ${JSON.stringify(calls)}`);
    if (calls.length > 0) {
      this.transactionManager.addCalls(calls, `CLVault ${mod.metadata.name}`);
      return;
    }
  }

  async handleFees() {
    this.ekuboCLModules.forEach(async (mod) => {
      try {
        const tvl = await mod.getTVL();
        const feesAccrued = await mod.getUncollectedFees();
        this.telegramNotif.sendMessage(`CLVault: ${mod.metadata.name} - TVL: $${tvl.usdValue}, amt0: ${tvl.token0.amount.toString()}, amt1: ${tvl.token1.amount.toString()}, Fees accrued for ${feesAccrued.usdValue}`);
        if (feesAccrued.usdValue < 1) {
          logger.log(`No fees accrued for ${mod.metadata.name}`);
          return;
        }
        const call = mod.handleFeesCall();
        this.transactionManager.addCalls(call, `CLVault ${mod.metadata.name}`);
      } catch (err) {
        logger.error(`Error in handleFees for ${mod.metadata.name}`);
        logger.error(err);
        this.telegramNotif.sendMessage(`Error in handleFees for ${mod.metadata.name}`);
        this.telegramNotif.sendMessage(`${err.message}`);
      }
    });
  }
}