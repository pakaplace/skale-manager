import BigNumber from "bignumber.js";
import * as chai from "chai";
import * as chaiAsPromised from "chai-as-promised";

import {ContractManagerContract,
        ContractManagerInstance,
        PricingInstance,
        PricingContract,
        SchainsDataContract,
        SchainsDataInstance,
        NodesDataContract,
        NodesDataInstance} from "../types/truffle-contracts";
import { totalmem } from "os";
import { skipTime } from "./utils/time";



const ContractManager: ContractManagerContract = artifacts.require("./ContractManager");
const Pricing: PricingContract = artifacts.require("./Pricing");
const SchainsData: SchainsDataContract = artifacts.require("./SchainsData");
const NodesData: NodesDataContract = artifacts.require("./NodesData");


chai.should();
chai.use(chaiAsPromised);



contract("Pricing", ([owner, holder]) => {
    let contractManager: ContractManagerInstance;
    let pricing: PricingInstance;
    let schainsData: SchainsDataInstance;
    let nodesData: NodesDataInstance;

    beforeEach(async () => {
        contractManager = await ContractManager.new({from: owner});
        pricing = await Pricing.new(contractManager.address, {from: owner});
        schainsData = await SchainsData.new("SchainsFunctionality", contractManager.address, {from: owner});
        nodesData = await NodesData.new(5260000, contractManager.address, {from: owner});
        await contractManager.setContractsAddress("SchainsData", schainsData.address);
        await contractManager.setContractsAddress("NodesData", nodesData.address);

    });

    describe("on initialized contracts", async () => {
        const bobSchainHash = web3.utils.soliditySha3("BobSchain");
        const davidSchainHash = web3.utils.soliditySha3("DavidSchain");
        const jacobSchainHash = web3.utils.soliditySha3("JacobSchain");

        beforeEach(async () => {
            await schainsData.initializeSchain("BobSchain", holder, 10, 2);
            await schainsData.initializeSchain("DavidSchain", holder, 10, 4);
            await schainsData.initializeSchain("JacobSchain", holder, 10, 8);
            await nodesData.addNode(holder, "John", "0x7f000001", "0x7f000002", 8545, "0x1122334455");
            await nodesData.addNode(holder, "Michael", "0x7f000003", "0x7f000004", 8545, "0x1122334455");
            await nodesData.addNode(holder, "Daniel", "0x7f000005", "0x7f000006", 8545, "0x1122334455");
            await nodesData.addNode(holder, "Steven", "0x7f000007", "0x7f000008", 8545, "0x1122334455");

        })

        it("should increase number of schains", async () => {
            const numberOfSchains = new BigNumber(await schainsData.numberOfSchains());
            assert(numberOfSchains.isEqualTo(3));
        })

        it("should increase number of nodes", async () => {
            const numberOfNodes = new BigNumber(await nodesData.getNumberOfNodes());
            assert(numberOfNodes.isEqualTo(4));
        })

        describe("on existing nodes and schains", async () => {
            beforeEach(async () => {
                const johnNodeIndex = new BigNumber(await nodesData.nodesNameToIndex(web3.utils.soliditySha3('John'))).toNumber();
                const michaelNodeIndex = new BigNumber(await nodesData.nodesNameToIndex(web3.utils.soliditySha3('Michael'))).toNumber();
                const danielNodeIndex = new BigNumber(await nodesData.nodesNameToIndex(web3.utils.soliditySha3('Daniel'))).toNumber();
                const stevenNodeIndex = new BigNumber(await nodesData.nodesNameToIndex(web3.utils.soliditySha3('Steven'))).toNumber();
                await schainsData.addSchainForNode(johnNodeIndex, bobSchainHash);
                await schainsData.addSchainForNode(michaelNodeIndex, davidSchainHash);
                await schainsData.addSchainForNode(danielNodeIndex, jacobSchainHash);
                await schainsData.addSchainForNode(stevenNodeIndex, jacobSchainHash);

                await schainsData.addGroup(bobSchainHash, 1, bobSchainHash);
                await schainsData.addGroup(davidSchainHash, 1, davidSchainHash);
                await schainsData.addGroup(jacobSchainHash, 2, jacobSchainHash);

                await schainsData.setNodeInGroup(bobSchainHash, johnNodeIndex);
                await schainsData.setNodeInGroup(davidSchainHash, michaelNodeIndex);
                await schainsData.setNodeInGroup(jacobSchainHash, danielNodeIndex);
                await schainsData.setNodeInGroup(jacobSchainHash, stevenNodeIndex);

                await schainsData.setSchainPartOfNode(bobSchainHash, 4);
                await schainsData.setSchainPartOfNode(davidSchainHash, 8);
                await schainsData.setSchainPartOfNode(jacobSchainHash, 128);
    
            })

            it("should check load percentage of network", async () => {

                const totalResources = new BigNumber(await schainsData.sumOfSchainsResources());
                assert(totalResources.isEqualTo(50));
                const loadPercentage = new BigNumber(await pricing.getTotalLoadPercentage());
                assert(loadPercentage.isEqualTo(9))
        
            })
            
            it("should check number of working nodes", async () => {
                await nodesData.setNodeLeft(0);
                await pricing.checkAllNodes();
                
                const workingNodes = new BigNumber(await pricing.workingNodes());
                assert(workingNodes.isEqualTo(3));
            })
            
            it("should check number of total nodes", async () => {
                await pricing.checkAllNodes();
                const totalNodes = new BigNumber(await pricing.totalNodes());
                assert(totalNodes.isEqualTo(4));
            })
            
            it("should not change price when no any new working or total nodes have been added", async () => {
                await pricing.initNodes();
                skipTime(web3, 60);
                await pricing.adjustPrice()
                    .should.be.eventually.rejectedWith("No any changes on nodes");
            })

            it("should not change price when the price is updated more often than necessary", async () => {
                await pricing.initNodes();
                await pricing.adjustPrice()
                    .should.be.eventually.rejectedWith("It's not a time to update a price");
            })


            describe("change the price when changing the number of nodes", async () => {
                let oldPrice: number;

                beforeEach(async () => {
                    await pricing.initNodes();
                    oldPrice = new BigNumber(await pricing.price()).toNumber();
                })

                afterEach(async () => {
                    const COOLDOWN_TIME = new BigNumber(await pricing.COOLDOWN_TIME()).toNumber();
                    const MINUTES_PASSED = 2;
                    skipTime(web3, MINUTES_PASSED*COOLDOWN_TIME);
                    await pricing.adjustPrice();
                    const newPrice = new BigNumber(await pricing.price()).toNumber();
    
                    const OPTIMAL_LOAD_PERCENTAGE = new BigNumber(await pricing.OPTIMAL_LOAD_PERCENTAGE()).toNumber();
                    const ADJUSTMENT_SPEED = new BigNumber(await pricing.ADJUSTMENT_SPEED()).toNumber();
                    const loadPercentage = new BigNumber(await pricing.getTotalLoadPercentage()).toNumber();
                    const priceChange = (ADJUSTMENT_SPEED * oldPrice) * (OPTIMAL_LOAD_PERCENTAGE - loadPercentage) / 1000000;
                    const price = oldPrice - priceChange * MINUTES_PASSED;
                    price.should.be.equal(newPrice);
                })

                it("should change price when new working node has been added", async () => {
                    await nodesData.addNode(holder, "vadim", "0x7f000010", "0x7f000011", 8545, "0x1122334455");
                })

                it("should change price when working node has been removed", async () => {
                    await nodesData.setNodeLeft(2);
                })

            })
            
        })
            
    })
})