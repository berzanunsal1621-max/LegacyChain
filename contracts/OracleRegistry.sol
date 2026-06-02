// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

contract OracleRegistry is EIP712 {
    bytes32 private constant ATTESTATION_TYPEHASH =
        keccak256("Attestation(address authority,address user,bytes32 metadataHash,bytes32 sourceType,uint256 nonce,uint256 deadline)");
    bytes32 private constant CATEGORY_UNSPECIFIED = bytes32("unspecified");
    bytes32 private constant CATEGORY_GOVERNMENT = bytes32("government");
    bytes32 private constant CATEGORY_HEALTH = bytes32("health");
    bytes32 private constant CATEGORY_MEDICAL = bytes32("medical");
    bytes32 private constant CATEGORY_LEGAL = bytes32("legal");
    bytes32 private constant REASON_WATCH = bytes32("watch");

    enum CaseStatus {
        NONE,
        WATCH,
        CASE_OPEN,
        ATTESTED,
        GRACE_ACTIVE,
        DISPUTED,
        CANCELED,
        CLAIMABLE,
        RESOLVED
    }

    struct Authority {
        bool active;
        bytes32 role;
        string name;
    }

    struct Attestation {
        address authority;
        bytes32 metadataHash;
        bytes32 sourceType;
        uint256 timestamp;
    }

    struct CaseRecord {
        bytes32 caseId;
        address user;
        address vault;
        CaseStatus status;
        bytes32 reason;
        uint64 openedAt;
        uint64 attestedAt;
        uint64 resolvedAt;
        uint8 categoryCount;
        bool ownerResponded;
    }

    address public owner;
    uint256 public requiredSignals = 2;
    uint256 public caseNonce;

    mapping(address => Authority) public authorities;
    address[] public authorityList;

    mapping(address => mapping(address => bool)) public deathSignals;
    mapping(address => uint256) public signalCount;
    mapping(address => Attestation[]) private attestations;
    mapping(bytes32 => CaseRecord) private cases;
    mapping(address => bytes32) public currentCaseId;
    mapping(bytes32 => mapping(address => bool)) public authoritySubmitted;
    mapping(bytes32 => mapping(bytes32 => bool)) public categoryVotes;
    mapping(bytes32 => bytes32) public disputeHashes;
    mapping(address => uint256) public attestationNonces;
    mapping(address => bool) public registeredVaults;
    mapping(address => bool) public registeredFactories;

    event AuthorityAdded(address indexed authority, bytes32 indexed role, string name);
    event AuthorityRemoved(address indexed authority);
    event AuthorityRotated(address indexed oldAuthority, address indexed newAuthority, bytes32 indexed role);
    event FactoryStatusUpdated(address indexed factory, bool allowed);
    event VaultRegistered(address indexed vault);
    event CaseOpened(bytes32 indexed caseId, address indexed user, address indexed vault, bytes32 reason);
    event CaseStatusChanged(bytes32 indexed caseId, CaseStatus previousStatus, CaseStatus newStatus, address actor);
    event CategoryVoteRecorded(bytes32 indexed caseId, bytes32 indexed category, address indexed authority);
    event DisputeOpened(bytes32 indexed caseId, address indexed actor, bytes32 disputeHash);
    event GracePeriodActivated(bytes32 indexed caseId, address indexed user, uint256 timestamp);
    event SignedAttestationAccepted(address indexed relayer, address indexed authority, address indexed user, uint256 nonce);
    event DeathSignalSubmitted(
        address indexed user,
        address indexed authority,
        bytes32 indexed metadataHash,
        bytes32 sourceType,
        uint256 timestamp
    );
    event DeathConfirmed(address indexed user, uint256 timestamp);
    event SignalsReset(address indexed user, address indexed caller);

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner can call this");
        _;
    }

    modifier onlyAuthority() {
        require(authorities[msg.sender].active, "Not an authorized oracle");
        _;
    }

    modifier onlyOwnerOrAuthority() {
        require(msg.sender == owner || authorities[msg.sender].active, "Not authorized to manage cases");
        _;
    }

    constructor() EIP712("LegacyChainOracleRegistry", "2") {
        owner = msg.sender;
    }

    function setRequiredSignals(uint256 _requiredSignals) external onlyOwner {
        require(_requiredSignals > 0, "Invalid threshold");
        requiredSignals = _requiredSignals;
    }

    function setFactory(address _factory, bool _allowed) external onlyOwner {
        require(_factory != address(0), "Invalid factory");
        registeredFactories[_factory] = _allowed;
        emit FactoryStatusUpdated(_factory, _allowed);
    }

    function registerVault(address _vault) external {
        require(msg.sender == owner || registeredFactories[msg.sender], "Not allowed to register vault");
        require(_vault != address(0), "Invalid vault");
        registeredVaults[_vault] = true;
        emit VaultRegistered(_vault);
    }

    function openCase(address _user, address _vault, bytes32 _reason) external onlyOwnerOrAuthority returns (bytes32) {
        require(_user != address(0), "Invalid user");
        return _openCase(_user, _vault, _reason);
    }

    function addAuthority(address _authority) external onlyOwner {
        _addAuthority(_authority, bytes32("unspecified"), "Authority");
    }

    function addAuthority(address _authority, bytes32 _role, string calldata _name) external onlyOwner {
        _addAuthority(_authority, _role, _name);
    }

    function removeAuthority(address _authority) public onlyOwner {
        require(authorities[_authority].active, "Not an authority");
        authorities[_authority].active = false;

        for (uint256 i = 0; i < authorityList.length; i++) {
            if (authorityList[i] == _authority) {
                authorityList[i] = authorityList[authorityList.length - 1];
                authorityList.pop();
                break;
            }
        }

        emit AuthorityRemoved(_authority);
    }

    function rotateAuthority(address _oldAuthority, address _newAuthority, string calldata _newName) external onlyOwner {
        require(authorities[_oldAuthority].active, "Old authority missing");
        require(_newAuthority != address(0), "Invalid new authority");
        require(!authorities[_newAuthority].active, "New authority already active");

        bytes32 role = authorities[_oldAuthority].role;
        removeAuthority(_oldAuthority);
        _addAuthority(_newAuthority, role, _newName);
        emit AuthorityRotated(_oldAuthority, _newAuthority, role);
    }

    function submitDeathSignal(address _user) external onlyAuthority {
        _submitAttestation(msg.sender, _user, bytes32(0), authorities[msg.sender].role);
    }

    function submitDeathSignal(address _user, bytes32 _metadataHash, bytes32 _sourceType) public onlyAuthority {
        _submitAttestation(msg.sender, _user, _metadataHash, _sourceType);
    }

    function submitSignedAttestation(
        address _authority,
        address _user,
        bytes32 _metadataHash,
        bytes32 _sourceType,
        uint256 _nonce,
        uint256 _deadline,
        bytes calldata _signature
    ) external {
        require(_authority != address(0), "Invalid authority");
        require(authorities[_authority].active, "Authority inactive");
        require(block.timestamp <= _deadline, "Attestation expired");
        require(_nonce == attestationNonces[_authority], "Invalid nonce");

        bytes32 digest = _attestationDigest(_authority, _user, _metadataHash, _sourceType, _nonce, _deadline);
        address recovered = ECDSA.recover(digest, _signature);
        require(recovered == _authority, "Invalid attestation signature");

        attestationNonces[_authority]++;
        _submitAttestation(_authority, _user, _metadataHash, _sourceType);
        emit SignedAttestationAccepted(msg.sender, _authority, _user, _nonce);
    }

    function getAttestationDigest(
        address _authority,
        address _user,
        bytes32 _metadataHash,
        bytes32 _sourceType,
        uint256 _nonce,
        uint256 _deadline
    ) external view returns (bytes32) {
        return _attestationDigest(_authority, _user, _metadataHash, _sourceType, _nonce, _deadline);
    }

    function _submitAttestation(address _authority, address _user, bytes32 _metadataHash, bytes32 _sourceType) internal {
        require(_user != address(0), "Invalid user");
        require(!deathSignals[_user][_authority], "Already submitted signal for this user");

        bytes32 caseId = _ensureOpenCase(_user, bytes32("auto_signal"));
        require(!authoritySubmitted[caseId][_authority], "Authority already submitted for case");
        bytes32 category = _normalizedCategory(authorities[_authority].role);

        deathSignals[_user][_authority] = true;
        signalCount[_user]++;
        authoritySubmitted[caseId][_authority] = true;
        attestations[_user].push(Attestation({
            authority: _authority,
            metadataHash: _metadataHash,
            sourceType: _sourceType,
            timestamp: block.timestamp
        }));
        if (!categoryVotes[caseId][category]) {
            categoryVotes[caseId][category] = true;
            cases[caseId].categoryCount += 1;
            emit CategoryVoteRecorded(caseId, category, _authority);
        }

        emit DeathSignalSubmitted(_user, _authority, _metadataHash, _sourceType, block.timestamp);

        if (canAdvanceToAttested(caseId)) {
            cases[caseId].attestedAt = uint64(block.timestamp);
            _setCaseStatus(caseId, CaseStatus.ATTESTED, _authority);
            emit DeathConfirmed(_user, block.timestamp);
        }
    }

    function isDeathConfirmed(address _user) external view returns (bool) {
        bytes32 caseId = currentCaseId[_user];
        if (caseId == bytes32(0)) {
            return signalCount[_user] >= requiredSignals;
        }

        CaseStatus status = cases[caseId].status;
        return status == CaseStatus.ATTESTED
            || status == CaseStatus.GRACE_ACTIVE
            || status == CaseStatus.CLAIMABLE
            || status == CaseStatus.RESOLVED;
    }

    function canStartGracePeriod(address _user) external view returns (bool) {
        bytes32 caseId = currentCaseId[_user];
        return caseId != bytes32(0) && cases[caseId].status == CaseStatus.ATTESTED;
    }

    function activateGracePeriod(address _user) external {
        require(msg.sender == owner || registeredVaults[msg.sender], "Only owner or registered vault can activate grace");
        bytes32 caseId = currentCaseId[_user];
        require(caseId != bytes32(0), "No active case");
        require(cases[caseId].status == CaseStatus.ATTESTED, "Case not attested");
        _setCaseStatus(caseId, CaseStatus.GRACE_ACTIVE, msg.sender);
        emit GracePeriodActivated(caseId, _user, block.timestamp);
    }

    function openDispute(address _user, bytes32 _disputeHash) external {
        require(
            msg.sender == owner
                || msg.sender == _user
                || registeredVaults[msg.sender]
                || authorities[msg.sender].active,
            "Not authorized to dispute"
        );
        bytes32 caseId = currentCaseId[_user];
        require(caseId != bytes32(0), "No active case");
        CaseStatus status = cases[caseId].status;
        require(
            status == CaseStatus.WATCH
                || status == CaseStatus.CASE_OPEN
                || status == CaseStatus.ATTESTED
                || status == CaseStatus.GRACE_ACTIVE,
            "Case not disputable"
        );
        disputeHashes[caseId] = _disputeHash;
        cases[caseId].ownerResponded = true;
        _setCaseStatus(caseId, CaseStatus.DISPUTED, msg.sender);
        emit DisputeOpened(caseId, msg.sender, _disputeHash);
    }

    function cancelCase(address _user) external {
        require(
            msg.sender == owner
                || msg.sender == _user
                || registeredVaults[msg.sender],
            "Not authorized to cancel"
        );
        _cancelCaseAndSignals(_user, msg.sender);
    }

    function resetSignals(address _user) external {
        require(msg.sender == owner || registeredVaults[msg.sender], "Only owner or registered vault can reset");
        _cancelCaseAndSignals(_user, msg.sender);
    }

    function getAuthorities() external view returns (address[] memory) {
        return authorityList;
    }

    function getAttestation(address _user, uint256 _index) external view returns (Attestation memory) {
        require(_index < attestations[_user].length, "Invalid attestation index");
        return attestations[_user][_index];
    }

    function getAttestationCount(address _user) external view returns (uint256) {
        return attestations[_user].length;
    }

    function getCurrentCaseId(address _user) external view returns (bytes32) {
        return currentCaseId[_user];
    }

    function getCaseStatus(address _user) external view returns (CaseStatus) {
        bytes32 caseId = currentCaseId[_user];
        if (caseId == bytes32(0)) return CaseStatus.NONE;
        return cases[caseId].status;
    }

    function getCase(bytes32 _caseId) external view returns (CaseRecord memory) {
        require(cases[_caseId].caseId != bytes32(0), "Case not found");
        return cases[_caseId];
    }

    function hasCaseCategory(bytes32 _caseId, bytes32 _category) external view returns (bool) {
        return categoryVotes[_caseId][_normalizedCategory(_category)];
    }

    function canAdvanceToAttested(bytes32 _caseId) public view returns (bool) {
        CaseRecord memory record = cases[_caseId];
        if (record.caseId == bytes32(0)) return false;
        if (
            record.status == CaseStatus.DISPUTED
                || record.status == CaseStatus.CANCELED
                || record.status == CaseStatus.GRACE_ACTIVE
                || record.status == CaseStatus.CLAIMABLE
                || record.status == CaseStatus.RESOLVED
        ) {
            return false;
        }

        bool hasGovernment = categoryVotes[_caseId][CATEGORY_GOVERNMENT];
        bool hasHealth = categoryVotes[_caseId][CATEGORY_HEALTH] || categoryVotes[_caseId][CATEGORY_MEDICAL];
        bool hasLegal = categoryVotes[_caseId][CATEGORY_LEGAL];

        if ((hasGovernment && hasHealth) || (hasGovernment && hasLegal)) {
            return true;
        }

        if (record.status == CaseStatus.WATCH && hasHealth && hasLegal) {
            return true;
        }

        if (requiredSignals == 1 && signalCount[record.user] >= 1) {
            return true;
        }

        if (!_hasRecognizedCategoryVote(_caseId) && signalCount[record.user] >= requiredSignals) {
            return true;
        }

        return false;
    }

    function _addAuthority(address _authority, bytes32 _role, string memory _name) internal {
        require(_authority != address(0), "Invalid address");
        require(!authorities[_authority].active, "Already an authority");

        authorities[_authority] = Authority({
            active: true,
            role: _role,
            name: _name
        });
        authorityList.push(_authority);
        emit AuthorityAdded(_authority, _role, _name);
    }

    function _ensureOpenCase(address _user, bytes32 _reason) internal returns (bytes32) {
        bytes32 existing = currentCaseId[_user];
        if (existing != bytes32(0) && _isActiveCase(cases[existing].status)) {
            return existing;
        }
        return _openCase(_user, address(0), _reason);
    }

    function _openCase(address _user, address _vault, bytes32 _reason) internal returns (bytes32) {
        bytes32 existing = currentCaseId[_user];
        require(existing == bytes32(0) || !_isActiveCase(cases[existing].status), "Active case already exists");

        bytes32 caseId = keccak256(abi.encodePacked(_user, _vault, _reason, block.timestamp, caseNonce++));
        CaseStatus initialStatus = _reason == REASON_WATCH ? CaseStatus.WATCH : CaseStatus.CASE_OPEN;
        cases[caseId] = CaseRecord({
            caseId: caseId,
            user: _user,
            vault: _vault,
            status: initialStatus,
            reason: _reason,
            openedAt: uint64(block.timestamp),
            attestedAt: 0,
            resolvedAt: 0,
            categoryCount: 0,
            ownerResponded: false
        });
        currentCaseId[_user] = caseId;
        emit CaseOpened(caseId, _user, _vault, _reason);
        emit CaseStatusChanged(caseId, CaseStatus.NONE, initialStatus, msg.sender);
        return caseId;
    }

    function _setCaseStatus(bytes32 _caseId, CaseStatus _newStatus, address _actor) internal {
        CaseStatus previousStatus = cases[_caseId].status;
        if (previousStatus == _newStatus) return;
        cases[_caseId].status = _newStatus;
        if (_newStatus == CaseStatus.CANCELED || _newStatus == CaseStatus.RESOLVED) {
            cases[_caseId].resolvedAt = uint64(block.timestamp);
        }
        emit CaseStatusChanged(_caseId, previousStatus, _newStatus, _actor);
    }

    function _cancelCaseAndSignals(address _user, address _actor) internal {
        bytes32 caseId = currentCaseId[_user];
        if (caseId != bytes32(0)) {
            cases[caseId].resolvedAt = uint64(block.timestamp);
            cases[caseId].ownerResponded = true;
            _setCaseStatus(caseId, CaseStatus.CANCELED, _actor);
            delete currentCaseId[_user];
        }
        signalCount[_user] = 0;

        for (uint256 i = 0; i < authorityList.length; i++) {
            deathSignals[_user][authorityList[i]] = false;
        }

        delete attestations[_user];
        emit SignalsReset(_user, _actor);
    }

    function _isActiveCase(CaseStatus _status) internal pure returns (bool) {
        return _status == CaseStatus.WATCH
            || _status == CaseStatus.CASE_OPEN
            || _status == CaseStatus.ATTESTED
            || _status == CaseStatus.GRACE_ACTIVE
            || _status == CaseStatus.DISPUTED
            || _status == CaseStatus.CLAIMABLE;
    }

    function _normalizedCategory(bytes32 _category) internal pure returns (bytes32) {
        if (_category == CATEGORY_MEDICAL) return CATEGORY_HEALTH;
        return _category;
    }

    function _hasRecognizedCategoryVote(bytes32 _caseId) internal view returns (bool) {
        return categoryVotes[_caseId][CATEGORY_GOVERNMENT]
            || categoryVotes[_caseId][CATEGORY_HEALTH]
            || categoryVotes[_caseId][CATEGORY_LEGAL];
    }

    function _attestationDigest(
        address _authority,
        address _user,
        bytes32 _metadataHash,
        bytes32 _sourceType,
        uint256 _nonce,
        uint256 _deadline
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                ATTESTATION_TYPEHASH,
                _authority,
                _user,
                _metadataHash,
                _sourceType,
                _nonce,
                _deadline
            )
        );
        return _hashTypedDataV4(structHash);
    }
}
