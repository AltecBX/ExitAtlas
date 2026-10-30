import Foundation

/// The next maneuver along the route, from the routing provider's own steps, for the Drive guidance banner.
/// OSRM steps carry "type modifier" ("fork slight right", "off ramp right", "merge slight left", "arrive");
/// MapKit steps carry Apple's own sentence, which is shown as given. Steps that only rename the road or say
/// to continue are skipped, and so is a merge back onto the road already driven. Port of
/// web/js/engine/guidance.js, tested on the same fixtures (Fixtures/guidance).
public enum Guidance {
    public struct Maneuver: Sendable, Equatable {
        public enum Kind: String, Sendable { case fork, exit, ramp, merge, turn, roundabout, arrive, other }
        public enum Side: String, Sendable { case left, right, straight, uturn }

        /// Meters along the route where it happens, and meters from the driver.
        public let at: Double
        public let distance: Double
        public let kind: Kind
        public let side: Side
        /// "I-295 N", a street name, or nil.
        public let road: String?
        /// The exit number at an off ramp, when a bundled exit is there.
        public let exitLabel: String?
        public let text: String
    }

    // Longest first, so "off ramp" is not read as a word "off".
    static let types = ["exit roundabout", "exit rotary", "roundabout turn", "end of road", "notification", "off ramp", "on ramp",
                        "new name", "use lane", "roundabout", "continue", "rotary", "depart", "arrive", "merge", "turn", "fork"]
    static let skip: Set<String> = ["depart", "new name", "continue", "notification", "use lane"]
    static let modifiers: Set<String> = ["", "uturn", "sharp right", "right", "slight right", "straight", "slight left", "left", "sharp left"]
    /// How far past a ramp or fork to look for the road it leads to.
    static let leadsToWithin = 5000.0
    /// A bundled exit this close to an off ramp is the exit taken there.
    static let exitMatch = 600.0

    /// (type, modifier) for an OSRM style instruction ("fork slight right"), nil for a sentence (MapKit's
    /// "Turn right onto Main St" starts like one, so the modifier must be one of OSRM's).
    public static func parse(_ instruction: String) -> (type: String, modifier: String)? {
        let t = instruction.trimmingCharacters(in: .whitespaces).lowercased()
        for type in types where t == type || t.hasPrefix(type + " ") {
            let modifier = String(t.dropFirst(type.count)).trimmingCharacters(in: .whitespaces)
            return modifiers.contains(modifier) ? (type, modifier) : nil
        }
        return nil
    }

    static func side(of text: String) -> Maneuver.Side {
        func word(_ w: String) -> Bool { text.range(of: "\\b\(w)\\b", options: .regularExpression) != nil }
        if word("uturn") || text.contains("u-turn") { return .uturn }
        if word("left") { return .left }
        if word("right") { return .right }
        return .straight
    }

    /// "I-295 N" for a highway at a distance along the route. Named roads (turnpikes, parkways) are signed by
    /// their own directions, which the shape of the route does not tell reliably, so they get none.
    static func label(_ ref: HighwayRef, _ route: PlannedRoute, at: Double) -> String {
        if ref.kind == .named {
            return ref.number.replacingOccurrences(of: "^NJTP\\s+", with: "", options: .regularExpression)
        }
        return "\(ref) \(route.direction(of: ref, at: at).rawValue)"
    }

    /// The next maneuver after `progress` (meters along the route), or nil when none comes within `within`.
    /// `exits` names the exit at an off ramp.
    public static func next(on route: PlannedRoute, progress: Double, within: Double = .infinity,
                            destinationName: String? = nil, exits: [RouteExit] = []) -> Maneuver? {
        let steps = route.steps
        func previousRef(_ i: Int) -> HighwayRef? {
            var j = i - 1
            while j >= 0 { if let r = steps[j].highways.first { return r }; j -= 1 }
            return nil
        }
        func leadsTo(_ i: Int) -> (ref: HighwayRef, at: Double)? {
            let start = steps[i].startDistance
            var j = i
            while j < steps.count, steps[j].startDistance - start <= leadsToWithin {
                if let r = steps[j].highways.first { return (r, steps[j].startDistance) }
                if j > i, parse(steps[j].instruction)?.type == "arrive" { break }
                j += 1
            }
            return nil
        }
        for i in steps.indices {
            let st = steps[i]
            guard st.startDistance > progress else { continue }
            let at = st.startDistance, distance = at - progress
            if distance > within { return nil }
            guard let (type, modifier) = parse(st.instruction) else {
                let text = st.instruction.trimmingCharacters(in: .whitespaces)
                if text.isEmpty { continue }
                return Maneuver(at: at, distance: distance, kind: .other, side: side(of: text.lowercased()), road: nil, exitLabel: nil, text: text)
            }
            if skip.contains(type) { continue }
            let sd = side(of: modifier)
            let before = previousRef(i)
            let target = leadsTo(i)
            let road = target.map { label($0.ref, route, at: $0.at + 1) }
            let staying = target != nil && before != nil && target!.ref == before!
            let streetName = st.roadName.trimmingCharacters(in: .whitespaces)
            let street: String? = streetName.isEmpty ? nil : streetName
            var roadOut = road
            var exitLabel: String?
            let kind: Maneuver.Kind, text: String
            switch type {
            case "fork":
                kind = .fork
                let keep = sd == .left ? "Keep left" : sd == .right ? "Keep right" : "Continue straight"
                text = road.map { "\(keep) \(staying ? "to stay on" : "onto") \($0)" } ?? keep
            case "off ramp":
                kind = .exit
                exitLabel = exits.filter { abs($0.distanceAlongRoute - at) <= exitMatch }
                    .min { abs($0.distanceAlongRoute - at) < abs($1.distanceAlongRoute - at) }?.label
                let what = exitLabel.map { "Take Exit \($0)" } ?? "Take the exit on the \(sd == .left ? "left" : "right")"
                text = road != nil && !staying ? "\(what) toward \(road!)" : what
            case "on ramp":
                kind = .ramp
                text = road.map { "Take the ramp onto \($0)" } ?? "Take the ramp"
            case "merge":
                guard let road, !staying else { continue }
                kind = .merge
                text = "Merge onto \(road)"
            case "turn", "end of road":
                kind = .turn
                let turn = sd == .uturn ? "Make a U-turn" : sd == .straight ? "Continue straight" : "Turn \(sd.rawValue)"
                let onto = target != nil && target!.at == at ? road : street
                text = (type == "end of road" ? "At the end of the road, " + turn.lowercased() : turn) + (onto.map { " onto \($0)" } ?? "")
                roadOut = onto
            case "roundabout", "rotary", "roundabout turn":
                kind = .roundabout
                text = "Enter the roundabout"
                roadOut = nil
            case "exit roundabout", "exit rotary":
                kind = .roundabout
                text = "Exit the roundabout" + (street.map { " onto \($0)" } ?? "")
                roadOut = street
            case "arrive":
                kind = .arrive
                text = "Arrive at \(destinationName ?? "your destination")" + (sd == .left || sd == .right ? ", on the \(sd.rawValue)" : "")
            default:
                continue
            }
            return Maneuver(at: at, distance: distance, kind: kind, side: sd, road: roadOut, exitLabel: exitLabel, text: text)
        }
        return nil
    }
}
