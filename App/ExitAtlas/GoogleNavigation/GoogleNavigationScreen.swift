#if GOOGLE_NAVIGATION
import ExitAtlasCore
import SwiftUI

/// The experimental Google navigation mode (docs/14), full screen over the ExitAtlas trip: ExitAtlas's
/// explanation once, then Google's navigation with an ExitAtlas panel below Google's map, never over it.
/// The ExitAtlas trip keeps tracking with its own GPS; Ending returns to it.
struct GoogleNavigationScreen: View {
    @Environment(TripController.self) private var trip
    @Environment(\.dismiss) private var dismiss
    @Bindable private var account = GoogleNavigationAccount.shared
    @State private var keyReady: Bool?
    @State private var phase: GoogleNavigationViewController.Phase = .starting
    @State private var controller = GoogleNavigationControllerRef()
    @State private var simulating = false

    var body: some View {
        // One container, so appearing and disappearing happen once for the whole mode.
        ZStack {
            if !account.consented {
                GoogleNavigationConsent(onContinue: {
                    account.consented = true
                    keyReady = account.provideKeyToGoogle()
                }, onCancel: { dismiss() })
            } else if keyReady == true {
                navigation
            } else if keyReady == false {
                message(account.needsRestartForKey
                    ? "The Google key changed. Close and reopen ExitAtlas to use the new key."
                    : "Add your Google key in Settings, Navigate with Google.")
            } else {
                Theme.background.ignoresSafeArea()
            }
        }
        .onAppear {
            // Google gets the key only after the driver agreed, before its first map is made (once per launch).
            if account.consented { keyReady = account.provideKeyToGoogle() }
            // One voice at a time: Google speaks the guidance and the alerts in this mode.
            trip.announcer.suspended = true
        }
        .onDisappear { trip.announcer.suspended = false }
    }

    private var navigation: some View {
        VStack(spacing: 0) {
            topBar
            ZStack {
                GoogleNavigationMap(destinations: trip.waypointsAhead, ref: controller) { phase = $0 }
                if case .failed(let text) = phase { failure(text) }
            }
            GoogleModeTripPanel()
        }
        .background(Theme.background.ignoresSafeArea())
        .onChange(of: phase) { _, p in if p == .declined { dismiss() } }
    }

    /// Outside Google's map: End, the mode's name, and the parked tests (labeled as simulations).
    private var topBar: some View {
        HStack(spacing: 12) {
            Button("End", role: .destructive) { dismiss() }
                .font(.body.weight(.semibold))
                .accessibilityIdentifier("endGoogleNavigation")
            Spacer()
            VStack(spacing: 2) {
                Text("Google navigation").font(.subheadline.weight(.semibold))
                Text(simulating ? "SIMULATED DRIVE · TEST" : "EXPERIMENTAL")
                    .font(.system(size: 10, weight: .heavy)).tracking(0.5)
                    .foregroundStyle(simulating ? Color.purple : Theme.secondaryText)
            }
            Spacer()
            Menu {
                Button("Simulate the drive (parked test)") {
                    controller.controller?.simulateDrive()
                    simulating = true
                }
                Button("Show Google's test alert") { controller.controller?.showTestAlert() }
            } label: {
                Image(systemName: "testtube.2").font(.body.weight(.semibold))
            }
            .disabled(phase != .navigating && phase != .arrived)
            .accessibilityLabel("Parked tests")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(Theme.card)
    }

    private func failure(_ text: String) -> some View {
        VStack(spacing: 12) {
            Text(text).font(.body).multilineTextAlignment(.center)
            Button("Back to ExitAtlas") { dismiss() }.buttonStyle(.borderedProminent).tint(Theme.signGreen)
        }
        .padding(20)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .padding(24)
    }

    private func message(_ text: String) -> some View {
        VStack(spacing: 16) {
            Text(text).font(.body).multilineTextAlignment(.center)
            Button("Back to ExitAtlas") { dismiss() }.buttonStyle(.borderedProminent).tint(Theme.signGreen)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.background.ignoresSafeArea())
    }
}

/// Lets the screen reach the controller for the parked tests.
final class GoogleNavigationControllerRef {
    weak var controller: GoogleNavigationViewController?
}

private struct GoogleNavigationMap: UIViewControllerRepresentable {
    let destinations: [Waypoint]
    let ref: GoogleNavigationControllerRef
    let onPhase: (GoogleNavigationViewController.Phase) -> Void

    func makeUIViewController(context: Context) -> GoogleNavigationViewController {
        let c = GoogleNavigationViewController(destinations: destinations)
        c.onPhase = onPhase
        ref.controller = c
        return c
    }

    func updateUIViewController(_ controller: GoogleNavigationViewController, context: Context) {}
}

/// ExitAtlas's explanation before anything goes to Google, shown once.
struct GoogleNavigationConsent: View {
    let onContinue: () -> Void
    let onCancel: () -> Void

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Google's turn by turn navigation, with the live alerts Google Maps users report: police, speed cameras, crashes, closures and more. Your ExitAtlas trip keeps running underneath.")
                }
                Section("What Google receives") {
                    Label("Your location and your route's stops while Google navigates", systemImage: "location")
                    Label("Reports and votes you choose to send with Google's report button", systemImage: "exclamationmark.bubble")
                }
                Section("What it costs") {
                    Text("Each destination is a request billed to the Google account of the key in Settings: 1,000 a month free, then 2.5 cents each. Reroutes are free.")
                }
                Section("What ExitAtlas does not do") {
                    Text("ExitAtlas does not read, keep or share Google's reports, routes or road data. They stay in Google's screen.")
                }
                Section {
                    Text("Next, Google shows its own terms. Experimental: it has not been tested on a drive yet.")
                        .font(.footnote).foregroundStyle(Theme.secondaryText)
                }
            }
            .navigationTitle("Navigate with Google")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Not now", action: onCancel) }
                ToolbarItem(placement: .confirmationAction) { Button("Continue", action: onContinue) }
            }
        }
    }
}

/// ExitAtlas's trip below Google's map: the state, miles to the state line, exits left and the next exit,
/// from ExitAtlas's own route and GPS (nothing from Google). Its own background and border keep it apart
/// from Google's content.
private struct GoogleModeTripPanel: View {
    @Environment(TripController.self) private var trip

    var body: some View {
        Group {
            if let s = trip.snapshot, let current = s.current {
                HStack(alignment: .center, spacing: 14) {
                    StateBadge(code: current.segment.code, highlighted: true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(s.next.map { "\(Format.miles(current.remainingMeters)) to \($0.segment.displayName)" }
                             ?? "Final state: \(current.segment.displayName)")
                            .font(.headline).lineLimit(1).minimumScaleFactor(0.8)
                        Text("\(current.exitsRemaining) exits left in \(current.segment.code ?? "this state") · \(Int((current.fractionComplete * 100).rounded()))% driven")
                            .font(.subheadline).foregroundStyle(Theme.secondaryText).lineLimit(1).minimumScaleFactor(0.8)
                    }
                    Spacer(minLength: 8)
                    if let e = s.nextExit {
                        VStack(alignment: .trailing, spacing: 4) {
                            ExitSign(label: e.exit.label, compact: true)
                            Text(Format.miles(e.distance)).font(.caption.weight(.semibold)).foregroundStyle(Theme.secondaryText)
                        }
                    }
                }
                .accessibilityElement(children: .combine)
            } else {
                Text("ExitAtlas trip progress shows here once your position is on the route.")
                    .font(.footnote).foregroundStyle(Theme.secondaryText)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.card.ignoresSafeArea(edges: .bottom))
        .overlay(alignment: .top) { Rectangle().fill(Theme.cardStroke).frame(height: 1) }
        .accessibilityIdentifier("googleModeTripPanel")
    }
}

/// Settings, Navigate with Google (experimental): the key, what it costs, and this month's destinations.
struct GoogleNavigationSettingsSection: View {
    @Bindable private var account = GoogleNavigationAccount.shared

    var body: some View {
        Section {
            SecureField("Google API key", text: $account.key)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            LabeledContent("Destinations this month",
                           value: "\(account.destinationsThisMonth) of \(GoogleNavigationAccount.freeDestinationsPerMonth.formatted()) free")
            if account.consented {
                Button("Show the explanation again") { account.consented = false }
            }
        } header: {
            Text("Navigate with Google (experimental)")
        } footer: {
            Text("Google's navigation with its live alerts (police, speed cameras, crashes), from Trip. Use a key restricted to this app and to the Navigation SDK and Maps SDK for iOS. Each destination is billed to the key's Google account after 1,000 a month (2.5 cents each). ExitAtlas reads nothing from Google's screen. The key stays in this iPhone's Keychain."
                 + (account.needsRestartForKey ? " Reopen ExitAtlas to use a changed key." : ""))
        }
    }
}
#endif
