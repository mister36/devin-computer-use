import Foundation

struct HelperRequest: Codable {
    let id: Int
    let method: String
    let params: [String: JSONValue]?
}

struct HelperResponse: Codable {
    let id: Int
    var result: [String: JSONValue]? = nil
    var error: HelperErrorBody? = nil

    static func ok(id: Int, _ result: [String: JSONValue]) -> HelperResponse {
        HelperResponse(id: id, result: result)
    }

    static func failure(id: Int, code: String, message: String) -> HelperResponse {
        HelperResponse(id: id, error: HelperErrorBody(code: code, message: message))
    }
}

struct HelperErrorBody: Codable {
    let code: String
    let message: String
}

struct HelperException: Error {
    let code: String
    let message: String

    init(_ code: String, _ message: String) {
        self.code = code
        self.message = message
    }
}

// Minimal untyped JSON value for request/response payloads.
enum JSONValue: Codable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case array([JSONValue])
    case object([String: JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let v): try container.encode(v)
        case .number(let v): try container.encode(v)
        case .bool(let v): try container.encode(v)
        case .array(let v): try container.encode(v)
        case .object(let v): try container.encode(v)
        case .null: try container.encodeNil()
        }
    }

    var stringValue: String? {
        if case .string(let v) = self { return v }
        return nil
    }

    var doubleValue: Double? {
        switch self {
        case .number(let v): return v
        case .string(let v): return Double(v)
        default: return nil
        }
    }

    var intValue: Int? {
        doubleValue.map { Int($0) }
    }

    var boolValue: Bool? {
        switch self {
        case .bool(let v): return v
        case .number(let v): return v != 0
        default: return nil
        }
    }

    var objectValue: [String: JSONValue]? {
        if case .object(let v) = self { return v }
        return nil
    }

    var arrayValue: [JSONValue]? {
        if case .array(let v) = self { return v }
        return nil
    }

    static func point(_ x: Double, _ y: Double) -> JSONValue {
        .object(["x": .number(x), "y": .number(y)])
    }

    static func rect(_ rect: CGRect) -> JSONValue {
        .array([.number(Double(rect.origin.x)), .number(Double(rect.origin.y)),
                .number(Double(rect.size.width)), .number(Double(rect.size.height))])
    }
}
