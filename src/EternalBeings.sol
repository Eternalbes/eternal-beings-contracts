// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title Eternal Beings
 * @notice A fully on-chain, ownerless, endlessly evolving NFT game.
 * @dev Website: https://eternalbeings.space/
 *
 * Eternal Beings is designed to live entirely inside Ethereum contracts. There
 * is no admin wallet, no pause switch, no upgrade path, no backend server, and
 * no off-chain image storage required for the core game. Players interact with
 * the contract directly through public functions, and the game state advances
 * only when users submit Ethereum transactions.
 *
 * Core idea:
 * - 9,999 genesis Beings can be minted through a commit/reveal flow.
 * - Every Being has permanent on-chain state: mass, complexity, power, skill,
 *   devour count, fusion count, scars, lineage, stage, and genome.
 * - A Being can devour eligible external NFTs. Standard ERC721 NFTs are locked
 *   forever inside this contract; supported CryptoPunks-style assets are also
 *   handled through their legacy ownership model.
 * - A Being can fuse with another Being from this collection. The sacrifice is
 *   burned forever, while the survivor absorbs part of its mass, complexity,
 *   power, skill, lineage, and genome.
 * - A Being can enter Hunt. While hunting, the NFT is held by this contract and
 *   cannot be transferred. Resolving the hunt returns the NFT and may emit ORE,
 *   increase power or skill, add scars, and mutate the genome.
 * - ORE is a fixed-supply ERC20-style token with a hard cap of 21,000,000. The
 *   game can only emit ORE up to a tiny per-block emission cap, and rewards are
 *   further limited by hunt difficulty, scene, endurance, and Being strength.
 * - Artwork and metadata are generated from on-chain state by EternalRenderer.
 *   The image evolves from genome, lineage, stats, scars, fusions, devours, and
 *   stage rather than from uploaded files.
 *
 * Genesis mint principles:
 * - Genesis supply is capped at 9,999 Beings.
 * - Minting is free at the contract level; users only pay Ethereum gas.
 * - Supply is released gradually by block epochs. Each epoch lasts 7,200
 *   blocks, roughly one day on Ethereum-like block times.
 * - At most 333 new Beings are released per epoch. Full distribution therefore
 *   takes about 31 epochs, with the last epoch releasing only the remaining
 *   supply.
 * - A wallet can mint at most one genesis Being. The contract tracks whether an
 *   address has already minted.
 * - Minting uses commit/reveal instead of first-come-first-served minting. This
 *   hides each user's mint secret during the commit phase, making mempool
 *   copying and simple front-running much less useful.
 * - Reveals are only accepted after the commit phase ends. If more users reveal
 *   than the epoch cap, only the deterministic winners for that epoch receive a
 *   Being; others can try again in later epochs.
 * - The contract has no whitelist, no admin mint, no reserved team allocation,
 *   and no function that can increase the 9,999 genesis cap.
 *
 * Mint flow:
 * 1. During a commit phase, call commitMint(commitment).
 * 2. During the reveal phase, call revealMint(epoch, secret).
 * 3. If needed after the epoch ends, call claimMint(epoch).
 *
 * Devour flow:
 * - For unknown standard ERC721 collections, first call observeExternal(nft,
 *   tokenId), keep ownership through the waiting period, then call
 *   devourExternal(beingId, nft, tokenId).
 * - For top-tier collections, provide the Merkle proof for the collection tier.
 * - The consumed NFT is permanently locked in this contract or, for Beings,
 *   burned. There is intentionally no rescue or withdrawal function.
 *
 * Hunt flow:
 * - Call enterHunt(tokenId) to send a Being into a generated scene.
 * - Call resolveHunt(tokenId) later to retrieve the Being and settle rewards.
 * - Low-power Beings have low endurance and must resolve sooner. Stronger
 *   Beings can survive longer but still face very low long-term emissions.
 *
 * Important user functions:
 * - commitMint, revealMint, claimMint
 * - observeExternal, devourExternal
 * - observeCryptoPunk, devourCryptoPunk
 * - fuseBeing
 * - enterHunt, resolveHunt
 * - getBeing, tokenURI, ownerOf, balanceOf, royaltyInfo
 *
 * Design limits:
 * - The game is autonomous, but Ethereum contracts cannot wake themselves up.
 *   Users must submit transactions to trigger minting, devouring, fusing, hunt
 *   entry, and hunt resolution.
 * - Randomness is generated from public chain data and game state. It is suited
 *   for an experimental on-chain game, not for high-value gambling.
 * - All rules are immutable after deployment. Verify the source and understand
 *   the rules before interacting.
 */

interface IERC721Like {
    function ownerOf(uint256 tokenId) external view returns (address);
    function transferFrom(address from, address to, uint256 tokenId) external;
}

interface IERC165Like {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface IERC721SupplyLike {
    function totalSupply() external view returns (uint256);
}

interface ICryptoPunksLike {
    function punkIndexToAddress(uint256 punkIndex) external view returns (address);
}

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data) external returns (bytes4);
}

library Base64 {
    string internal constant TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    function encode(bytes memory data) internal pure returns (string memory) {
        if (data.length == 0) return "";

        string memory table = TABLE;
        string memory result = new string(4 * ((data.length + 2) / 3));

        assembly {
            let tablePtr := add(table, 1)
            let dataPtr := data
            let endPtr := add(dataPtr, mload(data))
            let resultPtr := add(result, 32)

            for {} lt(dataPtr, endPtr) {} {
                dataPtr := add(dataPtr, 3)
                let input := mload(dataPtr)

                mstore8(resultPtr, mload(add(tablePtr, and(shr(18, input), 0x3F))))
                resultPtr := add(resultPtr, 1)
                mstore8(resultPtr, mload(add(tablePtr, and(shr(12, input), 0x3F))))
                resultPtr := add(resultPtr, 1)
                mstore8(resultPtr, mload(add(tablePtr, and(shr(6, input), 0x3F))))
                resultPtr := add(resultPtr, 1)
                mstore8(resultPtr, mload(add(tablePtr, and(input, 0x3F))))
                resultPtr := add(resultPtr, 1)
            }

            switch mod(mload(data), 3)
            case 1 {
                mstore8(sub(resultPtr, 1), 0x3d)
                mstore8(sub(resultPtr, 2), 0x3d)
            }
            case 2 {
                mstore8(sub(resultPtr, 1), 0x3d)
            }
        }

        return result;
    }
}

contract EternalOre {
    string public constant name = "Eternal Ore";
    string public constant symbol = "ORE";
    uint8 public constant decimals = 18;
    uint256 public constant MAX_SUPPLY = 21_000_000 ether;

    address public immutable minter;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    constructor(address minter_) {
        minter = minter_;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == minter, "not minter");
        require(totalSupply + amount <= MAX_SUPPLY, "max supply");
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0), "zero to");
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

contract EternalRenderer {
    struct RenderState {
        uint256 tokenId;
        uint128 mass;
        uint128 complexity;
        uint64 devours;
        uint64 fusions;
        uint64 premiumDevours;
        uint64 markLuck;
        uint32 power;
        uint32 skill;
        uint32 scars;
        uint16 stage;
        uint8 lineageMask;
        bytes32 genome;
        uint256 mood;
    }

    function tokenURI(
        uint256 tokenId,
        uint128 mass,
        uint128 complexity,
        uint64 devours,
        uint64 fusions,
        uint64 premiumDevours,
        uint64 markLuck,
        uint32 power,
        uint32 skill,
        uint32 scars,
        uint16 stage,
        uint8 lineageMask,
        bytes32 genome
    ) public pure returns (string memory) {
        uint8 mask = lineageMask == 0 ? uint8(1 << (uint256(genome) % 6)) : lineageMask;
        return _tokenURI(RenderState({
            tokenId: tokenId,
            mass: mass,
            complexity: complexity,
            devours: devours,
            fusions: fusions,
            premiumDevours: premiumDevours,
            markLuck: markLuck,
            power: power,
            skill: skill,
            scars: scars,
            stage: stage,
            lineageMask: mask,
            genome: genome,
            mood: (uint256(mask) + stage + scars) % 6
        }));
    }

    function _tokenURI(RenderState memory s) internal pure returns (string memory) {
        string memory svg = _svg(s);
        string memory image = string.concat("data:image/svg+xml;base64,", Base64.encode(bytes(svg)));
        string memory json = string.concat(
            "{\"name\":\"Being #",
            _toString(s.tokenId),
            "\",\"description\":\"A permanent on-chain evolving being.\",\"image\":\"",
            image,
            "\",\"attributes\":[{\"trait_type\":\"Power\",\"value\":",
            _toString(s.power),
            "},{\"trait_type\":\"Skill\",\"value\":",
            _toString(s.skill),
            "},{\"trait_type\":\"Mass\",\"value\":",
            _toString(s.mass),
            "},{\"trait_type\":\"Complexity\",\"value\":",
            _toString(s.complexity),
            "},{\"trait_type\":\"Devours\",\"value\":",
            _toString(s.devours),
            "},{\"trait_type\":\"Fusions\",\"value\":",
            _toString(s.fusions),
            "},{\"trait_type\":\"Scars\",\"value\":",
            _toString(s.scars),
            "},{\"trait_type\":\"Lineage\",\"value\":\"",
            _lineageName(s.lineageMask),
            "\"},{\"trait_type\":\"LineageMask\",\"value\":",
            _toString(s.lineageMask),
            "}]}");
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    function _svg(RenderState memory s) internal pure returns (string memory) {
        uint256 mutationLevel = _mutationLevel(s);
        string memory core = string.concat(_growthLayer(s, mutationLevel), _cardFigure(s, mutationLevel));
        if (mutationLevel >= 3 && (s.premiumDevours >= 3 || s.fusions >= 4 || s.scars >= 4)) {
            core = string.concat(
                "<g>",
                core,
                "<animate attributeName='opacity' values='.86;1;.86' dur='6s' repeatCount='indefinite'/></g>"
            );
        }
        string memory body = string.concat(
            _cardBorder(s),
            _glyphColumn(s, mutationLevel),
            core
        );
        string memory title = string.concat(
            "<text x='256' y='54' fill='",
            _color(s.mood, 1),
            "' font-family='monospace' font-size='18' text-anchor='middle' opacity='.9'>Being #",
            _toString(s.tokenId),
            "</text>"
        );
        string memory stats = string.concat(
            "<text x='256' y='490' fill='white' font-family='monospace' font-size='14' text-anchor='middle'>P",
            _toString(s.power),
            " S",
            _toString(s.skill),
            " D",
            _toString(s.devours),
            "</text>"
        );
        return string.concat(
            "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512'><rect width='512' height='512' fill='",
            _bg(s.mood),
            "'/>",
            body,
            title,
            stats,
            "</svg>"
        );
    }

    function _isPrimordial(RenderState memory s) internal pure returns (bool) {
        return s.mass <= 1 && s.devours == 0 && s.fusions == 0 && s.scars == 0;
    }

    function _mutationLevel(RenderState memory s) internal pure returns (uint256) {
        uint256 lineageCount = _bitCount(s.lineageMask);
        if (s.scars >= 8 || s.premiumDevours >= 18 || (lineageCount >= 5 && s.fusions >= 24) || s.fusions >= 36) return 4;
        if (s.scars >= 4 || s.premiumDevours >= 9 || (lineageCount >= 4 && s.fusions >= 12) || s.fusions >= 20) return 3;
        if (s.scars >= 2 || s.premiumDevours >= 4 || (lineageCount >= 3 && s.fusions >= 6) || s.fusions >= 10) return 2;
        uint256 rare = uint256(keccak256(abi.encodePacked(s.genome, "minor-mutation", s.devours))) % 10_000;
        if (s.devours >= 24 && rare < 70) return 1;
        return 0;
    }

    function _borderTier(RenderState memory s) internal pure returns (uint256) {
        return uint256(s.markLuck >> 60);
    }

    function _cardBorder(RenderState memory s) internal pure returns (string memory) {
        uint256 tier = _borderTier(s);
        if (tier == 0) return "";
        string memory c = tier == 4 ? "#ffd56a" : tier == 3 ? "#ff4fd8" : tier == 2 ? "#9c7dff" : "#38efff";
        return string.concat(
            "<rect x='18' y='18' width='476' height='476' rx='8' fill='rgba(255,255,255,0.018)' stroke='",
            c,
            "' stroke-width='",
            tier == 4 ? "8" : "6",
            "' opacity='.95'/>"
        );
    }

    function _glyphColumn(RenderState memory s, uint256 mutationLevel) internal pure returns (string memory) {
        uint256 rank = uint256((s.markLuck >> 56) & 15);
        if (rank == 0) return "";
        uint256 count = rank + uint256(s.premiumDevours / 8) + uint256(s.fusions / 12) + uint256(s.scars / 5);
        if (count > 34) count = 34;
        uint256 fontSize = count <= 10 ? 14 : count <= 18 ? 11 : 8;
        uint256 step = count <= 10 ? 21 : count <= 18 ? 16 : 11;
        string memory out = string.concat(
            "<rect x='46' y='76' width='74' height='356' rx='6' fill='none' stroke='",
            _color(s.mood, 1),
            "' stroke-width='1' opacity='.28'/>"
        );
        for (uint256 i = 0; i < count; i++) {
            uint256 r = uint256(keccak256(abi.encodePacked(s.genome, "char", i, mutationLevel)));
            out = string.concat(
                out,
                "<text x='62' y='",
                _toString(104 + i * step),
                "' fill='",
                _color(s.mood, i),
                "' font-family='monospace' font-size='",
                _toString(fontSize),
                "' opacity='.84'>",
                _rareGlyph(r, mutationLevel),
                "</text>"
            );
        }
        return out;
    }

    function _rareGlyph(uint256 r, uint256 mutationLevel) internal pure returns (string memory) {
        if (mutationLevel >= 4 && r % 23 == 0) {
            uint256 n = (r >> 8) % 4;
            if (n == 0) return "Rune";
            if (n == 1) return "Void";
            if (n == 2) return "Star";
            return "Core";
        }
        return _glyph(r);
    }

    function _growthLayer(RenderState memory s, uint256 mutationLevel) internal pure returns (string memory) {
        if (s.devours < 24 && mutationLevel == 0) return "";
        uint256 tier = mutationLevel == 0 ? _sqrt(_sqrt(uint256(s.devours))) : _sqrt(uint256(s.devours)) / 2;
        if (tier > 8) tier = 8;
        string memory out = "";
        for (uint256 i = 0; i < tier; i++) {
            out = string.concat(
                out,
                "<circle cx='300' cy='252' r='",
                _toString(30 + i * 11),
                "' fill='none' stroke='",
                _color(s.mood, i),
                "' stroke-width='1' opacity='.",
                _toString(14 + i * 3),
                "'/>"
            );
        }
        if (mutationLevel >= 3 && (s.fusions >= 10 || s.premiumDevours >= 5 || s.scars >= 2)) {
            for (uint256 i = 0; i < mutationLevel + 2; i++) {
                out = string.concat(out, _mutationWing(166 + i * 28, _color(s.mood, 2)));
            }
        }
        if (mutationLevel >= 4) {
            for (uint256 i = 0; i < 10; i++) {
                uint256 angle = (i * 32) / 10;
                int256 x = int256(300) + (int256(118) * _cos32(angle)) / 1000;
                int256 y2 = int256(252) + (int256(118) * _sin32(angle)) / 1000;
                out = string.concat(
                    out,
                    "<circle cx='",
                    _coord(x),
                    "' cy='",
                    _coord(y2),
                    "' r='",
                    i % 2 == 0 ? "4" : "3",
                    "' fill='",
                    _color(s.mood, i),
                    "' opacity='.72'/>"
                );
            }
        }
        return out;
    }

    function _mutationWing(uint256 y, string memory color) internal pure returns (string memory) {
        string memory y0 = _toString(y);
        string memory y1 = _toString(y > 34 ? y - 34 : 0);
        string memory y2 = _toString(y > 22 ? y - 22 : 0);
        return string.concat(
            "<path d='M196 ",
            y0,
            "C230 ",
            y1,
            " 246 ",
            y2,
            " 278 ",
            y0,
            "' fill='none' stroke='",
            color,
            "' stroke-width='2' opacity='.48'/>",
            "<path d='M404 ",
            y0,
            "C370 ",
            y1,
            " 354 ",
            y2,
            " 322 ",
            y0,
            "' fill='none' stroke='",
            color,
            "' stroke-width='2' opacity='.48'/>"
        );
    }

    function _cardFigure(RenderState memory s, uint256 mutationLevel) internal pure returns (string memory) {
        if (_isPrimordial(s)) {
            return _initialSeedFigure(s);
        }
        if (mutationLevel == 0 && s.devours < 24 && s.premiumDevours == 0) {
            return _smallCore(s, _color(s.mood, 1), _color(s.mood, 0));
        }
        return _advancedFigure(s, mutationLevel);
    }

    function _initialSeedFigure(RenderState memory s) internal pure returns (string memory) {
        uint256 kind = _primaryKind(s.lineageMask);
        uint256 seed = uint256(keccak256(abi.encodePacked(s.genome, "initial-seed")));
        string memory c0 = _color(s.mood, 0);
        string memory c1 = _color(s.mood, 1);
        string memory core = string.concat(
            "<circle cx='300' cy='256' r='",
            _toString(3 + (seed % 4)),
            "' fill='",
            c1,
            "' opacity='.86'/><text x='300' y='266' fill='",
            c1,
            "' font-family='monospace' font-size='30' font-weight='700' text-anchor='middle' opacity='.9'>",
            _glyph(seed >> 32),
            "</text>"
        );
        if (kind == 0) {
            return string.concat(core, "<path d='M268 256H332M300 224V288M284 240H316M284 272H316' stroke='", c0, "' stroke-width='2' opacity='.68'/>", _initialSeedSignature(s, c1));
        }
        if (kind == 1) {
            return string.concat(core, "<path d='M300 218L326 294H274Z' fill='none' stroke='", c0, "' stroke-width='2' opacity='.72'/><path d='M286 270H314' stroke='", c1, "' stroke-width='1' opacity='.58'/>", _initialSeedSignature(s, c1));
        }
        if (kind == 2) {
            return string.concat(core, "<path d='M272 286V246L300 222L328 246V286M286 286V262H314V286' fill='none' stroke='", c0, "' stroke-width='2' opacity='.72'/>", _initialSeedSignature(s, c1));
        }
        if (kind == 3) {
            return string.concat(core, "<path d='M300 216L340 256L300 296L260 256Z' fill='none' stroke='", c0, "' stroke-width='2' opacity='.72'/><path d='M300 216V296M260 256H340' stroke='", c1, "' stroke-width='1' opacity='.48'/>", _initialSeedSignature(s, c1));
        }
        if (kind == 4) {
            return string.concat(core, "<path d='M300 218V294M262 256H338M274 230L326 282M326 230L274 282' stroke='", c0, "' stroke-width='2' opacity='.68'/><circle cx='300' cy='256' r='24' fill='none' stroke='", c1, "' stroke-width='1' opacity='.35'/>", _initialSeedSignature(s, c1));
        }
        return string.concat(core, "<path d='M300 220V292M282 238H318M282 274H318M292 238L308 256L292 274' fill='none' stroke='", c0, "' stroke-width='2' opacity='.72'/>", _initialSeedSignature(s, c1));
    }

    function _initialSeedSignature(RenderState memory s, string memory color) internal pure returns (string memory) {
        uint256 v = uint256(keccak256(abi.encodePacked(s.genome, s.tokenId, "sig")));
        return string.concat(
            "<circle cx='",
            _toString(274 + (v % 53)),
            "' cy='",
            _toString(230 + ((v >> 8) % 53)),
            "' r='2' fill='",
            color,
            "' opacity='.7'/>"
        );
    }

    function _smallCore(RenderState memory s, string memory fillColor, string memory strokeColor) internal pure returns (string memory) {
        return string.concat(
            _initialSeedFigure(s),
            _smallDevourSignature(s, fillColor, strokeColor)
        );
    }

    function _smallDevourSignature(
        RenderState memory s,
        string memory fillColor,
        string memory strokeColor
    ) internal pure returns (string memory) {
        uint256 seed = uint256(keccak256(abi.encodePacked(s.genome, s.tokenId, s.devours, s.lineageMask, "small-devour")));
        uint256 nodes = 3 + (seed % 3) + uint256(s.devours > 4 ? 2 : s.devours / 2);
        string memory out = string.concat(
            "<text x='300' y='266' fill='",
            fillColor,
            "' font-family='monospace' font-size='22' font-weight='700' text-anchor='middle' opacity='.78'>",
            _glyph(seed >> 24),
            "</text>"
        );
        for (uint256 i = 0; i < nodes; i++) {
            uint256 a = (seed >> (i * 11)) % 360;
            uint256 r = 30 + ((seed >> (i * 7)) % 48);
            int256 x = int256(300) + (int256(r) * _cos32(a)) / 1000;
            int256 y = int256(256) + (int256(16 + r / 2) * _sin32(a)) / 1000;
            out = string.concat(
                out,
                "<circle cx='",
                _coord(x),
                "' cy='",
                _coord(y),
                "' r='",
                _toString(2 + ((seed >> (i * 5)) % 3)),
                "' fill='",
                i % 2 == 0 ? fillColor : strokeColor,
                "' opacity='.72'/>",
                "<path d='M300 256L",
                _coord(x),
                " ",
                _coord(y),
                "' stroke='",
                i % 2 == 0 ? strokeColor : fillColor,
                "' stroke-width='1' opacity='.24'/>"
            );
        }
        return out;
    }

    function _advancedFigure(RenderState memory s, uint256 mutationLevel) internal pure returns (string memory) {
        uint256 kind = s.fusions >= 6 || s.premiumDevours >= 4 || s.scars >= 2 ? _dominantKind(s) : _primaryKind(s.lineageMask);
        uint256 count = _bitCount(s.lineageMask);
        string memory figure = _materialBody(s, kind, mutationLevel);
        if (count > 1 && (s.fusions >= 8 || s.premiumDevours >= 5 || s.scars >= 3 || mutationLevel >= 4)) {
            figure = string.concat(figure, _hybridShell(s, kind, count, mutationLevel), _dominantOrgans(s, kind, mutationLevel));
        }
        return figure;
    }

    function _materialBody(RenderState memory s, uint256 kind, uint256 mutationLevel) internal pure returns (string memory) {
        if (kind == 0) {
            return string.concat(
                "<rect x='252' y='172' width='96' height='166' rx='10' fill='",
                _color(s.mood, 1),
                "' fill-opacity='.05' stroke='",
                _color(s.mood, 0),
                "' stroke-width='3'/>",
                "<circle cx='300' cy='228' r='28' fill='none' stroke='",
                _color(s.mood, 1),
                "' stroke-width='3'/>",
                "<path d='M252 224H204M348 224H396M252 292H202M348 292H398M300 172V128M300 338V382' stroke='",
                _color(s.mood, 1),
                "' stroke-width='2' opacity='.58'/>"
            );
        }
        if (kind == 1) {
            return string.concat(
                "<circle cx='300' cy='178' r='",
                _toString(22 + mutationLevel * 2),
                "' fill='",
                _color(s.mood, 1),
                "' fill-opacity='.2' stroke='",
                _color(s.mood, 0),
                "' stroke-width='3'/>",
                "<path d='M300 202L246 344H354Z' fill='",
                _color(s.mood, 1),
                "' fill-opacity='.06' stroke='",
                _color(s.mood, 0),
                "' stroke-width='3'/><path d='M228 256C260 226 340 226 372 256M246 302C274 282 326 282 354 302' fill='none' stroke='",
                _color(s.mood, 1),
                "' stroke-width='2' opacity='.58'/>"
            );
        }
        if (kind == 2) {
            return string.concat(
                "<path d='M226 356H374V224L350 210V172H326V198L300 178L274 198V172H250V210L226 224Z' fill='",
                _color(s.mood, 1),
                "' fill-opacity='.06' stroke='",
                _color(s.mood, 0),
                "' stroke-width='3'/><path d='M252 356V270H276V356M324 356V270H348V356M300 178V356M238 224H362M248 252H352' stroke='",
                _color(s.mood, 1),
                "' stroke-width='2' opacity='.62'/>"
            );
        }
        if (kind == 3) {
            return string.concat(
                "<circle cx='300' cy='252' r='72' fill='none' stroke='",
                _color(s.mood, 1),
                "' stroke-width='3' opacity='.62'/><path d='M300 142L358 252L300 362L242 252Z' fill='",
                _color(s.mood, 1),
                "' fill-opacity='.08' stroke='",
                _color(s.mood, 0),
                "' stroke-width='3'/><path d='M300 142V362M242 252H358' stroke='",
                _color(s.mood, 1),
                "' stroke-width='2' opacity='.5'/>"
            );
        }
        if (kind == 4) {
            return string.concat(
                "<circle cx='300' cy='252' r='116' fill='none' stroke='",
                _color(s.mood, 1),
                "' stroke-width='2' opacity='.35'/><ellipse cx='300' cy='252' rx='132' ry='32' fill='none' stroke='",
                _color(s.mood, 0),
                "' stroke-width='2' opacity='.55' transform='rotate(-18 300 252)'/><ellipse cx='300' cy='252' rx='132' ry='32' fill='none' stroke='",
                _color(s.mood, 1),
                "' stroke-width='2' opacity='.4' transform='rotate(42 300 252)'/><path d='M300 154L318 234L398 252L318 270L300 350L282 270L202 252L282 234Z' fill='",
                _color(s.mood, 1),
                "' fill-opacity='.08' stroke='",
                _color(s.mood, 0),
                "' stroke-width='3'/>"
            );
        }
        return string.concat(
            "<path d='M300 150C354 190 354 314 300 356C246 314 246 190 300 150Z' fill='",
            _color(s.mood, 1),
            "' fill-opacity='.06' stroke='",
            _color(s.mood, 0),
            "' stroke-width='3'/><path d='M300 178C276 218 278 292 300 330C322 292 324 218 300 178Z' fill='none' stroke='",
            _color(s.mood, 1),
            "' stroke-width='2' opacity='.68'/><text x='300' y='266' fill='",
            _color(s.mood, 0),
            "' font-family='monospace' font-size='48' text-anchor='middle' opacity='.76'>R</text>"
        );
    }

    function _hybridShell(RenderState memory s, uint256 kind, uint256 count, uint256 mutationLevel) internal pure returns (string memory) {
        uint256 seed = uint256(keccak256(abi.encodePacked(s.genome, "hybrid-form", s.fusions, s.scars)));
        uint256 wide = 76 + count * 16 + mutationLevel * 8;
        if (wide > 156) wide = 156;
        uint256 tall = 104 + ((seed >> 8) % 46) + mutationLevel * 10;
        if (tall > 182) tall = 182;
        string memory shell = _polarPath(300, 254, wide, tall, 16 + count * 3, seed, uint256(s.lineageMask) * 29 + kind * 17, true);
        return string.concat(
            "<path d='",
            shell,
            "' fill='",
            _color(s.mood, kind + 2),
            "' fill-opacity='.055' stroke='",
            _color(s.mood, kind + 3),
            "' stroke-width='",
            count > 3 ? "5" : "3",
            "' opacity='.86' stroke-linejoin='round'/>"
        );
    }

    function _dominantOrgans(RenderState memory s, uint256 kind, uint256 mutationLevel) internal pure returns (string memory) {
        string memory c = _color(s.mood, kind + 1);
        string memory a = _color(s.mood, kind + 4);
        if (kind == 0) {
            return string.concat(
                "<path d='M226 212H168V270M374 212H432V270M230 306H160V244M370 306H440V244' fill='none' stroke='",
                c,
                "' stroke-width='2' opacity='.68'/><circle cx='168' cy='270' r='4' fill='",
                a,
                "' opacity='.8'/><circle cx='432' cy='270' r='4' fill='",
                a,
                "' opacity='.8'/>"
            );
        }
        if (kind == 1) {
            return string.concat(
                "<path d='M206 214C244 174 356 174 394 214M192 276C240 244 360 244 408 276' fill='none' stroke='",
                c,
                "' stroke-width='2' opacity='.64'/>"
            );
        }
        if (kind == 2) {
            return string.concat(
                "<path d='M134 388V302L166 270L198 302V388M402 388V302L434 270L466 302V388M118 388H482' fill='none' stroke='",
                c,
                "' stroke-width='3' opacity='.68'/>"
            );
        }
        if (kind == 3) {
            return string.concat(
                "<path d='M176 220L130 170M424 220L470 170M182 310L126 360M418 310L474 360' stroke='",
                c,
                "' stroke-width='3' opacity='.7'/><path d='M130 170L152 194L130 218L108 194ZM470 170L492 194L470 218L448 194Z' fill='none' stroke='",
                a,
                "' stroke-width='2' opacity='.6'/>"
            );
        }
        if (kind == 4) {
            return string.concat(
                "<ellipse cx='300' cy='252' rx='168' ry='36' fill='none' stroke='",
                c,
                "' stroke-width='2' opacity='.62' transform='rotate(",
                _toString(18 + mutationLevel * 9),
                " 300 252)'/><ellipse cx='300' cy='252' rx='154' ry='30' fill='none' stroke='",
                a,
                "' stroke-width='2' opacity='.5' transform='rotate(-",
                _toString(32 + mutationLevel * 7),
                " 300 252)'/>"
            );
        }
        return string.concat(
            "<path d='M146 128V392M454 128V392M146 164H168M454 164H432M146 230H176M454 230H424' fill='none' stroke='",
            c,
            "' stroke-width='2' opacity='.62'/>"
        );
    }

    function _evo(RenderState memory s) internal pure returns (uint256) {
        uint256 value = uint256(s.stage) + uint256(s.devours / 10) + uint256(s.fusions * 2) + uint256(s.scars * 2);
        if (value > 30) return 30;
        if (value < 1) return 1;
        return value;
    }

    function _polarPath(
        uint256 cx,
        uint256 cy,
        uint256 rx,
        uint256 ry,
        uint256 points,
        uint256 seed,
        uint256 growth,
        bool closed
    ) internal pure returns (string memory) {
        uint256 f1 = 2 + (seed % 6);
        uint256 f2 = 5 + ((seed >> 8) % 8);
        uint256 amp1 = 60 + (growth % 160);
        uint256 amp2 = 30 + ((seed >> 16) % 120);
        string memory d = "";
        for (uint256 i = 0; i <= points; i++) {
            int256 wave = (int256(amp1) * _sin32((i * f1) % 32) + int256(amp2) * _cos32((i * f2) % 32)) / 1000;
            int256 scale = 1000 + wave;
            int256 x = int256(cx) + (int256(rx) * _cos32((i * 32) / points) * scale) / 1_000_000;
            int256 y = int256(cy) + (int256(ry) * _sin32((i * 32) / points) * scale) / 1_000_000;
            d = string.concat(d, i == 0 ? "M" : "L", _coord(x), " ", _coord(y));
        }
        if (closed) d = string.concat(d, "Z");
        return d;
    }

    function _cos32(uint256 i) internal pure returns (int256) {
        return _sin32(i + 8);
    }

    function _sin32(uint256 i) internal pure returns (int256) {
        uint256 n = i % 32;
        if (n == 0) return 0;
        if (n == 1) return 195;
        if (n == 2) return 383;
        if (n == 3) return 556;
        if (n == 4) return 707;
        if (n == 5) return 831;
        if (n == 6) return 924;
        if (n == 7) return 981;
        if (n == 8) return 1000;
        if (n == 9) return 981;
        if (n == 10) return 924;
        if (n == 11) return 831;
        if (n == 12) return 707;
        if (n == 13) return 556;
        if (n == 14) return 383;
        if (n == 15) return 195;
        if (n == 16) return 0;
        if (n == 17) return -195;
        if (n == 18) return -383;
        if (n == 19) return -556;
        if (n == 20) return -707;
        if (n == 21) return -831;
        if (n == 22) return -924;
        if (n == 23) return -981;
        if (n == 24) return -1000;
        if (n == 25) return -981;
        if (n == 26) return -924;
        if (n == 27) return -831;
        if (n == 28) return -707;
        if (n == 29) return -556;
        if (n == 30) return -383;
        return -195;
    }

    function _coord(int256 value) internal pure returns (string memory) {
        if (value <= 0) return "0";
        if (value >= 512) return "512";
        return _toString(uint256(value));
    }

    function _glyph(uint256 r) internal pure returns (string memory) {
        uint256 n = r % 24;
        if (n < 10) return _toString(n);
        if (n == 10) return "A";
        if (n == 11) return "B";
        if (n == 12) return "C";
        if (n == 13) return "D";
        if (n == 14) return "E";
        if (n == 15) return "F";
        if (n == 16) return "+";
        if (n == 17) return "-";
        if (n == 18) return "*";
        if (n == 19) return "/";
        if (n == 20) return "O";
        if (n == 21) return "S";
        if (n == 22) return "L";
        return "M";
    }

    function _bg(uint256 mood) internal pure returns (string memory) {
        if (mood == 0) return "#071113";
        if (mood == 1) return "#11071a";
        if (mood == 2) return "#120b07";
        if (mood == 3) return "#061018";
        if (mood == 4) return "#130614";
        return "#080c12";
    }

    function _lineageName(uint256 mask) internal pure returns (string memory) {
        if (mask == 1) return "Mechanical";
        if (mask == 2) return "Idol";
        if (mask == 4) return "Citadel";
        if (mask == 8) return "Crystal";
        if (mask == 16) return "Star";
        if (mask == 32) return "Rune";
        if (mask == 63) return "Omega";
        uint256 count = _bitCount(mask);
        if (count == 2) return "Hybrid";
        if (count == 3) return "Chimera";
        if (count > 3) return "Mythic";
        return "Rune";
    }

    function _bitCount(uint256 mask) internal pure returns (uint256 count) {
        for (uint256 i = 0; i < 6; i++) {
            if (mask & (1 << i) != 0) count++;
        }
    }

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }

    function _primaryKind(uint256 mask) internal pure returns (uint256) {
        for (uint256 i = 0; i < 6; i++) {
            if (mask & (1 << i) != 0) return i;
        }
        return 0;
    }

    function _dominantKind(RenderState memory s) internal pure returns (uint256) {
        uint256 count = _bitCount(s.lineageMask);
        if (count <= 1) return _primaryKind(s.lineageMask);
        uint256 pick = uint256(keccak256(abi.encodePacked(s.genome, "dominant", s.fusions, s.scars))) % count;
        for (uint256 i = 0; i < 6; i++) {
            if (s.lineageMask & (1 << i) != 0) {
                if (pick == 0) return i;
                pick--;
            }
        }
        return _primaryKind(s.lineageMask);
    }

    function _color(uint256 mood, uint256 index) internal pure returns (string memory) {
        uint256 n = (mood + index) % 6;
        if (n == 0) return "#f2ffff";
        if (n == 1) return "#38efff";
        if (n == 2) return "#ff4fd8";
        if (n == 3) return "#c6ff43";
        if (n == 4) return "#fff1a8";
        return "#9c7dff";
    }

    function _toString(uint256 value) internal pure returns (string memory) {
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
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }
}

/// @notice A no-owner, non-upgradeable prototype for a permanent on-chain NFT game.
/// @dev This is intentionally dependency-free for the first pass. It is not audited.
contract EternalBeings {
    uint256 public constant MAX_BEINGS = 9999;
    uint256 public constant TOKEN_MAX_SUPPLY = 21_000_000 ether;
    uint256 public constant EMISSION_PER_BLOCK = 26_636_225_266_362_252; // ~0.0266 token/block, ~300 years.
    uint256 public constant BASE_HUNT_RATE = 1e14;

    uint256 public constant EPOCH_BLOCKS = 12;
    uint256 public constant COMMIT_BLOCKS = 4;
    uint256 public constant MINTS_PER_EPOCH = 333;
    uint256 public constant MAX_ENDURANCE = 120;
    uint256 public constant COOLDOWN_BLOCKS = 1;
    uint256 public constant UNKNOWN_HOLD_BLOCKS = 0;
    uint256 public constant CRYPTOPUNK_OBSERVATION_BLOCKS = 32;
    uint256 public constant UNKNOWN_MIN_TOTAL_SUPPLY = 1;
    uint32 public constant UNKNOWN_COLLECTION_DEVOUR_LIMIT = 100;
    uint96 public constant ROYALTY_BPS = 300;
    uint96 public constant BPS_DENOMINATOR = 10_000;
    uint64 private constant MARK_LUCK_MASK = 0x00ffffffffffffff;

    string public constant name = "Eternal Beings";
    string public constant symbol = "BEING";

    uint256 public immutable startBlock;
    uint256 public immutable emissionStartBlock;
    bytes32 public immutable topCollectionsRoot;
    address public immutable royaltyReceiver;
    EternalOre public immutable ore;
    EternalRenderer public immutable renderer;

    uint256 public totalMinted;
    uint256 public aliveSupply;
    uint256 public totalEmitted;

    bool private locked;

    struct Being {
        uint128 mass;
        uint128 complexity;
        uint64 devours;
        uint64 fusions;
        uint64 premiumDevours;
        uint64 markLuck;
        uint64 huntNonce;
        uint32 power;
        uint32 skill;
        uint32 scars;
        uint16 stage;
        uint8 originClass;
        uint8 originSymbol;
        uint8 mutationBias;
        uint8 lineageMask;
        bytes32 genome;
    }

    struct Hunt {
        address owner;
        uint64 startBlock;
        uint64 endurance;
        uint32 difficulty;
        uint16 sceneId;
        uint16 tokenMultiplier;
        uint16 powerRate;
        uint16 skillRate;
        bytes32 seed;
    }

    struct ExternalObservation {
        address owner;
        uint64 blockNumber;
        bytes32 codehash;
    }

    struct CryptoPunkDeposit {
        address owner;
        uint64 blockNumber;
        uint8 tier;
        bytes32 codehash;
    }

    mapping(uint256 => Being) private beings;
    mapping(uint256 => Hunt) public hunts;
    mapping(uint256 => uint256) public cooldownUntil;
    mapping(address => mapping(uint256 => bool)) public devouredExternal;
    mapping(address => uint32) public unknownCollectionDevours;
    mapping(address => mapping(uint256 => ExternalObservation)) public externalObservations;
    mapping(address => mapping(uint256 => CryptoPunkDeposit)) public cryptoPunkDeposits;

    mapping(uint256 => mapping(address => bytes32)) public commitments;
    mapping(uint256 => mapping(address => bool)) public revealed;
    mapping(uint256 => mapping(address => bool)) public claimedEpoch;
    mapping(address => bool) public hasMintedBeing;
    mapping(address => bool) public hasRevealedAny;
    mapping(uint256 => uint32) public revealedCount;
    mapping(uint256 => uint32) public epochClaimLimit;
    mapping(uint256 => uint32) public epochClaimedCount;
    mapping(uint256 => bytes32) public epochSeed;

    mapping(uint256 => address) private owners;
    mapping(address => uint256) private balances;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed spender, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    event Committed(uint256 indexed epoch, address indexed user, bytes32 commitment);
    event Revealed(uint256 indexed epoch, address indexed user);
    event BeingMinted(address indexed user, uint256 indexed tokenId, bytes32 genome);
    event Devoured(uint256 indexed beingId, address indexed nft, uint256 indexed externalTokenId, uint8 tier, bytes32 genome);
    event ExternalObserved(address indexed owner, address indexed nft, uint256 indexed externalTokenId, uint64 readyBlock);
    event CryptoPunkObserved(address indexed owner, address indexed punkContract, uint256 indexed punkId, uint8 tier);
    event Fused(uint256 indexed parentId, uint256 indexed sacrificeId, bytes32 genome);
    event HuntEntered(uint256 indexed tokenId, address indexed owner, uint16 sceneId, uint32 difficulty, uint64 endurance);
    event HuntResolved(uint256 indexed tokenId, address indexed owner, uint256 reward, bool powerUp, bool skillUp);
    event Mutation(uint256 indexed tokenId, uint8 mutationKind, bytes32 genome);
    event MetadataUpdate(uint256 indexed tokenId);

    modifier nonReentrant() {
        require(!locked, "reentrant");
        locked = true;
        _;
        locked = false;
    }

    constructor(bytes32 topCollectionsRoot_, address royaltyReceiver_, address renderer_) {
        require(royaltyReceiver_ != address(0), "zero royalty");
        require(renderer_.code.length != 0, "bad renderer");
        startBlock = block.number;
        emissionStartBlock = block.number;
        topCollectionsRoot = topCollectionsRoot_;
        royaltyReceiver = royaltyReceiver_;
        ore = new EternalOre(address(this));
        renderer = EternalRenderer(renderer_);
    }

    // ----------------------------- Mint: commit / reveal / claim

    function currentEpoch() public view returns (uint256) {
        return (block.number - startBlock) / EPOCH_BLOCKS;
    }

    function epochStart(uint256 epoch) public view returns (uint256) {
        return startBlock + epoch * EPOCH_BLOCKS;
    }

    function commitMint(bytes32 commitment) external {
        uint256 epoch = currentEpoch();
        uint256 start = epochStart(epoch);
        require(block.number >= start && block.number < start + COMMIT_BLOCKS, "commit");
        require(!hasMintedBeing[msg.sender], "minted");
        require(commitment != bytes32(0), "zero");
        require(commitments[epoch][msg.sender] == bytes32(0), "committed");

        commitments[epoch][msg.sender] = commitment;
        emit Committed(epoch, msg.sender, commitment);
    }

    function revealMint(uint256 epoch, bytes32 secret) external {
        uint256 start = epochStart(epoch);
        require(block.number >= start + COMMIT_BLOCKS && block.number < start + EPOCH_BLOCKS, "reveal");
        require(!hasMintedBeing[msg.sender], "minted");
        require(!revealed[epoch][msg.sender], "revealed");

        bytes32 expected = keccak256(abi.encodePacked(msg.sender, epoch, secret));
        require(commitments[epoch][msg.sender] == expected, "bad secret");

        revealed[epoch][msg.sender] = true;
        hasRevealedAny[msg.sender] = true;
        revealedCount[epoch] += 1;
        epochSeed[epoch] = keccak256(abi.encodePacked(epochSeed[epoch], msg.sender, secret));

        emit Revealed(epoch, msg.sender);
    }

    function claimMint(uint256 epoch) external nonReentrant {
        require(block.number >= epochStart(epoch) + EPOCH_BLOCKS, "claim");
        require(totalMinted < MAX_BEINGS, "sold out");
        require(revealed[epoch][msg.sender], "not revealed");
        require(!claimedEpoch[epoch][msg.sender], "claimed");
        require(!hasMintedBeing[msg.sender], "minted");

        uint256 released = releasedMintCap(epoch);
        require(totalMinted < released, "quota");
        if (epochClaimLimit[epoch] == 0) {
            uint256 available = released - totalMinted;
            uint256 limit = revealedCount[epoch] < available ? revealedCount[epoch] : available;
            require(limit > 0, "quota");
            epochClaimLimit[epoch] = uint32(limit);
        }

        require(epochClaimedCount[epoch] < epochClaimLimit[epoch], "filled");

        if (revealedCount[epoch] > epochClaimLimit[epoch]) {
            bytes32 draw = keccak256(abi.encodePacked(epochSeed[epoch], msg.sender, epoch));
            uint256 chance = (uint256(epochClaimLimit[epoch]) * 1_000_000) / revealedCount[epoch];
            require(uint256(draw) % 1_000_000 < chance, "not winner");
        }

        claimedEpoch[epoch][msg.sender] = true;
        hasMintedBeing[msg.sender] = true;
        epochClaimedCount[epoch] += 1;

        uint256 tokenId = ++totalMinted;
        aliveSupply += 1;
        _mintBeing(msg.sender, tokenId);

        bytes32 genome = keccak256(abi.encodePacked(epochSeed[epoch], msg.sender, tokenId));
        beings[tokenId] = _initialBeing(genome);

        emit BeingMinted(msg.sender, tokenId, genome);
        emit MetadataUpdate(tokenId);
    }

    function releasedMintCap(uint256 epoch) public pure returns (uint256) {
        uint256 cap = (epoch + 1) * MINTS_PER_EPOCH;
        return cap > MAX_BEINGS ? MAX_BEINGS : cap;
    }

    // ----------------------------- Evolution

    function observeExternal(address nft, uint256 externalTokenId) external {
        require(nft != address(this), "use fuse");
        require(nft.code.length > 0, "not contract");
        require(_supportsERC721(nft), "not erc721");
        require(_totalSupplyOf(nft) >= UNKNOWN_MIN_TOTAL_SUPPLY, "supply too low");
        require(IERC721Like(nft).ownerOf(externalTokenId) == msg.sender, "ext owner");

        externalObservations[nft][externalTokenId] = ExternalObservation({
            owner: msg.sender,
            blockNumber: uint64(block.number),
            codehash: nft.codehash
        });

        emit ExternalObserved(msg.sender, nft, externalTokenId, uint64(block.number + UNKNOWN_HOLD_BLOCKS));
    }

    function devourExternal(uint256 beingId, address nft, uint256 externalTokenId) external nonReentrant {
        _devourExternal(beingId, nft, externalTokenId, 0);
    }

    function devourTieredExternal(
        uint256 beingId,
        address nft,
        uint256 externalTokenId,
        uint8 tier,
        bytes32[] calldata proof
    ) external nonReentrant {
        require(tier > 0 && tier <= 5, "bad tier");
        require(verifyCollectionTier(nft, tier, proof), "bad proof");
        _devourExternal(beingId, nft, externalTokenId, tier);
    }

    function observeCryptoPunk(address punkContract, uint256 punkId, uint8 tier, bytes32[] calldata proof) external {
        require(tier > 0 && tier <= 5, "bad tier");
        require(punkContract.code.length > 0, "not contract");
        require(verifyCollectionTier(punkContract, tier, proof), "bad proof");
        require(!devouredExternal[punkContract][punkId], "devoured");
        require(ICryptoPunksLike(punkContract).punkIndexToAddress(punkId) == msg.sender, "not punk owner");

        cryptoPunkDeposits[punkContract][punkId] = CryptoPunkDeposit({
            owner: msg.sender,
            blockNumber: uint64(block.number),
            tier: tier,
            codehash: punkContract.codehash
        });

        emit CryptoPunkObserved(msg.sender, punkContract, punkId, tier);
    }

    function devourCryptoPunk(uint256 beingId, address punkContract, uint256 punkId) external nonReentrant {
        CryptoPunkDeposit memory deposit = cryptoPunkDeposits[punkContract][punkId];
        require(deposit.owner == msg.sender, "not observed");
        require(block.number <= uint256(deposit.blockNumber) + CRYPTOPUNK_OBSERVATION_BLOCKS, "obs expired");
        require(deposit.codehash == punkContract.codehash, "code changed");
        require(ownerOf(beingId) == msg.sender, "not owner");
        require(hunts[beingId].owner == address(0), "hunting");
        require(!devouredExternal[punkContract][punkId], "devoured");
        require(ICryptoPunksLike(punkContract).punkIndexToAddress(punkId) == address(this), "punk not locked");

        delete cryptoPunkDeposits[punkContract][punkId];
        devouredExternal[punkContract][punkId] = true;

        _absorbExternal(beingId, punkContract, punkId, deposit.tier);
    }

    function _devourExternal(uint256 beingId, address nft, uint256 externalTokenId, uint8 tier) internal {
        require(nft != address(this), "use fuse");
        require(nft.code.length > 0, "not contract");
        require(!devouredExternal[nft][externalTokenId], "devoured");
        require(ownerOf(beingId) == msg.sender, "not owner");
        require(hunts[beingId].owner == address(0), "hunting");
        require(IERC721Like(nft).ownerOf(externalTokenId) == msg.sender, "ext owner");

        if (tier == 0) {
            _validateUnknownExternal(nft, externalTokenId);
            delete externalObservations[nft][externalTokenId];
            unknownCollectionDevours[nft] += 1;
        }

        IERC721Like(nft).transferFrom(msg.sender, address(this), externalTokenId);
        require(IERC721Like(nft).ownerOf(externalTokenId) == address(this), "devour failed");
        devouredExternal[nft][externalTokenId] = true;

        _absorbExternal(beingId, nft, externalTokenId, tier);
    }

    function _absorbExternal(uint256 beingId, address nft, uint256 externalTokenId, uint8 tier) internal {
        _consumeEvolution(beingId);

        Being storage b = beings[beingId];
        (uint32 nutrition, uint32 complexityGain) = nutritionForTier(tier);

        bytes32 gene = keccak256(abi.encodePacked(b.genome, nft, externalTokenId, nft.codehash, b.devours, tier));
        b.devours = _sat64(b.devours, 1);
        if (tier > 0) b.premiumDevours = _sat64(b.premiumDevours, 1);
        b.markLuck = _upgradeMarks(b.markLuck, gene, tier, false, b.devours);
        b.mass = _sat128(b.mass, nutrition);
        b.complexity = _sat128(b.complexity, complexityGain);
        if (tier > 0) {
            b.power = _sat32(b.power, tier);
            b.skill = _sat32(b.skill, tier / 2);
        }
        b.genome = keccak256(abi.encodePacked(b.genome, gene, b.mass, b.complexity));
        b.lineageMask |= _lineageGain(gene, tier, false);
        b.stage = _stageOf(b.complexity);

        _maybeMutation(beingId, b, gene, tier, false);

        emit Devoured(beingId, nft, externalTokenId, tier, b.genome);
        emit MetadataUpdate(beingId);
    }

    function fuseBeing(uint256 parentId, uint256 sacrificeId) external nonReentrant {
        require(parentId != sacrificeId, "same id");
        require(ownerOf(parentId) == msg.sender, "not parent owner");
        require(ownerOf(sacrificeId) == msg.sender, "not sacrifice owner");
        require(hunts[parentId].owner == address(0), "parent hunting");
        require(hunts[sacrificeId].owner == address(0), "sacrifice hunting");

        Being memory s = beings[sacrificeId];
        Being storage p = beings[parentId];
        bytes32 gene = keccak256(abi.encodePacked(p.genome, s.genome, parentId, sacrificeId, p.fusions, s.fusions));

        _consumeEvolution(parentId);
        _consumeEvolution(sacrificeId);

        p.mass = _sat128(p.mass, s.mass);
        p.complexity = _sat128(p.complexity, (uint256(s.complexity) * 70) / 100 + 1);
        p.devours = _sat64(p.devours, uint256(s.devours) + 1);
        p.fusions = _sat64(p.fusions, uint256(s.fusions) + 1);
        p.premiumDevours = _sat64(p.premiumDevours, s.premiumDevours);
        p.markLuck = _mergeMarks(p.markLuck, s.markLuck);
        p.markLuck = _upgradeMarks(p.markLuck, gene, 5, true, p.devours);
        p.power = _sat32(p.power, uint256(1) + s.power / 2);
        p.skill = _sat32(p.skill, uint256(1) + s.skill / 2);
        p.lineageMask |= s.lineageMask;
        p.genome = keccak256(abi.encodePacked(p.genome, s.genome, gene));
        p.stage = _stageOf(p.complexity);

        _burnBeing(sacrificeId);
        delete beings[sacrificeId];
        aliveSupply -= 1;

        _maybeMutation(parentId, p, gene, 5, true);

        emit Fused(parentId, sacrificeId, p.genome);
        emit MetadataUpdate(parentId);
    }

    // ----------------------------- Hunt

    function enterHunt(uint256 tokenId) external nonReentrant {
        require(ownerOf(tokenId) == msg.sender, "not owner");
        require(hunts[tokenId].owner == address(0), "already hunting");
        require(block.number >= cooldownUntil[tokenId], "cooldown");

        Being storage b = beings[tokenId];
        b.huntNonce += 1;

        bytes32 seed = keccak256(
            abi.encodePacked(tokenId, b.genome, msg.sender, block.number, block.basefee, block.prevrandao, b.huntNonce)
        );

        Scene memory scene = _scene(seed);
        uint256 score = _score(b);
        uint256 endurance = 20 + (score * score) / scene.difficulty;
        if (endurance > MAX_ENDURANCE) endurance = MAX_ENDURANCE;

        hunts[tokenId] = Hunt({
            owner: msg.sender,
            startBlock: uint64(block.number),
            endurance: uint64(endurance),
            difficulty: scene.difficulty,
            sceneId: scene.sceneId,
            tokenMultiplier: scene.tokenMultiplier,
            powerRate: scene.powerRate,
            skillRate: scene.skillRate,
            seed: seed
        });

        _transferBeing(msg.sender, address(this), tokenId);
        emit HuntEntered(tokenId, msg.sender, scene.sceneId, scene.difficulty, uint64(endurance));
    }

    function resolveHunt(uint256 tokenId) external nonReentrant {
        Hunt memory h = hunts[tokenId];
        require(h.owner == msg.sender, "not hunter");
        require(block.number > h.startBlock);

        delete hunts[tokenId];
        cooldownUntil[tokenId] = block.number + COOLDOWN_BLOCKS;

        Being storage b = beings[tokenId];
        uint256 elapsed = block.number - h.startBlock;
        uint256 activeBlocks = elapsed > h.endurance ? h.endurance : elapsed;
        uint256 score = _score(b);

        uint256 reward = 0;
        if (activeBlocks > 0 && h.difficulty > 0) {
            reward = (activeBlocks * score * BASE_HUNT_RATE) / h.difficulty;
            reward = (reward * h.tokenMultiplier) / 10_000;
            reward = _capReward(reward);
        }

        if (reward > 0) {
            totalEmitted += reward;
            _mintOre(msg.sender, reward);
        }

        bytes32 rollSeed = keccak256(abi.encodePacked(h.seed, block.number, b.genome, activeBlocks));
        bool powerUp = _tryStatGrowth(b.power, h.powerRate, activeBlocks, score, h.difficulty, rollSeed);
        bool skillUp = _tryStatGrowth(b.skill, h.skillRate, activeBlocks, score, h.difficulty, keccak256(abi.encodePacked(rollSeed, "skill")));

        if (powerUp) b.power = _sat32(b.power, 1);
        if (skillUp) b.skill = _sat32(b.skill, 1);

        if ((uint256(keccak256(abi.encodePacked(rollSeed, "scar"))) % 1_000_000) < h.powerRate + h.skillRate) {
            b.scars = _sat32(b.scars, 1);
        }

        b.genome = keccak256(abi.encodePacked(b.genome, h.seed, reward, powerUp, skillUp, b.scars));
        b.stage = _stageOf(uint256(b.complexity) + b.scars);

        _transferBeing(address(this), msg.sender, tokenId);
        emit HuntResolved(tokenId, msg.sender, reward, powerUp, skillUp);
        emit MetadataUpdate(tokenId);
    }

    // ----------------------------- Emission

    function emittedCap() public view returns (uint256) {
        uint256 blocksPassed = block.number - emissionStartBlock;
        uint256 cap = blocksPassed * EMISSION_PER_BLOCK;
        return cap > TOKEN_MAX_SUPPLY ? TOKEN_MAX_SUPPLY : cap;
    }

    function availableEmission() public view returns (uint256) {
        uint256 cap = emittedCap();
        return cap > totalEmitted ? cap - totalEmitted : 0;
    }

    function _capReward(uint256 reward) internal view returns (uint256) {
        uint256 available = availableEmission();
        return reward > available ? available : reward;
    }

    // ----------------------------- Views

    function getBeing(uint256 tokenId) external view returns (Being memory) {
        require(_exists(tokenId), "not exist");
        return beings[tokenId];
    }

    function ownerOf(uint256 tokenId) public view returns (address) {
        address owner = owners[tokenId];
        require(owner != address(0), "not exist");
        return owner;
    }

    function balanceOf(address owner) public view returns (uint256) {
        require(owner != address(0), "zero owner");
        return balances[owner];
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        require(_exists(tokenId), "not exist");
        Being memory b = beings[tokenId];
        return renderer.tokenURI(
            tokenId,
            b.mass,
            b.complexity,
            b.devours,
            b.fusions,
            b.premiumDevours,
            b.markLuck,
            b.power,
            b.skill,
            b.scars,
            b.stage,
            b.lineageMask,
            b.genome
        );
    }

    function royaltyInfo(uint256, uint256 salePrice) external view returns (address receiver, uint256 royaltyAmount) {
        return (royaltyReceiver, (salePrice * ROYALTY_BPS) / BPS_DENOMINATOR);
    }

    // ----------------------------- ERC721

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x80ac58cd || interfaceId == 0x5b5e139f
            || interfaceId == 0x2a55205a || interfaceId == 0x49064906;
    }

    function approve(address spender, uint256 tokenId) external {
        require(!locked, "reentrant");
        address owner = ownerOf(tokenId);
        require(msg.sender == owner || isApprovedForAll[owner][msg.sender], "not approved");
        getApproved[tokenId] = spender;
        emit Approval(owner, spender, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        require(!locked, "reentrant");
        isApprovedForAll[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        require(!locked, "reentrant");
        require(_isApprovedOrOwner(msg.sender, tokenId), "not approved");
        require(hunts[tokenId].owner == address(0), "hunting");
        _transferBeing(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        _safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes calldata data) external {
        _safeTransferFrom(from, to, tokenId, data);
    }

    function _safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) internal {
        transferFrom(from, to, tokenId);
        if (to.code.length > 0) {
            require(
                IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data)
                    == IERC721Receiver.onERC721Received.selector,
                "unsafe receiver"
            );
        }
    }

    function _mintBeing(address to, uint256 tokenId) internal {
        require(to != address(0), "zero to");
        require(owners[tokenId] == address(0), "exists");
        owners[tokenId] = to;
        balances[to] += 1;
        emit Transfer(address(0), to, tokenId);
    }

    function _burnBeing(uint256 tokenId) internal {
        address owner = ownerOf(tokenId);
        balances[owner] -= 1;
        delete owners[tokenId];
        delete getApproved[tokenId];
        emit Transfer(owner, address(0), tokenId);
    }

    function _transferBeing(address from, address to, uint256 tokenId) internal {
        require(to != address(0), "zero to");
        require(ownerOf(tokenId) == from, "wrong from");
        balances[from] -= 1;
        balances[to] += 1;
        owners[tokenId] = to;
        delete getApproved[tokenId];
        emit Transfer(from, to, tokenId);
    }

    function _isApprovedOrOwner(address spender, uint256 tokenId) internal view returns (bool) {
        address owner = ownerOf(tokenId);
        return spender == owner || getApproved[tokenId] == spender || isApprovedForAll[owner][spender];
    }

    function _exists(uint256 tokenId) internal view returns (bool) {
        return owners[tokenId] != address(0);
    }

    function _mintOre(address to, uint256 amount) internal {
        ore.mint(to, amount);
    }

    // ----------------------------- Rules

    function _consumeEvolution(uint256 tokenId) internal {
        require(block.number >= cooldownUntil[tokenId], "evo");
        cooldownUntil[tokenId] = block.number + 1;
    }

    struct Scene {
        uint16 sceneId;
        uint32 difficulty;
        uint16 tokenMultiplier;
        uint16 powerRate;
        uint16 skillRate;
    }

    function _scene(bytes32 seed) internal pure returns (Scene memory) {
        uint256 roll = uint256(seed) % 10_000;
        if (roll < 4000) return Scene(0, 800, 10_000, 1, 1);
        if (roll < 7000) return Scene(1, 1200, 8000, 5, 5);
        if (roll < 8800) return Scene(2, 2500, 5000, 30, 10);
        if (roll < 9700) return Scene(3, 6000, 2000, 200, 100);
        return Scene(4, 12000, 500, 800, 800);
    }

    function collectionTier(address nft) public pure returns (uint8) {
        // Tiered collections are verified with `verifyCollectionTier`.
        // Unknown collections are tier 0 and still playable through `devourExternal`.
        nft;
        return 0;
    }

    function verifyCollectionTier(address nft, uint8 tier, bytes32[] calldata proof) public view returns (bool) {
        if (topCollectionsRoot == bytes32(0)) return false;
        bytes32 leaf = keccak256(abi.encodePacked(nft, tier));
        return _verifyProof(proof, topCollectionsRoot, leaf);
    }

    function _validateUnknownExternal(address nft, uint256 externalTokenId) internal view {
        require(_supportsERC721(nft), "not erc721");
        require(_totalSupplyOf(nft) >= UNKNOWN_MIN_TOTAL_SUPPLY, "supply too low");
        require(unknownCollectionDevours[nft] < UNKNOWN_COLLECTION_DEVOUR_LIMIT, "collection filled");

        ExternalObservation memory observation = externalObservations[nft][externalTokenId];
        require(observation.owner == msg.sender, "not observed");
        require(observation.codehash == nft.codehash, "code changed");
        require(block.number >= uint256(observation.blockNumber) + UNKNOWN_HOLD_BLOCKS, "hold more");
    }

    function _supportsERC721(address nft) internal view returns (bool) {
        try IERC165Like(nft).supportsInterface(0x80ac58cd) returns (bool supported) {
            return supported;
        } catch {
            return false;
        }
    }

    function _totalSupplyOf(address nft) internal view returns (uint256) {
        try IERC721SupplyLike(nft).totalSupply() returns (uint256 supply) {
            return supply;
        } catch {
            return 0;
        }
    }

    function _verifyProof(bytes32[] calldata proof, bytes32 root, bytes32 leaf) internal pure returns (bool) {
        bytes32 computed = leaf;
        for (uint256 i = 0; i < proof.length; i++) {
            bytes32 proofElement = proof[i];
            computed = computed <= proofElement
                ? keccak256(abi.encodePacked(computed, proofElement))
                : keccak256(abi.encodePacked(proofElement, computed));
        }
        return computed == root;
    }

    function nutritionForTier(uint8 tier) public pure returns (uint32 nutrition, uint32 complexityGain) {
        if (tier == 0) return (1, 1);
        if (tier == 1) return (3, 3);
        if (tier == 2) return (6, 12);
        if (tier == 3) return (10, 25);
        if (tier == 4) return (25, 60);
        return (100, 200);
    }

    function _sat128(uint128 current, uint256 addend) internal pure returns (uint128) {
        uint256 next = uint256(current) + addend;
        if (next > type(uint128).max) return type(uint128).max;
        return uint128(next);
    }

    function _sat64(uint64 current, uint256 addend) internal pure returns (uint64) {
        uint256 next = uint256(current) + addend;
        if (next > type(uint64).max) return type(uint64).max;
        return uint64(next);
    }

    function _sat32(uint32 current, uint256 addend) internal pure returns (uint32) {
        uint256 next = uint256(current) + addend;
        if (next > type(uint32).max) return type(uint32).max;
        return uint32(next);
    }

    function _markLuckForTier(uint8 tier) internal pure returns (uint64) {
        if (tier == 0) return 0;
        if (tier == 1) return 50;
        if (tier == 2) return 100;
        if (tier == 3) return 500;
        if (tier == 4) return 10_000;
        return 100_000;
    }

    function _mergeMarks(uint64 a, uint64 b) internal pure returns (uint64) {
        return (((a & MARK_LUCK_MASK) + (b & MARK_LUCK_MASK)) & MARK_LUCK_MASK) | ((a | b) & 0xff00000000000000);
    }

    function _upgradeMarks(
        uint64 packed,
        bytes32 gene,
        uint8 tier,
        bool fusion,
        uint64 devours
    ) internal pure returns (uint64) {
        uint64 luck = (packed & MARK_LUCK_MASK) + (fusion ? uint64(50) : _markLuckForTier(tier));
        uint64 glyph = uint64((packed >> 56) & 15);
        uint64 border = uint64(packed >> 60);
        uint256 baseChance = 27 + uint256(devours) * 10 + uint256(luck);
        uint256 roll = uint256(keccak256(abi.encodePacked(gene, packed, tier, fusion))) % 100_000;

        if (roll < baseChance) {
            uint64 nextGlyph = glyph == 0 ? 1 : roll < baseChance / 16 ? 4 : roll < baseChance / 4 ? 3 : roll < baseChance / 2 ? 2 : 1;
            if (nextGlyph > glyph) glyph = nextGlyph;
        }

        uint256 borderChance = 18 + uint256(devours / 53) + uint256(luck);
        roll = (roll + (uint256(gene) >> 128)) % 100_000;
        if (roll < borderChance) {
            uint64 nextBorder = roll < borderChance / 16 ? 4 : roll < borderChance / 4 ? 3 : roll < borderChance / 2 ? 2 : 1;
            if (nextBorder > border) border = nextBorder;
        }

        return (luck & MARK_LUCK_MASK) | (glyph << 56) | (border << 60);
    }

    function _initialBeing(bytes32 genome) internal pure returns (Being memory b) {
        uint256 g = uint256(genome);
        b.mass = 1;
        b.complexity = uint128(1 + (g % 9));
        b.power = uint32(1 + ((g >> 8) % 10));
        b.skill = uint32(1 + ((g >> 16) % 10));
        b.stage = _stageOf(b.complexity);
        b.originClass = uint8((g >> 24) % 10);
        b.originSymbol = uint8((g >> 32) % 36);
        b.mutationBias = uint8((g >> 40) % 10);
        b.lineageMask = uint8(1 << ((g >> 48) % 6));
        b.genome = genome;
    }

    function _maybeMutation(uint256 tokenId, Being storage b, bytes32 gene, uint8 tier, bool fusion) internal {
        uint256 roll = uint256(keccak256(abi.encodePacked(gene, b.genome, tokenId))) % 1_000_000;
        uint256 minor = fusion ? 200_000 : tier == 0 ? 1_000 : uint256(tier) * 50_000;
        uint256 major = fusion ? 30_000 : tier == 0 ? 100 : uint256(tier) * 10_000;
        uint256 mythic = fusion ? 1_000 : tier == 0 ? 1 : uint256(tier) * 100;

        if (roll < mythic) {
            b.skill = _sat32(b.skill, 3);
            b.power = _sat32(b.power, 3);
            b.mutationBias = uint8((uint256(gene) >> 8) % 10);
            b.lineageMask |= _lineageGain(gene, tier, true);
            b.genome = keccak256(abi.encodePacked(b.genome, "MYTHIC", gene));
            emit Mutation(tokenId, 3, b.genome);
        } else if (roll < mythic + major) {
            b.skill = _sat32(b.skill, 1);
            b.power = _sat32(b.power, 2);
            b.lineageMask |= _lineageGain(gene, tier, true);
            b.genome = keccak256(abi.encodePacked(b.genome, "MAJOR", gene));
            emit Mutation(tokenId, 2, b.genome);
        } else if (roll < mythic + major + minor) {
            b.skill = _sat32(b.skill, 1);
            if (fusion) b.lineageMask |= _lineageGain(gene, tier, true);
            b.genome = keccak256(abi.encodePacked(b.genome, "MINOR", gene));
            emit Mutation(tokenId, 1, b.genome);
        }
    }

    function _lineageGain(bytes32 gene, uint8 tier, bool mutation) internal pure returns (uint8) {
        uint256 g = uint256(gene);
        if (mutation) return uint8(1 << ((g >> 80) % 6));
        if (tier == 0) return 0;
        uint256 threshold = uint256(tier) * 9;
        if ((g % 100) >= threshold) return 0;
        return uint8(1 << ((g >> 88) % 6));
    }

    function _tryStatGrowth(
        uint32 current,
        uint16 rate,
        uint256 activeBlocks,
        uint256 score,
        uint256 difficulty,
        bytes32 seed
    ) internal pure returns (bool) {
        if (activeBlocks == 0 || difficulty == 0 || rate == 0) return false;
        uint256 rawChance = (uint256(rate) * activeBlocks * score) / difficulty;
        uint256 finalChance = (rawChance * 1000) / (1000 + uint256(current));
        if (finalChance > 100_000) finalChance = 100_000;
        return uint256(seed) % 1_000_000 < finalChance;
    }

    function _score(Being memory b) internal pure returns (uint256) {
        uint256 value = _sqrt(uint256(b.power)) * 8 + _sqrt(uint256(b.skill)) * 5
            + _sqrt(uint256(b.complexity)) / 2 + _sqrt(uint256(b.mass));
        return _sqrt(value == 0 ? 1 : value);
    }

    function _stageOf(uint256 complexity) internal pure returns (uint16) {
        uint16 stage = 0;
        uint256 x = complexity;
        while (x > 1 && stage < 20) {
            x >>= 1;
            stage++;
        }
        return stage;
    }

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }

}
