#!/usr/bin/env ruby
# Add the share extension to the Xcode project Tauri generates.
#
# `tauri ios init` writes `src-tauri/gen/apple/project.yml` from its own template
# on every CI run, and that file is a build product — editing it by hand on a Mac
# and committing the result is a change the next `ios init` silently throws away.
# So the extension target is merged in here, at build time, by a script that reads
# the generated spec rather than assuming what Tauri named things.
#
# Ruby and its YAML library are on every macOS runner, which is why this is not a
# Python script with a dependency to install.
#
# Usage: ruby scripts/ios-add-extension.rb src-tauri/gen/apple
#
# It expects the extension's sources to have been copied to
# `<gen/apple>/SubscribeExtension` already.

require "yaml"
require "json"

generated = ARGV[0] || "src-tauri/gen/apple"
spec_path = File.join(generated, "project.yml")
abort "no project.yml at #{spec_path}" unless File.file?(spec_path)

spec = YAML.load_file(spec_path)
targets = spec["targets"] || {}
app_name = targets.find { |_, target| target["type"] == "application" }&.first
abort "no application target in #{spec_path}" unless app_name

version = JSON.parse(File.read("package.json"))["version"]

extension = "HardlyReaderSubscribe"
targets[extension] = {
  "type" => "app-extension",
  "platform" => "iOS",
  "deploymentTarget" => "15.0",
  # Info.plist is named as the target's plist, so it must not also be copied as a
  # resource: an Info.plist inside the bundle root that is not the bundle's plist
  # is a warning and a second, stale copy.
  "sources" => [{ "path" => "SubscribeExtension", "excludes" => ["Info.plist"] }],
  "settings" => {
    "base" => {
      "PRODUCT_BUNDLE_IDENTIFIER" => "ing.hardlysleep.hardlyreader.subscribe",
      "PRODUCT_NAME" => extension,
      "INFOPLIST_FILE" => "SubscribeExtension/Info.plist",
      "GENERATE_INFOPLIST_FILE" => "NO",
      "MARKETING_VERSION" => version,
      "CURRENT_PROJECT_VERSION" => "1",
      "SWIFT_VERSION" => "5.0",
      "TARGETED_DEVICE_FAMILY" => "1,2",
      "IPHONEOS_DEPLOYMENT_TARGET" => "15.0",
      "SKIP_INSTALL" => "YES",
      # The whole IPA is unsigned (`tauri ios build --no-sign`); an extension that
      # insists on a signature of its own fails the build for a binary that is
      # re-signed on the device anyway.
      "CODE_SIGN_IDENTITY" => "",
      "CODE_SIGNING_REQUIRED" => "NO",
      "CODE_SIGNING_ALLOWED" => "NO",
    },
  },
  "dependencies" => [
    { "sdk" => "SwiftUI.framework" },
    { "sdk" => "UniformTypeIdentifiers.framework" },
  ],
}

# Embedded into the app, which is what puts it at PlugIns/*.appex in the bundle.
app = targets[app_name]
app["dependencies"] ||= []
already = app["dependencies"].any? { |dep| dep.is_a?(Hash) && dep["target"] == extension }
app["dependencies"] << { "target" => extension, "embed" => true } unless already

spec["targets"] = targets
File.write(spec_path, YAML.dump(spec))
puts "added #{extension} to #{app_name} (#{spec_path})"
