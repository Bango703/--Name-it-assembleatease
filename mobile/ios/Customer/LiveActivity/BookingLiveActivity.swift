import ActivityKit
import SwiftUI
import WidgetKit

// The lock screen and Dynamic Island while a visit is under way: who is coming,
// the arrival window, and the step, in the server's words. The app starts it on
// the day of the visit; the server moves it on every status change.

private let sky = Color(red: 0, green: 191.0 / 255.0, blue: 1)
private let skyDark = Color(red: 0, green: 153.0 / 255.0, blue: 204.0 / 255.0)

@main
struct CustomerLiveActivityBundle: WidgetBundle {
    var body: some Widget {
        BookingLiveActivity()
    }
}

struct BookingLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: BookingActivityAttributes.self) { context in
            LockScreenTracker(state: context.state, service: context.attributes.service)
                .padding(16)
                .activitySystemActionForegroundColor(skyDark)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Image(systemName: "wrench.and.screwdriver.fill").foregroundStyle(sky)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if !context.state.window.isEmpty {
                        Text(windowStart(context.state.window)).font(.caption.weight(.semibold))
                    }
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.state.status).font(.subheadline.weight(.semibold)).lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    StepBar(step: context.state.step, count: context.state.stepCount)
                }
            } compactLeading: {
                Image(systemName: "wrench.and.screwdriver.fill").foregroundStyle(sky)
            } compactTrailing: {
                Text("\(min(context.state.step + 1, context.state.stepCount))/\(context.state.stepCount)")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(sky)
            } minimal: {
                Image(systemName: "wrench.and.screwdriver.fill").foregroundStyle(sky)
            }
        }
    }
}

private func windowStart(_ window: String) -> String {
    window.components(separatedBy: CharacterSet(charactersIn: "-–—")).first?.trimmingCharacters(in: .whitespaces) ?? window
}

private struct LockScreenTracker: View {
    let state: BookingActivityAttributes.ContentState
    let service: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("AssembleAtEase").font(.caption.weight(.bold)).foregroundStyle(skyDark)
                Spacer()
                if !state.window.isEmpty {
                    Text(state.window).font(.caption).foregroundStyle(.secondary)
                }
            }
            Text(state.status).font(.headline).lineLimit(2)
            Text(service).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
            StepBar(step: state.step, count: state.stepCount)
        }
    }
}

private struct StepBar: View {
    let step: Int
    let count: Int

    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<max(count, 1), id: \.self) { index in
                Capsule()
                    .fill(index <= step ? sky : Color.gray.opacity(0.3))
                    .frame(height: 6)
            }
        }
    }
}
