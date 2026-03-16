// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title MultiHeirInheritance - Gelişmiş Çoklu Varis Miras Sistemi
 * @author LegacyChain Team - Teknofest 2025
 * @notice Bu kontrat birden fazla varisin yüzdelik pay ile miras almasını sağlar
 * @dev ReentrancyGuard ve TimeLock mekanizmaları ile güvenli miras transferi
 */

// OpenZeppelin IERC20 interface
interface IERC20 {
    function transfer(address recipient, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface DecentralizedOracle {
    function isDeathConfirmed(address _user) external view returns (bool);
    function resetSignals(address _user) external;
}

// OpenZeppelin ReentrancyGuard pattern (inline for simplicity)
abstract contract ReentrancyGuard {
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _status;

    constructor() {
        _status = _NOT_ENTERED;
    }

    modifier nonReentrant() {
        require(_status != _ENTERED, "ReentrancyGuard: reentrant call");
        _status = _ENTERED;
        _;
        _status = _NOT_ENTERED;
    }
}

contract MultiHeirInheritance is ReentrancyGuard {
    
    // ============================================
    // STATE VARIABLES
    // ============================================
    
    address public owner;
    address public oracle;
    
    uint256 public lastSeen;
    uint256 public timeLimit;
    
    // TimeLock için bekleme süresi (varis değişikliklerinde)
    uint256 public constant TIMELOCK_DURATION = 1 minutes;
    
    // Maksimum varis sayısı
    uint256 public constant MAX_HEIRS = 10;
    
    // Varis bilgilerini tutan struct
    struct Heir {
        address wallet;
        uint256 percentage; // 1-100 arası
        string name;        // Opsiyonel isim
        bool isActive;
        bytes32 secretHash; // Commit-Reveal için
    }
    
    // Privacy modunda verilerin açılıp açılmadığı
    bool public isHeirListRevealed;
    
    // Decentralized Oracle referansı
    address public decentralizedOracle;
    
    // Grace Period takipçisi
    uint256 public deathConfirmedTime;
    uint256 public constant GRACE_PERIOD = 24 hours;
    
    // Pasif aktivite takibi
    uint256 public lastActivity;
    
    // Pending değişiklik (TimeLock için)
    struct PendingChange {
        address newHeir;
        uint256 newPercentage;
        string newName;
        uint256 unlockTime;
        bool exists;
    }
    
    // Varisler dizisi
    Heir[] public heirs;
    
    // Pending değişiklikler mapping
    mapping(uint256 => PendingChange) public pendingChanges;
    
    // Emergency multi-sig için onay sayacı
    mapping(bytes32 => uint256) public emergencyApprovals;
    mapping(bytes32 => mapping(address => bool)) public hasApproved;
    
    // Trusted signers for emergency (owner + oracle + heir0)
    address[] public trustedSigners;
    uint256 public constant REQUIRED_SIGNATURES = 2;
    
    // ============================================
    // EVENTS
    // ============================================
    
    event Pulse(uint256 timestamp);
    event OracleSignalReceived(string message, uint256 timestamp);
    event AssetsTransferred(address[] recipients, uint256[] amounts, uint256 totalAmount);
    event EmergencyWithdraw(uint256 amount);
    event HeirAdded(address indexed heir, uint256 percentage, string name);
    event HeirRemoved(address indexed heir);
    event HeirUpdated(uint256 indexed index, address newHeir, uint256 newPercentage);
    event TimeLockInitiated(uint256 indexed heirIndex, uint256 unlockTime);
    event TimeLockExecuted(uint256 indexed heirIndex);
    event EmergencyApprovalGiven(address indexed signer, bytes32 actionHash);
    event DepositReceived(address indexed from, uint256 amount);
    
    // ============================================
    // MODIFIERS
    // ============================================
    
    modifier onlyOwner() {
        require(msg.sender == owner, "Sadece sahip bu islemi yapabilir");
        _;
    }
    
    modifier onlyOracle() {
        require(msg.sender == oracle || msg.sender == owner, "Yetkisiz Oracle");
        _;
    }
    
    modifier onlyTrustedSigner() {
        bool isTrusted = false;
        for (uint256 i = 0; i < trustedSigners.length; i++) {
            if (trustedSigners[i] == msg.sender) {
                isTrusted = true;
                break;
            }
        }
        require(isTrusted, "Yetkisiz imzalayici");
        _;
    }
    
    // ============================================
    // CONSTRUCTOR
    // ============================================
    
    /**
     * @notice Contract'ı başlat
     * @param _initialHeir İlk varis adresi
     * @param _oracle Oracle adresi
     * @param _timeLimitSeconds Proof-of-life zaman limiti (saniye)
     */
    constructor(
        address _initialHeir,
        address _oracle,
        uint256 _timeLimitSeconds
    ) {
        require(_initialHeir != address(0), "Gecersiz varis adresi");
        require(_oracle != address(0), "Gecersiz oracle adresi");
        require(_timeLimitSeconds >= 60, "Zaman limiti en az 60 saniye olmali");
        
        owner = msg.sender;
        oracle = _oracle;
        decentralizedOracle = _oracle; // Default as decentralized oracle
        timeLimit = _timeLimitSeconds;
        lastSeen = block.timestamp;
        lastActivity = block.timestamp;
        
        // İlk varisi %100 ile ekle
        heirs.push(Heir({
            wallet: _initialHeir,
            percentage: 100,
            name: "Primary Heir",
            isActive: true,
            secretHash: bytes32(0)
        }));
        
        // Trusted signers ayarla
        trustedSigners.push(msg.sender);  // owner
        trustedSigners.push(_oracle);      // oracle
        trustedSigners.push(_initialHeir); // primary heir
        
        emit HeirAdded(_initialHeir, 100, "Primary Heir");
    }
    
    // ============================================
    // RECEIVE FUNCTION
    // ============================================
    
    receive() external payable {
        emit DepositReceived(msg.sender, msg.value);
    }
    
    // ============================================
    // CORE FUNCTIONS
    // ============================================
    
    /**
     * @notice Proof-of-Life: Sahip hayatta olduğunu kanıtlar
     */
    function ping() external onlyOwner {
        lastSeen = block.timestamp;
        emit Pulse(lastSeen);
    }
    
    /**
     * @notice Oracle ölüm sinyali gönderir
     */
    function simulateOracleSignal() external onlyOracle {
        lastSeen = 0;
        emit OracleSignalReceived("Death Confirmed by Oracle", block.timestamp);
    }
    
    /**
     * @notice Kalan süreyi hesapla
     * @return Kalan saniye (0 = miras aktarılabilir/onaylanmış)
     */
    function timeLeft() public view returns (uint256) {
        // 1. Durum: Oracle Konsensüsü Sağlanmış mı?
        if (decentralizedOracle != address(0)) {
            bool confirmed = DecentralizedOracle(decentralizedOracle).isDeathConfirmed(owner);
            if (confirmed) return 0;
        }

        // 2. Durum: Manuel ping ve pasif takip
        uint256 lastEvent = lastSeen > lastActivity ? lastSeen : lastActivity;
        
        if (block.timestamp > lastEvent + timeLimit) {
            return 0;
        }
        return (lastEvent + timeLimit) - block.timestamp;
    }
    
    /**
     * @notice Otonom Aktivite Takibi (Ghost Ping)
     * @dev Kontrat sahibi bir işlem yaptığında tetiklenir
     */
    function recordActivity() external {
        require(msg.sender == owner, "Only owner activity counts");
        lastActivity = block.timestamp;
        
        // Eğer bir ölüm sinyali varsa ve sahibi işlem yaparsa sinyalleri sıfırla (Grace Period koruması)
        if (decentralizedOracle != address(0)) {
            DecentralizedOracle(decentralizedOracle).resetSignals(owner);
        }
        deathConfirmedTime = 0; // Reset grace period
    }

    /**
     * @notice Grace Period'u başlatır (Ölüm onaylandıktan sonra bir kez çağrılmalıdır)
     */
    function startGracePeriod() external {
        require(timeLeft() == 0, "Sure dolmadi veya Oracle onayi yok");
        require(deathConfirmedTime == 0, "Grace Period zaten baslatildi");
        deathConfirmedTime = block.timestamp;
    }
    
    /**
     * @notice Contract bakiyesini döndür
     */
    function currentBalance() public view returns (uint256) {
        return address(this).balance;
    }
    
    // ============================================
    // HEIR MANAGEMENT
    // ============================================
    
    /**
     * @notice Yeni varis ekle
     * @param _wallet Varis cüzdan adresi
     * @param _percentage Miras yüzdesi (1-100)
     * @param _name Varis ismi
     */
    function addHeir(
        address _wallet,
        uint256 _percentage,
        string memory _name
    ) external onlyOwner {
        require(_wallet != address(0), "Gecersiz adres");
        require(_percentage > 0 && _percentage < 100, "Yuzde 1-99 arasi olmali");
        require(heirs.length < MAX_HEIRS, "Maksimum varis sayisina ulasildi");
        
        uint256 totalPercentage = _getTotalPercentage();
        
        // Otomatik yüzde ayarlama: birinci varisin yüzdesinden düş
        if (totalPercentage + _percentage > 100) {
            uint256 excess = (totalPercentage + _percentage) - 100;
            require(heirs[0].percentage > excess, "Birinci varisin yuzdesi yetersiz");
            heirs[0].percentage -= excess;
        }
        
        heirs.push(Heir({
            wallet: _wallet,
            percentage: _percentage,
            name: _name,
            isActive: true,
            secretHash: bytes32(0)
        }));
        
        // Yeni varisi trusted signers'a ekle
        trustedSigners.push(_wallet);
        
        emit HeirAdded(_wallet, _percentage, _name);
    }
    
    /**
     * @notice Varis güncelleme başlat (TimeLock ile)
     * @param _index Güncellenecek varis index'i
     * @param _newWallet Yeni cüzdan adresi
     * @param _newPercentage Yeni yüzde
     * @param _newName Yeni isim
     */
    function initiateHeirUpdate(
        uint256 _index,
        address _newWallet,
        uint256 _newPercentage,
        string memory _newName
    ) external onlyOwner {
        require(_index < heirs.length, "Gecersiz varis indexi");
        require(_newWallet != address(0), "Gecersiz adres");
        require(_newPercentage > 0 && _newPercentage <= 100, "Yuzde 1-100 arasi olmali");
        
        // Yüzde kontrolü (mevcut varis hariç)
        uint256 totalExcludingCurrent = _getTotalPercentage() - heirs[_index].percentage;
        require(totalExcludingCurrent + _newPercentage <= 100, "Toplam yuzde 100'u gecemez");
        
        pendingChanges[_index] = PendingChange({
            newHeir: _newWallet,
            newPercentage: _newPercentage,
            newName: _newName,
            unlockTime: block.timestamp + TIMELOCK_DURATION,
            exists: true
        });
        
        emit TimeLockInitiated(_index, block.timestamp + TIMELOCK_DURATION);
    }
    
    /**
     * @notice TimeLock süresi dolduktan sonra değişikliği uygula
     * @param _index Varis index'i
     */
    function executeHeirUpdate(uint256 _index) external onlyOwner {
        require(pendingChanges[_index].exists, "Bekleyen degisiklik yok");
        require(block.timestamp >= pendingChanges[_index].unlockTime, "TimeLock suresi dolmadi");
        
        PendingChange memory change = pendingChanges[_index];
        
        heirs[_index].wallet = change.newHeir;
        heirs[_index].percentage = change.newPercentage;
        heirs[_index].name = change.newName;
        
        delete pendingChanges[_index];
        
        emit TimeLockExecuted(_index);
        emit HeirUpdated(_index, change.newHeir, change.newPercentage);
    }
    
    /**
     * @notice Bekleyen değişikliği iptal et
     * @param _index Varis index'i
     */
    function cancelHeirUpdate(uint256 _index) external onlyOwner {
        require(pendingChanges[_index].exists, "Bekleyen degisiklik yok");
        delete pendingChanges[_index];
    }
    
    /**
     * @notice Varisi deaktive et
     * @param _index Varis index'i
     */
    function deactivateHeir(uint256 _index) external onlyOwner {
        require(_index < heirs.length, "Gecersiz index");
        require(heirs.length > 1, "En az bir varis olmali");
        heirs[_index].isActive = false;
        emit HeirRemoved(heirs[_index].wallet);
    }
    
    // ============================================
    // INHERITANCE CLAIM
    // ============================================
    
    /**
     * @notice Miras talep et - tüm aktif varislere yüzdelik dağıtım yapar
     */
    function claimInheritance() external nonReentrant {
        require(timeLeft() == 0, "Sure dolmadi veya Oracle onayi yok");
        
        // Grace Period Kontrolü
        require(deathConfirmedTime > 0, "Grace Period baslatilmadi. Once startGracePeriod() cagrilmali.");
        require(block.timestamp >= deathConfirmedTime + GRACE_PERIOD, "Grace Period: 24 saatlik guvenlik suresi dolmadi");

        uint256 balance = address(this).balance;
        require(balance > 0, "Bakiye yok");
        
        // Aktif varisleri ve toplam yüzdeyi hesapla (Reveal kontrolü burada yapılabilir)
        uint256 activePercentage = 0;
        uint256 activeCount = 0;
        
        for (uint256 i = 0; i < heirs.length; i++) {
            if (heirs[i].isActive) {
                activePercentage += heirs[i].percentage;
                activeCount++;
            }
        }
        
        require(activeCount > 0, "Aktif varis yok");
        
        // Transfer dizileri
        address[] memory recipients = new address[](activeCount);
        uint256[] memory amounts = new uint256[](activeCount);
        uint256 currentIndex = 0;
        uint256 totalTransferred = 0;
        
        // Her varise payını transfer et
        for (uint256 i = 0; i < heirs.length; i++) {
            if (heirs[i].isActive) {
                uint256 normalizedPercentage = (heirs[i].percentage * 100) / activePercentage;
                uint256 amount = (balance * normalizedPercentage) / 100;
                
                if (currentIndex == activeCount - 1) {
                    amount = balance - totalTransferred;
                }
                
                recipients[currentIndex] = heirs[i].wallet;
                amounts[currentIndex] = amount;
                
                (bool success, ) = payable(heirs[i].wallet).call{value: amount}("");
                require(success, "Transfer failed");
                totalTransferred += amount;
                currentIndex++;
            }
        }
        
        emit AssetsTransferred(recipients, amounts, balance);
    }
    
    /**
     * @notice ERC20 Token mirasını dağıt
     */
    function claimTokens(address _tokenAddress) external nonReentrant {
        require(timeLeft() == 0, "Sure dolmadi");
        require(block.timestamp >= deathConfirmedTime + GRACE_PERIOD, "Grace Period aktif");
        
        uint256 balance = IERC20(_tokenAddress).balanceOf(address(this));
        require(balance > 0, "Token bakiyesi yok");
        
        // (Similar distribution logic for tokens...)
        for (uint256 i = 0; i < heirs.length; i++) {
            if (heirs[i].isActive) {
                uint256 amount = (balance * heirs[i].percentage) / 100;
                IERC20(_tokenAddress).transfer(heirs[i].wallet, amount);
            }
        }
    }
    
    // ============================================
    // EMERGENCY FUNCTIONS
    // ============================================
    
    /**
     * @notice Acil durum - sahip tüm bakiyeyi çeker
     */
    function emergencyWithdraw() external onlyOwner nonReentrant {
        uint256 balance = address(this).balance;
        require(balance > 0, "Bakiye yok");
        (bool success, ) = payable(owner).call{value: balance}("");
        require(success, "Transfer failed");
        emit EmergencyWithdraw(balance);
    }
    
    /**
     * @notice Multi-sig acil durum onayı ver
     * @param _actionHash İşlem hash'i
     */
    function approveEmergencyAction(bytes32 _actionHash) external onlyTrustedSigner {
        require(!hasApproved[_actionHash][msg.sender], "Zaten onayladiniz");
        
        hasApproved[_actionHash][msg.sender] = true;
        emergencyApprovals[_actionHash]++;
        
        emit EmergencyApprovalGiven(msg.sender, _actionHash);
    }
    
    /**
     * @notice Multi-sig ile acil transfer (2/3 onay gerekli)
     * @param _to Hedef adres
     * @param _amount Transfer miktarı
     */
    function emergencyMultiSigTransfer(address _to, uint256 _amount) external nonReentrant {
        bytes32 actionHash = keccak256(abi.encodePacked(_to, _amount, block.number / 100));
        require(emergencyApprovals[actionHash] >= REQUIRED_SIGNATURES, "Yetersiz onay");
        require(address(this).balance >= _amount, "Yetersiz bakiye");
        
        (bool success, ) = payable(_to).call{value: _amount}("");
        require(success, "Transfer failed");
        
        // Reset approvals
        delete emergencyApprovals[actionHash];
    }
    
    // ============================================
    // VIEW FUNCTIONS
    // ============================================
    
    /**
     * @notice Tüm varisleri getir
     */
    function getAllHeirs() external view returns (Heir[] memory) {
        return heirs;
    }
    
    /**
     * @notice Varis sayısını getir
     */
    function getHeirCount() external view returns (uint256) {
        return heirs.length;
    }
    
    /**
     * @notice Belirli bir varisin bilgilerini getir
     */
    function getHeir(uint256 _index) external view returns (
        address wallet,
        uint256 percentage,
        string memory name,
        bool isActive
    ) {
        require(_index < heirs.length, "Gecersiz index");
        Heir memory h = heirs[_index];
        return (h.wallet, h.percentage, h.name, h.isActive);
    }
    
    /**
     * @notice Pending değişiklik bilgisini getir
     */
    function getPendingChange(uint256 _index) external view returns (
        address newHeir,
        uint256 newPercentage,
        string memory newName,
        uint256 unlockTime,
        bool exists
    ) {
        PendingChange memory p = pendingChanges[_index];
        return (p.newHeir, p.newPercentage, p.newName, p.unlockTime, p.exists);
    }
    
    /**
     * @notice Toplam aktif yüzdeyi hesapla
     */
    function getTotalActivePercentage() external view returns (uint256) {
        uint256 total = 0;
        for (uint256 i = 0; i < heirs.length; i++) {
            if (heirs[i].isActive) {
                total += heirs[i].percentage;
            }
        }
        return total;
    }
    
    // ============================================
    // INTERNAL FUNCTIONS
    // ============================================
    
    function _getTotalPercentage() internal view returns (uint256) {
        uint256 total = 0;
        for (uint256 i = 0; i < heirs.length; i++) {
            if (heirs[i].isActive) {
                total += heirs[i].percentage;
            }
        }
        return total;
    }
}
