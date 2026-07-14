// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract TestExternalNFT {
    string public constant name = "Test External NFT";
    string public constant symbol = "TEXT";
    uint256 public totalSupply;

    mapping(uint256 => address) public ownerOf;
    mapping(address => uint256) public balanceOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed spender, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    function mint(address to, uint256 tokenId) external {
        require(to != address(0), "zero to");
        require(ownerOf[tokenId] == address(0), "exists");
        ownerOf[tokenId] = to;
        balanceOf[to] += 1;
        totalSupply += 1;
        emit Transfer(address(0), to, tokenId);
    }

    function mintBatch(address to, uint256 startTokenId, uint256 count) external {
        for (uint256 i = 0; i < count; i++) {
            uint256 tokenId = startTokenId + i;
            require(ownerOf[tokenId] == address(0), "exists");
            ownerOf[tokenId] = to;
            balanceOf[to] += 1;
            totalSupply += 1;
            emit Transfer(address(0), to, tokenId);
        }
    }

    function mintWithSupply(address to, uint256 tokenId, uint256 supply) external {
        require(to != address(0), "zero to");
        require(ownerOf[tokenId] == address(0), "exists");
        require(supply > totalSupply, "low supply");
        ownerOf[tokenId] = to;
        balanceOf[to] += 1;
        totalSupply = supply;
        emit Transfer(address(0), to, tokenId);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x80ac58cd;
    }

    function approve(address spender, uint256 tokenId) external {
        address owner = ownerOf[tokenId];
        require(msg.sender == owner || isApprovedForAll[owner][msg.sender], "not approved");
        getApproved[tokenId] = spender;
        emit Approval(owner, spender, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 tokenId) external {
        address owner = ownerOf[tokenId];
        require(owner == from, "wrong from");
        require(msg.sender == owner || getApproved[tokenId] == msg.sender || isApprovedForAll[owner][msg.sender], "not approved");
        require(to != address(0), "zero to");
        ownerOf[tokenId] = to;
        balanceOf[from] -= 1;
        balanceOf[to] += 1;
        delete getApproved[tokenId];
        emit Transfer(from, to, tokenId);
    }
}
