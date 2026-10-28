# 10. Lock Screen, Siri and CarPlay

What milestone 4 added, how to check it on a device, and what still needs Apple.

## 10.1 Live Activity

* **Where it shows:** Lock Screen, Dynamic Island, the CarPlay Dashboard and the Apple Watch Smart Stack. The CarPlay and Watch places use the small family (`.supplementalActivityFamilies([.small])`, iOS 18). Apple: "Your app does not need to be a CarPlay app to support Live Activities in CarPlay" (docs/research/2026-10-28_apple_platform.md, 1.5).
* **Content** (`DriveActivityContent` in the engine): next exit number and its services or name, distance, the next state line and the exits left before it, the next rest area, a "Last gas for N mi" warning when a long stretch starts within 25 miles, arrival time, and flags for simulated GPS and off route. Encoded size 392 bytes on the test route; ActivityKit allows 4 KB (tested).
* **Updates** (`DriveActivityThrottle`): at once when the exit, state, rest area or warning changes; distances when the shown value changes (tenths of a mile under 10 miles, whole miles above), at most every 15 seconds; at least every 2 minutes. Each update moves the stale date 5 minutes ahead, so a suspended app shows "Updated N min ago" instead of wrong numbers. Apple publishes no rate limit for local updates; these numbers are ExitAtlas's choice.
* **Lifecycle:** starts with a trip or discovery mode (a tap, so the app is in front, as ActivityKit requires). Ends with the trip and stays 15 minutes. iOS ends any Live Activity after 8 hours; ExitAtlas starts a new one the next time it is opened after 7.5 hours. It cannot restart itself in the background without a push server (push-to-start, milestone 6).
* **Settings:** Settings, Lock Screen and CarPlay, Live Activity (on by default), and a preview that draws the same views with the current trip. The UI tests capture that preview, because the Lock Screen cannot be captured in a UI test.
* **Not verified yet:** on a device (Lock Screen, Dynamic Island), in CarPlay Simulator, on a Watch.

## 10.2 Siri and Shortcuts

Six App Shortcuts (Apple allows 10). Every phrase names the app, as Apple requires:

| Shortcut | Example phrase | Answer on the Miami to Manhattan test route at mile 358 (from `TripAnswers`, tested) |
|---|---|---|
| Next state line | "How far to the next state line in ExitAtlas" | "Georgia is 16 miles ahead, about 18 minutes. 2 exits remain in Florida." |
| Distance to a state | "How far to Georgia in ExitAtlas" | "Georgia is 16 miles ahead, about 18 minutes. You cross at 3:50 AM Eastern Time." |
| Next exit | "Next exit in ExitAtlas" | "Exit 373 is 7 miles ahead. It has gas, food and lodging." |
| Next rest area | "Next rest area in ExitAtlas" | "The next welcome center is Georgia Visitor Information Center, 17 miles ahead, about 18 minutes. Its amenities are not listed." |
| Next gas | "Next gas in ExitAtlas" | "The next gas is Exit 373, 7 miles ahead." |
| Arrival time | "When do I arrive in ExitAtlas" | "You arrive at Manhattan at about 9:03 PM Eastern Time, in 17 hours 30 minutes. 923 miles to go." |

Answers are full sentences because in CarPlay and on a locked phone they are only heard. They run in the app's process; with no trip running they say so. Not verified on a device yet.

## 10.3 CarPlay app (driving task): not enabled

`App/ExitAtlas/CarPlay/CarPlaySceneDelegate.swift` is a scaffold: an information template with the same facts as the Live Activity, refreshed every 10 seconds. iOS never creates it until both steps below are done. It is compiled in CI but has never run.

Steps that need Jerry's Apple developer account:

1. Request the CarPlay driving task entitlement (`com.apple.developer.carplay-driving-task`) at developer.apple.com/carplay. Apple reviews each request; approval time is not published (docs/09, 9.11).
2. Once granted: add the entitlement to a `ExitAtlas.entitlements` file, enable it on the App ID and the provisioning profile, and declare the scene in `App/project.yml`:

```yaml
UIApplicationSceneManifest:
  UIApplicationSupportsMultipleScenes: true
  UISceneConfigurations:
    CPTemplateApplicationSceneSessionRoleApplication:
      - UISceneClassName: CPTemplateApplicationScene
        UISceneConfigurationName: CarPlay
        UISceneDelegateClassName: $(PRODUCT_MODULE_NAME).CarPlaySceneDelegate
```

3. Test in CarPlay Simulator with a USB connected iPhone (Xcode, Device Hub, or Additional Tools for Xcode).
