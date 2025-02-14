import { pollHeartbeat } from "@/utils";
import assert from "assert";
import BigNumber from "bignumber.js";
import { Account, Call, Contract, uint256 } from "starknet";
import { FatalError, MarginType, Web3Number } from "@strkfarm/sdk";
import { PricerRedis } from "@strkfarm/sdk";
import { getDefaultStoreConfig } from "@strkfarm/sdk";
import { Network } from "@strkfarm/sdk";
import { ContractAddr, Global, IConfig, ILendingPosition, 
    logger, Pricer, Store, TelegramNotif, ZkLend, Pragma } from "@strkfarm/sdk";

export interface ContractInfo {
    address: string,
    name: string,
    minHfBasisPoints: BigInt,
    targetHfBasisPoints: BigInt,
    mainToken: string,
    secondaryToken: string,
    is_inverted?: boolean,
    requiredDebtToRepay: (contractInfo: ContractInfo, requiredHf: number, positions: ILendingPosition[]) => Promise<string>
    getPositions: (user: ContractAddr) => Promise<ILendingPosition[]>
    getShouldRepay: (currentHf1: BigInt, currentHf2: BigInt, minHf: BigInt) => Promise<boolean>
}

export class DeltaNeutraMM {
    readonly config: IConfig;
    readonly contractsInfo: ContractInfo[] = [{
    //     name: 'DeltaNeutralLoopingUSDCETH',
    //     address: '0x4937b58e05a3a2477402d1f74e66686f58a61a5070fcc6f694fb9a0b3bae422',
    //     minHfBasisPoints: BigInt(0),
    //     targetHfBasisPoints: BigInt(0),
    //     mainToken: 'USDC',
    //     secondaryToken: 'ETH',
    //     requiredDebtToRepay: this.requiredDebtToRepay.bind(this),
    //     getPositions: this.getZkLendPositions.bind(this),
    //     getShouldRepay: this.getShouldRepayZkLend.bind(this),
    // }, {
    //     name: 'DeltaNeutralLoopingSTRKETH',
    //     address: '0x20d5fc4c9df4f943ebb36078e703369c04176ed00accf290e8295b659d2cea6',
    //     minHfBasisPoints: BigInt(0),
    //     targetHfBasisPoints: BigInt(0),
    //     mainToken: 'STRK',
    //     secondaryToken: 'ETH',
    //     requiredDebtToRepay: this.requiredDebtToRepay.bind(this),
    //     getPositions: this.getZkLendPositions.bind(this),
    //     getShouldRepay: this.getShouldRepayZkLend.bind(this),
    // }, {
    //     name: 'DeltaNeutralLoopingETHUSDC',
    //     address: '0x9d23d9b1fa0db8c9d75a1df924c3820e594fc4ab1475695889286f3f6df250',
    //     minHfBasisPoints: BigInt(0),
    //     targetHfBasisPoints: BigInt(0),
    //     mainToken: 'ETH',
    //     secondaryToken: 'USDC',
    //     requiredDebtToRepay: this.requiredDebtToRepay.bind(this),
    //     getPositions: this.getZkLendPositions.bind(this),
    //     getShouldRepay: this.getShouldRepayZkLend.bind(this),
    // }, {
    //     name: 'DeltaNeutralLoopingETHUSDC2',
    //     address: '0x9140757f8fb5748379be582be39d6daf704cc3a0408882c0d57981a885eed9',
    //     minHfBasisPoints: BigInt(0),
    //     targetHfBasisPoints: BigInt(0),
    //     mainToken: 'ETH',
    //     secondaryToken: 'USDC',
    //     is_inverted: true,
    //     requiredDebtToRepay: this.requiredDebtToRepay.bind(this),
    //     getPositions: this.getZkLendPositions.bind(this),
    //     getShouldRepay: this.getShouldRepayZkLend.bind(this),
    // }, {
        name: 'DeltaNeutralLoopingSTRKxSTRK',
        address: '0x7023a5cadc8a5db80e4f0fde6b330cbd3c17bbbf9cb145cbabd7bd5e6fb7b0b',
        minHfBasisPoints: BigInt(0),
        targetHfBasisPoints: BigInt(0),
        mainToken: 'STRK',
        secondaryToken: 'xSTRK',
        requiredDebtToRepay: this.requiredDebtToRepayEndurVesu.bind(this),
        getPositions: this.getVesuPositions.bind(this),
        is_inverted: true,
        getShouldRepay: this.getShouldRepayEndurVesu.bind(this),
    }];

    readonly contracts: {[key: string]: Contract} = {}
    readonly pragma: Pragma;
    private pricer: Pricer;
    zkLend: ZkLend;
    private initialised = false;
    readonly account: Account;
    readonly telegramNotif: TelegramNotif;
    private isFirstRun = true;

    ERRORS = {
        ZKLEND_LOW_HF: 'ZkLend:: low health factor',
        NOSTRA_LOW_HF: 'Nostra:: low health factor',
        MM1_LOW_HF: 'MM1:: low health factor',
        MM2_LOW_HF: 'MM2:: low health factor',
    }
    constructor(config: IConfig) {
        this.config = config;
        const defaultStoreConfig = getDefaultStoreConfig(<Network>process.env.NETWOR);
        defaultStoreConfig.PASSWORD = process.env.ACCOUNT_SECURE_PASSWORD;
        defaultStoreConfig.ACCOUNTS_FILE_NAME = 'accounts-risk.json'
        const store = new Store(this.config, defaultStoreConfig);
        
        if (!process.env.ACCOUNT_NAME) {
            throw new Error('ACCOUNT_NAME not set');
        }
        this.account = <any>store.getAccount(process.env.ACCOUNT_NAME);
        this.telegramNotif = new TelegramNotif(process.env.TG_TOKEN, false);
        this.pragma = new Pragma(this.config.provider);
        this.init();
    }

    async init() {
        this.telegramNotif.sendMessage(`Starting Delta Neutral MM risk manager`);
        for(let i=0; i<this.contractsInfo.length; ++i) {
            const c = this.contractsInfo[i];
            const cls = await this.config.provider.getClassAt(c.address);
            this.contracts[c.name] = new Contract(cls.abi, c.address, <any>this.config.provider)
        }
        await this.loadSettings();

        const tokens = await Global.getTokens();
        const pricer = new PricerRedis(this.config, tokens);
        if (!process.env.REDIS_URL) {
          throw new FatalError('REDIS_URL not set');
        }
        await pricer.initRedis(process.env.REDIS_URL);
        this.pricer = pricer;
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
                try {
                    this.isFirstRun = true;
                    console.log(`Submitting batch of ${calls.length} calls`);
                    this.telegramNotif.sendMessage(`Submitting batch of ${calls.length} calls ♻️`);
                    // execute calls
                    const tx = await this.account.execute(calls);
                    logger.info(`Transaction submitted: ${tx.transaction_hash}`);
                    const receipt = await this.config.provider.waitForTransaction(tx.transaction_hash);
                    if (receipt.statusReceipt == 'success') {
                        logger.info(`Transaction confirmed: ${tx.transaction_hash}`);
                        this.telegramNotif.sendMessage(`DNMM:: Completed ${calls.length} rebalances ✅`);
                    } else {
                        logger.error(`Transaction failed: ${tx.transaction_hash}`);
                        this.telegramNotif.sendMessage(`DNMM:: Transaction failed ❌`);
                        throw new Error(`Transaction failed: ${tx.transaction_hash}`);
                        // const err = await this.account.getTransactionTrace(tx.transaction_hash);
                    }
                } catch(err) {
                    console.error(`DNMM Risk error`, err);
                    this.telegramNotif.sendMessage(`DNMM Risk error ⚠️☠️🚨⚠️☠️🚨`)
                }
            }
        } catch(err) {
            console.error(`DNMM Risk error`, err);
            this.isFirstRun = true;
            this.telegramNotif.sendMessage(`DNMM Risk error ⚠️☠️🚨`)
            this.telegramNotif.sendMessage(`Wait sometime. If keeps repeating, you should intervene`);
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

    async getZkLendPositions(user: ContractAddr) {
        if (!this.zkLend) return [];
        const zkLendPositions = await this.zkLend.getPositions(user);
        return zkLendPositions;
    }

    async getShouldRepayEndurVesu(currentHf1: BigInt, currentHf2: BigInt, minHf: BigInt) {
        // in this strategy, currentHf1 doesn't go down
        if (currentHf2 < minHf) return true;
        throw new Error('Invalid health factors');
    }

    /** Reads positionn data from vesu API and returns required info */
    async _getVesuData(user: ContractAddr) {
        const resp = await fetch(
            `https://api.vesu.xyz/positions?walletAddress=${user.address}`,
        );
        const data = await resp.json();
        if (!data.data || data.data.length == 0) {
            throw new Error('No positions found');
        }
        return {
            max_ltv: Web3Number.fromWei(data.data[0].ltv.max.value, data.data[0].ltv.max.decimals),
            collateral: {
                tokenName: data.data[0].collateral.name,
                tokenSymbol: data.data[0].collateral.symbol,
                value: Web3Number.fromWei(data.data[0].collateral.value, data.data[0].collateral.decimals),
                usdPrice: Web3Number.fromWei(data.data[0].collateral.usdPrice.value, data.data[0].collateral.usdPrice.decimals),
            },
            debt: {
                tokenName: data.data[0].debt.name,
                tokenSymbol: data.data[0].debt.symbol,
                value: Web3Number.fromWei(data.data[0].debt.value, data.data[0].debt.decimals),
                usdPrice: Web3Number.fromWei(data.data[0].debt.usdPrice.value, data.data[0].debt.usdPrice.decimals),
            }
        }
    }

    /** Returns vesu positions info as ILendingPosition[] */
    async getVesuPositions(user: ContractAddr) {
        const resp = await this._getVesuData(user);

        const collateralPosition: ILendingPosition = {
            tokenName: resp.collateral.tokenName,
            tokenSymbol: resp.collateral.tokenSymbol,
            marginType: MarginType.NONE,
            supplyAmount: resp.collateral.value,
            supplyUSD: resp.collateral.usdPrice,
            debtAmount: Web3Number.fromWei(0, 0),
            debtUSD: Web3Number.fromWei(0, 0),
        }

        const debtPosition: ILendingPosition = {
            tokenName: resp.debt.tokenName,
            tokenSymbol: resp.debt.tokenSymbol,
            marginType: MarginType.NONE,
            supplyAmount: Web3Number.fromWei(0, 0),
            supplyUSD: Web3Number.fromWei(0, 0),
            debtAmount: resp.debt.value,
            debtUSD: resp.debt.usdPrice
        }

        return [collateralPosition, debtPosition];
    }

    async getShouldRepayZkLend(currentHf1: BigInt, currentHf2: BigInt, minHf: BigInt) {
        if (currentHf1 < minHf) return true;
        if (currentHf2 < minHf) return false;
        throw new Error('Invalid health factors');
    }

    async generateRebalanceCall(currentHf1: BigInt, currentHf2: BigInt, contractInfo: ContractInfo, contract: Contract): Promise<Call> {
        const positions = await contractInfo.getPositions(ContractAddr.from(contractInfo.address));
        const minHf: BigInt = contractInfo.minHfBasisPoints;
        const debtToRepay = await contractInfo.requiredDebtToRepay(contractInfo, Number(contractInfo.targetHfBasisPoints), positions);
        logger.verbose(`generateRebalanceCall:: debtToRepay: ${debtToRepay}`);
        let amount = debtToRepay;
        let attempt = 1;
        let factorBasisPercent = 50;
        const shouldRepay = await contractInfo.getShouldRepay(currentHf1, currentHf2, minHf);
        while (attempt < 30) {
            try {
                logger.info(`Checking amount: ${amount}, shouldRepay: ${shouldRepay}`);
                const call = contract.populate('rebalance', {
                    amount: uint256.bnToUint256(amount.toString()),
                    shouldRepay: shouldRepay,
                });
                const est = await this.account.estimateFee([call]);
                logger.info(`Using amount: ${amount.toString()}, shouldRepay: ${shouldRepay}`);
                this.telegramNotif.sendMessage(`Calldata: amount ${amount.toString()}, shouldRepay: ${shouldRepay ? 1 : 0}`)
                return call;
            } catch(err) {
                attempt++;
                console.log(`estimate failed2`)
                if (attempt >= 30) {
                    this.telegramNotif.sendMessage(`Failed to estimate fee after 30 attempts, error: ${err.message}`);
                    throw err;
                }
                const isLowLending1 = err.message.includes(this.ERRORS.ZKLEND_LOW_HF) || err.message.includes(this.ERRORS.MM1_LOW_HF);
                const isLowLending2 = err.message.includes(this.ERRORS.NOSTRA_LOW_HF) || err.message.includes(this.ERRORS.MM2_LOW_HF);

                // depending on following conditions, we try to increase/reduce amount
                const condition1Sign = shouldRepay ? 1 : -1; // if not inverted
                const condition2Sign = contractInfo.is_inverted ? -1 : 1; // if inverted
                const finalSign = condition1Sign * condition2Sign;
                if (isLowLending1) {
                    // increase amount by factorPercent and check
                    logger.info(`isLowLending1: sign: ${finalSign}, amount by ${factorBasisPercent}`);
                    amount = (new BigNumber(amount)).mul(10000 + (finalSign * factorBasisPercent)).div(10000).toFixed(0);
                } else if (isLowLending2) {
                    // decrease amount by factorPercent and check
                    logger.info(`isLowLending2: sign: ${finalSign}, amount by ${factorBasisPercent}`);
                    amount = (new BigNumber(amount)).mul(10000 - (finalSign * factorBasisPercent)).div(10000).toFixed(0);
                } else {
                    this.telegramNotif.sendMessage(`Unexpected Error: ${err.message}`);
                    throw err;
                }
                await new Promise((res) => setTimeout(res, 1000))
            }
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
        const mainToken = contractInfo.is_inverted ? contractInfo.secondaryToken : contractInfo.mainToken;
        const secondaryToken = contractInfo.is_inverted ? contractInfo.mainToken : contractInfo.secondaryToken;
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

        // if not inverted
        if (!contractInfo.is_inverted) {
            // ! todo why not use borrow factor?
            const requiredDebt = collateralUsd
                .multipliedBy(collateralFactor.toFixed(6))
                .multipliedBy(borrowFactor.toFixed(6))
                .dividedBy(requiredHf / 10000)
                .dividedBy(borrowPrice);
            requiredDebt.decimals = borrowAmount.decimals
            logger.info(`requiredDebtToRepay:: requiredDebt: ${requiredDebt}`);
            logger.info(`requiredDebtToRepay:: borrowAmount: ${borrowAmount}`);

            if (requiredDebt.lt(borrowAmount)) {
                return borrowAmount.minus(requiredDebt.toFixed(6)).toWei();
            } else {
                return requiredDebt.minus(borrowAmount.toFixed(6)).toWei();
            }
        } else {
            const borrowUsd = borrowAmount.multipliedBy(borrowPrice);
            const requiredCollateral = borrowUsd.multipliedBy(requiredHf / 10000)
                                        .dividedBy(colPrice)
                                        .dividedBy(collateralFactor.toFixed(6))
                                        .dividedBy(borrowFactor.toFixed(6));
            requiredCollateral.decimals = collateralAmount.decimals;
            logger.info(`requiredDebtToRepay:: requiredCollateral: ${requiredCollateral}`);
            logger.info(`requiredDebtToRepay:: collateralAmount: ${collateralAmount}`);

            if (requiredCollateral.lt(collateralAmount)) {
                return collateralAmount.minus(requiredCollateral.toFixed(6)).toWei();
            } else {
                return requiredCollateral.minus(collateralAmount.toFixed(6)).toWei();
            }
        }
    }

    async requiredDebtToRepayEndurVesu(contractInfo: ContractInfo, requiredHf: number, positions: ILendingPosition[]) {
        const mainToken = contractInfo.is_inverted ? contractInfo.secondaryToken : contractInfo.mainToken;
        const secondaryToken = contractInfo.is_inverted ? contractInfo.mainToken : contractInfo.secondaryToken;
        const collateralPosition = positions.find(p => p.tokenSymbol === mainToken);
        const debtPosition = positions.find(p => p.tokenSymbol === secondaryToken);
        const collateralAmount = collateralPosition?.supplyAmount;
        const collateralUsd = collateralPosition?.supplyUSD;
        if (!collateralUsd || collateralAmount.eq(0)) {
            throw new FatalError('Vesu:Collateral amount not found');
        }
        const maxLTV = (await this._getVesuData(ContractAddr.from(contractInfo.address))).max_ltv;
        logger.info(`Vesu:requiredDebtToRepay:: collateralAmount: ${collateralUsd}, maxLTV: ${maxLTV}`);

        const borrowUSD = debtPosition?.debtUSD;
        if (!borrowUSD || borrowUSD.eq(0)) {
            throw new FatalError('Vesu:Borrow amount not found');
        }
        logger.info(`Vesu:requiredDebtToRepay:: borrowUSD: ${borrowUSD}`);

        // todo 
        let xSTRKPrice = await this.pricer.getPrice(mainToken);
        let STRKPrice = debtPosition.debtAmount.dividedBy(debtPosition.debtUSD.toString());
        logger.info(`Vesu:requiredDebtToRepay:: xSTRKPrice: ${xSTRKPrice.price}`);
        logger.info(`Vesu:requiredDebtToRepay:: STRKPrice: ${STRKPrice}`);
        // hf = (collateralUSD - amountUSD) * max_ltv / (borrowUSD - amountUSD)
        // (collateralUSD - amountUSD) * max_ltv = hf * (borrowUSD - amountUSD)
        // => amountUSD = (collateralUSD * max_ltv - hf * borrowUSD) / (max_ltv - hf)

        const numerator = collateralUsd.multipliedBy(maxLTV.toString()).minus(borrowUSD.multipliedBy(requiredHf / 10000).toString());
        logger.info(`requiredDebtToRepayVesu:: numerator: ${numerator}`);
        const denominator = maxLTV.minus(requiredHf / 10000);
        logger.info(`requiredDebtToRepayVesu:: denominator: ${denominator}`);
        const amountUSD = numerator.dividedBy(denominator.toString());
        const amountxSTRK = amountUSD.multipliedBy(STRKPrice.toString()).dividedBy(xSTRKPrice.toString()).toWei();
        logger.info(`requiredDebtToRepayVesu:: amountUSD: ${amountUSD}`);
        logger.info(`requiredDebtToRepayVesu:: amountxSTRK: ${amountxSTRK}`);
        return amountxSTRK;
    }

    async loadSettings() {
        for (let i=0; i<this.contractsInfo.length; ++i) {
            console.log(`name: ${this.contractsInfo[i].name}`)
            const contract = this.contracts[this.contractsInfo[i].name];
            const result = await contract.get_settings();
            this.contractsInfo[i].minHfBasisPoints = result.target_health_factor - 500n;
            this.contractsInfo[i].targetHfBasisPoints = result.target_health_factor;
        }
    }
}