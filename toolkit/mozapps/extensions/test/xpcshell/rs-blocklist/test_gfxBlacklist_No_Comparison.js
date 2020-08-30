/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 */

// Test whether a machine which exactly matches the blacklist entry is
// successfully blocked.
// Uses test_gfxBlacklist.json

// Performs the initial setup
async function run_test() {
  var gfxInfo = Cc["@mozilla.org/gfx/info;1"].getService(Ci.nsIGfxInfo);

  // We can't do anything if we can't spoof the stuff we need.
  if (!(gfxInfo instanceof Ci.nsIGfxInfoDebug)) {
    do_test_finished();
    return;
  }

  gfxInfo.QueryInterface(Ci.nsIGfxInfoDebug);
  gfxInfo.fireTestProcess();

  gfxInfo.spoofVendorID("0xabcd");
  gfxInfo.spoofDeviceID("0x6666");

  // Spoof the OS version so it matches the test file.
  switch (Services.appinfo.OS) {
    case "WINNT":
      // Windows 7
      gfxInfo.spoofOSVersion(0x60001);
      break;
    case "Linux":
      break;
    case "Darwin":
      gfxInfo.spoofOSVersion(0xa0900);
      break;
    case "Android":
      break;
  }

  do_test_pending();

  createAppInfo("xpcshell@tests.mozilla.org", "XPCShell", "3", "8");
  await promiseStartupManager();

  function checkBlacklist() {
    var driverVersion = gfxInfo.adapterDriverVersion;
    if (driverVersion) {
      var status = gfxInfo.getFeatureStatus(Ci.nsIGfxInfo.FEATURE_DIRECT2D);
      Assert.equal(status, Ci.nsIGfxInfo.FEATURE_BLOCKED_DEVICE);

      // Make sure unrelated features aren't affected
      status = gfxInfo.getFeatureStatus(
        Ci.nsIGfxInfo.FEATURE_DIRECT3D_9_LAYERS
      );
      Assert.equal(status, Ci.nsIGfxInfo.FEATURE_STATUS_OK);
    }
    do_test_finished();
  }

  Services.obs.addObserver(function(aSubject, aTopic, aData) {
    // If we wait until after we go through the event loop, gfxInfo is sure to
    // have processed the gfxItems event.
    executeSoon(checkBlacklist);
  }, "blocklist-data-gfxItems");

  mockGfxBlocklistItemsFromDisk("../data/test_gfxBlacklist.json");
}
