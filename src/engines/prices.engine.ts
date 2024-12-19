import * as dotenv from 'dotenv';
dotenv.config();
import { getMainnetConfig, Global, logger, PricerRedis } from "@strkfarm/sdk";

async function run() {
  const tokens = await Global.getTokens();
  const config = getMainnetConfig();
  config.heartbeatUrl = process.env.PRICER_HEARTBEAT;
  const pricer = new PricerRedis(config, tokens);
  if (!process.env.REDIS_URL) {
    logger.error("REDIS_URL not set");
    process.exit(1);
  }

  await pricer.startWithRedis(process.env.REDIS_URL);
  await pricer.waitTillReady();
}

if (require.main === module) {
  run();
}