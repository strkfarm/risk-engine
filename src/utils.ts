import { getDefaultStoreConfig, IConfig, logger, Network, Store, TelegramNotif } from "@strkfarm/sdk";
import axios from "axios";
import { Account, Call, TransactionExecutionStatus } from "starknet";

export async function pollHeartbeat() {
    try {
        await axios.get(process.env.HEARTBEAT);
    } catch(err) {
        console.error(`heartbeat`, err);
    }
}

export function getAccount(config: IConfig) {
    const defaultStoreConfig = getDefaultStoreConfig(<Network>process.env.NETWORK);
    defaultStoreConfig.PASSWORD = process.env.ACCOUNT_SECURE_PASSWORD;
    defaultStoreConfig.ACCOUNTS_FILE_NAME = 'accounts-risk.json'
    const store = new Store(config, defaultStoreConfig);
    
    if (!process.env.ACCOUNT_NAME) {
        throw new Error('ACCOUNT_NAME not set');
    }
    return <Account>(store.getAccount(process.env.ACCOUNT_NAME, '0x3') as any);
}

export class TransactionManager {
    private calls: {call: Call, source: string}[] = [];
    readonly account: Account;
    readonly telegramNotif: TelegramNotif;
    constructor(config: IConfig) {
        this.account = getAccount(config);
        this.telegramNotif = new TelegramNotif(process.env.TG_TOKEN, false);
        this.start();
    }

    start() {
        setInterval(() => {
            this.execute();
        }, 10000);
    }

    addCalls(calls: Call[], source: string) {
        logger.info(`Adding call from ${source}`);
        this.calls = this.calls.concat(calls.map(call => ({call, source})));
    }

    private async execute() {
        if (this.calls.length === 0) {
            return;
        }
        logger.info(`Sending transaction with ${this.calls.length} calls`);
        const callsInfo = [...this.calls];
        this.calls = [];
        const calls = callsInfo.map(c => c.call);

        // Update summary of source success in telegram
        const sourceSuccessMsg = callsInfo.reduce((acc, c) => {
            if (!acc[c.source]) {
                acc[c.source] = 0;
            }
            acc[c.source]++;
            return acc;
        }, {});
        const sourceSuccessStr = Object.entries(sourceSuccessMsg).map(([source, success]) => `${source}: ${success}`).join('\n');
       
        const MAX_RETRY = 3;
        let retry = 0;
        let _err: any | null = null;
        while (retry < MAX_RETRY) {
            try {
                const tx = await this.account.execute(calls);
                logger.info(`Transaction sent: ${tx.transaction_hash}`);
                await this.account.waitForTransaction(tx.transaction_hash, {
                    successStates: [TransactionExecutionStatus.SUCCEEDED],
                });
                logger.info(`Transaction succeeded: ${tx.transaction_hash}`);
                
                this.telegramNotif.sendMessage(`RiskManager: Transaction succeeded\n${sourceSuccessStr}`);
                return;
            } catch (err) {
                _err = err;
                retry += 1;
                if (retry >= MAX_RETRY) {
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 1000));
                logger.error(`Transaction failed, retrying... (${retry}/${MAX_RETRY})`, sourceSuccessMsg);
            }
        }

        // tx not succeeded
        logger.error(`Error in TransactionManager`, _err);
        this.telegramNotif.sendMessage(`RiskManager: Error in TransactionManager: ${_err}, source: ${sourceSuccessStr}`);
        this.calls = callsInfo.concat(this.calls); // to add new calls added in this time
    }
}