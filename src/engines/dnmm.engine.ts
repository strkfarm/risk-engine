import * as dotenv from 'dotenv';
dotenv.config();
import { getMainnetConfig } from "@strkfarm/sdk";
import { DeltaNeutraMM } from "@/monitors/delta_neutral_mm";

async function main() {
  const config = getMainnetConfig();

  const dnmm = new DeltaNeutraMM(config);
  await dnmm.waitForInitialisation();
  dnmm.start();
}

if (require.main === module) {
  main();
}