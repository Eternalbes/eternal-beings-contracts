// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {StockWorldTypes} from "./StockWorldTypes.sol";
import {StockWorldBase64} from "./libraries/StockWorldBase64.sol";

/**
 * @title StockWorldRenderer
 * @notice Shared, fully on-chain renderer for every Stock World collection.
 * @dev A World seed controls its visual language while each Being genome and
 *      Fusion history produce a distinct, deterministic member of that family.
 */
contract StockWorldRenderer {
    function tokenURI(
        string calldata collectionName,
        uint256 tokenId,
        uint128 weight,
        uint64 fusionCount,
        bytes32 genome,
        StockWorldTypes.VisualSeed calldata seed
    ) external pure returns (string memory) {
        string memory id = _toString(tokenId);
        string memory svg = _renderSVG(tokenId, weight, fusionCount, genome, seed);
        string memory json = string.concat(
            "{\"name\":\"",
            collectionName,
            " #",
            id,
            "\",\"description\":\"A deterministic evolving position from an immutable Stock World visual seed.\",",
            "\"image\":\"data:image/svg+xml;base64,",
            StockWorldBase64.encode(bytes(svg)),
            "\",\"attributes\":[{\"trait_type\":\"Weight\",\"value\":",
            _toString(weight),
            "},{\"trait_type\":\"Fusion Count\",\"value\":",
            _toString(fusionCount),
            "},{\"trait_type\":\"Render Mode\",\"value\":",
            _toString(seed.renderMode),
            "}]}"
        );
        return string.concat("data:application/json;base64,", StockWorldBase64.encode(bytes(json)));
    }

    function renderSVG(
        uint256 tokenId,
        uint128 weight,
        uint64 fusionCount,
        bytes32 genome,
        StockWorldTypes.VisualSeed calldata seed
    ) external pure returns (string memory) {
        return _renderSVG(tokenId, weight, fusionCount, genome, seed);
    }

    function _renderSVG(
        uint256 tokenId,
        uint128 weight,
        uint64 fusionCount,
        bytes32 genome,
        StockWorldTypes.VisualSeed calldata seed
    ) private pure returns (string memory) {
        bytes32 tokenSeed = keccak256(abi.encode(seed.imageHash, seed.vectorHash, seed.styleHash, genome, tokenId));
        string memory primary = _brightColor(seed.paletteHash, 3);
        string memory secondary = _brightColor(seed.paletteHash, 6);
        string memory genomeColor = _brightColor(tokenSeed, 0);
        string memory background = _darkColor(seed.paletteHash);
        string memory silhouette = _silhouette(seed.vectorHash, tokenSeed, fusionCount);
        string memory details = _details(seed.styleHash, tokenSeed, fusionCount, primary, secondary);
        string memory orbits = _orbits(tokenSeed, fusionCount, primary, genomeColor);
        string memory animation = fusionCount >= 8 && uint8(tokenSeed[31]) < 64
            ? "<animateTransform attributeName='transform' type='rotate' from='0 256 242' to='360 256 242' dur='24s' repeatCount='indefinite'/>"
            : "";

        return string.concat(
            "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 512 512'>",
            "<rect width='512' height='512' fill='",
            background,
            "'/><rect x='18' y='18' width='476' height='476' rx='6' fill='none' stroke='",
            secondary,
            "' stroke-opacity='.55'/><g fill='none' stroke-linecap='round' stroke-linejoin='round'>",
            "<g opacity='.38'>",
            orbits,
            animation,
            "</g><path d='",
            silhouette,
            "' fill='",
            primary,
            "' fill-opacity='.08' stroke='",
            primary,
            "' stroke-width='4'/>",
            details,
            "<circle cx='256' cy='242' r='",
            _toString(8 + _min(22, _log2(uint256(weight) + 1) * 2)),
            "' fill='",
            genomeColor,
            "' fill-opacity='.2' stroke='",
            genomeColor,
            "' stroke-width='3'/></g><text x='256' y='470' fill='",
            secondary,
            "' font-family='monospace' font-size='18' text-anchor='middle'>WORLD BEING #",
            _toString(tokenId),
            "</text></svg>"
        );
    }

    function _silhouette(bytes32 vectorHash, bytes32 tokenSeed, uint64 fusionCount)
        private
        pure
        returns (string memory path)
    {
        path = "M256 72";
        uint256 spread = 5 + _min(8, _log2(uint256(fusionCount) + 1));
        for (uint256 i = 0; i < 16; i++) {
            uint8 packed = uint8(vectorHash[i]);
            uint256 left = uint256(packed >> 4);
            uint256 jitter = uint8(tokenSeed[i]) % (spread * 2 + 1);
            uint256 x = 92 + left * 7 + jitter;
            uint256 y = 94 + i * 19;
            path = string.concat(path, " L", _toString(x), " ", _toString(y));
        }
        path = string.concat(path, " L256 424");
        for (uint256 reverse = 16; reverse > 0; reverse--) {
            uint256 i = reverse - 1;
            uint8 packed = uint8(vectorHash[i]);
            uint256 right = uint256(packed & 0x0f);
            uint256 jitter = uint8(tokenSeed[31 - i]) % (spread * 2 + 1);
            uint256 x = 420 - right * 7 - jitter;
            uint256 y = 94 + i * 19;
            path = string.concat(path, " L", _toString(x), " ", _toString(y));
        }
        return string.concat(path, " Z");
    }

    function _details(
        bytes32 styleHash,
        bytes32 tokenSeed,
        uint64 fusionCount,
        string memory primary,
        string memory secondary
    ) private pure returns (string memory output) {
        uint256 count = 2 + _min(10, _log2(uint256(fusionCount) + 1) * 2);
        for (uint256 i = 0; i < count; i++) {
            uint8 a = uint8(styleHash[(i * 2) % 32]);
            uint8 b = uint8(styleHash[(i * 2 + 1) % 32]);
            uint256 x1 = 96 + uint256(a >> 4) * 20 + uint8(tokenSeed[i]) % 9;
            uint256 y1 = 92 + uint256(a & 0x0f) * 20;
            uint256 x2 = 96 + uint256(b >> 4) * 20 + uint8(tokenSeed[31 - i]) % 9;
            uint256 y2 = 92 + uint256(b & 0x0f) * 20;
            output = string.concat(
                output,
                "<path d='M",
                _toString(x1),
                " ",
                _toString(y1),
                " Q256 ",
                _toString(170 + uint256(uint8(tokenSeed[i + 8]) % 145)),
                " ",
                _toString(x2),
                " ",
                _toString(y2),
                "' stroke='",
                i % 2 == 0 ? primary : secondary,
                "' stroke-opacity='.72' stroke-width='",
                _toString(1 + (uint8(tokenSeed[i + 16]) % 3)),
                "'/>"
            );
        }
    }

    function _orbits(bytes32 tokenSeed, uint64 fusionCount, string memory primary, string memory accent)
        private
        pure
        returns (string memory output)
    {
        uint256 count = 1 + _min(4, _log2(uint256(fusionCount) + 1));
        for (uint256 i = 0; i < count; i++) {
            uint256 rx = 88 + i * 30 + uint8(tokenSeed[i]) % 20;
            uint256 ry = 42 + i * 18 + uint8(tokenSeed[i + 4]) % 14;
            output = string.concat(
                output,
                "<ellipse cx='256' cy='242' rx='",
                _toString(rx),
                "' ry='",
                _toString(ry),
                "' transform='rotate(",
                _toString(uint8(tokenSeed[i + 12]) % 180),
                " 256 242)' stroke='",
                i % 2 == 0 ? primary : accent,
                "'/><circle cx='",
                _toString(256 + rx / 2),
                "' cy='",
                _toString(242 - ry / 2),
                "' r='",
                _toString(2 + i),
                "' fill='",
                accent,
                "' stroke='none'/>"
            );
        }
    }

    function _brightColor(bytes32 source, uint256 offset) private pure returns (string memory) {
        return _color(
            80 + uint8(source[offset % 32]) % 176,
            80 + uint8(source[(offset + 1) % 32]) % 176,
            80 + uint8(source[(offset + 2) % 32]) % 176
        );
    }

    function _darkColor(bytes32 source) private pure returns (string memory) {
        return _color(uint8(source[0]) % 24, uint8(source[1]) % 24, uint8(source[2]) % 24);
    }

    function _color(uint8 red, uint8 green, uint8 blue) private pure returns (string memory) {
        bytes memory out = new bytes(7);
        bytes16 symbols = "0123456789abcdef";
        out[0] = "#";
        out[1] = symbols[red >> 4];
        out[2] = symbols[red & 0x0f];
        out[3] = symbols[green >> 4];
        out[4] = symbols[green & 0x0f];
        out[5] = symbols[blue >> 4];
        out[6] = symbols[blue & 0x0f];
        return string(out);
    }

    function _log2(uint256 value) private pure returns (uint256 result) {
        while (value > 1) {
            value >>= 1;
            result++;
        }
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
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
