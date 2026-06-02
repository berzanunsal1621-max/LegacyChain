// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IVaultOracle {
    function isDeathConfirmed(address _user) external view returns (bool);
    function canStartGracePeriod(address _user) external view returns (bool);
    function activateGracePeriod(address _user) external;
    function getCaseStatus(address _user) external view returns (uint8);
    function resetSignals(address _user) external;
}

interface IVaultERC20 {
    function transfer(address recipient, uint256 amount) external returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

interface IVaultERC721 {
    function transferFrom(address from, address to, uint256 tokenId) external;
}

abstract contract VaultReentrancyGuard {
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _status;

    function _initReentrancyGuard() internal {
        _status = _NOT_ENTERED;
    }

    modifier nonReentrant() {
        require(_status != _ENTERED, "Reentrant call");
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }
}

contract InheritanceVault is VaultReentrancyGuard {
    uint256 public constant MAX_HEIRS = 10;
    uint256 public constant GRACE_PERIOD = 24 hours;
    string public constant VAULT_VERSION = "LegacyChain-v2";

    address public factory;
    address public owner;
    address public oracle;
    uint256 public lastSeen;
    uint256 public lastActivity;
    uint256 public timeLimit;
    uint256 public deathConfirmedTime;
    uint256 public timelockDuration;
    bool public initialized;
    bool public inheritanceClaimed;

    struct Heir {
        address wallet;
        uint256 percentage;
        string name;
        bool isActive;
        bytes32 secretHash;
    }

    struct PendingChange {
        address newHeir;
        uint256 newPercentage;
        string newName;
        uint256 unlockTime;
        bool exists;
    }

    struct SpecificAsset {
        address assetAddress;
        uint256 tokenId;
        uint256 amount;
        address designatedHeir;
        bool isERC721;
        bool isClaimed;
    }

    Heir[] public heirs;
    SpecificAsset[] public specificWills;

    mapping(uint256 => PendingChange) public pendingChanges;
    mapping(address => uint256) public pendingWithdrawals;
    mapping(address => mapping(address => uint256)) public pendingTokenWithdrawals;
    mapping(address => bool) public tokenClaimed;

    event VaultInitialized(address indexed factory, address indexed owner, address indexed initialHeir);
    event Pulse(uint256 timestamp);
    event DepositReceived(address indexed from, uint256 amount);
    event HeirAdded(address indexed heir, uint256 percentage, string name);
    event HeirUpdated(uint256 indexed index, address newHeir, uint256 newPercentage);
    event TimeLockInitiated(uint256 indexed heirIndex, uint256 unlockTime);
    event TimeLockExecuted(uint256 indexed heirIndex);
    event ShareAllocated(address indexed heir, uint256 amount);
    event ShareWithdrawn(address indexed heir, uint256 amount);
    event TokenShareAllocated(address indexed token, address indexed heir, uint256 amount);
    event TokenShareWithdrawn(address indexed token, address indexed heir, uint256 amount);
    event SpecificAssetAssigned(uint256 indexed willIndex, address indexed assetAddress, address designatedHeir);
    event SpecificAssetClaimed(uint256 indexed willIndex, address indexed heir);
    event SpecificAssetRemoved(uint256 indexed willIndex);
    event EmergencyWithdraw(uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "Only vault owner");
        _;
    }

    function initialize(
        address _owner,
        address _initialHeir,
        address _oracle,
        uint256 _timeLimitSeconds
    ) external {
        require(!initialized, "Already initialized");
        require(_owner != address(0), "Invalid owner");
        require(_initialHeir != address(0), "Invalid heir");
        require(_oracle != address(0), "Invalid oracle");
        require(_timeLimitSeconds >= 60, "Time limit too short");

        _initReentrancyGuard();
        initialized = true;
        factory = msg.sender;
        owner = _owner;
        oracle = _oracle;
        timeLimit = _timeLimitSeconds;
        lastSeen = block.timestamp;
        lastActivity = block.timestamp;
        timelockDuration = 1 minutes;

        heirs.push(Heir({
            wallet: _initialHeir,
            percentage: 100,
            name: "Primary Heir",
            isActive: true,
            secretHash: bytes32(0)
        }));

        emit HeirAdded(_initialHeir, 100, "Primary Heir");
        emit VaultInitialized(msg.sender, _owner, _initialHeir);
    }

    receive() external payable {
        emit DepositReceived(msg.sender, msg.value);
    }

    function ping() external onlyOwner {
        lastSeen = block.timestamp;
        emit Pulse(lastSeen);
    }

    function recordActivity() external onlyOwner {
        lastActivity = block.timestamp;
        IVaultOracle(oracle).resetSignals(owner);
        deathConfirmedTime = 0;
        emit Pulse(lastActivity);
    }

    function timeLeft() public view returns (uint256) {
        if (IVaultOracle(oracle).isDeathConfirmed(owner)) return 0;
        uint256 lastEvent = lastSeen > lastActivity ? lastSeen : lastActivity;
        if (block.timestamp > lastEvent + timeLimit) return 0;
        return (lastEvent + timeLimit) - block.timestamp;
    }

    function startGracePeriod() external {
        require(timeLeft() == 0, "Not ready");
        require(deathConfirmedTime == 0, "Grace already started");
        uint8 caseStatus = IVaultOracle(oracle).getCaseStatus(owner);
        if (caseStatus != 0) {
            require(IVaultOracle(oracle).canStartGracePeriod(owner), "Case not attested");
        }
        deathConfirmedTime = block.timestamp;
        if (caseStatus != 0) {
            IVaultOracle(oracle).activateGracePeriod(owner);
        }
    }

    function currentBalance() external view returns (uint256) {
        return address(this).balance;
    }

    function addHeir(address _wallet, uint256 _percentage, string calldata _name) external onlyOwner {
        require(_wallet != address(0), "Invalid heir");
        require(_percentage > 0 && _percentage < 100, "Percentage 1-99");
        require(heirs.length < MAX_HEIRS, "Max heirs reached");
        _makeRoomForPercentage(_percentage);
        heirs.push(Heir(_wallet, _percentage, _name, true, bytes32(0)));
        emit HeirAdded(_wallet, _percentage, _name);
    }

    function addHeirHash(bytes32 _secretHash, uint256 _percentage) external onlyOwner {
        require(_secretHash != bytes32(0), "Invalid hash");
        require(_percentage > 0 && _percentage < 100, "Percentage 1-99");
        require(heirs.length < MAX_HEIRS, "Max heirs reached");
        _makeRoomForPercentage(_percentage);
        heirs.push(Heir(address(0), _percentage, "Hidden Heir", true, _secretHash));
        emit HeirAdded(address(0), _percentage, "Hidden Heir");
    }

    function revealHeir(uint256 _index, address _wallet, string calldata _name, string calldata _secretSalt) external {
        require(timeLeft() == 0, "Death not confirmed");
        require(_index < heirs.length, "Invalid index");
        Heir storage h = heirs[_index];
        require(h.wallet == address(0) && h.secretHash != bytes32(0), "Not hidden");
        require(keccak256(abi.encodePacked(_wallet, _name, _secretSalt)) == h.secretHash, "Invalid reveal");
        h.wallet = _wallet;
        h.name = _name;
        emit HeirUpdated(_index, _wallet, h.percentage);
    }

    function initiateHeirUpdate(uint256 _index, address _newWallet, uint256 _newPercentage, string calldata _newName) external onlyOwner {
        require(_index < heirs.length, "Invalid index");
        require(_newWallet != address(0), "Invalid heir");
        require(_newPercentage > 0 && _newPercentage <= 100, "Invalid percentage");
        require((_totalPercentage() - heirs[_index].percentage) + _newPercentage <= 100, "Total too high");
        pendingChanges[_index] = PendingChange(_newWallet, _newPercentage, _newName, block.timestamp + timelockDuration, true);
        emit TimeLockInitiated(_index, block.timestamp + timelockDuration);
    }

    function executeHeirUpdate(uint256 _index) external onlyOwner {
        PendingChange memory change = pendingChanges[_index];
        require(change.exists, "No pending change");
        require(block.timestamp >= change.unlockTime, "Timelock active");
        heirs[_index].wallet = change.newHeir;
        heirs[_index].percentage = change.newPercentage;
        heirs[_index].name = change.newName;
        delete pendingChanges[_index];
        emit TimeLockExecuted(_index);
        emit HeirUpdated(_index, change.newHeir, change.newPercentage);
    }

    function assignSpecificToken(address _tokenAddress, uint256 _amount, address _heir) external onlyOwner {
        require(_tokenAddress != address(0) && _heir != address(0), "Invalid address");
        require(_amount > 0, "Invalid amount");
        specificWills.push(SpecificAsset(_tokenAddress, 0, _amount, _heir, false, false));
        emit SpecificAssetAssigned(specificWills.length - 1, _tokenAddress, _heir);
    }

    function assignSpecificNFT(address _nftAddress, uint256 _tokenId, address _heir) external onlyOwner {
        require(_nftAddress != address(0) && _heir != address(0), "Invalid address");
        specificWills.push(SpecificAsset(_nftAddress, _tokenId, 1, _heir, true, false));
        emit SpecificAssetAssigned(specificWills.length - 1, _nftAddress, _heir);
    }

    function removeSpecificAsset(uint256 _index) external onlyOwner {
        require(_index < specificWills.length, "Invalid index");
        require(!specificWills[_index].isClaimed, "Already claimed");
        specificWills[_index].amount = 0;
        specificWills[_index].designatedHeir = address(0);
        emit SpecificAssetRemoved(_index);
    }

    function claimInheritance() external nonReentrant {
        require(!inheritanceClaimed, "Already distributed");
        _requireClaimReady();
        uint256 balance = address(this).balance;
        require(balance > 0, "No balance");
        inheritanceClaimed = true;
        _allocateEth(balance);
    }

    function withdrawShare() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        require(amount > 0, "No pending share");
        pendingWithdrawals[msg.sender] = 0;
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "Transfer failed");
        emit ShareWithdrawn(msg.sender, amount);
    }

    function claimTokens(address _tokenAddress) external nonReentrant {
        require(!tokenClaimed[_tokenAddress], "Token already distributed");
        _requireClaimReady();
        uint256 balance = IVaultERC20(_tokenAddress).balanceOf(address(this));
        require(balance > 0, "No token balance");
        tokenClaimed[_tokenAddress] = true;
        _allocateToken(_tokenAddress, balance);
    }

    function claimApprovedTokens(address _tokenAddress) external nonReentrant {
        require(!tokenClaimed[_tokenAddress], "Token already distributed");
        _requireClaimReady();
        uint256 allowance = IVaultERC20(_tokenAddress).allowance(owner, address(this));
        uint256 ownerBalance = IVaultERC20(_tokenAddress).balanceOf(owner);
        uint256 available = allowance < ownerBalance ? allowance : ownerBalance;
        require(available > 0, "No approved token balance");
        tokenClaimed[_tokenAddress] = true;
        require(IVaultERC20(_tokenAddress).transferFrom(owner, address(this), available), "Transfer failed");
        _allocateToken(_tokenAddress, available);
    }

    function withdrawTokenShare(address _tokenAddress) external nonReentrant {
        uint256 amount = pendingTokenWithdrawals[_tokenAddress][msg.sender];
        require(amount > 0, "No pending token share");
        pendingTokenWithdrawals[_tokenAddress][msg.sender] = 0;
        require(IVaultERC20(_tokenAddress).transfer(msg.sender, amount), "Transfer failed");
        emit TokenShareWithdrawn(_tokenAddress, msg.sender, amount);
    }

    function claimSpecificAsset(uint256 _index) external nonReentrant {
        _requireClaimReady();
        require(_index < specificWills.length, "Invalid index");
        SpecificAsset storage item = specificWills[_index];
        require(!item.isClaimed, "Already claimed");
        require(item.designatedHeir != address(0), "Removed");
        item.isClaimed = true;
        if (item.isERC721) {
            IVaultERC721(item.assetAddress).transferFrom(owner, item.designatedHeir, item.tokenId);
        } else {
            require(IVaultERC20(item.assetAddress).transferFrom(owner, item.designatedHeir, item.amount), "Transfer failed");
        }
        emit SpecificAssetClaimed(_index, item.designatedHeir);
    }

    function emergencyWithdraw() external onlyOwner nonReentrant {
        uint256 balance = address(this).balance;
        require(balance > 0, "No balance");
        (bool success, ) = payable(owner).call{value: balance}("");
        require(success, "Transfer failed");
        emit EmergencyWithdraw(balance);
    }

    function getAllHeirs() external view returns (Heir[] memory) {
        return heirs;
    }

    function getHeirCount() external view returns (uint256) {
        return heirs.length;
    }

    function getSpecificWillsCount() external view returns (uint256) {
        return specificWills.length;
    }

    function decentralizedOracle() external view returns (address) {
        return oracle;
    }

    function getTotalActivePercentage() external view returns (uint256) {
        return _totalPercentage();
    }

    function _requireClaimReady() internal view {
        require(timeLeft() == 0, "Not ready");
        require(deathConfirmedTime > 0, "Grace not started");
        uint8 caseStatus = IVaultOracle(oracle).getCaseStatus(owner);
        if (caseStatus != 0) {
            require(caseStatus == 4 || caseStatus == 7 || caseStatus == 8, "Case blocked");
        }
        require(block.timestamp >= deathConfirmedTime + GRACE_PERIOD, "Grace active");
    }

    function _makeRoomForPercentage(uint256 _percentage) internal {
        uint256 total = _totalPercentage();
        if (total + _percentage > 100) {
            uint256 excess = (total + _percentage) - 100;
            require(heirs[0].percentage > excess, "Primary percentage too low");
            heirs[0].percentage -= excess;
        }
    }

    function _activeStats() internal view returns (uint256 activePercentage, uint256 activeCount) {
        for (uint256 i = 0; i < heirs.length; i++) {
            if (heirs[i].isActive) {
                require(heirs[i].wallet != address(0), "Reveal hidden heirs first");
                activePercentage += heirs[i].percentage;
                activeCount++;
            }
        }
        require(activeCount > 0, "No active heirs");
    }

    function _allocateEth(uint256 _balance) internal {
        (uint256 activePercentage, uint256 activeCount) = _activeStats();
        uint256 allocated = 0;
        uint256 current = 0;
        for (uint256 i = 0; i < heirs.length; i++) {
            if (heirs[i].isActive) {
                current++;
                uint256 amount = (_balance * heirs[i].percentage) / activePercentage;
                if (current == activeCount) amount = _balance - allocated;
                pendingWithdrawals[heirs[i].wallet] += amount;
                allocated += amount;
                emit ShareAllocated(heirs[i].wallet, amount);
            }
        }
    }

    function _allocateToken(address _tokenAddress, uint256 _balance) internal {
        (uint256 activePercentage, uint256 activeCount) = _activeStats();
        uint256 allocated = 0;
        uint256 current = 0;
        for (uint256 i = 0; i < heirs.length; i++) {
            if (heirs[i].isActive) {
                current++;
                uint256 amount = (_balance * heirs[i].percentage) / activePercentage;
                if (current == activeCount) amount = _balance - allocated;
                pendingTokenWithdrawals[_tokenAddress][heirs[i].wallet] += amount;
                allocated += amount;
                emit TokenShareAllocated(_tokenAddress, heirs[i].wallet, amount);
            }
        }
    }

    function _totalPercentage() internal view returns (uint256 total) {
        for (uint256 i = 0; i < heirs.length; i++) {
            if (heirs[i].isActive) total += heirs[i].percentage;
        }
    }
}
