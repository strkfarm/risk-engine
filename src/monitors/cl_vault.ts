import { pollHeartbeat } from "@/utils";
import { Bind } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { getDefaultStoreConfig, IConfig, logger, Network, Store, ContractAddr, TelegramNotif } from "@strkfarm/sdk";
import { Account, Contract, uint256 } from "starknet";

interface PoolKey {
  token0: string,
  token1: string,
  fee: string,
  tick_spacing: string,
  extension: string
}

export interface ContractInfo {
  address: string,
  name: string,
  priceSpread: number,
  poolKey?: PoolKey,
  truePrice: () => Promise<number>
}

export class CLVault {
  readonly config: IConfig;
  readonly contractsInfo: ContractInfo[] = [{
    address: ContractAddr.from('0x1f083b98674bc21effee29ef443a00c7b9a500fd92cf30341a3da12c73f2324').address,
    name: 'Ekubo xSTRK/STRK',
    priceSpread: 0.02,
    truePrice: this.xSTRKTruePrice.bind(this)
  }];
  
  readonly account: Account;
  readonly contracts: Contract[] = [];
  readonly telegramNotif: TelegramNotif;
  ekuboPositionsContract: Contract;
  xSTRKContract: Contract;
  private initialised = false;

  constructor(config: IConfig) {
    this.config = config;

    // configure the account for asset management
    const defaultStoreConfig = getDefaultStoreConfig(<Network>process.env.NETWOR);
    defaultStoreConfig.PASSWORD = process.env.ACCOUNT_SECURE_PASSWORD;
    defaultStoreConfig.ACCOUNTS_FILE_NAME = 'accounts-risk.json'
    const store = new Store(this.config, defaultStoreConfig);
    
    if (!process.env.ACCOUNT_NAME) {
        throw new Error('ACCOUNT_NAME not set');
    }
    this.account = <any>store.getAccount(process.env.ACCOUNT_NAME);
    this.telegramNotif = new TelegramNotif(process.env.TG_TOKEN, false);
    this.init();
  }

  async init() {
    for (let i=0; i<this.contractsInfo.length; i++) {
      let contractInfo = this.contractsInfo[i];
      const cls = await this.config.provider.getClassAt(contractInfo.address);
      const contract = new Contract(cls.abi, contractInfo.address, this.config.provider);
      this.contracts.push(contract);
      const result: any = await contract.call('get_settings', []);
      this.contractsInfo[i].poolKey = {
        token0: result.pool_key.token0.toString(),
        token1: result.pool_key.token1.toString(),
        fee: result.pool_key.fee.toString(),
        tick_spacing: result.pool_key.tick_spacing.toString(),
        extension: result.pool_key.extension.toString()
      };
    }
    logger.log('CLVault initialised');

    // init Ekubo Position
    const ekuboPosition = '0x02e0af29598b407c8716b17f6d2795eca1b471413fa03fb145a5e33722184067';
    const cls = await this.config.provider.getClassAt(ekuboPosition);
    this.ekuboPositionsContract = new Contract(cls.abi, ekuboPosition, this.config.provider);
    logger.log('Ekubo Position initialised');

    // init xSTRK Contract
    const xSTRK = '0x028d709c875c0ceac3dce7065bec5328186dc89fe254527084d1689910954b0a';
    const clsXSTRK = await this.config.provider.getClassAt(xSTRK);
    this.xSTRKContract = new Contract(clsXSTRK.abi, xSTRK, this.config.provider);
    logger.log('xSTRK Contract initialised');

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
        const contractInfo = this.contractsInfo[i];
        const bounds = await this.getBounds(i);
        const currentPrice = await this.getCurrentPrice(contractInfo.poolKey);
        const poolFee = this.getPoolFeeNumber(contractInfo.poolKey);
        const truePrice = await contractInfo.truePrice();
        this.telegramNotif.sendMessage(`[${contractInfo.name}] Bounds: ${bounds.lower} - ${bounds.upper}, Current Price: ${currentPrice.price}, tick: ${currentPrice.tick}, Pool Fee: ${poolFee}`);
        this.telegramNotif.sendMessage(`[${contractInfo.name}] True Price: ${truePrice}, tick: ${this.priceToTick(truePrice, true, Number(contractInfo.poolKey.tick_spacing)).mag}`);

        // create a record
        await prisma.cl_vault_record.create({
          data: {
            contract_address: contractInfo.address,
            is_below_range: currentPrice.tick < bounds.lower,
            is_above_range: currentPrice.tick > bounds.upper,
            timestamp: Math.round(new Date().getTime() / 1000),
            block_number: (await this.config.provider.getBlockLatestAccepted()).block_number
          }
        });

        // just extra notifs in the initial phase
        if (currentPrice.tick < bounds.lower) {
          this.telegramNotif.sendMessage(`[${contractInfo.name}] Price is below lower bound`);
        }
        if (currentPrice.tick > bounds.upper) {
          this.telegramNotif.sendMessage(`[${contractInfo.name}] Price is above upper bound`);
        }

        // if price is above upper bound, do nothing, all good
        if (currentPrice.tick >= bounds.lower && currentPrice.tick <= bounds.upper) {
          logger.log(`[${contractInfo.name}] Price is within bounds`);
          continue;
        }

        const last24HrRangeHistory = await this.summariseLast24HrRangeHistory(contractInfo);

        // if lower, do nothing, wait for price to go up
        // arb engine should pick it up      if (currentPrice.tick < bounds.lower) {
        if (currentPrice.tick < bounds.lower && last24HrRangeHistory.isAllLower) {
          this.telegramNotif.sendMessage(`[${contractInfo.name}] Price is below lower bound and has been below lower bound for the last 24 hours`);
          continue;
        }

        // if higher but current price below true price, may need to adjust
        if (currentPrice.tick > bounds.upper && currentPrice.price < truePrice) {
          this.telegramNotif.sendMessage(`[${contractInfo.name}] Price is above upper bound and has been above upper bound for the last 24 hours but current price is below true price`);
          this.telegramNotif.sendMessage(`Need to adjust range for ${contractInfo.name}`);
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

  async getBounds(contractIndex: number) {
    const contract = this.contracts[contractIndex];
    const result: any = await contract.call('get_position_key', []);
    return {
      lower: Number(result.bounds.lower.mag) * (result.bounds.lower.sign.toString() == "false" ? 1 : -1),
      upper: Number(result.bounds.upper.mag) * (result.bounds.upper.sign.toString() == "false" ? 1 : -1)
    }
  }

  async getCurrentPrice(poolKey: PoolKey) {
    const priceInfo: any = await this.ekuboPositionsContract.call('get_pool_price', [
      poolKey
    ])
    const sqrtRatio = this.div2Power128(BigInt(priceInfo.sqrt_ratio.toString()));
    const price = sqrtRatio * sqrtRatio;
    const tick = this.priceToTick(price, true, Number(poolKey.tick_spacing));
    return {
      price,
      tick: tick.mag * (tick.sign == 0 ? 1 : -1)
    }
  }

  /**
   * @description Get the pool fee number
   * @param poolKey 
   * @returns number
   */
  getPoolFeeNumber(poolKey: PoolKey) {
    return this.div2Power128(BigInt(poolKey.fee));
  }

  /**
   * @description Get the pool tick spacing number
   * @param num 
   * @returns number
   */
  private div2Power128(num: BigInt): number {
    return (Number(((BigInt(num.toString()) * 1000000n) / BigInt(2 ** 128))) / 1000000)
  }

  private priceToTick(price: number, isRoundDown: boolean, tickSpacing: number) {
    const value = isRoundDown ? Math.floor(Math.log(price) / Math.log(1.000001)) : Math.ceil(Math.log(price) / Math.log(1.000001));
    const tick = Math.floor(value / tickSpacing) * tickSpacing;
    if (tick < 0) {
        return {
            mag: -tick,
            sign: 1
        };
    } else {
        return {
            mag: tick,
            sign: 0
        };
    }
  }

  private async summariseLast24HrRangeHistory(contractInfo: ContractInfo) {
    const contract_address = contractInfo.address;
    const prisma = new PrismaClient();
    const now = new Date();
    const records = await prisma.cl_vault_record.findMany({
      orderBy: {
        timestamp: 'desc'
      },
      where: {
        contract_address,
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
      this.telegramNotif.sendMessage(`Too few records in the last 24 hours for ${contractInfo.name}`);
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

  async xSTRKTruePrice() {
    const result: any = await this.xSTRKContract.call('convert_to_assets', [uint256.bnToUint256(BigInt(10e18).toString())]);
    const truePrice = Number(BigInt(result.toString()) * BigInt(10e9)/ BigInt(10e18)) / 10e9;
    return truePrice;
  }
}