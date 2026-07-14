// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IReentrantGameLike {
    function enterHunt(uint256 tokenId) external;
    function devourExternal(uint256 beingId, address nft, uint256 externalTokenId) external;
    function transferFrom(address from, address to, uint256 tokenId) external;
}

contract TestReentrantExternalNFT {
    string public constant name = "Test Reentrant External NFT";
    string public constant symbol = "TRXT";
    uint256 public totalSupply;

    address public game;
    uint256 public beingId;
    uint8 public mode;
    bool public attempted;
    bool public caught;

    mapping(uint256 => address) public ownerOf;
    mapping(address => uint256) public balanceOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed spender, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

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

    function configureReentry(address game_, uint256 beingId_, uint8 mode_) external {
        game = game_;
        beingId = beingId_;
        mode = mode_;
        attempted = false;
        caught = false;
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

        if (msg.sender == game && mode != 0) {
            attempted = true;
            if (mode == 1) {
                try IReentrantGameLike(game).enterHunt(beingId) {
                    caught = false;
                } catch {
                    caught = true;
                }
            } else if (mode == 2) {
                try IReentrantGameLike(game).transferFrom(from, to, beingId) {
                    caught = false;
                } catch {
                    caught = true;
                }
            } else if (mode == 3) {
                try IReentrantGameLike(game).devourExternal(beingId, address(this), tokenId) {
                    caught = false;
                } catch {
                    caught = true;
                }
            }
        }

        ownerOf[tokenId] = to;
        balanceOf[from] -= 1;
        balanceOf[to] += 1;
        delete getApproved[tokenId];
        emit Transfer(from, to, tokenId);
    }
}
