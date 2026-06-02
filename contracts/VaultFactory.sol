// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "./InheritanceVault.sol";

interface IOracleRegistry {
    function registerVault(address _vault) external;
}

contract VaultFactory {
    address public owner;
    address public oracleRegistry;
    address public immutable vaultImplementation;

    mapping(address => address[]) private userVaults;
    address[] public allVaults;

    event VaultCreated(
        address indexed owner,
        address indexed vault,
        address indexed initialHeir,
        address oracleRegistry,
        uint256 timeLimit
    );
    event OracleRegistryUpdated(address indexed previousRegistry, address indexed newRegistry);

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner can call this");
        _;
    }

    constructor(address _oracleRegistry) {
        require(_oracleRegistry != address(0), "Invalid oracle registry");
        owner = msg.sender;
        oracleRegistry = _oracleRegistry;

        address implementation = address(new InheritanceVault());
        InheritanceVault(payable(implementation)).initialize(address(this), address(1), _oracleRegistry, 1 days);
        vaultImplementation = implementation;
    }

    function createVault(address _initialHeir, uint256 _timeLimitSeconds) external returns (address) {
        address vaultAddress = Clones.clone(vaultImplementation);
        InheritanceVault(payable(vaultAddress)).initialize(
            msg.sender,
            _initialHeir,
            oracleRegistry,
            _timeLimitSeconds
        );

        userVaults[msg.sender].push(vaultAddress);
        allVaults.push(vaultAddress);
        IOracleRegistry(oracleRegistry).registerVault(vaultAddress);

        emit VaultCreated(msg.sender, vaultAddress, _initialHeir, oracleRegistry, _timeLimitSeconds);
        return vaultAddress;
    }

    function setOracleRegistry(address _oracleRegistry) external onlyOwner {
        require(_oracleRegistry != address(0), "Invalid oracle registry");
        address previous = oracleRegistry;
        oracleRegistry = _oracleRegistry;
        emit OracleRegistryUpdated(previous, _oracleRegistry);
    }

    function getVaults(address _user) external view returns (address[] memory) {
        return userVaults[_user];
    }

    function getAllVaults() external view returns (address[] memory) {
        return allVaults;
    }

    function getVaultCount(address _user) external view returns (uint256) {
        return userVaults[_user].length;
    }
}
