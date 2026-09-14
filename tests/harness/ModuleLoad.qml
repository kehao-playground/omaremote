// Spec §2 verification item: every lib/*.mjs module must load and run under the QML JS engine (Qt 6.11 V4). Run: QT_QPA_PLATFORM=offscreen qml tests/harness/ModuleLoad.qml
import QtQuick
import "../../lib/Actions.mjs" as Actions
import "../../lib/Config.mjs" as Config
import "../../lib/ConfigFile.mjs" as ConfigFile
import "../../lib/Dbus.mjs" as Dbus
import "../../lib/Defaults.mjs" as Defaults
import "../../lib/Doctor.mjs" as Doctor
import "../../lib/KeyEngine.mjs" as KeyEngine
import "../../lib/MicApply.mjs" as MicApply
import "../../lib/Pipewire.mjs" as Pipewire
import "../../lib/Presentation.mjs" as Presentation
import "../../lib/SelfTest.mjs" as SelfTest
import "../../lib/Stats.mjs" as Stats
import "../../lib/Systemd.mjs" as Systemd
import "../../lib/VoiceSession.mjs" as VoiceSession
import "../../lib/VoxStatus.mjs" as VoxStatus

QtObject {
    Component.onCompleted: {
        var normalized = Config.normalizeConfig(Defaults.DEFAULT_CONFIG).config;

        var checks = [
            Defaults.KEY_NAMES.length,
            KeyEngine.createKeyEngine(normalized).press("home", 0).length,
            VoiceSession.createVoiceSession(normalized).snapshot().state,
            MicApply.parseConfigGet("{}").literalKnown,
            Systemd.backoffMs(1),
            Presentation.elapsedText(0),
            Pipewire.captureSourceOf([]).streamFound,
            Doctor.evaluate({}, normalized).length,
            Dbus.atvvoiceNames("").length,
            VoxStatus.parseStatusLine("{}"),
            SelfTest.createSelfTest({
                supportedKeys: [],
                gate: {
                    acquire: function () { return true; },
                    release: function () {}
                }
            }).active(),
            Stats.createStats([]).entries().length,
            ConfigFile.load("").missing,
            Actions.toArgv({ type: "none" }).kind
        ];

        console.log("module-load: ok");
        Qt.quit();
    }
}
