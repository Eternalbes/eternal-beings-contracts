// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

library SafeERC20 {
    error TokenCallFailed();

    function safeTransfer(IERC20Minimal token, address to, uint256 amount) internal {
        _call(token, abi.encodeCall(IERC20Minimal.transfer, (to, amount)));
    }

    function safeTransferFrom(IERC20Minimal token, address from, address to, uint256 amount) internal {
        _call(token, abi.encodeCall(IERC20Minimal.transferFrom, (from, to, amount)));
    }

    function forceApprove(IERC20Minimal token, address spender, uint256 amount) internal {
        bytes memory approval = abi.encodeCall(IERC20Minimal.approve, (spender, amount));
        if (!_tryCall(token, approval)) {
            _call(token, abi.encodeCall(IERC20Minimal.approve, (spender, 0)));
            _call(token, approval);
        }
    }

    function _call(IERC20Minimal token, bytes memory data) private {
        if (!_tryCall(token, data)) revert TokenCallFailed();
    }

    function _tryCall(IERC20Minimal token, bytes memory data) private returns (bool) {
        (bool success, bytes memory result) = address(token).call(data);
        return success && (result.length == 0 || (result.length >= 32 && abi.decode(result, (bool))));
    }
}
