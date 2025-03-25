import { getAccount, TransactionManager } from "@/utils";
import { FatalError, Global, IConfig, logger, PricerRedis, TelegramNotif, VesuRebalance, VesuRebalanceStrategies } from "@strkfarm/sdk";
import { Account, Call, Contract, TransactionExecutionStatus } from "starknet";

export class VesuRebalancer {
  readonly config: IConfig;
  readonly contractsInfo = VesuRebalanceStrategies;

  readonly vesuRebalanceModules: VesuRebalance[] = [];
  readonly transactionManager: TransactionManager;
  readonly telegramNotif: TelegramNotif;
  
  private initialised = false;
  
  constructor(config: IConfig, txManager: TransactionManager) {
    this.config = config;
    this.telegramNotif = new TelegramNotif(process.env.TG_TOKEN, false);
    this.transactionManager = txManager;
    this.init();
  }

  async init() {
    this.telegramNotif.sendMessage(`Starting Delta Neutral MM risk manager`);

    const tokens = await Global.getTokens();
    const pricer = new PricerRedis(this.config, tokens);
    if (!process.env.REDIS_URL) {
      throw new FatalError('REDIS_URL not set');
    }
    await pricer.initRedis(process.env.REDIS_URL);

    for(let i=0; i<this.contractsInfo.length; ++i) {
        const c = this.contractsInfo[i];
        const cls = new VesuRebalance(this.config, pricer, c);
        this.vesuRebalanceModules.push(cls);
    }

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

  async start(count = 0) {
    if (count % 6 == 0) {
      await this.statusMessage();
    }

    try {
      await this.waitForInitialisation();
      await this.checkAndRebalance();
    } catch (err) {
      logger.error(`Error in VesuRebalancer: ${err}`);
      this.telegramNotif.sendMessage(`Error in VesuRebalancer: ${err}`);
    }

    setTimeout(() => {
      this.start(count + 1)
    }, 3600 * 1000); // 1 hour
  }

  async checkAndRebalance() {
    const calls: Call[] = [];
    for (const vesuRebalance of this.vesuRebalanceModules) {
      const {netApy, newYield, changes, isAnyPoolOverMaxWeight} = await this.getPoolInfo(vesuRebalance);
      const rebalanceCondition1 = newYield - netApy > 0.01; // 1% improvement
      const rebalanceCondition2 = isAnyPoolOverMaxWeight // 

      if (rebalanceCondition1 || rebalanceCondition2) {
        logger.info(`${VesuRebalance.name}: ${vesuRebalance.metadata.name} => rebalancing required`);
        this.telegramNotif.sendMessage(`${VesuRebalance.name}: ${vesuRebalance.metadata.name} => rebalancing required\nnet APY: ${(netApy * 100).toFixed(4)}% => ${(newYield * 100).toFixed(4)}%\nisAnyPoolOverMaxWeight: ${isAnyPoolOverMaxWeight}`);
        calls.push(await vesuRebalance.getRebalanceCall(changes, isAnyPoolOverMaxWeight));
      }
    }

    if (calls.length > 0) {
      this.transactionManager.addCalls(calls, 'VesuRebalancer');
    }
  }

  async statusMessage() {
    let msg: string = '';
    for (let cls of this.vesuRebalanceModules) {
      const {currentPools, netApy, newYield, changes, isAnyPoolOverMaxWeight} = await this.getPoolInfo(cls);
      const weightSummary = currentPools.filter(p => p.pool_name).map(p => `${p.pool_name}: ${p.current_weight}/${p.max_weight}, poolYield: ${(p.APY.netApy * 100).toFixed(4)}%`).join(', ');
      msg += `${cls.metadata.name} => net APY: ${(netApy * 100).toFixed(4)}%\nNew APY: ${(newYield * 100).toFixed(4)}%\n${weightSummary}\n\n`;
    }
    this.telegramNotif.sendMessage(msg);
  }

  private async getPoolInfo(vesuRebalance: VesuRebalance) {
    const currentPoolsInfo = await vesuRebalance.getPools();
    const netApy = await vesuRebalance.netAPYGivenPools(currentPoolsInfo.data);
    logger.verbose(`${VesuRebalance.name}: ${vesuRebalance.metadata.name} => net APY: ${(netApy * 100).toFixed(4)}%`);

    const {changes, finalPools, isAnyPoolOverMaxWeight} = await vesuRebalance.getRebalancedPositions();

    const newYield = await vesuRebalance.netAPYGivenPools(finalPools);
    logger.verbose(`${VesuRebalance.name}: ${vesuRebalance.metadata.name} => net APY after rebalance: ${(newYield * 100).toFixed(4)}%`);

    return {
      currentPools: currentPoolsInfo.data,
      netApy,
      newYield,
      changes,
      isAnyPoolOverMaxWeight
    }
  }
}