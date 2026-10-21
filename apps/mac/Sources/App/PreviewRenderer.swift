import AppKit
import SwiftUI

/// Renders screens and the app icon to PNG without opening a window, for review and for the build.
@MainActor
enum PreviewRenderer {
    static func renderScreens(to directory: String) {
        _ = NSApplication.shared
        let screens: [(String, AppModel.SampleKind)] = [
            ("ready", .allConnected), ("first-run", .firstRun), ("restart", .restart), ("attention", .mixed),
            ("no-scrivener", .noScrivener), ("no-apps", .empty), ("failed", .failed),
        ]
        for (name, kind) in screens {
            for dark in [false, true] {
                let view = ContentView(model: .sample(kind))
                guard let png = snapshot(view, size: CGSize(width: 640, height: 1000), dark: dark) else {
                    FileHandle.standardError.write(Data("Could not render \(name)\n".utf8))
                    continue
                }
                save(png, to: "\(directory)/\(name)-\(dark ? "dark" : "light").png")
            }
        }
        for dark in [false, true] {
            if let png = snapshot(SettingsView(model: .sample(.allConnected)), size: CGSize(width: 480, height: 520), dark: dark) {
                save(png, to: "\(directory)/settings-\(dark ? "dark" : "light").png")
            }
        }
    }

    /// Renders through a real offscreen window so scroll views and native controls draw correctly.
    private static func snapshot<V: View>(_ view: V, size: CGSize, dark: Bool) -> Data? {
        let hosting = NSHostingView(rootView: view)
        hosting.frame = CGRect(origin: .zero, size: size)
        let window = NSWindow(
            contentRect: hosting.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        window.contentView = hosting
        window.setContentSize(size)
        hosting.layoutSubtreeIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.4))
        hosting.layoutSubtreeIfNeeded()
        guard let rep = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else { return nil }
        hosting.cacheDisplay(in: hosting.bounds, to: rep)
        return rep.representation(using: .png, properties: [:])
    }

    private static func save(_ png: Data, to path: String) {
        do {
            try FileManager.default.createDirectory(
                atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
            try png.write(to: URL(fileURLWithPath: path))
        } catch {
            FileHandle.standardError.write(Data("Could not write \(path): \(error)\n".utf8))
        }
    }

    static func renderIconSet(to directory: String) {
        let sizes: [(Int, Int)] = [(16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2), (256, 1), (256, 2), (512, 1), (512, 2)]
        for (size, scale) in sizes {
            let pixels = size * scale
            let view = AppGlyph().frame(width: CGFloat(pixels), height: CGFloat(pixels))
            let name = scale == 1 ? "icon_\(size)x\(size).png" : "icon_\(size)x\(size)@2x.png"
            write(view, to: "\(directory)/\(name)", scale: 1)
        }
    }

    private static func write<V: View>(_ view: V, to path: String, scale: CGFloat) {
        let renderer = ImageRenderer(content: view)
        renderer.scale = scale
        guard let image = renderer.nsImage,
              let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:])
        else {
            FileHandle.standardError.write(Data("Could not render \(path)\n".utf8))
            return
        }
        do {
            try FileManager.default.createDirectory(
                atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
            try png.write(to: URL(fileURLWithPath: path))
        } catch {
            FileHandle.standardError.write(Data("Could not write \(path): \(error)\n".utf8))
        }
    }
}
