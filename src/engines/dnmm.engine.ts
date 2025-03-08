import * as dotenv from 'dotenv';
dotenv.config();
import { getMainnetConfig } from "@strkfarm/sdk";
import { DeltaNeutraMM } from "@/monitors/delta_neutral_mm";
import { CLVault } from '@/monitors/cl_vault';

async function main() {
  const config = getMainnetConfig();

  const dnmm = new DeltaNeutraMM(config);
  await dnmm.waitForInitialisation();

  const clVault = new CLVault(config);
  await clVault.waitForInitialisation();

  // Start monitors
  dnmm.start();
  clVault.start();
}

if (require.main === module) {
  main();
}