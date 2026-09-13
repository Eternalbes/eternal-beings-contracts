// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {StockWorldBase64} from "./libraries/StockWorldBase64.sol";
import {StockWorldConstants} from "./StockWorldTypes.sol";

interface IWorldNftRewardVault {
    function checkpointNftWeight(uint256 tokenId, address beneficiary, uint256 newWeight) external;
}

interface IStockWorldERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4);
}

/**
 * @title WorldNFT
 * @notice Fixed-cap evolving ERC-721 collection for one Stock World.
 * @dev Reward ownership is checkpointed before mint, transfer, burn, and
 *      Fusion state changes. The historical mint count never decreases.
 */
contract WorldNFT {
    struct WorldBeing {
        uint128 weight;
        uint64 fusionCount;
        bytes32 genome;
    }

    string public name;
    string public symbol;

    address public immutable factory;
    IWorldNftRewardVault public immutable rewardVault;
    uint32 public immutable maxSupply;

    address public mintController;
    uint32 public totalMinted;
    uint32 public totalBurned;

    mapping(uint256 tokenId => WorldBeing being) private beings;
    mapping(uint256 tokenId => address owner) private owners;
    mapping(address owner => uint256 balance) private balances;
    mapping(uint256 tokenId => address approved) public getApproved;
    mapping(address owner => mapping(address operator => bool approved)) public isApprovedForAll;

    uint256 private reentrancyState = 1;

    error ZeroAddress();
    error NotContract();
    error InvalidName();
    error InvalidSymbol();
    error InvalidSupply();
    error NotFactory();
    error NotMintController();
    error MintControllerAlreadySet();
    error MaxSupplyReached();
    error TokenDoesNotExist();
    error NotAuthorized();
    error IncorrectOwner();
    error IdenticalFusionTokens();
    error UnsafeRecipient();
    error ReentrantCall();

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event MintControllerSet(address indexed controller);
    event BeingMinted(address indexed owner, uint256 indexed tokenId, bytes32 genome);
    event Fused(
        address indexed operator,
        uint256 indexed parentId,
        uint256 indexed sacrificeId,
        uint128 newWeight,
        uint64 fusionCount,
        bytes32 genome
    );
    event MetadataUpdate(uint256 indexed tokenId);

    constructor(
        string memory name_,
        string memory symbol_,
        uint32 maxSupply_,
        address factory_,
        IWorldNftRewardVault rewardVault_
    ) {
        uint256 nameLength = bytes(name_).length;
        uint256 symbolLength = bytes(symbol_).length;
        if (nameLength == 0 || nameLength > 64) revert InvalidName();
        if (symbolLength == 0 || symbolLength > 12) revert InvalidSymbol();
        if (maxSupply_ < StockWorldConstants.MIN_NFT_SUPPLY || maxSupply_ > StockWorldConstants.MAX_NFT_SUPPLY) {
            revert InvalidSupply();
        }
        if (factory_ == address(0) || address(rewardVault_) == address(0)) revert ZeroAddress();
        if (address(rewardVault_).code.length == 0) revert NotContract();

        name = name_;
        symbol = symbol_;
        maxSupply = maxSupply_;
        factory = factory_;
        rewardVault = rewardVault_;
    }

    modifier nonReentrant() {
        if (reentrancyState != 1) revert ReentrantCall();
        reentrancyState = 2;
        _;
        reentrancyState = 1;
    }

    function setMintController(address controller) external {
        if (msg.sender != factory) revert NotFactory();
        if (mintController != address(0)) revert MintControllerAlreadySet();
        if (controller == address(0)) revert ZeroAddress();
        if (controller.code.length == 0) revert NotContract();
        mintController = controller;
        emit MintControllerSet(controller);
    }

    function mintFromController(address to, bytes32 genome)
        external
        nonReentrant
        returns (uint256 tokenId)
    {
        if (msg.sender != mintController) revert NotMintController();
        if (to == address(0)) revert ZeroAddress();
        if (totalMinted >= maxSupply) revert MaxSupplyReached();

        tokenId = uint256(++totalMinted);
        owners[tokenId] = to;
        balances[to] += 1;
        beings[tokenId] = WorldBeing({weight: 1, fusionCount: 0, genome: genome});

        rewardVault.checkpointNftWeight(tokenId, to, 1);
        emit Transfer(address(0), to, tokenId);
        emit BeingMinted(to, tokenId, genome);
        emit MetadataUpdate(tokenId);

        _checkReceiver(address(0), to, tokenId, "");
    }

    function fuse(uint256 parentId, uint256 sacrificeId) external nonReentrant {
        if (parentId == sacrificeId) revert IdenticalFusionTokens();
        if (!_isAuthorized(msg.sender, parentId) || !_isAuthorized(msg.sender, sacrificeId)) {
            revert NotAuthorized();
        }

        address parentOwner = ownerOf(parentId);
        address sacrificeOwner = ownerOf(sacrificeId);
        WorldBeing storage parent = beings[parentId];
        WorldBeing memory sacrifice = beings[sacrificeId];

        uint128 newWeight = parent.weight + sacrifice.weight + 1;
        uint64 newFusionCount = parent.fusionCount + sacrifice.fusionCount + 1;
        bytes32 newGenome = keccak256(
            abi.encode(
                parent.genome,
                sacrifice.genome,
                parentId,
                sacrificeId,
                newFusionCount,
                block.prevrandao,
                block.number
            )
        );

        rewardVault.checkpointNftWeight(parentId, parentOwner, newWeight);
        rewardVault.checkpointNftWeight(sacrificeId, sacrificeOwner, 0);

        parent.weight = newWeight;
        parent.fusionCount = newFusionCount;
        parent.genome = newGenome;
        _burn(sacrificeId, sacrificeOwner);

        emit Fused(msg.sender, parentId, sacrificeId, newWeight, newFusionCount, newGenome);
        emit MetadataUpdate(parentId);
    }

    function settleReward(uint256 tokenId) external nonReentrant {
        address owner = ownerOf(tokenId);
        rewardVault.checkpointNftWeight(tokenId, owner, beings[tokenId].weight);
    }

    function approve(address approved, uint256 tokenId) external {
        address owner = ownerOf(tokenId);
        if (msg.sender != owner && !isApprovedForAll[owner][msg.sender]) revert NotAuthorized();
        getApproved[tokenId] = approved;
        emit Approval(owner, approved, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 tokenId) external nonReentrant {
        _transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external nonReentrant {
        _transfer(from, to, tokenId);
        _checkReceiver(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes calldata data)
        external
        nonReentrant
    {
        _transfer(from, to, tokenId);
        _checkReceiver(from, to, tokenId, data);
    }

    function ownerOf(uint256 tokenId) public view returns (address owner) {
        owner = owners[tokenId];
        if (owner == address(0)) revert TokenDoesNotExist();
    }

    function balanceOf(address owner) external view returns (uint256) {
        if (owner == address(0)) revert ZeroAddress();
        return balances[owner];
    }

    function getBeing(uint256 tokenId) external view returns (WorldBeing memory) {
        if (owners[tokenId] == address(0)) revert TokenDoesNotExist();
        return beings[tokenId];
    }

    function circulatingSupply() external view returns (uint256) {
        return uint256(totalMinted) - uint256(totalBurned);
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        if (owners[tokenId] == address(0)) revert TokenDoesNotExist();
        WorldBeing memory being = beings[tokenId];
        string memory id = _toString(tokenId);
        string memory color = _color(being.genome);
        string memory svg = string.concat(
            "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512'>",
            "<rect width='512' height='512' fill='#080b10'/>",
            "<circle cx='256' cy='238' r='",
            _toString(54 + uint256(being.fusionCount % 9) * 9),
            "' fill='none' stroke='",
            color,
            "' stroke-width='8'/>",
            "<path d='M256 78L416 370L96 370Z' fill='none' stroke='#f4f7ff' stroke-width='3'/>",
            "<text x='256' y='438' fill='#f4f7ff' font-family='monospace' font-size='22' text-anchor='middle'>WORLD #",
            id,
            "</text></svg>"
        );
        string memory json = string.concat(
            "{\"name\":\"Stock World #",
            id,
            "\",\"description\":\"An evolving on-chain Stock World position.\",\"image\":\"data:image/svg+xml;base64,",
            StockWorldBase64.encode(bytes(svg)),
            "\",\"attributes\":[{\"trait_type\":\"Weight\",\"value\":",
            _toString(being.weight),
            "},{\"trait_type\":\"Fusion Count\",\"value\":",
            _toString(being.fusionCount),
            "}]}"
        );
        return string.concat("data:application/json;base64,", StockWorldBase64.encode(bytes(json)));
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x80ac58cd || interfaceId == 0x5b5e139f
            || interfaceId == 0x49064906;
    }

    function _transfer(address from, address to, uint256 tokenId) private {
        if (to == address(0)) revert ZeroAddress();
        address owner = ownerOf(tokenId);
        if (owner != from) revert IncorrectOwner();
        if (!_isAuthorized(msg.sender, tokenId)) revert NotAuthorized();

        rewardVault.checkpointNftWeight(tokenId, owner, beings[tokenId].weight);
        balances[from] -= 1;
        balances[to] += 1;
        owners[tokenId] = to;
        delete getApproved[tokenId];
        emit Transfer(from, to, tokenId);
    }

    function _burn(uint256 tokenId, address owner) private {
        balances[owner] -= 1;
        delete owners[tokenId];
        delete getApproved[tokenId];
        delete beings[tokenId];
        totalBurned += 1;
        emit Transfer(owner, address(0), tokenId);
    }

    function _isAuthorized(address operator, uint256 tokenId) private view returns (bool) {
        address owner = owners[tokenId];
        if (owner == address(0)) revert TokenDoesNotExist();
        return operator == owner || getApproved[tokenId] == operator || isApprovedForAll[owner][operator];
    }

    function _checkReceiver(address from, address to, uint256 tokenId, bytes memory data) private {
        if (to.code.length == 0) return;
        try IStockWorldERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data) returns (bytes4 value) {
            if (value != IStockWorldERC721Receiver.onERC721Received.selector) revert UnsafeRecipient();
        } catch {
            revert UnsafeRecipient();
        }
    }

    function _color(bytes32 genome) private pure returns (string memory) {
        bytes memory out = new bytes(7);
        bytes16 symbols = "0123456789abcdef";
        out[0] = "#";
        for (uint256 i = 0; i < 3; i++) {
            uint8 value = uint8(genome[i]);
            out[1 + i * 2] = symbols[value >> 4];
            out[2 + i * 2] = symbols[value & 0x0f];
        }
        return string(out);
    }

    function _toString(uint256 value) private pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + value % 10));
            value /= 10;
        }
        return string(buffer);
    }
}
