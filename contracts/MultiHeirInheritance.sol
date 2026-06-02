// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title MultiHeirInheritance - Gelişmiş Çoklu Varis Miras Sistemi
 * @author LegacyChain Team - Teknofest 2026
 * @notice Bu kontrat birden fazla varisin yüzdelik pay ile miras almasını sağlar
 * @dev ReentrancyGuard ve TimeLock mekanizmaları ile güvenli miras transferi
 */

// OpenZeppelin IERC20 interface
interface IERC20 {
    function transfer(address recipient, uint256 amount) external returns (bool);
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

// OpenZeppelin IERC721 interface (NFT)
interface IERC721 {
    function transferFrom(address from, address to, uint256 tokenId) external;
    function ownerOf(uint256 tokenId) external view returns (address);
    function isApprovedForAll(address owner, address operator) external view returns (bool);
    function getApproved(uint256 tokenId) external view returns (address);
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
    // Üretimde 24-48 saat olarak ayarlanmalı, test ortamında kısa tutulmuştur
    uint256 public timelockDuration = 1 minutes;
    
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
    
    // Spesifik varlık atamaları (NFT veya Token)
    struct SpecificAsset {
        address assetAddress;  // NFT veya Token kontrat adresi
        uint256 tokenId;       // NFT ise ID, Token ise 0
        uint256 amount;        // Token ise miktar, NFT ise 1
        address designatedHeir;// Kime bırakılacağı
        bool isERC721;         // Varlık tipi
        bool isClaimed;        // Talep edildi mi?
    }
    
    // Spesifik vasiyetler dizisi
    SpecificAsset[] public specificWills;
    
    // Emergency multi-sig için onay sayacı
    mapping(bytes32 => uint256) public emergencyApprovals;
    mapping(bytes32 => mapping(address => bool)) public hasApproved;
    
    // Trusted signers for emergency (owner + oracle + heir0)
    address[] public trustedSigners;
    uint256 public constant REQUIRED_SIGNATURES = 2;
    uint256 public emergencyNonce;
    
    // Pull-over-Push pattern: Varisler kendi paylarını çeker
    mapping(address => uint256) public pendingWithdrawals;
    // Token bazlı pull-over-push
    mapping(address => mapping(address => uint256)) public pendingTokenWithdrawals; // token => heir => amount
    
    // Miras talep edildi mi takibi (çift dağıtımı önlemek için)
    bool public inheritanceClaimed;
    mapping(address => bool) public tokenClaimed;
    
    // Emergency Pause Mechanism
    bool public paused;
    
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
    event ShareAllocated(address indexed heir, uint256 amount);
    event ShareWithdrawn(address indexed heir, uint256 amount);
    event TokenShareAllocated(address indexed token, address indexed heir, uint256 amount);
    event TokenShareWithdrawn(address indexed token, address indexed heir, uint256 amount);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    
    // Specific Asset Events
    event SpecificAssetAssigned(uint256 indexed willIndex, address indexed assetAddress, address designatedHeir);
    event SpecificAssetClaimed(uint256 indexed willIndex, address indexed heir);
    event SpecificAssetRemoved(uint256 indexed willIndex);
    event ContractPaused(address indexed by, uint256 timestamp);
    event ContractUnpaused(address indexed by, uint256 timestamp);
    
    // ============================================
    // MODIFIERS
    // ============================================
    
    modifier onlyOwner() {
        require(msg.sender == owner, "Sadece sahip bu islemi yapabilir");
        _;
    }
    
    modifier onlyOracle() {
        require(msg.sender == oracle, "Sadece Oracle bu islemi yapabilir");
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
    
    modifier whenNotPaused() {
        require(!paused, "Kontrat duraklatildi");
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

    function transferOwnership(address _newOwner) public onlyOwner {
        require(_newOwner != address(0), "Gecersiz sahip adresi");

        address previousOwner = owner;
        owner = _newOwner;

        for (uint256 i = 0; i < trustedSigners.length; i++) {
            if (trustedSigners[i] == previousOwner) {
                trustedSigners[i] = _newOwner;
                emit OwnershipTransferred(previousOwner, _newOwner);
                return;
            }
        }

        trustedSigners.push(_newOwner);
        emit OwnershipTransferred(previousOwner, _newOwner);
    }
    
    // ============================================
    // CORE FUNCTIONS
    // ============================================
    
    /**
     * @notice Proof-of-Life: Sahip hayatta olduğunu kanıtlar
     */
    function ping() external onlyOwner whenNotPaused {
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
     * @notice Yeni varis ekle (Şifreli - Commit/Reveal)
     * @param _secretHash keccak256(wallet + name + salt)
     * @param _percentage Miras yüzdesi
     */
    function addHeirHash(
        bytes32 _secretHash,
        uint256 _percentage
    ) external onlyOwner whenNotPaused {
        require(_secretHash != bytes32(0), "Gecersiz hash");
        require(_percentage > 0 && _percentage < 100, "Yuzde 1-99 arasi olmali");
        require(heirs.length < MAX_HEIRS, "Maksimum varis sayisina ulasildi");
        
        uint256 totalPercentage = _getTotalPercentage();
        
        if (totalPercentage + _percentage > 100) {
            uint256 excess = (totalPercentage + _percentage) - 100;
            require(heirs[0].percentage > excess, "Birinci varisin yuzdesi yetersiz");
            heirs[0].percentage -= excess;
        }
        
        heirs.push(Heir({
            wallet: address(0), // Gizli
            percentage: _percentage,
            name: "Hidden Heir",
            isActive: true,
            secretHash: _secretHash
        }));
        
        emit HeirAdded(address(0), _percentage, "Hidden Heir");
    }
    
    /**
     * @notice Yeni varis ekle (Açık - Mevcut sistem)
     * @param _wallet Varis cüzdan adresi
     * @param _percentage Miras yüzdesi (1-100)
     * @param _name Varis ismi
     */
    function addHeir(
        address _wallet,
        uint256 _percentage,
        string memory _name
    ) external onlyOwner whenNotPaused {
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
     * @notice Ölümden sonra şifreli varisi açığa çıkar (Reveal)
     * @param _index Varis sırası
     * @param _wallet Gerçek cüzdan adresi
     * @param _name Gerçek isim
     * @param _secretSalt Şifrelemede kullanılan gizli kelime
     */
    function revealHeir(
        uint256 _index,
        address _wallet,
        string memory _name,
        string memory _secretSalt
    ) external {
        require(timeLeft() == 0, "Olum onayi yok, reveal yapilamaz");
        require(_index < heirs.length, "Gecersiz index");
        
        Heir storage h = heirs[_index];
        require(h.wallet == address(0), "Vasiyet zaten aciga cikarildi veya acik kaydedildi");
        require(h.secretHash != bytes32(0), "Bu acik bir vasiyet");
        
        // Hash kontrolü: keccak256(abi.encodePacked(_wallet, _name, _secretSalt))
        bytes32 computedHash = keccak256(abi.encodePacked(_wallet, _name, _secretSalt));
        require(computedHash == h.secretHash, "Hatali bilgiler veya yanlis varis");
        
        h.wallet = _wallet;
        h.name = _name;
        
        emit HeirUpdated(_index, _wallet, h.percentage);
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
    ) external onlyOwner whenNotPaused {
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
            unlockTime: block.timestamp + timelockDuration,
            exists: true
        });
        
        emit TimeLockInitiated(_index, block.timestamp + timelockDuration);
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
        
        // Trusted signer listesinden çıkar
        address heirWallet = heirs[_index].wallet;
        for (uint256 i = 0; i < trustedSigners.length; i++) {
            if (trustedSigners[i] == heirWallet) {
                trustedSigners[i] = trustedSigners[trustedSigners.length - 1];
                trustedSigners.pop();
                break;
            }
        }
        
        emit HeirRemoved(heirWallet);
    }
    
    // ============================================
    // INHERITANCE CLAIM
    // ============================================
    
    /**
     * @notice Miras talep et - tüm aktif varislere yüzdelik dağıtım yapar
     */
    /**
     * @notice Miras dağıtımını hesapla — Pull-over-Push pattern
     * @dev DoS saldırısını önlemek için ETH doğrudan gönderilmez,
     *      her varisin payı pendingWithdrawals'a yazılır.
     *      Varisler kendi paylarını withdrawShare() ile çeker.
     */
    function claimInheritance() external nonReentrant whenNotPaused {
        require(!inheritanceClaimed, "Miras zaten dagitildi");
        require(timeLeft() == 0, "Sure dolmadi veya Oracle onayi yok");
        
        // Grace Period Kontrolü
        require(deathConfirmedTime > 0, "Grace Period baslatilmadi. Once startGracePeriod() cagrilmali.");
        require(block.timestamp >= deathConfirmedTime + GRACE_PERIOD, "Grace Period: 24 saatlik guvenlik suresi dolmadi");

        uint256 balance = address(this).balance;
        require(balance > 0, "Bakiye yok");
        
        inheritanceClaimed = true;
        
        // Aktif varisleri ve toplam yüzdeyi hesapla
        uint256 activePercentage = 0;
        uint256 activeCount = 0;
        
        for (uint256 i = 0; i < heirs.length; i++) {
            if (heirs[i].isActive) {
                require(heirs[i].wallet != address(0), "Once tum gizli vasiyetler aciga cikarilmali (Reveal)");
                activePercentage += heirs[i].percentage;
                activeCount++;
            }
        }
        
        require(activeCount > 0, "Aktif varis yok");
        
        // Pull-over-Push: Her varisin payını hesapla ve pendingWithdrawals'a yaz
        address[] memory recipients = new address[](activeCount);
        uint256[] memory amounts = new uint256[](activeCount);
        uint256 currentIndex = 0;
        uint256 totalAllocated = 0;
        
        for (uint256 i = 0; i < heirs.length; i++) {
            if (heirs[i].isActive) {
                uint256 normalizedPercentage = (heirs[i].percentage * 100) / activePercentage;
                uint256 amount = (balance * normalizedPercentage) / 100;
                
                if (currentIndex == activeCount - 1) {
                    amount = balance - totalAllocated;
                }
                
                pendingWithdrawals[heirs[i].wallet] += amount;
                recipients[currentIndex] = heirs[i].wallet;
                amounts[currentIndex] = amount;
                
                emit ShareAllocated(heirs[i].wallet, amount);
                totalAllocated += amount;
                currentIndex++;
            }
        }
        emit AssetsTransferred(recipients, amounts, balance);
    }
    
    /**
     * @notice Varis kendi ETH payını çeker (Pull-over-Push)
     * @dev DoS saldırısına karşı güvenli: Her varis sadece kendi payını çeker
     */
    function withdrawShare() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        require(amount > 0, "Cekilecek pay yok");
        
        pendingWithdrawals[msg.sender] = 0;
        
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "Transfer failed");
        
        emit ShareWithdrawn(msg.sender, amount);
    }
    
    // ============================================
    // SPECIFIC ASSET ALLOCATION (NFT & TOKEN)
    // ============================================
    
    /**
     * @notice Spesifik bir ERC20 Token miktarını bir varise ata
     */
    function assignSpecificToken(address _tokenAddress, uint256 _amount, address _heir) external onlyOwner whenNotPaused {
        require(_tokenAddress != address(0), "Gecersiz adres");
        require(_amount > 0, "Miktar 0 olamaz");
        require(_heir != address(0), "Gecersiz varis");
        
        specificWills.push(SpecificAsset({
            assetAddress: _tokenAddress,
            tokenId: 0,
            amount: _amount,
            designatedHeir: _heir,
            isERC721: false,
            isClaimed: false
        }));
        
        emit SpecificAssetAssigned(specificWills.length - 1, _tokenAddress, _heir);
    }
    
    /**
     * @notice Spesifik bir NFT'yi (ERC721) bir varise ata
     */
    function assignSpecificNFT(address _nftAddress, uint256 _tokenId, address _heir) external onlyOwner whenNotPaused {
        require(_nftAddress != address(0), "Gecersiz adres");
        require(_heir != address(0), "Gecersiz varis");
        
        specificWills.push(SpecificAsset({
            assetAddress: _nftAddress,
            tokenId: _tokenId,
            amount: 1,
            designatedHeir: _heir,
            isERC721: true,
            isClaimed: false
        }));
        
        emit SpecificAssetAssigned(specificWills.length - 1, _nftAddress, _heir);
    }
    
    /**
     * @notice Spesifik atamayı iptal et
     */
    function removeSpecificAsset(uint256 _index) external onlyOwner {
        require(_index < specificWills.length, "Gecersiz index");
        require(!specificWills[_index].isClaimed, "Zaten talep edildi");
        
        // Sadece sıfırlama (diziden silmiyoruz indexler kaymasin diye)
        specificWills[_index].amount = 0;
        specificWills[_index].designatedHeir = address(0);
        
        emit SpecificAssetRemoved(_index);
    }
    
    /**
     * @notice Atanmis spesifik varligi (NFT/Token) talep et
     * @dev Token/NFT sahibinin bu kontrata 'Approve' vermis olmasi gerekir
     */
    function claimSpecificAsset(uint256 _index) external nonReentrant {
        require(timeLeft() == 0, "Sure dolmadi veya Oracle onayi yok");
        require(deathConfirmedTime > 0, "Grace Period baslatilmadi");
        require(block.timestamp >= deathConfirmedTime + GRACE_PERIOD, "Grace Period dolmadi");
        
        require(_index < specificWills.length, "Gecersiz index");
        SpecificAsset storage willRecord = specificWills[_index];
        require(!willRecord.isClaimed, "Zaten talep edildi");
        require(willRecord.designatedHeir != address(0), "Atanmis varis yok veya iptal edildi");
        require(msg.sender == willRecord.designatedHeir, "Sadece atanmis varis talep edebilir");
        
        willRecord.isClaimed = true;
        
        if (willRecord.isERC721) {
            // NFT Transfer
            IERC721(willRecord.assetAddress).transferFrom(owner, willRecord.designatedHeir, willRecord.tokenId);
        } else {
            // ERC20 Token Transfer
            IERC20(willRecord.assetAddress).transferFrom(owner, willRecord.designatedHeir, willRecord.amount);
        }
        
        emit SpecificAssetClaimed(_index, willRecord.designatedHeir);
    }
    
    function getSpecificWillsCount() external view returns (uint256) {
        return specificWills.length;
    }
    
    /**
     * @notice ERC20 Token mirasını dağıt (normalize edilmiş yüzdelerle)
     */
    /**
     * @notice ERC20 Token mirasını hesapla — Pull-over-Push pattern
     * @dev Tokenlar pendingTokenWithdrawals'a yazılır, varisler withdrawTokenShare() ile çeker
     */
    function claimTokens(address _tokenAddress) external nonReentrant whenNotPaused {
        require(!tokenClaimed[_tokenAddress], "Token zaten dagitildi");
        require(timeLeft() == 0, "Sure dolmadi");
        require(deathConfirmedTime > 0, "Grace Period baslatilmadi");
        require(block.timestamp >= deathConfirmedTime + GRACE_PERIOD, "Grace Period aktif");
        
        uint256 balance = IERC20(_tokenAddress).balanceOf(address(this));
        require(balance > 0, "Token bakiyesi yok");
        
        tokenClaimed[_tokenAddress] = true;
        
        uint256 activePercentage = 0;
        uint256 activeCount = 0;
        for (uint256 i = 0; i < heirs.length; i++) {
            if (heirs[i].isActive) {
                require(heirs[i].wallet != address(0), "Once tum gizli vasiyetler aciga cikarilmali (Reveal)");
                activePercentage += heirs[i].percentage;
                activeCount++;
            }
        }
        require(activeCount > 0, "Aktif varis yok");
        
        uint256 totalAllocated = 0;
        uint256 currentIndex = 0;
        for (uint256 i = 0; i < heirs.length; i++) {
            if (heirs[i].isActive) {
                currentIndex++;
                uint256 normalizedPercentage = (heirs[i].percentage * 100) / activePercentage;
                uint256 amount = (balance * normalizedPercentage) / 100;
                
                if (currentIndex == activeCount) {
                    amount = balance - totalAllocated;
                }
                
                pendingTokenWithdrawals[_tokenAddress][heirs[i].wallet] += amount;
                emit TokenShareAllocated(_tokenAddress, heirs[i].wallet, amount);
                totalAllocated += amount;
            }
        }
    }
    
    /**
     * @notice Varis kendi token payını çeker (Pull-over-Push)
     * @param _tokenAddress Çekilecek token adresi
     */
    function withdrawTokenShare(address _tokenAddress) external nonReentrant {
        uint256 amount = pendingTokenWithdrawals[_tokenAddress][msg.sender];
        require(amount > 0, "Cekilecek token payi yok");
        
        pendingTokenWithdrawals[_tokenAddress][msg.sender] = 0;
        
        bool success = IERC20(_tokenAddress).transfer(msg.sender, amount);
        require(success, "Token transfer basarisiz");
        
        emit TokenShareWithdrawn(_tokenAddress, msg.sender, amount);
    }
    
    // ============================================
    // CONFIGURATION FUNCTIONS
    // ============================================
    
    /**
     * @notice TimeLock süresini güncelle (sadece sahip)
     * @param _newDuration Yeni süre (saniye cinsinden)
     */
    function setTimelockDuration(uint256 _newDuration) external onlyOwner {
        require(_newDuration >= 60, "Minimum 60 saniye olmali");
        timelockDuration = _newDuration;
    }
    
    /**
     * @notice Approve tabanlı token mirası — kullanıcı tokenlarını kendi cüzdanında tutar,
     *         kontrata sadece harcama izni (approve) verir. Ölüm onaylandığında
     *         kontrat kullanıcının cüzdanından direkt varislere transfer yapar.
     * @param _tokenAddress ERC20 token kontrat adresi
     */
    function claimApprovedTokens(address _tokenAddress) external nonReentrant whenNotPaused {
        require(!tokenClaimed[_tokenAddress], "Token zaten dagitildi");
        require(timeLeft() == 0, "Sure dolmadi");
        require(deathConfirmedTime > 0, "Grace Period baslatilmadi");
        require(block.timestamp >= deathConfirmedTime + GRACE_PERIOD, "Grace Period aktif");
        
        // Sahibin cüzdanındaki onaylanmış bakiyeyi kontrol et
        uint256 allowance = IERC20(_tokenAddress).allowance(owner, address(this));
        uint256 ownerBalance = IERC20(_tokenAddress).balanceOf(owner);
        uint256 available = allowance < ownerBalance ? allowance : ownerBalance;
        require(available > 0, "Onaylanmis token bakiyesi yok");

        tokenClaimed[_tokenAddress] = true;
        require(
            IERC20(_tokenAddress).transferFrom(owner, address(this), available),
            "Token transferi basarisiz"
        );
        
        // Aktif varislerin toplam yüzdesini hesapla
        uint256 activePercentage = 0;
        uint256 activeCount = 0;
        for (uint256 i = 0; i < heirs.length; i++) {
            if (heirs[i].isActive) {
                require(heirs[i].wallet != address(0), "Once tum gizli vasiyetler aciga cikarilmali (Reveal)");
                activePercentage += heirs[i].percentage;
                activeCount++;
            }
        }
        require(activeCount > 0, "Aktif varis yok");
        
        uint256 totalAllocated = 0;
        uint256 currentIndex = 0;
        for (uint256 i = 0; i < heirs.length; i++) {
            if (heirs[i].isActive) {
                currentIndex++;
                uint256 normalizedPercentage = (heirs[i].percentage * 100) / activePercentage;
                uint256 amount = (available * normalizedPercentage) / 100;
                
                if (currentIndex == activeCount) {
                    amount = available - totalAllocated;
                }
                
                pendingTokenWithdrawals[_tokenAddress][heirs[i].wallet] += amount;
                emit TokenShareAllocated(_tokenAddress, heirs[i].wallet, amount);
                totalAllocated += amount;
            }
        }
    }
    
    /**
     * @notice Kontratı duraklat — tüm kritik işlemleri engeller
     * @dev Sadece sahip çağırabilir. Kritik bir güvenlik açığı bulunduğunda kullanılır.
     */
    function pause() external onlyOwner {
        require(!paused, "Zaten duraklatildi");
        paused = true;
        emit ContractPaused(msg.sender, block.timestamp);
    }
    
    /**
     * @notice Kontratı devam ettir — duraklatmayı kaldır
     */
    function unpause() external onlyOwner {
        require(paused, "Kontrat zaten aktif");
        paused = false;
        emit ContractUnpaused(msg.sender, block.timestamp);
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
    function emergencyMultiSigTransfer(address _to, uint256 _amount) external onlyTrustedSigner nonReentrant {
        bytes32 actionHash = keccak256(abi.encodePacked(_to, _amount, emergencyNonce));
        emergencyNonce++;
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
