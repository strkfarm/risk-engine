// import { NestFactory } from '@nestjs/core';
// import { AppModule } from './app.module';
import * as dotenv from 'dotenv';
dotenv.config();
import { getMainnetConfig } from "strkfarm-sdk";
import { DeltaNeutraMM } from "./monitors/delta_neutral_mm";

// async function bootstrap() {
//   const app = await NestFactory.create(AppModule);
//   await app.listen(3000);
// }
// bootstrap();

async function main() {
  const config = getMainnetConfig();
  // const loanGuard = new LoanGuardService(config);
  // await loanGuard.waitForInitilisation();
  // await loanGuard.start();

  const dnmm = new DeltaNeutraMM(config);
  await dnmm.waitForInitialisation();
  dnmm.start();
}

main();