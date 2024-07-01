// import { NestFactory } from '@nestjs/core';
// import { AppModule } from './app.module';

import { RpcProvider, provider } from "starknet";
import { DeltaNeutraMM } from "./monitors/delta_neutral_mm";

// async function bootstrap() {
//   const app = await NestFactory.create(AppModule);
//   await app.listen(3000);
// }
// bootstrap();

export interface IConfig {
  provider: RpcProvider
}

if (require.main === module) {
  const config = {
    provider: new RpcProvider({
      nodeUrl: 'https://starknet-mainnet.public.blastapi.io'
    })
  }

  async function run() {
    const dnmm = new DeltaNeutraMM(config);
    await dnmm.waitForInitialisation();
    dnmm.start();
  }
  
  run();
}
