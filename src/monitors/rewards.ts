import { Call, Contract, uint256, TransactionExecutionStatus } from "starknet";;
import axios from "axios";
import { getAccount, TransactionManager } from "@/utils";
import { IConfig, logger, TelegramNotif, Web3Number } from "@strkfarm/sdk";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
export class RewardsModule {
  readonly config: IConfig;
  readonly transactionManager: TransactionManager;
  readonly telegramNotif: TelegramNotif;

  constructor(config: IConfig, txManager: TransactionManager) {
    this.config = config;

    this.transactionManager = txManager;
    this.telegramNotif = new TelegramNotif(process.env.TG_TOKEN, false);
  }

  async sendRewards() {
    const res = await axios.get('http://beta.strkfarm.com/api/rewards');
    const rewardsInfo = res.data;
    const calls: Call[] = [];

    for (let reward of rewardsInfo.rewards) {
      logger.log(`Reward: ${JSON.stringify(reward)}`);
      if (reward.reward == 0) continue;

      // last reward
      const lastReward = await prisma.rewards.findFirst({
        orderBy: {
          timestamp: 'desc',
        },
        where: {
          strategy_id: reward.id,
        }
      })
      if (lastReward && (new Date().getTime() - (lastReward.timestamp) * 1000) < 50 * 60 * 1000) { // 50 minutes
        logger.log(`Last reward for ${reward.id} was less than 50 minutes ago`);
        continue;
      }
      const cls = await this.config.provider.getClassAt(reward.rewardToken);
      const rewardTokenContract = new Contract(cls.abi, reward.rewardToken, this.config.provider as any);
      const call = rewardTokenContract.populate('transfer', [reward.receiver, uint256.bnToUint256(new Web3Number(reward.reward.toFixed(13), reward.rewardDecimals).toWei())])
      calls.push(call);
      this.telegramNotif.sendMessage(`Sending rewards to ${reward.id} of ${reward.reward}`);
    }
    if (calls.length) {
      const acc = getAccount(this.config);
      let retry = 0;
      while (retry < 3) {
        try {
          const rewardDoc = await prisma.rewards.createMany({
            data: rewardsInfo.rewards.map((reward: any) => ({
              timestamp: Math.floor(Date.now() / 1000),
              strategy_id: reward.id,
              reward_amount: reward.reward,
              reward_token: reward.rewardToken,
              tx_hash: ""
            }))
          });
          logger.log(`Rewards saved to DB`);
          this.telegramNotif.sendMessage(`Rewards saved to DB`);
          
          const tx = await acc.execute(calls);
          logger.log(`Rewards Transaction sent: ${tx.transaction_hash}`);
          await this.config.provider.waitForTransaction(tx.transaction_hash, {
            successStates: [TransactionExecutionStatus.SUCCEEDED]
          });
          logger.log(`Rewards Transaction succeeded: ${tx.transaction_hash}`);
          this.telegramNotif.sendMessage(`Rewards Transaction succeeded: ${tx.transaction_hash}`);
          await prisma.rewards.updateMany({
            where: {
              strategy_id: {
                in: rewardsInfo.rewards.map((reward: any) => reward.id)
              }
            },
            data: {
              tx_hash: tx.transaction_hash
            }
          });
          logger.log(`Rewards Transaction hash saved to DB`);
          break;
        } catch (err) {
          console.error(`Rewards Transaction failed: retry: ${retry}`, err);
          if (retry >= 10) {
            logger.error(`Rewards Transaction failed: ${err}`);
            this.telegramNotif.sendMessage(`Rewards Transaction failed: ${err}`);
            throw err;
          }
          retry += 1;
          await new Promise(resolve => setTimeout(resolve, 1000 * retry));
        }
      }
    } else {
      logger.log(`No rewards to send`);
    }
  }
}