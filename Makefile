# The git tag is the only place the version lives: v1.2.3 → 1.2.3.
# Untagged commits build as e.g. 1.2.3-2-gabc1234, uncommitted changes add -dirty.
VERSION   := $(shell git describe --tags --dirty --match 'v[0-9]*' 2>/dev/null | sed 's/^v//')
VERSION   := $(or $(VERSION),0.0.0-dev)
BUNDLE_ID := com.matkovsky.alfred-slack
BUILD     := build/workflow
SLACK_APP := /Applications/Slack.app

# Alfred's active preferences folder (respects sync folder, e.g. Dropbox).
ALFRED_PREFS := $(shell /usr/bin/osascript -l JavaScript -e 'ObjC.import("Cocoa"); const p=$$.NSString.stringWithContentsOfFileEncodingError($$("~/Library/Application Support/Alfred/prefs.json").stringByExpandingTildeInPath,4,null); p.isNil()?"":(JSON.parse(p.js).current||"").replace(/^~/, $$.NSHomeDirectory().js)')
INSTALL_DIR  := $(ALFRED_PREFS)/workflows/user.workflow.$(BUNDLE_ID)

.PHONY: build install package clean test

build:
	@rm -rf $(BUILD) && mkdir -p $(BUILD)
	cp src/slack.js $(BUILD)/
	/usr/bin/osascript -l JavaScript tools/build-plist.js $(BUILD)/info.json $(VERSION)
	plutil -convert xml1 -o $(BUILD)/info.plist $(BUILD)/info.json && rm $(BUILD)/info.json
	@if [ -f src/icon.png ]; then cp src/icon.png $(BUILD)/icon.png; \
	else sips -s format png -Z 256 "$$(ls $(SLACK_APP)/Contents/Resources/*.icns | head -1)" --out $(BUILD)/icon.png >/dev/null; fi
	plutil -lint $(BUILD)/info.plist

# Copies the build into Alfred. prefs.plist (your User Configuration) is preserved.
install: build
	@test -n "$(ALFRED_PREFS)" || (echo "Alfred preferences not found" && exit 1)
	mkdir -p "$(INSTALL_DIR)"
	rsync -a --delete --exclude prefs.plist $(BUILD)/ "$(INSTALL_DIR)/"
	@echo "Installed to $(INSTALL_DIR)"

package: build
	cd $(BUILD) && zip -qr ../Slack-$(VERSION).alfredworkflow .
	@echo "build/Slack-$(VERSION).alfredworkflow"

test:
	./tools/test.sh

clean:
	rm -rf build
