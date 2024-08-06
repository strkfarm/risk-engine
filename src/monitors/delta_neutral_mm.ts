import { pollHeartbeat } from "@/utils";
import assert from "assert";
import { Account, Call, Contract, uint256 } from "starknet";
import { FatalError } from "strkfarm-sdk";
import { PricerRedis } from "strkfarm-sdk";
import { getDefaultStoreConfig } from "strkfarm-sdk";
import { Network } from "strkfarm-sdk";
import { ContractAddr, Global, IConfig, ILendingPosition, 
    logger, Pricer, Store, TelegramNotif, ZkLend, Pragma } from "strkfarm-sdk";

export interface ContractInfo {
    address: string,
    name: string,
    minHfBasisPoints: BigInt,
    targetHfBasisPoints: BigInt,
    mainToken: string,
    secondaryToken: string
}

export class DeltaNeutraMM {
    readonly config: IConfig;
    readonly contractsInfo: ContractInfo[] = [{
        name: 'DeltaNeutralLoopingUSDCETH',
        address: '0x4937b58e05a3a2477402d1f74e66686f58a61a5070fcc6f694fb9a0b3bae422',
        minHfBasisPoints: BigInt(0),
        targetHfBasisPoints: BigInt(0),
        mainToken: 'USDC',
        secondaryToken: 'ETH',
    }, {
        name: 'DeltaNeutralLoopingSTRKETH',
        address: '0x20d5fc4c9df4f943ebb36078e703369c04176ed00accf290e8295b659d2cea6',
        minHfBasisPoints: BigInt(0),
        targetHfBasisPoints: BigInt(0),
        mainToken: 'STRK',
        secondaryToken: 'ETH',
    }];

    readonly contracts: {[key: string]: Contract} = {}
    readonly pragma: Pragma;
    zkLend: ZkLend;
    private initialised = false;
    readonly account: any;
    readonly telegramNotif: TelegramNotif;
    private isFirstRun = true;
    constructor(config: IConfig) {
        this.config = config;
        const defaultStoreConfig = getDefaultStoreConfig(<Network>process.env.NETWOR);
        defaultStoreConfig.PASSWORD = process.env.ACCOUNT_SECURE_PASSWORD;
        defaultStoreConfig.ACCOUNTS_FILE_NAME = 'accounts-risk.json'
        const store = new Store(this.config, defaultStoreConfig);
        
        if (!process.env.ACCOUNT_NAME) {
            throw new Error('ACCOUNT_NAME not set');
        }
        this.account = store.getAccount(process.env.ACCOUNT_NAME);
        this.telegramNotif = new TelegramNotif(process.env.TG_TOKEN, false);
        this.pragma = new Pragma(this.config.provider);
        this.init();
    }

    async init() {
        this.telegramNotif.sendMessage(`Starting Delta Neutral MM risk manager`);
        const cls = await this.config.provider.getClassAt(this.contractsInfo[0].address);
        this.contractsInfo.forEach(c => {
            this.contracts[c.name] = new Contract(cls.abi, c.address, <any>this.config.provider)
        })
        await this.loadSettings();

        const tokens = await Global.getTokens();
        const pricer = new PricerRedis(this.config, tokens);
        if (!process.env.REDIS_URL) {
          throw new FatalError('REDIS_URL not set');
        }
        await pricer.initRedis(process.env.REDIS_URL);
        this.zkLend = new ZkLend(this.config, pricer);
        await this.zkLend.waitForInitilisation();
        this.initialised = true;
    }

    waitForInitialisation() {
        return new Promise<void>((resolve, reject) => {
            const interval = setInterval(() => {
                if (this.initialised) {
                    clearInterval(interval);
                    resolve();
                }
            }, 1000);
        })
    }

    async start() {
        try {
            pollHeartbeat();
            const calls = await this.shouldRebalance();
            if (calls.length > 0) {
                this.isFirstRun = true;
                console.log(`Submitting batch of ${calls.length} calls`);
                this.telegramNotif.sendMessage(`Submitting batch of ${calls.length} calls ♻️`);
                // execute calls
                const tx = await this.account.execute(calls);
                logger.info(`Transaction submitted: ${tx.transaction_hash}`);
                await this.config.provider.waitForTransaction(tx.transaction_hash);
                logger.info(`Transaction confirmed: ${tx.transaction_hash}`);
                this.telegramNotif.sendMessage(`DNMM:: Completed ${calls.length} rebalances ✅`);
            }
        } catch(err) {
            console.error(`DNMM Risk error`, err);
            this.telegramNotif.sendMessage(`DNMM Risk error ⚠️☠️🚨⚠️☠️🚨`)
        }

        setTimeout(async () => {
            this.start();
        }, 120 * 1000); // 2 minutes
    }

    async shouldRebalance() {
        const calls: Call[]  = [];
        for (let i=0; i<this.contractsInfo.length; ++i) {
            console.log(`name: ${this.contractsInfo[i].name}`)
            const contract = this.contracts[this.contractsInfo[i].name];
            const result = await contract.call('health_factors', [])
            const hf1 = result[0];
            const hf2 = result[1];
            const now = new Date();
            if (now.getHours() % 3 == 0 && now.getMinutes() <= 5 || this.isFirstRun) {
                this.telegramNotif.sendMessage(`${this.contractsInfo[i].name}:: Current health factors: ${hf1}, ${hf2}`);
            }

            console.log(this.contractsInfo[i], hf1, hf2);
            // if either health factor is below the minimum, we should rebalance
            if (hf1 < this.contractsInfo[i].minHfBasisPoints || hf2 < this.contractsInfo[i].minHfBasisPoints) {
                console.log(`Rebalancing ${this.contractsInfo[i].name}`);
                const call = await this.generateRebalanceCall(hf1, hf2, this.contractsInfo[i], contract);
                calls.push(call);
            }
        }

        console.log(`Rebalancing calls: ${calls.length}`);
        this.isFirstRun = false;
        return calls;
    }

    async generateRebalanceCall(currentHf1: BigInt, currentHf2: BigInt, contractInfo: ContractInfo, contract: Contract) {
        const zkLendPositions = await this.zkLend.getPositions(ContractAddr.from(contract.address));
        const minHf: BigInt = contractInfo.minHfBasisPoints;
        if (currentHf1 < minHf) {
            // e.g. zkLend is unhealth. repay some debt in zklend by withdrawing from nostra
            const debtToRepay = await this.requiredDebtToRepay(contractInfo, Number(contractInfo.targetHfBasisPoints), zkLendPositions);
            logger.verbose(`generateRebalanceCall:: debtToRepay: ${debtToRepay}`);
            return contract.populate('rebalance', {
                amount: uint256.bnToUint256(debtToRepay.toString()),
                shouldRepay: true,
            });
        } else if (currentHf2 < contractInfo.minHfBasisPoints) {
            // e.g. nostra is unhealth. add collateral in nostra by borrowing from zkLend
            const debtToBorrow = await this.requiredDebtToRepay(contractInfo, Number(contractInfo.targetHfBasisPoints), zkLendPositions);
            logger.verbose(`generateRebalanceCall:: debtToBorrow: ${debtToBorrow}`);
            return contract.populate('rebalance', {
                amount: uint256.bnToUint256(debtToBorrow.toString()),
                shouldRepay: false,
            });
        } else {
            throw new Error('Invalid health factors');
        }
    }

    async computeHealthFactor() {
        const borrowAmount = 0n;
        const borrowFactor = 0n;
        const borrowPrice = 0n;
        const collateralAmount = 0n;
        const collateralFactor = 0n;
        const collateralPrice = 0n;

        return (collateralAmount * collateralFactor * collateralPrice * borrowFactor) / (borrowAmount * borrowPrice);
    }

    async requiredDebtToRepay(contractInfo: ContractInfo, requiredHf: number, positions: ILendingPosition[]) {
        const mainToken = contractInfo.mainToken;
        const secondaryToken = contractInfo.secondaryToken;
        const collateralAmount = positions.find(p => p.tokenSymbol === mainToken)?.supplyAmount;
        const mainTokenInfo = this.zkLend.tokens.find(t => t.symbol === mainToken);
        if (!mainTokenInfo) {
            throw new FatalError('Main token info not found');
        }
        const colPrice = await this.pragma.getPrice(mainTokenInfo.address);
        const collateralUsd = collateralAmount.multipliedBy(colPrice);
        if (!collateralUsd) {
            throw new FatalError('Collateral amount not found');
        }
        const collateralFactor = mainTokenInfo?.collareralFactor;
        if (!collateralFactor) {
            throw new FatalError('Collateral factor not found');
        }
        logger.info(`requiredDebtToRepay:: collateralAmount: ${collateralUsd}, collateralFactor: ${collateralFactor}`);

        const borrowAmount = positions.find(p => p.tokenSymbol === secondaryToken)?.debtAmount;
        if (!borrowAmount) {
            throw new FatalError('Borrow amount not found');
        }
        const secondaryTokenInfo = this.zkLend.tokens.find(t => t.symbol === secondaryToken);
        if(!secondaryTokenInfo) {
            throw new FatalError('Secondary token info not found');
        }
        const borrowPrice = await this.pragma.getPrice(secondaryTokenInfo?.address || '');
        const borrowFactor = secondaryTokenInfo?.borrowFactor;
        if (!borrowFactor) {
            throw new FatalError('Borrow factor not found');
        }
        logger.info(`requiredDebtToRepay:: borrowFactor: ${borrowFactor}`);

        const requiredDebt = collateralUsd
            .multipliedBy(collateralFactor.toFixed(6))
            .dividedBy(requiredHf / 10000)
            .dividedBy(borrowPrice);
        requiredDebt.decimals = borrowAmount.decimals
        logger.info(`requiredDebtToRepay:: requiredDebt: ${requiredDebt}`);
        logger.info(`requiredDebtToRepay:: borrowAmount: ${borrowAmount}`);

        if (requiredDebt < borrowAmount) {
            return borrowAmount.minus(requiredDebt.toFixed(6)).toWei();
        } else {
            return requiredDebt.minus(borrowAmount.toFixed(6)).toWei();
        }
    }


    async loadSettings() {
        for (let i=0; i<this.contractsInfo.length; ++i) {
            console.log(`name: ${this.contractsInfo[i].name}`)
            const contract = this.contracts[this.contractsInfo[i].name];
            const result = await contract.get_settings();
            this.contractsInfo[i].minHfBasisPoints = BigInt(12500); // result.min_health_factor;
            this.contractsInfo[i].targetHfBasisPoints = result.target_health_factor;
        }
    }
}