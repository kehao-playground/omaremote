.PHONY: test lint check
test:
	node --test "tests/*.test.mjs"

# qmllint and omarchy are only present on an Omarchy host; skip gracefully elsewhere.
lint:
	@if command -v qmllint >/dev/null 2>&1; then qmllint -I "$${OMARCHY_PATH:-/usr/share/omarchy}/shell" *.qml components/*.qml; else echo "qmllint not found - skipped"; fi
	@if command -v omarchy >/dev/null 2>&1; then omarchy plugin validate .; else echo "omarchy CLI not found - skipped"; fi

check: test lint
