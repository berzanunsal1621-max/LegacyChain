// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title DecentralizedOracle - LegacyChain Consensus Oracle
 * @notice Manages multi-sig death signal consensus from multiple authorities.
 * @dev Implements a 2/3 consensus mechanism for death verification.
 */
contract DecentralizedOracle {
    address public owner;
    address public inheritanceContract;
    
    // Authorities who can sign death signals (e.g., Hospital, Government, Relative)
    mapping(address => bool) public isAuthority;
    address[] public authorities;
    
    // Death signal tracking: user => (authority => hasSigned)
    mapping(address => mapping(address => bool)) public deathSignals;
    mapping(address => uint256) public signalCount;
    
    // Consensus requirement (e.g., 2 for 2/3)
    uint256 public constant REQUIRED_SIGNALS = 2;
    
    event AuthorityAdded(address indexed authority);
    event AuthorityRemoved(address indexed authority);
    event DeathSignalSubmitted(address indexed user, address indexed authority);
    event DeathConfirmed(address indexed user, uint256 timestamp);
    
    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner can call this");
        _;
    }
    
    modifier onlyAuthority() {
        require(isAuthority[msg.sender], "Not an authorized oracle");
        _;
    }
    
    constructor() {
        owner = msg.sender;
    }
    
    /**
     * @notice Miras kontratı adresini kaydet (sadece bu adres resetSignals çağırabilir)
     */
    function setInheritanceContract(address _contract) external onlyOwner {
        require(_contract != address(0), "Invalid address");
        inheritanceContract = _contract;
    }
    
    /**
     * @notice Add a new authorized oracle node
     */
    function addAuthority(address _authority) external onlyOwner {
        require(_authority != address(0), "Invalid address");
        require(!isAuthority[_authority], "Already an authority");
        
        isAuthority[_authority] = true;
        authorities.push(_authority);
        emit AuthorityAdded(_authority);
    }
    
    /**
     * @notice Remove an existing authority
     * @param _authority Address to remove
     */
    function removeAuthority(address _authority) external onlyOwner {
        require(isAuthority[_authority], "Not an authority");
        
        isAuthority[_authority] = false;
        
        // Diziden çıkar (swap-and-pop)
        for (uint256 i = 0; i < authorities.length; i++) {
            if (authorities[i] == _authority) {
                authorities[i] = authorities[authorities.length - 1];
                authorities.pop();
                break;
            }
        }
        
        emit AuthorityRemoved(_authority);
    }
    
    /**
     * @notice Submit a death signal for a user
     * @param _user The user whose pulse is being checked
     */
    function submitDeathSignal(address _user) external onlyAuthority {
        require(!deathSignals[_user][msg.sender], "Already submitted signal for this user");
        
        deathSignals[_user][msg.sender] = true;
        signalCount[_user]++;
        
        emit DeathSignalSubmitted(_user, msg.sender);
        
        if (signalCount[_user] == REQUIRED_SIGNALS) {
            emit DeathConfirmed(_user, block.timestamp);
        }
    }
    
    /**
     * @notice Check if a user's death is confirmed by consensus
     */
    function isDeathConfirmed(address _user) external view returns (bool) {
        return signalCount[_user] >= REQUIRED_SIGNALS;
    }
    
    /**
     * @notice Reset signals for a user (if they prove to be alive during Grace Period)
     * @dev Only the registered inheritance contract can call this
     */
    function resetSignals(address _user) external {
        require(msg.sender == inheritanceContract || msg.sender == owner, "Only inheritance contract or owner can reset");
        signalCount[_user] = 0;
        for (uint256 i = 0; i < authorities.length; i++) {
            deathSignals[_user][authorities[i]] = false;
        }
    }

    function getAuthorities() external view returns (address[] memory) {
        return authorities;
    }
}
