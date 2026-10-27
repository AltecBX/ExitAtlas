import Foundation

public enum DatasetError: Error, CustomStringConvertible, Equatable {
    case badMagic(expected: String, found: String)
    case unsupportedVersion(UInt32)
    case truncated(at: Int)
    case invalid(String)

    public var description: String {
        switch self {
        case let .badMagic(expected, found): return "expected \(expected) file, found \(found)"
        case let .unsupportedVersion(v): return "unsupported dataset version \(v)"
        case let .truncated(at): return "dataset truncated at byte \(at)"
        case let .invalid(message): return message
        }
    }
}

/// Little-endian cursor over the bundled binary datasets (see tools/data-pipeline/eaformat.py).
struct BinaryReader {
    let data: Data
    private(set) var offset: Int

    init(_ data: Data, offset: Int = 0) {
        self.data = data
        self.offset = offset
    }

    @inline(__always)
    func value<T: FixedWidthInteger>(at position: Int, as type: T.Type) throws -> T {
        let size = MemoryLayout<T>.size
        guard position >= 0, position + size <= data.count else { throw DatasetError.truncated(at: position) }
        let raw = data.withUnsafeBytes { buffer in
            buffer.loadUnaligned(fromByteOffset: position, as: T.self)
        }
        return T(littleEndian: raw)
    }

    mutating func read<T: FixedWidthInteger>(_ type: T.Type) throws -> T {
        let v = try value(at: offset, as: T.self)
        offset += MemoryLayout<T>.size
        return v
    }

    mutating func readFloat32() throws -> Float {
        Float(bitPattern: try read(UInt32.self))
    }

    mutating func readBytes(_ count: Int) throws -> Data {
        guard count >= 0, offset + count <= data.count else { throw DatasetError.truncated(at: offset) }
        let start = data.startIndex + offset
        let slice = data[start..<(start + count)]
        offset += count
        return Data(slice)
    }

    mutating func readString(lengthPrefix: Int) throws -> String {
        let length: Int
        switch lengthPrefix {
        case 1: length = Int(try read(UInt8.self))
        case 2: length = Int(try read(UInt16.self))
        default: length = Int(try read(UInt32.self))
        }
        let bytes = try readBytes(length)
        guard let s = String(data: bytes, encoding: .utf8) else { throw DatasetError.invalid("invalid UTF-8") }
        return s
    }

    mutating func skip(_ count: Int) throws {
        guard offset + count <= data.count else { throw DatasetError.truncated(at: offset) }
        offset += count
    }

    /// Reads the common header: magic, version and JSON metadata.
    mutating func readHeader(magic expected: String, supportedVersion: UInt32) throws -> DatasetMetadata {
        let magicBytes = try readBytes(4)
        let magic = String(decoding: magicBytes, as: UTF8.self)
        guard magic == expected else { throw DatasetError.badMagic(expected: expected, found: magic) }
        let version = try read(UInt32.self)
        guard version == supportedVersion else { throw DatasetError.unsupportedVersion(version) }
        let metaLength = Int(try read(UInt32.self))
        let metaData = try readBytes(metaLength)
        let object = (try? JSONSerialization.jsonObject(with: metaData)) as? [String: Any] ?? [:]
        var values: [String: String] = [:]
        for (k, v) in object { values[k] = "\(v)" }
        return DatasetMetadata(values: values)
    }

    @inline(__always)
    static func coordinate(latE7: Int32, lonE7: Int32) -> GeoCoordinate {
        GeoCoordinate(latitude: Double(latE7) / 1e7, longitude: Double(lonE7) / 1e7)
    }
}

/// Provenance stored in every dataset header (source, license, attribution, build date).
public struct DatasetMetadata: Sendable, Equatable {
    public let values: [String: String]

    public init(values: [String: String]) {
        self.values = values
    }

    public var source: String? { values["source"] }
    public var license: String? { values["license"] }
    public var attribution: String? { values["attribution"] }
    public var generatedAt: String? { values["generated_at"] }
    public subscript(key: String) -> String? { values[key] }
}

/// Deduplicated UTF-8 string table. Strings decode lazily on access.
struct StringTable: Sendable {
    static let none: UInt32 = 0xFFFF_FFFF
    private let blob: Data
    private let offsets: [UInt32]

    init(reader: inout BinaryReader) throws {
        let count = Int(try reader.read(UInt32.self))
        let total = Int(try reader.read(UInt32.self))
        var offsets: [UInt32] = []
        offsets.reserveCapacity(count + 1)
        for _ in 0...count { offsets.append(try reader.read(UInt32.self)) }
        guard Int(offsets.last ?? 0) == total else { throw DatasetError.invalid("string table size mismatch") }
        blob = try reader.readBytes(total)
        self.offsets = offsets
    }

    var count: Int { offsets.count - 1 }

    func string(_ index: UInt32) -> String? {
        guard index != Self.none, Int(index) < count else { return nil }
        let start = Int(offsets[Int(index)]), end = Int(offsets[Int(index) + 1])
        return blob.withUnsafeBytes { buffer in
            String(decoding: UnsafeRawBufferPointer(rebasing: buffer[start..<end]), as: UTF8.self)
        }
    }
}
