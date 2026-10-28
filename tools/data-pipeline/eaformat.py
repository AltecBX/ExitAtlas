"""Binary writers for ExitAtlas bundled datasets.

All files are little-endian and start with a common header:
    magic (4 ASCII bytes) | u32 format version | u32 metadata length | metadata JSON (UTF-8)

The Swift reader lives in Sources/ExitAtlasCore/Data/BinaryDatasetReader.swift.
Coordinates are stored as Int32 degrees * 1e7 (about 1 cm resolution).
"""
import json
import struct

NONE32 = 0xFFFFFFFF
NONE16 = 0xFFFF
E7 = 10_000_000


def e7(value):
    return int(round(value * E7))


class StringTable:
    """Deduplicated UTF-8 string table referenced by u32 index."""

    def __init__(self):
        self._index = {}
        self._strings = []

    def ref(self, value):
        if value is None or value == "":
            return NONE32
        if value not in self._index:
            self._index[value] = len(self._strings)
            self._strings.append(value)
        return self._index[value]

    def encode(self):
        blobs = [s.encode("utf-8") for s in self._strings]
        offsets = [0]
        for b in blobs:
            offsets.append(offsets[-1] + len(b))
        out = bytearray()
        out += struct.pack("<II", len(blobs), offsets[-1])
        out += struct.pack("<%dI" % len(offsets), *offsets)
        out += b"".join(blobs)
        return bytes(out)


def header(magic, version, metadata):
    assert len(magic) == 4
    meta = json.dumps(metadata, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return magic.encode("ascii") + struct.pack("<II", version, len(meta)) + meta


def str8(value):
    b = value.encode("utf-8")
    assert len(b) < 256
    return struct.pack("<B", len(b)) + b


def str16(value):
    b = value.encode("utf-8")
    assert len(b) < 65536
    return struct.pack("<H", len(b)) + b


def ring_bytes(ring):
    """ring: list of (lon, lat). Stored as (lat, lon) e7 pairs."""
    out = bytearray(struct.pack("<I", len(ring)))
    for lon, lat in ring:
        out += struct.pack("<ii", e7(lat), e7(lon))
    return bytes(out)


def read_header(data):
    magic = data[:4].decode("ascii")
    version, meta_len = struct.unpack_from("<II", data, 4)
    meta = json.loads(data[12:12 + meta_len])
    return magic, version, meta, 12 + meta_len


def read_eax_exit_node_ids(path):
    """Return the OSM node ids of all exits in an EAX1 file (used for test oracles)."""
    data = open(path, "rb").read()
    magic, _, _, off = read_header(data)
    assert magic == "EAX1", magic
    count, total = struct.unpack_from("<II", data, off)
    off += 8 + 4 * (count + 1) + total
    (exits,) = struct.unpack_from("<I", data, off)
    off += 4
    return {struct.unpack_from("<q", data, off + 40 * i)[0] for i in range(exits)}
