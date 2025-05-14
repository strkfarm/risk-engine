import { getAccount, pollHeartbeat, TransactionManager } from '@/utils';
import { Bind } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import {
  getDefaultStoreConfig,
  IConfig,
  logger,
  Network,
  Store,
  ContractAddr,
  TelegramNotif,
  EkuboCLVaultStrategies,
  Global,
  PricerRedis,
  FatalError,
  EkuboCLVault,
  IStrategyMetadata,
  EkuboPoolKey,
  CLVaultStrategySettings,
  EkuboBounds,
  SwapInfo,
  Web3Number,
} from '@strkfarm/sdk';
import { Account, Contract, uint256 } from 'starknet';
const schedule = require('node-schedule');

export interface ContractInfo {
  address: string;
  name: string;
  priceSpread: number;
  poolKey?: EkuboPoolKey;
  truePrice: () => Promise<number>;
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

    for (let i = 0; i < this.contractsInfo.length; i++) {
      const c = this.contractsInfo[i];
      const cls = new EkuboCLVault(this.config, pricer, c);
      this.ekuboCLModules.push(cls);
    }
    logger.info('CLVault initialised');

    // init Ekubo Position
    const ekuboPosition =
      '0x02e0af29598b407c8716b17f6d2795eca1b471413fa03fb145a5e33722184067';
    const cls = await this.config.provider.getClassAt(ekuboPosition);
    this.ekuboPositionsContract = new Contract(
      cls.abi,
      ekuboPosition,
      this.config.provider as any,
    );
    logger.info('Ekubo Position initialised');

    // init xSTRK Contract
    const xSTRK =
      '0x028d709c875c0ceac3dce7065bec5328186dc89fe254527084d1689910954b0a';
    const clsXSTRK = await this.config.provider.getClassAt(xSTRK);
    this.xSTRKContract = new Contract(
      clsXSTRK.abi,
      xSTRK,
      this.config.provider as any,
    );
    logger.info('xSTRK Contract initialised');

    const handleFeeJob = schedule.scheduleJob('42 12 * * *', () => {
      this.handleUnused();
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
    });
  }

  async start() {
    if (!this.initialised) {
      throw new Error('CLVault not initialised');
    }

    const prisma = new PrismaClient();

    for (let i = 0; i < this.contractsInfo.length; i++) {
      try {
        const module = this.ekuboCLModules[i];
        const bounds = await module.getCurrentBounds();
        const poolKey = await module.getPoolKey();
        const currentPrice = await module.getCurrentPrice();
        const poolFee = this.getPoolFeeNumber(poolKey);
        const truePrice = await module.truePrice();
        this.telegramNotif.sendMessage(
          `[${module.metadata.name}] Bounds: ${bounds.lowerTick} - ${bounds.upperTick}, Current Price: ${currentPrice.price}, tick: ${currentPrice.tick}, Pool Fee: ${poolFee}`,
        );
        this.telegramNotif.sendMessage(
          `[${module.metadata.name}] True Price: ${truePrice}, tick: ${EkuboCLVault.priceToTick(truePrice, true, Number(poolKey.tick_spacing)).mag}`,
        );

        // create a record
        await prisma.cl_vault_record.create({
          data: {
            contract_address: module.address.address,
            is_below_range: currentPrice.tick < bounds.lowerTick,
            is_above_range: currentPrice.tick > bounds.upperTick,
            timestamp: Math.round(new Date().getTime() / 1000),
            block_number: (await this.config.provider.getBlockLatestAccepted())
              .block_number,
          },
        });
        
        const minHours = module.metadata.additionalInfo.rebalanceConditions.minWaitHours;
        const lastNHrRangeHistory =
        await this.summariseLastNHrRangeHistory(module, minHours);

        // just extra notifs in the initial phase
        if (currentPrice.tick < bounds.lowerTick) {
          this.telegramNotif.sendMessage(
            `[${module.metadata.name}] Price is below lowerTick bound, below count: ${lastNHrRangeHistory?.isBelowFactor.toFixed(4)}`,
          );
        }
        if (currentPrice.tick > bounds.upperTick) {
          this.telegramNotif.sendMessage(
            `[${module.metadata.name}] Price is above upperTick bound, above count: ${lastNHrRangeHistory?.isAboveFactor.toFixed(4)}`,
          );
        }

        if (
          currentPrice.tick >= bounds.lowerTick &&
          currentPrice.tick <= bounds.upperTick
        ) {
          logger.info(`[${module.metadata.name}] Price is within bounds`);
          continue;
        }

        let customShouldRebalance = await module.metadata.additionalInfo.rebalanceConditions.customShouldRebalance(currentPrice.price);
        logger.info(`[${module.metadata.name}]: custom should rebalance? ${customShouldRebalance}`)

        if (!customShouldRebalance) {
          continue;
        }

        let shouldRebalanceStandard = false;
        let rebelanceDirection = module.metadata.additionalInfo.rebalanceConditions.direction;

        if (
          lastNHrRangeHistory?.isAllLower
        ) {
          this.telegramNotif.sendMessage(
            `[${module.metadata.name}] Price is below lowerTick bound and has been below lowerTick bound for the last ${minHours} hours`,
          );
          
          if (
            currentPrice.tick < bounds.lowerTick &&
            rebelanceDirection == 'any'
          ) {
            shouldRebalanceStandard = true;
          }
        } else if (lastNHrRangeHistory?.isAllHigher) {
          this.telegramNotif.sendMessage(
            `[${module.metadata.name}] Price is above upperTick bound and has been above upperTick bound for the last ${minHours} hours`,
          );

          // if higher but current price below true price, may beed to adjust
          if (
            currentPrice.tick > bounds.upperTick &&
            rebelanceDirection == 'any' || rebelanceDirection == 'uponly'
          ) {
            shouldRebalanceStandard = true;
          }
        }

        if (shouldRebalanceStandard) {
          this.telegramNotif.sendMessage(
            `Need to adjust range for ${module.metadata.name}`,
          );
          await this.rebalance(module, poolKey);
          continue;
        }
      } catch (err) {
        logger.error(err);
        this.telegramNotif.sendMessage(`Error in CLVault:`);
        this.telegramNotif.sendMessage(`${err.message}`);
      }
    }

    pollHeartbeat();
    setTimeout(
      () => {
        this.start();
      },
      1000 * 60 * 55,
    ); // every 55 minutes
  }

  /**
   * @description Get the pool fee number
   * @param poolKey
   * @returns number
   */
  getPoolFeeNumber(poolKey: EkuboPoolKey) {
    return EkuboCLVault.div2Power128(BigInt(poolKey.fee));
  }

  private async summariseLastNHrRangeHistory(mod: EkuboCLVault, minHours: number) {
    const contract_address = mod.address.address;
    const prisma = new PrismaClient();
    const now = new Date();
    const records = await prisma.cl_vault_record.findMany({
      orderBy: {
        timestamp: 'desc',
      },
      where: {
        contract_address: contract_address.toString(),
        timestamp: {
          lte: Math.round(now.getTime() / 1000),
        },
      },
      take: minHours,
    });

    let isTooFewRecords = false;
    if (records.length < minHours * 0.9) { // atleast 90% of required data must exist
      isTooFewRecords = true;
    }

    const filteredRecords = records.filter(
      (record, index) =>
        record.timestamp > Math.round(now.getTime() / 1000) - 3600 * minHours,
    );
    let isTooFewRecordsInLastNHrs = false;
    if (filteredRecords.length < minHours * 0.9) {
      isTooFewRecordsInLastNHrs = true;
    }

    if (!isTooFewRecords && isTooFewRecordsInLastNHrs) {
      this.telegramNotif.sendMessage(
        `Too few records in the last ${minHours} hours for ${mod.metadata.name}`,
      );
      return null;
    } else {
      // check if all records are below or above range
      const isAllLower = filteredRecords.every(
        (record) => record.is_below_range,
      );
      
      const isAllHigher = filteredRecords.every(
        (record) => record.is_above_range,
      );

      // count how many higher
      const isAboveLen = filteredRecords.filter((f) => f.is_above_range).length;
      const isBelowLen = filteredRecords.filter((f) => f.is_below_range).length;
      
      return {
        isAllLower,
        isAllHigher,
        isAboveFactor: isAboveLen / filteredRecords.length,
        isBelowFactor: isBelowLen / filteredRecords.length,
      };
    }
  }

  async rebalance(mod: EkuboCLVault, poolInfo: EkuboPoolKey, retry = 0) {
    const tvlInfo = await mod.getTVL();
    const swapInfo = await mod.getSwapInfoToHandleUnused(true);
    const acc = getAccount(this.config);
    const newBounds = await mod.getNewBounds();
    const isSellTokenToken0 = poolInfo.token0.eqString(swapInfo.token_from_address);
    const calls = await mod.rebalanceIter(
      swapInfo,
      acc as any,
      async (_swapInfo) => {
        logger.verbose(`Swap Info: ${JSON.stringify(_swapInfo)}`);
        return await mod.rebalanceCall(newBounds, _swapInfo);
      },
      isSellTokenToken0,
      0,
      // lower limit
      0n,
      // upper limit
      isSellTokenToken0 ? BigInt(tvlInfo.token0.amount.toWei()) : BigInt(tvlInfo.token1.amount.toWei())
    );
    logger.verbose(`Rebalance calls: ${JSON.stringify(calls)}`);
    if (calls.length > 0) {
      this.transactionManager.addCalls(calls, `CLVault ${mod.metadata.name}`);
      return;
    }
  }

  handleFees(forceHandleFees = false) {
    return new Promise<void>((resolve, reject) => {
      this.ekuboCLModules.forEach(async (mod) => {
        try {
          const tvl = await mod.getTVL();
          const feesAccrued = await mod.getUncollectedFees();
          this.telegramNotif.sendMessage(
            `CLVault::Fees: ${mod.metadata.name} - TVL: $${tvl.usdValue}, amt0: ${tvl.token0.amount.toString()}, amt1: ${tvl.token1.amount.toString()}, Fees accrued for ${feesAccrued.usdValue}`,
          );
          if (feesAccrued.usdValue < 1 && !forceHandleFees) {
            logger.info(`No fees accrued for ${mod.metadata.name}`);
            return;
          }
          const call = mod.handleFeesCall();

          // resolve is called when the tx is successful
          this.transactionManager.addCalls(call, `CLVault handle fees ${mod.metadata.name}`, resolve);
        } catch (err) {
          logger.error(`Error in handleFees for ${mod.metadata.name}`);
          logger.error(err);
          this.telegramNotif.sendMessage(
            `Error in handleFees for ${mod.metadata.name}`,
          );
          this.telegramNotif.sendMessage(`${err.message}`);
          reject(err);
        }
      });
    });
  }

  async handleUnused() {      
    await this.handleFees(true);

    [this.ekuboCLModules[0]].forEach(async (mod) => {
      try {
        const tvl = await mod.getTVL();
        const unusedBalances = await mod.unusedBalances();
        const totalUnused = unusedBalances.token0.usdValue + unusedBalances.token1.usdValue;
        this.telegramNotif.sendMessage(
          `CLVault::Unused: ${mod.metadata.name} - TVL: $${tvl.usdValue}, amt0: ${tvl.token0.amount.toString()}, amt1: ${tvl.token1.amount.toString()}, total unused: ${totalUnused}`,
        );
        if (totalUnused < 1) {
          logger.info(`No unused balances for ${mod.metadata.name}`);
          return;
        }
        const swapInfo = await mod.getSwapInfoToHandleUnused(false);
        const call = mod.handleUnusedCall(swapInfo);
        this.transactionManager.addCalls(call, `CLVault Unused ${mod.metadata.name}`);
      } catch (err) {
        logger.error(`Error in handleUnused for ${mod.metadata.name}`);
        logger.error(err);
        this.telegramNotif.sendMessage(
          `Error in handleUnused for ${mod.metadata.name}`,
        );
        this.telegramNotif.sendMessage(`${err.message}`);
      }
    });
  }
}
