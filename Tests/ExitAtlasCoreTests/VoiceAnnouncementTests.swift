import XCTest
@testable import ExitAtlasCore

/// Voice messages across a reroute on real route geometry with simulated GPS. A new plan restarts
/// segment numbering at 0; state line messages must still be given once each.
final class VoiceAnnouncementTests: XCTestCase {
    let start = Date(timeIntervalSince1970: 1_793_000_000)
    let settings = VoiceAnnouncements.Settings(enabled: true, stateLines: true, exits: false)
    let mile = Geodesy.metersPerMile

    func testStateLineMessagesSurviveAReroute() {
        let datasets = TripDatasets(states: Fixtures.states, timeZones: nil, interstates: Fixtures.interstates)
        let route = Fixtures.route("richmond_to_nyc_turnpike")
        var session = TripSession(plan: TripPlan(route: route, datasets: datasets), states: Fixtures.states, startedAt: start)
        var voice = VoiceAnnouncements()
        var spoken: [String] = []
        func drive(from: Double, to: Double, at time: Date) -> LocationSample? {
            var last: LocationSample?
            for (sample, _) in GPSSimulator(route: route).traceWithTruth(from: from, to: to, startTime: time) {
                if let text = voice.message(for: session.ingest(sample), settings: settings) { spoken.append(text) }
                last = sample
            }
            return last
        }

        let segments = session.plan.states.segments
        guard let k = segments.indices.first(where: { $0 >= 2 && segments[$0].startDistance > 60 * mile && segments[$0].code != nil }) else {
            return XCTFail("route has a later state line")
        }
        let border = segments[k].startDistance
        let name = segments[k].displayName
        func warnings() -> Int { spoken.filter { $0.hasPrefix("\(name) state line in") }.count }

        guard let last = drive(from: 0, to: border - 4 * mile, at: start) else { return XCTFail("no samples") }
        XCTAssertEqual(warnings(), 1, spoken.joined(separator: " | "))

        // Reroute onto the same road ahead: a new plan that starts here.
        let here = route.polyline.nearestProjection(of: last.coordinate, within: 50)!
        let remainder = route.polyline.slice(from: here.distanceAlong, to: route.polyline.length)
        let profile = TravelTimeProfile.uniform(length: remainder.length,
                                                totalSeconds: route.timeProfile.seconds(from: here.distanceAlong, to: route.length))
        let rerouted = PlannedRoute(source: .osrm, polyline: remainder, timeProfile: profile,
                                    origin: Waypoint(name: "Here", coordinate: remainder.points.first!),
                                    destination: route.destination)
        session.replacePlan(TripPlan(route: rerouted, datasets: datasets), at: last.timestamp)
        XCTAssertNotEqual(session.plan.states.segments.firstIndex { $0.displayName == name }, k, "indexes changed")

        guard let crossed = drive(from: here.distanceAlong + 20, to: border + 2 * mile, at: last.timestamp.addingTimeInterval(1)) else {
            return XCTFail("no samples")
        }
        XCTAssertEqual(warnings(), 1, "the same state line is not announced twice")
        XCTAssertTrue(spoken.contains { $0.hasPrefix("Welcome to \(name).") }, spoken.joined(separator: " | "))

        if let after = segments[(k + 1)...].first(where: { $0.code != nil && $0.startDistance - border > 10 * mile }) {
            _ = drive(from: border + 2 * mile, to: after.startDistance - 4 * mile, at: crossed.timestamp.addingTimeInterval(1))
            XCTAssertTrue(spoken.contains { $0.hasPrefix("\(after.displayName) state line in") }, spoken.joined(separator: " | "))
        }
    }

    func testSilentWhenOffThenNoFalseWelcome() {
        let datasets = TripDatasets(states: Fixtures.states, timeZones: nil, interstates: Fixtures.interstates)
        let route = Fixtures.route("atlanta_to_nashville")
        var session = TripSession(plan: TripPlan(route: route, datasets: datasets), states: Fixtures.states, startedAt: start)
        var voice = VoiceAnnouncements()
        var spoken: [String] = []
        let off = VoiceAnnouncements.Settings(enabled: false, stateLines: true, exits: false)
        for (sample, _) in GPSSimulator(route: route).traceWithTruth(from: 0, to: 20 * mile, startTime: start) {
            if let text = voice.message(for: session.ingest(sample), settings: off) { spoken.append(text) }
        }
        XCTAssertEqual(spoken, [])
        for (sample, _) in GPSSimulator(route: route).traceWithTruth(from: 20 * mile, to: 40 * mile, startTime: start.addingTimeInterval(3600)) {
            if let text = voice.message(for: session.ingest(sample), settings: settings) { spoken.append(text) }
        }
        XCTAssertFalse(spoken.contains { $0.hasPrefix("Welcome") }, spoken.joined(separator: " | "))
    }
}
