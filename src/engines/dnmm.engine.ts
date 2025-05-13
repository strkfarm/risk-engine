import * as dotenv from 'dotenv';
dotenv.config();
import { getMainnetConfig, VesuRebalance } from "@strkfarm/sdk";
import { DeltaNeutraMM } from "@/monitors/delta_neutral_mm";
import { CLVault } from '@/monitors/cl_vault';
import { VesuRebalancer } from '@/monitors/vesu_rebalance';
import { TransactionManager } from '@/utils';
import { RewardsModule } from '@/monitors/rewards';
import { EndurArbitrage } from '@/monitors/endur_arbitrage';
const schedule = require('node-schedule');

async function main() {
  const config = getMainnetConfig(process.env.RPC_URL!);
  const txManager = new TransactionManager(config);
  txManager.start();
  
  const dnmm = new DeltaNeutraMM(config);
  await dnmm.waitForInitialisation();

  const clVault = new CLVault(config, txManager);
  await clVault.waitForInitialisation();

  const vesuRebalancer = new VesuRebalancer(config, txManager);
  await vesuRebalancer.waitForInitialisation();

  // const endurArb = new EndurArbitrage(config, txManager);
  // await endurArb.init();

  // @no longer used
  // const rewardsMod = new RewardsModule(config, txManager);
  // schedule.scheduleJob('13 * * * *', () => {
  //   console.log('Sending rewards');
  //   rewardsMod.sendRewards();
  // });

  // Start monitors
  dnmm.start();
  clVault.start();
  vesuRebalancer.start();
  endurArb.start();
}

if (require.main === module) {
  main();
}