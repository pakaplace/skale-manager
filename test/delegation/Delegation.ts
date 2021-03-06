import { ConstantsHolderInstance,
    ContractManagerInstance,
    DelegationControllerInstance,
    DelegationPeriodManagerInstance,
    DelegationServiceInstance,
    SkaleManagerMockContract,
    SkaleManagerMockInstance,
    SkaleTokenInstance,
    TokenStateInstance,
    ValidatorServiceInstance} from "../../types/truffle-contracts";

const SkaleManagerMock: SkaleManagerMockContract = artifacts.require("./SkaleManagerMock");

import { currentTime, skipTime, skipTimeToDate } from "../utils/time";

import BigNumber from "bignumber.js";
import * as chai from "chai";
import * as chaiAsPromised from "chai-as-promised";
import { deployConstantsHolder } from "../utils/deploy/constantsHolder";
import { deployContractManager } from "../utils/deploy/contractManager";
import { deployDelegationController } from "../utils/deploy/delegation/delegationController";
import { deployDelegationPeriodManager } from "../utils/deploy/delegation/delegationPeriodManager";
import { deployDelegationService } from "../utils/deploy/delegation/delegationService";
import { deployTokenState } from "../utils/deploy/delegation/tokenState";
import { deployValidatorService } from "../utils/deploy/delegation/validatorService";
import { deploySkaleToken } from "../utils/deploy/skaleToken";

chai.should();
chai.use(chaiAsPromised);

const allowedDelegationPeriods = [3, 6, 12];

class Delegation {
    public holder: string;
    public validatorId: BigNumber;
    public amount: BigNumber;
    public delegationPeriod: BigNumber;
    public created: BigNumber;
    public description: string;

    constructor(arrayData: [string, BigNumber, BigNumber, BigNumber, BigNumber, string]) {
        this.holder = arrayData[0];
        this.validatorId = new BigNumber(arrayData[1]);
        this.amount = new BigNumber(arrayData[2]);
        this.delegationPeriod = new BigNumber(arrayData[3]);
        this.created = new BigNumber(arrayData[4]);
        this.description = arrayData[5];
    }
}

contract("Delegation", ([owner,
                         holder1,
                         holder2,
                         holder3,
                         validator,
                         bountyAddress]) => {
    let contractManager: ContractManagerInstance;
    let skaleToken: SkaleTokenInstance;
    let delegationService: DelegationServiceInstance;
    let delegationController: DelegationControllerInstance;
    let delegationPeriodManager: DelegationPeriodManagerInstance;
    let skaleManagerMock: SkaleManagerMockInstance;
    let validatorService: ValidatorServiceInstance;
    let constantsHolder: ConstantsHolderInstance;
    let tokenState: TokenStateInstance;

    const defaultAmount = 100 * 1e18;
    const month = 60 * 60 * 24 * 31;

    beforeEach(async () => {
        contractManager = await deployContractManager();

        skaleManagerMock = await SkaleManagerMock.new(contractManager.address);
        await contractManager.setContractsAddress("SkaleManager", skaleManagerMock.address);

        skaleToken = await deploySkaleToken(contractManager);
        delegationService = await deployDelegationService(contractManager);
        delegationController = await deployDelegationController(contractManager);
        delegationPeriodManager = await deployDelegationPeriodManager(contractManager);
        validatorService = await deployValidatorService(contractManager);
        constantsHolder = await deployConstantsHolder(contractManager);
        tokenState = await deployTokenState(contractManager);

        // each test will start from Nov 10
        await skipTimeToDate(web3, 10, 10);
    });

    describe("when holders have tokens and validator registered", async () => {
        let validatorId: number;
        beforeEach(async () => {
            await skaleToken.mint(owner, holder1, defaultAmount.toString(), "0x", "0x");
            await skaleToken.mint(owner, holder2, defaultAmount.toString(), "0x", "0x");
            await skaleToken.mint(owner, holder3, defaultAmount.toString(), "0x", "0x");
            await skaleToken.mint(owner, skaleManagerMock.address, defaultAmount.toString(), "0x", "0x");
            const { logs } = await delegationService.registerValidator(
                "First validator", "Super-pooper validator", 150, 0, {from: validator});
            validatorId = logs[0].args.validatorId.toNumber();
            await validatorService.enableValidator(validatorId, {from: owner});
        });

        for (let delegationPeriod = 1; delegationPeriod <= 18; ++delegationPeriod) {
            it("should check " + delegationPeriod + " month" + (delegationPeriod > 1 ? "s" : "")
                + " delegation period availability", async () => {
                await delegationPeriodManager.isDelegationPeriodAllowed(delegationPeriod)
                    .should.be.eventually.equal(allowedDelegationPeriods.includes(delegationPeriod));
            });

            if (allowedDelegationPeriods.includes(delegationPeriod)) {
                describe("when delegation period is " + delegationPeriod + " months", async () => {
                    let requestId: number;

                    it("should send request for delegation", async () => {
                        const { logs } = await delegationService.delegate(
                            validatorId, defaultAmount.toString(), delegationPeriod, "D2 is even", {from: holder1});
                        assert.equal(logs.length, 1, "No DelegationRequestIsSent Event emitted");
                        assert.equal(logs[0].event, "DelegationRequestIsSent");
                        requestId = logs[0].args.delegationId;

                        const delegation: Delegation = new Delegation(
                            await delegationController.delegations(requestId));
                        assert.equal(holder1, delegation.holder);
                        assert.equal(validatorId, delegation.validatorId.toNumber());
                        assert.equal(delegationPeriod, delegation.delegationPeriod.toNumber());
                        assert.equal("D2 is even", delegation.description);
                    });

                    describe("when delegation request is sent", async () => {

                        beforeEach(async () => {
                            const { logs } = await delegationService.delegate(
                                validatorId, defaultAmount.toString(), delegationPeriod, "D2 is even", {from: holder1});
                            assert.equal(logs.length, 1, "No DelegationRequest Event emitted");
                            assert.equal(logs[0].event, "DelegationRequestIsSent");
                            requestId = logs[0].args.delegationId;
                        });

                        it("should not allow holder to spend tokens", async () => {
                            await skaleToken.transfer(holder2, 1, {from: holder1})
                                .should.be.eventually.rejectedWith("Token should be unlocked for transferring");
                            await skaleToken.approve(holder2, 1, {from: holder1});
                            await skaleToken.transferFrom(holder1, holder2, 1, {from: holder2})
                                .should.be.eventually.rejectedWith("Token should be unlocked for transferring");
                            await skaleToken.send(holder2, 1, "0x", {from: holder1})
                                .should.be.eventually.rejectedWith("Token should be unlocked for transferring");
                        });

                        it("should allow holder to receive tokens", async () => {
                            await skaleToken.transfer(holder1, 1, {from: holder2});
                            const balance = (await skaleToken.balanceOf(holder1)).toString();
                            balance.should.be.equal("100000000000000000001");
                        });

                        it("should accept delegation request", async () => {
                            await delegationService.acceptPendingDelegation(requestId, {from: validator});

                            // await delegationService.listDelegationRequests().should.be.eventually.empty;
                        });

                        it("should unlock token if validator does not accept delegation request", async () => {
                            await skipTimeToDate(web3, 1, 11);

                            await skaleToken.transfer(holder2, 1, {from: holder1});
                            await skaleToken.approve(holder2, 1, {from: holder1});
                            await skaleToken.transferFrom(holder1, holder2, 1, {from: holder2});
                            await skaleToken.send(holder2, 1, "0x", {from: holder1});

                            const balance = new BigNumber((await skaleToken.balanceOf(holder1)).toString());
                            const correctBalance = (new BigNumber(defaultAmount)).minus(3);

                            balance.should.be.deep.equal(correctBalance);
                        });

                        describe("when delegation request is accepted", async () => {
                            beforeEach(async () => {
                                await delegationService.acceptPendingDelegation(requestId, {from: validator});
                            });

                            it("should extend delegation period for 3 months if undelegation request was not sent",
                                async () => {

                                    if (delegationPeriod >= 12) {
                                        skipTime(web3, 60 * 60 * 24 * 365 * Math.floor(delegationPeriod / 12));
                                    }
                                    await skipTimeToDate(web3, 1, (11 + delegationPeriod) % 12);

                                    await skaleToken.transfer(holder2, 1, {from: holder1})
                                        .should.be.eventually.rejectedWith("Token should be unlocked for transferring");
                                    await skaleToken.approve(holder2, 1, {from: holder1});
                                    await skaleToken.transferFrom(holder1, holder2, 1, {from: holder2})
                                        .should.be.eventually.rejectedWith("Token should be unlocked for transferring");
                                    await skaleToken.send(holder2, 1, "0x", {from: holder1})
                                        .should.be.eventually.rejectedWith("Token should be unlocked for transferring");

                                    await delegationService.requestUndelegation(requestId, {from: holder1});

                                    await skipTimeToDate(web3, 27, (11 + delegationPeriod + 2) % 12);

                                    await skaleToken.transfer(holder2, 1, {from: holder1})
                                        .should.be.eventually.rejectedWith("Token should be unlocked for transferring");

                                    await skaleToken.approve(holder2, 1, {from: holder1});
                                    await skaleToken.transferFrom(holder1, holder2, 1, {from: holder2})
                                        .should.be.eventually.rejectedWith("Token should be unlocked for transferring");
                                    await skaleToken.send(holder2, 1, "0x", {from: holder1})
                                        .should.be.eventually.rejectedWith("Token should be unlocked for transferring");

                                    await skipTimeToDate(web3, 1, (11 + delegationPeriod + 3) % 12);

                                    await skaleToken.transfer(holder2, 1, {from: holder1});
                                    await skaleToken.approve(holder2, 1, {from: holder1});
                                    await skaleToken.transferFrom(holder1, holder2, 1, {from: holder2});
                                    await skaleToken.send(holder2, 1, "0x", {from: holder1});

                                    (await skaleToken.balanceOf(holder1)).toString().should.be.equal("99999999999999999997");
                            });
                        });
                    });
                });
            } else {
                it("should not allow to send delegation request for " + delegationPeriod +
                    " month" + (delegationPeriod > 1 ? "s" : "" ), async () => {
                    await delegationService.delegate(validatorId, defaultAmount.toString(), delegationPeriod,
                        "D2 is even", {from: holder1})
                        .should.be.eventually.rejectedWith("This delegation period is not allowed");
                });
            }
        }

        it("should not allow holder to delegate to unregistered validator", async () => {
            await delegationService.delegate(13, 1,  3, "D2 is even", {from: holder1})
                .should.be.eventually.rejectedWith("Validator with such id doesn't exist");
        });

        it("should return bond amount if validator delegated to itself", async () => {
            await skaleToken.mint(owner, validator, defaultAmount.toString(), "0x", "0x");
            await delegationService.delegate(validatorId, defaultAmount.toString(), 3, "D2 is even", {from: validator});
            await delegationService.delegate(validatorId, defaultAmount.toString(), 3, "D2 is even", {from: holder1});
            await delegationService.acceptPendingDelegation(0, {from: validator});
            await delegationService.acceptPendingDelegation(1, {from: validator});
            skipTime(web3, month);
            const bondAmount = await delegationService.getValidatorBondAmount.call(validator);
            assert.equal(defaultAmount.toString(), bondAmount.toString());
        });

        describe("when 3 holders delegated", async () => {
            beforeEach(async () => {
                delegationService.delegate(validatorId, 2, 12, "D2 is even", {from: holder1});
                delegationService.delegate(validatorId, 3, 6, "D2 is even more even", {from: holder2});
                delegationService.delegate(validatorId, 5, 3, "D2 is the evenest", {from: holder3});

                await delegationService.acceptPendingDelegation(0, {from: validator});
                await delegationService.acceptPendingDelegation(1, {from: validator});
                await delegationService.acceptPendingDelegation(2, {from: validator});

                skipTime(web3, month);
            });

            it("should distribute funds sent to DelegationService across delegators", async () => {
                await delegationService.setLaunchTimestamp(await currentTime(web3));
                await skaleManagerMock.payBounty(validatorId, 101);

                // 15% fee to validator

                // Stakes:
                // holder1: 20%
                // holder2: 30%
                // holder3: 50%

                // Affective stakes:
                // holder1: $8
                // holder2: $9
                // holder3: $10

                // Shares:
                // holder1: ~29%
                // holder2: ~33%
                // holder3: ~37%

                (await delegationService.getEarnedBountyAmount.call({from: validator})).toNumber().should.be.equal(17);
                (await delegationService.getEarnedBountyAmount.call({from: holder1})).toNumber().should.be.equal(25);
                (await delegationService.getEarnedBountyAmount.call({from: holder2})).toNumber().should.be.equal(28);
                (await delegationService.getEarnedBountyAmount.call({from: holder3})).toNumber().should.be.equal(31);

                await delegationService.withdrawBounty(bountyAddress, 10, {from: validator})
                    .should.be.eventually.rejectedWith("Bounty is locked");
                await delegationService.withdrawBounty(bountyAddress, 20, {from: holder1})
                    .should.be.eventually.rejectedWith("Bounty is locked");

                skipTime(web3, 3 * month);

                await delegationService.withdrawBounty(bountyAddress, 10, {from: validator});
                (await delegationService.getEarnedBountyAmount.call({from: validator})).toNumber().should.be.equal(7);
                await delegationService.withdrawBounty(validator, 7, {from: validator});
                (await delegationService.getEarnedBountyAmount.call({from: validator})).toNumber().should.be.equal(0);

                (await skaleToken.balanceOf(bountyAddress)).toNumber().should.be.equal(10);

                await delegationService.withdrawBounty(bountyAddress, 20, {from: holder1});
                (await delegationService.getEarnedBountyAmount.call({from: holder1})).toNumber().should.be.equal(5);
                await delegationService.withdrawBounty(holder1, 5, {from: holder1});
                (await delegationService.getEarnedBountyAmount.call({from: holder1})).toNumber().should.be.equal(0);

                (await skaleToken.balanceOf(bountyAddress)).toNumber().should.be.equal(30);

                const balance = (await skaleToken.balanceOf(holder1)).toString();
                balance.should.be.equal((new BigNumber(defaultAmount)).plus(5).toString());
            });

            describe("Slashing", async () => {

                it("should slash validator and lock delegators fund in proportion of delegation share", async () => {
                    await delegationService.slash(validatorId, 5);

                    // Stakes:
                    // holder1: $2
                    // holder2: $3
                    // holder3: $5

                    (await delegationService.getLockedOf.call(holder1)).toNumber().should.be.equal(2);
                    (await delegationService.getDelegatedOf.call(holder1)).toNumber().should.be.equal(1);

                    (await delegationService.getLockedOf.call(holder2)).toNumber().should.be.equal(3);
                    (await delegationService.getDelegatedOf.call(holder2)).toNumber().should.be.equal(1);

                    (await delegationService.getLockedOf.call(holder3)).toNumber().should.be.equal(5);
                    (await delegationService.getDelegatedOf.call(holder3)).toNumber().should.be.equal(2);
                });

                it("should not lock more tokens than were delegated", async () => {
                    await delegationService.slash(validatorId, 100);

                    (await delegationService.getLockedOf.call(holder1)).toNumber().should.be.equal(2);
                    (await delegationService.getDelegatedOf.call(holder1)).toNumber().should.be.equal(0);

                    (await delegationService.getLockedOf.call(holder2)).toNumber().should.be.equal(3);
                    (await delegationService.getDelegatedOf.call(holder2)).toNumber().should.be.equal(0);

                    (await delegationService.getLockedOf.call(holder3)).toNumber().should.be.equal(5);
                    (await delegationService.getDelegatedOf.call(holder3)).toNumber().should.be.equal(0);
                });

                it("should allow to return slashed tokens back", async () => {
                    await delegationService.slash(validatorId, 10);

                    (await delegationService.getLockedOf.call(holder3)).toNumber().should.be.equal(5);
                    (await delegationService.getDelegatedOf.call(holder3)).toNumber().should.be.equal(0);

                    await delegationService.forgive(holder3, 3);

                    (await delegationService.getLockedOf.call(holder3)).toNumber().should.be.equal(2);
                    (await delegationService.getDelegatedOf.call(holder3)).toNumber().should.be.equal(0);
                });
            });
        });

        it("Should be possible for N.O.D.E. foundation to spin up node immediately", async () => {
            const amount = 100;
            await delegationService.delegate(validatorId, amount, 3, "D2 is even", {from: holder1});
            await constantsHolder.setMSR(amount);
            const delegationId = 0;
            await delegationService.acceptPendingDelegation(delegationId, {from: validator});

            await validatorService.checkPossibilityCreatingNode(validator)
                .should.be.eventually.rejectedWith("Validator has to meet Minimum Staking Requirement");

            await tokenState.skipTransitionDelay(delegationId);

            await validatorService.checkPossibilityCreatingNode(validator);
        });

        // describe("when validator is registered", async () => {
        //     beforeEach(async () => {
        //         await delegationService.registerValidator(
        //             "First validator", "Super-pooper validator", 150, 0, {from: validator});
        //     });

        //     // MSR = $100
        //     // Bounty = $100 per month per node
        //     // Validator fee is 15%

        //     // Stake in time:
        //     // month       |11|12| 1| 2| 3| 4| 5| 6| 7| 8| 9|10|11|12| 1|
        //     // ----------------------------------------------------------
        //     // holder1 $97 |  |##|##|##|##|##|##|  |  |##|##|##|  |  |  |
        //     // holder2 $89 |  |  |##|##|##|##|##|##|##|##|##|##|##|##|  |
        //     // holder3 $83 |  |  |  |  |##|##|##|==|==|==|  |  |  |  |  |

        //     // month       |11|12| 1| 2| 3| 4| 5| 6| 7| 8| 9|10|11|12| 1|
        //     // ----------------------------------------------------------
        //     //             |  |  |  |  |##|##|##|  |  |##|  |  |  |  |  |
        //     // Nodes online|  |  |##|##|##|##|##|##|##|##|##|##|  |  |  |

        //     // bounty
        //     // month       |11|12| 1| 2| 3| 4| 5| 6| 7| 8| 9|10|11|12| 1|
        //     // ------------------------------------------------------------
        //     // holder 1    |  | 0|38|38|60|60|60|  |  |46|29|29|  |  |  |
        //     // holder 2    |  |  |46|46|74|74|74|57|57|84|55|55| 0| 0|  |
        //     // holder 3    |  |  |  |  |34|34|34|27|27|39|  |  |  |  |  |
        //     // validator   |  |  |15|15|30|30|30|15|15|30|15|15|  |  |  |

        //     it("should distribute bounty proportionally to delegation share and period coefficient", async () => {
        //         const holder1Balance = 97;
        //         const holder2Balance = 89;
        //         const holder3Balance = 83;

        //         await skaleToken.transfer(validator, (defaultAmount - holder1Balance).toString());
        //         await skaleToken.transfer(validator, (defaultAmount - holder2Balance)).toString();
        //         await skaleToken.transfer(validator, (defaultAmount - holder3Balance)).toString();

        //         await delegationService.setMinimumStakingRequirement(100);

        //         const validatorIds = await delegationService.getValidators.call();
        //         validatorIds.should.be.deep.equal([0]);

        //         let response = await delegationService.delegate(
        //             validatorId, holder1Balance, 6, "First holder", {from: holder1});
        //         const requestId1 = response.logs[0].args.id;
        //         await delegationService.accept(requestId1, {from: validator});

        //         await skipTimeToDate(web3, 28, 10);

        //         response = await delegationService.delegate(
        //             validatorId, holder2Balance, 12, "Second holder", {from: holder2});
        //         const requestId2 = response.logs[0].args.id;
        //         await delegationService.accept(requestId2, {from: validator});

        //         await skipTimeToDate(web3, 28, 11);

        //         await delegationService.createNode("4444", 0, "127.0.0.1", "127.0.0.1", {from: validator});

        //         await skipTimeToDate(web3, 1, 0);

        //         await delegationService.requestUndelegation(requestId1, {from: holder1});
        //         await delegationService.requestUndelegation(requestId2, {from: holder2});
        //         // get bounty
        //         await skipTimeToDate(web3, 1, 1);

        //         response = await delegationService.delegate(
        //             validatorId, holder3Balance, 3, "Third holder", {from: holder3});
        //         const requestId3 = response.logs[0].args.id;
        //         await delegationService.accept(requestId3, {from: validator});

        //         let bounty = await delegationService.getEarnedBountyAmount.call({from: holder1});
        //         bounty.should.be.equal(38);
        //         await delegationService.withdrawBounty(bountyAddress, bounty, {from: holder1});

        //         bounty = await delegationService.getEarnedBountyAmount.call({from: holder2});
        //         bounty.should.be.equal(46);
        //         await delegationService.withdrawBounty(bountyAddress, bounty, {from: holder2});

        //         bounty = await delegationService.getEarnedBountyAmount.call({from: validator});
        //         bounty.should.be.equal(15);
        //         await delegationService.withdrawBounty(bountyAddress, bounty, {from: validator});

        //         // spin up second node

        //         await skipTimeToDate(web3, 27, 1);
        //         await delegationService.createNode("2222", 1, "127.0.0.2", "127.0.0.2", {from: validator});

        //         // get bounty for February

        //         await skipTimeToDate(web3, 1, 2);

        //         bounty = await delegationService.getEarnedBountyAmount.call({from: holder1});
        //         bounty.should.be.equal(38);
        //         await delegationService.withdrawBounty(bountyAddress, bounty, {from: holder1});

        //         bounty = await delegationService.getEarnedBountyAmount.call({from: holder2});
        //         bounty.should.be.equal(46);
        //         await delegationService.withdrawBounty(bountyAddress, bounty, {from: holder2});

        //         bounty = await delegationService.getEarnedBountyAmount.call({from: validator});
        //         bounty.should.be.equal(15);
        //         await delegationService.withdrawBounty(bountyAddress, bounty, {from: validator});

        //         // get bounty for March

        //         await skipTimeToDate(web3, 1, 3);

        //         bounty = await delegationService.getEarnedBountyAmount.call({from: holder1});
        //         bounty.should.be.equal(60);
        //         await delegationService.withdrawBounty(bountyAddress, bounty, {from: holder1});

        //         bounty = await delegationService.getEarnedBountyAmount.call({from: holder2});
        //         bounty.should.be.equal(74);
        //         await delegationService.withdrawBounty(bountyAddress, bounty, {from: holder2});

        //         bounty = await delegationService.getEarnedBountyAmount.call({from: holder3});
        //         bounty.should.be.equal(34);
        //         await delegationService.withdrawBounty(bountyAddress, bounty, {from: holder3});

        //         bounty = await delegationService.getEarnedBountyAmount.call({from: validator});
        //         bounty.should.be.equal(30);
        //         await delegationService.withdrawBounty(bountyAddress, bounty, {from: validator});

        //         // get bounty for April

        //         await skipTimeToDate(web3, 1, 4);

        //         bounty = await delegationService.getEarnedBountyAmount.call({from: holder1});
        //         bounty.should.be.equal(60);
        //         await delegationService.withdrawBounty(bountyAddress, bounty, {from: holder1});

        //         bounty = await delegationService.getEarnedBountyAmount.call({from: holder2});
        //         bounty.should.be.equal(74);
        //         await delegationService.withdrawBounty(bountyAddress, bounty, {from: holder2});

        //         bounty = await delegationService.getEarnedBountyAmount.call({from: holder3});
        //         bounty.should.be.equal(34);
        //         await delegationService.withdrawBounty(bountyAddress, bounty, {from: holder3});

        //         bounty = await delegationService.getEarnedBountyAmount.call({from: validator});
        //         bounty.should.be.equal(30);
        //         await delegationService.withdrawBounty(bountyAddress, bounty, {from: validator});

        //         // get bounty for May

        //         await skipTimeToDate(web3, 1, 5);

        //         bounty = await delegationService.getEarnedBountyAmount.call({from: holder1});
        //         bounty.should.be.equal(60);
        //         await delegationService.withdrawBounty(bountyAddress, bounty, {from: holder1});

        //         bounty = await delegationService.getEarnedBountyAmount.call({from: holder2});
        //         bounty.should.be.equal(74);
        //         await delegationService.withdrawBounty(bountyAddress, bounty, {from: holder2});

        //         bounty = await delegationService.getEarnedBountyAmount.call({from: holder3});
        //         bounty.should.be.equal(34);
        //         await delegationService.withdrawBounty(bountyAddress, bounty, {from: holder3});

        //         bounty = await delegationService.getEarnedBountyAmount.call({from: validator});
        //         bounty.should.be.equal(30);
        //         await delegationService.withdrawBounty(bountyAddress, bounty, {from: validator});

        //         // stop one node

        //         await delegationService.deleteNode(0, {from: validator});

        //         // get bounty for June

        //         await skipTimeToDate(web3, 1, 6);

        //         bounty = await delegationService.getEarnedBountyAmount.call({from: holder1});
        //         bounty.should.be.equal(0);

        //         bounty = await delegationService.getEarnedBountyAmount.call({from: holder2});
        //         bounty.should.be.equal(57);
        //         await delegationService.withdrawBounty(bountyAddress, bounty, {from: holder2});

        //         bounty = await delegationService.getEarnedBountyAmount.call({from: holder3});
        //         bounty.should.be.equal(27);
        //         await delegationService.withdrawBounty(bountyAddress, bounty, {from: holder3});

        //         bounty = await delegationService.getEarnedBountyAmount.call({from: validator});
        //         bounty.should.be.equal(15);
        //         await delegationService.withdrawBounty(bountyAddress, bounty, {from: validator});

        //         // manage delegation

        //         response = await delegationService.delegate(
        //             validatorId, holder1Balance, 3, "D2 is even", {from: holder1});
        //         const requestId = response.logs[0].args.id;
        //         await delegationService.accept(requestId, {from: validator});

        //         await delegationService.requestUndelegation(requestId, {from: holder3});

        //         // spin up node

        //         await skipTimeToDate(web3, 30, 6);
        //         await delegationService.createNode("3333", 2, "127.0.0.3", "127.0.0.3", {from: validator});

        //         // get bounty for July

        //         await skipTimeToDate(web3, 1, 7);

        //         bounty = await delegationService.getEarnedBountyAmount.call({from: holder1});
        //         bounty.should.be.equal(0);
        //         await delegationService.withdrawBounty(bountyAddress, bounty, {from: holder1});

        //         bounty = await delegationService.getEarnedBountyAmount.call({from: holder2});
        //         bounty.should.be.equal(57);
        //         await delegationService.withdrawBounty(bountyAddress, bounty, {from: holder2});

        //         bounty = await delegationService.getEarnedBountyAmount.call({from: holder3});
        //         bounty.should.be.equal(27);
        //         await delegationService.withdrawBounty(bountyAddress, bounty, {from: holder3});

        //         bounty = await delegationService.getEarnedBountyAmount.call({from: validator});
        //         bounty.should.be.equal(15);
        //         await delegationService.withdrawBounty(bountyAddress, bounty, {from: validator});

        //         // get bounty for August

        //         await skipTimeToDate(web3, 1, 8);

        //         bounty = await delegationService.getEarnedBountyAmount.call({from: holder1});
        //         bounty.should.be.equal(46);
        //         await delegationService.withdrawBounty(bountyAddress, bounty, {from: holder1});

        //         bounty = await delegationService.getEarnedBountyAmount.call({from: holder2});
        //         bounty.should.be.equal(84);
        //         await delegationService.withdrawBounty(bountyAddress, bounty, {from: holder2});

        //         bounty = await delegationService.getEarnedBountyAmount.call({from: holder3});
        //         bounty.should.be.equal(39);
        //         await delegationService.withdrawBounty(bountyAddress, bounty, {from: holder3});

        //         bounty = await delegationService.getEarnedBountyAmount.call({from: validator});
        //         bounty.should.be.equal(30);
        //         await delegationService.withdrawBounty(bountyAddress, bounty, {from: validator});

        //         await delegationService.deleteNode(1, {from: validator});

        //         // get bounty for September

        //         await skipTimeToDate(web3, 1, 9);

        //         bounty = await delegationService.getEarnedBountyAmount.call({from: holder1});
        //         bounty.should.be.equal(29);
        //         await delegationService.withdrawBounty(bountyAddress, bounty, {from: holder1});

        //         bounty = await delegationService.getEarnedBountyAmount.call({from: holder2});
        //         bounty.should.be.equal(55);
        //         await delegationService.withdrawBounty(bountyAddress, bounty, {from: holder2});

        //         bounty = await delegationService.getEarnedBountyAmount.call({from: holder3});
        //         bounty.should.be.equal(0);
        //         await delegationService.withdrawBounty(bountyAddress, bounty, {from: holder3});

        //         bounty = await delegationService.getEarnedBountyAmount.call({from: validator});
        //         bounty.should.be.equal(15);
        //         await delegationService.withdrawBounty(bountyAddress, bounty, {from: validator});

        //     });
        // });
    });
});
