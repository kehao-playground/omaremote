.PHONY: test lint check dev-install dev-restart integration
PLUGIN_ID := io.github.kehao-chen.omaremote
PLUGIN_DIR := $(HOME)/.config/omarchy/plugins/$(PLUGIN_ID)
OMARCHY_SHELL := $(or $(OMARCHY_PATH),/usr/share/omarchy)/shell
QMLLINT := $(shell command -v qmllint 2>/dev/null || ls /usr/lib/qt6/bin/qmllint 2>/dev/null)

test:
	node --test "tests/*.test.mjs"

# qmllint and omarchy are only present on an Omarchy host; skip gracefully elsewhere.
lint:
	@if [ -n "$(QMLLINT)" ]; then "$(QMLLINT)" -I "$(OMARCHY_SHELL)" *.qml components/*.qml tests/harness/*.qml; else echo "qmllint not found - skipped"; fi
	@if command -v omarchy >/dev/null 2>&1; then omarchy plugin validate .; else echo "omarchy CLI not found - skipped"; fi

check: test lint

# Integration scenarios against a second Quickshell instance with fake adapters (Task 4+).
integration:
	bash tests/fake-remote.sh

# Copy the plugin into the user plugin directory (Omarchy forbids symlinks) and hot-reload.
dev-install:
	mkdir -p "$(PLUGIN_DIR)"
	rsync -a --delete --exclude .git --exclude node_modules --exclude tests --exclude docs --exclude .superpowers --exclude .claude ./ "$(PLUGIN_DIR)/"
	-omarchy-shell shell rescanPlugins

# keepLoaded services only pick up code changes on a shell restart.
dev-restart: dev-install
	omarchy-restart-shell
