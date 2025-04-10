import * as dotenv from 'dotenv';
dotenv.config();
import { getMainnetConfig, VesuRebalance } from "@strkfarm/sdk";
import { DeltaNeutraMM } from "@/monitors/delta_neutral_mm";
import { CLVault } from '@/monitors/cl_vault';
import { VesuRebalancer } from '@/monitors/vesu_rebalance';
import { TransactionManager } from '@/utils';

async function main() {
  const config = getMainnetConfig(process.env.RPC_URL!);
  const txManager = new TransactionManager(config);
  txManager.start();
  
  // const dnmm = new DeltaNeutraMM(config);
  // await dnmm.waitForInitialisation();

  // const clVault = new CLVault(config, txManager);
  // await clVault.waitForInitialisation();

  const vesuRebalancer = new VesuRebalancer(config, txManager);
  await vesuRebalancer.waitForInitialisation();

  // Start monitors
  // dnmm.start();
  // clVault.start();
  vesuRebalancer.start();
}

if (require.main === module) {
  main();
}