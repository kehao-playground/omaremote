# Spec §9: action fakes append their argv to actions.log instead of touching the desktop.
fake_log() { printf '%s\n' "$*" >> "${OMAREMOTE_FAKE_DIR:?OMAREMOTE_FAKE_DIR unset}/actions.log"; }
