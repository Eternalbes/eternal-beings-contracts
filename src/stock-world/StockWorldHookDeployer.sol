// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title StockWorldHookDeployer
 * @notice Ownerless CREATE2 deployer for the permission-encoded Stock World Hook.
 * @dev CREATE2 includes the creation-code hash, so another caller cannot occupy
 *      the predicted Hook address with different constructor arguments or code.
 */
contract StockWorldHookDeployer {
    error EmptyCreationCode();
    error DeploymentFailed();

    event ContractDeployed(address indexed deployed, bytes32 indexed salt, bytes32 indexed initCodeHash);

    function deploy(bytes32 salt, bytes calldata creationCode) external returns (address deployed) {
        if (creationCode.length == 0) revert EmptyCreationCode();
        bytes memory code = creationCode;
        assembly ("memory-safe") {
            deployed := create2(0, add(code, 0x20), mload(code), salt)
        }
        if (deployed == address(0)) revert DeploymentFailed();
        emit ContractDeployed(deployed, salt, keccak256(creationCode));
    }

    function predict(bytes32 salt, bytes32 initCodeHash) external view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)))));
    }
}
