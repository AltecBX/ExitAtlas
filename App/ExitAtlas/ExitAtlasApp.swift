import SwiftUI

@main
struct ExitAtlasApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .environment(model.trip)
                .environment(model.settings)
                .environment(model.library)
                .task { await model.start() }
        }
    }
}
