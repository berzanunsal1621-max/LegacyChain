// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

contract InheritanceSystem {
    address public owner;
    address public heir;
    address public oracle;
    
    uint256 public lastSeen;
    uint256 public timeLimit;

    // Frontend'in dinlediği olaylar
    event Pulse(uint256 timestamp);
    event OracleSignalReceived(string message, uint256 timestamp);
    event AssetsTransferred(address recipient, uint256 amount);
    event EmergencyWithdraw(uint256 amount);

    constructor(address _heir, address _oracle, uint256 _timeLimitSeconds) {
        owner = msg.sender;
        heir = _heir;
        oracle = _oracle;
        timeLimit = _timeLimitSeconds;
        lastSeen = block.timestamp;
    }

    receive() external payable {}

    // 1. PING: Ben yaşıyorum, süreyi sıfırla
    function ping() external {
        require(msg.sender == owner, "Yetkisiz");
        lastSeen = block.timestamp;
        emit Pulse(lastSeen);
    }

    // 2. ORACLE SİMÜLASYONU: Buna basınca süre 0 olur, sistem ÖLÜ moduna geçer
    function simulateOracleSignal() external {
        require(msg.sender == oracle || msg.sender == owner, "Yetkisiz Oracle");
        lastSeen = 0; // Süreyi 0 yap = ÖLÜM
        emit OracleSignalReceived("Death Confirmed", block.timestamp);
    }

    // 3. EMERGENCY: İptal et ve parayı geri çek
    function emergencyWithdraw() external {
        require(msg.sender == owner, "Yetkisiz");
        uint256 balance = address(this).balance;
        payable(owner).transfer(balance);
        emit EmergencyWithdraw(balance);
    }

    // 4. MİRAS TRANSFERİ
    function claimInheritance() external {
        require(timeLeft() == 0, "Sure dolmadi");
        uint256 balance = address(this).balance;
        require(balance > 0, "Bakiye yok");
        payable(heir).transfer(balance);
        emit AssetsTransferred(heir, balance);
    }

    // 5. ZAMAN HESAPLAYICI (0 dönerse ÖLÜ demektir)
    function timeLeft() public view returns (uint256) {
        if (lastSeen == 0 || block.timestamp > lastSeen + timeLimit) {
            return 0; 
        }
        return (lastSeen + timeLimit) - block.timestamp;
    }

    // 6. BAKİYE
    function currentBalance() public view returns (uint256) {
        return address(this).balance;
    }
}