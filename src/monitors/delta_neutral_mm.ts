import { Account, Call, Contract, uint256 } from "starknet";
import { ContractAddr, Global, IConfig, ILendingPosition, logger, Pricer, Store, TelegramNotif, ZkLend } from "strkfarm-sdk";

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
    }];

    readonly contracts: {[key: string]: Contract} = {}
    zkLend: ZkLend;
    private initialised = false;
    readonly account: any;
    readonly telegramNotif: TelegramNotif;
    private isFirstRun = true;
    constructor(config: IConfig) {
        this.config = config;
        const store = new Store(this.config, {
            SECRET_FILE_FOLDER: process.env.SECRET_FILE_FOLDER,
            NETWORK: process.env.NETWORK,
        })
        this.account = store.getAccount();
        this.telegramNotif = new TelegramNotif(process.env.TG_TOKEN, true);
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
        const pricer = new Pricer(this.config, tokens);
        await pricer.waitTillReady();
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
        const calls = await this.shouldRebalance();
        if (calls.length > 0) {
            console.log(`Submitting batch of ${calls.length} calls`);
            // execute calls
            const tx = await this.account.execute(calls);
            logger.info(`Transaction submitted: ${tx.transaction_hash}`);
            await this.config.provider.waitForTransaction(tx.transaction_hash);
            logger.info(`Transaction confirmed: ${tx.transaction_hash}`);
        }

        setInterval(async () => {
            this.start();
        }, 60 * 1000); // 5 minutes
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
                this.telegramNotif.sendMessage(`DNMM:: Current health factors: ${hf1}, ${hf2}`);
            }

            console.log(this.contractsInfo[i], hf1, hf2);
            // if either health factor is below the minimum, we should rebalance
            if (hf1 < this.contractsInfo[i].minHfBasisPoints || hf2 < this.contractsInfo[i].minHfBasisPoints) {
                console.log(`Rebalancing ${this.contractsInfo[i].name}`);
                const call = await this.generateRebalanceCall(hf1, hf2, this.contractsInfo[i], contract);
                calls.push(call);
            }
        }

        console.log(`Rebalancing calls: ${calls.length}`)
        this.isFirstRun = false;
        return calls;
    }

    async generateRebalanceCall(currentHf1: BigInt, currentHf2: BigInt, contractInfo: ContractInfo, contract: Contract) {
        const zkLendPositions = await this.zkLend.getPositions(ContractAddr.from(contract.address));
        const minHf: BigInt = contractInfo.minHfBasisPoints;
        if (currentHf1 < minHf) {
            // e.g. zkLend is unhealth. repay some debt in zklend by withdrawing from nostra
            const debtToRepay = await this.requiredDebtToRepay(Number(contractInfo.targetHfBasisPoints), zkLendPositions);
            logger.verbose(`generateRebalanceCall:: debtToRepay: ${debtToRepay}`);
            return contract.populate('rebalance', {
                amount: uint256.bnToUint256(debtToRepay.toString()),
                shouldRepay: true,
            });
        } else if (currentHf2 < contractInfo.minHfBasisPoints) {
            // e.g. nostra is unhealth. add collateral in nostra by borrowing from zkLend
            const debtToBorrow = await this.requiredDebtToRepay(Number(contractInfo.targetHfBasisPoints), zkLendPositions);
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

    async requiredDebtToRepay(requiredHf: number, positions: ILendingPosition[]) {
        const collateralUsd = positions.find(p => p.tokenSymbol === 'USDC')?.supplyUSD;
        if (!collateralUsd) {
            throw new Error('Collateral amount not found');
        }
        const collateralFactor = this.zkLend.tokens.find(t => t.symbol === 'USDC')?.collareralFactor;
        if (!collateralFactor) {
            throw new Error('Collateral factor not found');
        }
        logger.info(`requiredDebtToRepay:: collateralAmount: ${collateralUsd}, collateralFactor: ${collateralFactor}`);

        const borrowAmount = positions.find(p => p.tokenSymbol === 'ETH')?.debtAmount;
        if (!borrowAmount) {
            throw new Error('Borrow amount not found');
        }
        const borrowPriceInfo = this.zkLend.pricer.getPrice('ETH');
        const borrowFactor = this.zkLend.tokens.find(t => t.symbol === 'ETH')?.borrowFactor;
        if (!borrowFactor) {
            throw new Error('Borrow factor not found');
        }
        logger.info(`requiredDebtToRepay:: borrowFactor: ${borrowFactor}`);

        const requiredDebt = collateralUsd
            .multipliedBy(collateralFactor.toFixed(6))
            .dividedBy(requiredHf / 10000)
            .dividedBy(borrowPriceInfo.price);
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
            this.contractsInfo[i].minHfBasisPoints = result.min_health_factor;
            this.contractsInfo[i].targetHfBasisPoints = result.target_health_factor;
        }
    }
}