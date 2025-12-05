// SPDX-License-Identifier: MIT 
pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";


contract DaoPayrollFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error InvalidBatch();
    error InvalidParameter();
    error ReplayAttempt();
    error StateMismatch();
    error ProofVerificationFailed();

    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event ContractPaused();
    event ContractUnpaused();
    event CooldownSecondsSet(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event ContributionSubmitted(address indexed contributor, uint256 indexed batchId, bytes32 encryptedSalary, bytes32 encryptedKpiScore);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 totalSalary, uint256 totalBonus);

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    uint256 public currentBatchId;
    mapping(uint256 => bool) public isBatchOpen;
    mapping(uint256 => mapping(address => bool)) public hasContributedToBatch;

    mapping(address => euint32) public encryptedBaseSalary;
    mapping(address => euint32) public encryptedKpiScore;
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier checkSubmissionCooldown() {
        if (block.timestamp < lastSubmissionTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    modifier checkDecryptionRequestCooldown() {
        if (block.timestamp < lastDecryptionRequestTime[msg.sender] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        cooldownSeconds = 60; 
        emit ProviderAdded(owner);
    }

    function addProvider(address _provider) external onlyOwner {
        if (isProvider[_provider]) revert InvalidParameter();
        isProvider[_provider] = true;
        emit ProviderAdded(_provider);
    }

    function removeProvider(address _provider) external onlyOwner {
        if (!isProvider[_provider]) revert InvalidParameter();
        if (_provider == owner) revert InvalidParameter(); 
        isProvider[_provider] = false;
        emit ProviderRemoved(_provider);
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit ContractPaused();
    }

    function unpause() external onlyOwner {
        if (!paused) revert InvalidParameter();
        paused = false;
        emit ContractUnpaused();
    }

    function setCooldownSeconds(uint256 _cooldownSeconds) external onlyOwner {
        if (_cooldownSeconds == 0) revert InvalidParameter();
        emit CooldownSecondsSet(cooldownSeconds, _cooldownSeconds);
        cooldownSeconds = _cooldownSeconds;
    }

    function openBatch() external onlyOwner whenNotPaused {
        currentBatchId++;
        isBatchOpen[currentBatchId] = true;
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        if (!isBatchOpen[currentBatchId]) revert InvalidBatch();
        isBatchOpen[currentBatchId] = false;
        emit BatchClosed(currentBatchId);
    }

    function submitContribution(
        euint32 _encryptedBaseSalary,
        euint32 _encryptedKpiScore
    ) external onlyProvider whenNotPaused checkSubmissionCooldown {
        if (!isBatchOpen[currentBatchId]) revert InvalidBatch();
        if (hasContributedToBatch[currentBatchId][msg.sender]) {
            revert InvalidParameter(); 
        }

        _initIfNeeded(_encryptedBaseSalary);
        _initIfNeeded(_encryptedKpiScore);

        encryptedBaseSalary[msg.sender] = _encryptedBaseSalary;
        encryptedKpiScore[msg.sender] = _encryptedKpiScore;
        hasContributedToBatch[currentBatchId][msg.sender] = true;
        lastSubmissionTime[msg.sender] = block.timestamp;

        emit ContributionSubmitted(
            msg.sender,
            currentBatchId,
            _encryptedBaseSalary.toBytes32(),
            _encryptedKpiScore.toBytes32()
        );
    }

    function requestBatchDecryption(uint256 _batchId)
        external
        onlyProvider
        whenNotPaused
        checkDecryptionRequestCooldown
    {
        if (isBatchOpen[_batchId]) revert InvalidBatch(); 

        euint32 memory totalSalaryEnc = FHE.asEuint32(0);
        euint32 memory totalBonusEnc = FHE.asEuint32(0);
        ebool memory initialized = FHE.asEbool(false);

        address[] memory contributors = new address[](1); 
        contributors[0] = msg.sender; 

        for (uint256 i = 0; i < contributors.length; i++) {
            address contributor = contributors[i];
            if (hasContributedToBatch[_batchId][contributor]) {
                euint32 memory salary = encryptedBaseSalary[contributor];
                euint32 memory kpi = encryptedKpiScore[contributor];

                if (FHE.isInitialized(salary) && FHE.isInitialized(kpi)) {
                    totalSalaryEnc = FHE.add(totalSalaryEnc, salary);
                    euint32 memory bonus = FHE.mul(salary, kpi); 
                    totalBonusEnc = FHE.add(totalBonusEnc, bonus);
                    initialized = FHE.asEbool(true);
                }
            }
        }

        bytes32[] memory cts = new bytes32[](2);
        cts[0] = totalSalaryEnc.toBytes32();
        cts[1] = totalBonusEnc.toBytes32();

        bytes32 stateHash = _hashCiphertexts(cts);

        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);
        decryptionContexts[requestId] = DecryptionContext({
            batchId: _batchId,
            stateHash: stateHash,
            processed: false
        });

        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit DecryptionRequested(requestId, _batchId);
    }

    function myCallback(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        if (decryptionContexts[requestId].processed) {
            revert ReplayAttempt();
        }

        DecryptionContext memory ctx = decryptionContexts[requestId];

        euint32 memory currentTotalSalaryEnc = FHE.asEuint32(0);
        euint32 memory currentTotalBonusEnc = FHE.asEuint32(0);
        ebool memory initialized = FHE.asEbool(false);

        address[] memory contributors = new address[](1); 
        contributors[0] = ctx.batchId == 0 ? address(0) : owner; 

        for (uint256 i = 0; i < contributors.length; i++) {
            address contributor = contributors[i];
            if (hasContributedToBatch[ctx.batchId][contributor]) {
                euint32 memory salary = encryptedBaseSalary[contributor];
                euint32 memory kpi = encryptedKpiScore[contributor];

                if (FHE.isInitialized(salary) && FHE.isInitialized(kpi)) {
                    currentTotalSalaryEnc = FHE.add(currentTotalSalaryEnc, salary);
                    euint32 memory bonus = FHE.mul(salary, kpi);
                    currentTotalBonusEnc = FHE.add(currentTotalBonusEnc, bonus);
                    initialized = FHE.asEbool(true);
                }
            }
        }
        
        bytes32[] memory currentCts = new bytes32[](2);
        currentCts[0] = currentTotalSalaryEnc.toBytes32();
        currentCts[1] = currentTotalBonusEnc.toBytes32();

        bytes32 currentStateHash = _hashCiphertexts(currentCts);

        if (currentStateHash != ctx.stateHash) {
            revert StateMismatch();
        }

        try FHE.checkSignatures(requestId, cleartexts, proof) {
            uint256 totalSalary = abi.decode(cleartexts, (uint256));
            uint256 totalBonus = abi.decode(cleartexts, (uint256)); 

            decryptionContexts[requestId].processed = true;
            emit DecryptionCompleted(requestId, ctx.batchId, totalSalary, totalBonus);
        } catch {
            revert ProofVerificationFailed();
        }
    }

    function _hashCiphertexts(bytes32[] memory cts)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 memory value) internal pure {
        if (!FHE.isInitialized(value)) {
            value = FHE.asEuint32(0);
        }
    }

    function _requireInitialized(euint32 memory value) internal pure {
        if (!FHE.isInitialized(value)) {
            revert InvalidParameter();
        }
    }
}