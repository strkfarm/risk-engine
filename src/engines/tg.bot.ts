import * as dotenv from 'dotenv';
dotenv.config();
import { TelegramNotif } from "@strkfarm/sdk";

async function run() {
  const telegramBot = new TelegramNotif(process.env.TG_TOKEN, true);
  telegramBot.activateChatBot();
}

if (require.main === module) {
  run();
}